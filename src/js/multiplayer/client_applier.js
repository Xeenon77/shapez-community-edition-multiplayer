import { DefaultCompression } from "../core/compression";
import { Logger } from "../core/logging";
import { SOUNDS } from "../platform/sound";
import { applyEntityState, computeStructureChecksum } from "./entity_sync";
import { MSG } from "./protocol";

/**
 * @typedef {import("../game/root").GameRoot} GameRoot
 * @typedef {import("./session").MultiplayerSession} MultiplayerSession
 */

const logger = new Logger("mp/client");

const INITIAL_SNAPSHOT_TIMEOUT_MS = 120000;
const RESYNC_MIN_INTERVAL_MS = 10000;
const MAX_MESSAGES_PER_FRAME = 200;

/**
 * Runs on clients: applies the authoritative state the host broadcasts.
 */
export class ClientApplier {
    /**
     * @param {MultiplayerSession} session
     */
    constructor(session) {
        this.session = session;

        /** @type {GameRoot|null} */
        this.root = null;

        /** Messages waiting to be applied, in arrival order @type {{ envelope: any, payload: Uint8Array|null }[]} */
        this.queue = [];

        /** Sequence number of the last applied delta (or snapshot) */
        this.lastSeq = -1;

        /** Set while an async step (snapshot decompression) runs; the queue waits for it */
        this.busy = false;

        this.lastResyncRequest = -Infinity;

        /** Uids we asked the host to delete and that still exist @type {Set<number>} */
        this.pendingDeletes = new Set();

        this.compression = new DefaultCompression();

        /** Tick rate of the host, applied once the game runs */
        this.hostTickRate = null;

        /** @type {{ resolve: (value: { dump: any, gameModeId: string }) => void, reject: (err: Error) => void }|null} */
        this.initialSnapshotWaiter = null;
    }

    /**
     * Resolves with the world once the host sent it
     * @returns {Promise<{ dump: any, gameModeId: string }>}
     */
    waitForInitialSnapshot() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.initialSnapshotWaiter = null;
                reject(new Error("The host did not send the world in time."));
            }, INITIAL_SNAPSHOT_TIMEOUT_MS);

            this.initialSnapshotWaiter = {
                resolve: value => {
                    clearTimeout(timeout);
                    resolve(value);
                },
                reject: err => {
                    clearTimeout(timeout);
                    reject(err);
                },
            };
        });
    }

    /**
     * @param {GameRoot} root
     */
    attach(root) {
        this.root = root;
    }

    cleanup() {
        this.initialSnapshotWaiter?.reject(new Error("Left the session"));
        this.initialSnapshotWaiter = null;
        this.queue = [];
        this.root = null;
    }

    onReconnected() {
        // Our pending deletes might have been lost
        this.pendingDeletes.clear();
    }

    /**
     * @param {any} envelope
     * @param {Uint8Array|null} payload
     */
    onMessage(envelope, payload) {
        if (envelope.t === MSG.snapshot && this.initialSnapshotWaiter) {
            this.handleInitialSnapshot(envelope, payload);
            return;
        }
        this.queue.push({ envelope, payload });
    }

    /**
     * @param {any} envelope
     * @param {Uint8Array|null} payload
     */
    async handleInitialSnapshot(envelope, payload) {
        const waiter = this.initialSnapshotWaiter;
        this.initialSnapshotWaiter = null;
        try {
            const dump = await this.compression.decompress(payload);
            this.lastSeq = envelope.seq;
            this.hostTickRate = envelope.tickRate;
            waiter.resolve({ dump, gameModeId: envelope.gameModeId });
        } catch (ex) {
            waiter.reject(new Error("Could not read the world sent by the host: " + ex));
        }
    }

    /**
     * Whether a delete for this uid is already on its way to the host
     * @param {number} uid
     */
    hasPendingDelete(uid) {
        return this.pendingDeletes.has(uid);
    }

    /**
     * @param {number} uid
     */
    addPendingDelete(uid) {
        this.pendingDeletes.add(uid);
    }

    update() {
        const root = this.root;
        if (!root || !root.gameInitialized) {
            return;
        }

        if (this.hostTickRate && root.dynamicTickrate.currentTickRate !== this.hostTickRate) {
            root.dynamicTickrate.setTickRate(this.hostTickRate);
        }

        let processed = 0;
        while (this.queue.length > 0 && !this.busy && processed++ < MAX_MESSAGES_PER_FRAME) {
            const { envelope, payload } = this.queue.shift();
            try {
                this.handle(envelope, payload);
            } catch (ex) {
                logger.error("Failed to handle", envelope.t, ex);
                this.requestResync();
            }
        }
    }

    /**
     * @param {any} envelope
     * @param {Uint8Array|null} payload
     */
    handle(envelope, payload) {
        const root = this.root;
        switch (envelope.t) {
            case MSG.delta: {
                if (envelope.seq <= this.lastSeq) {
                    // Already part of the snapshot we loaded
                    return;
                }
                if (envelope.seq !== this.lastSeq + 1) {
                    logger.warn("Missed deltas, expected", this.lastSeq + 1, "got", envelope.seq);
                    this.requestResync();
                }
                this.lastSeq = envelope.seq;
                const added = Array.isArray(envelope.added) ? envelope.added : [];
                const destroyed = Array.isArray(envelope.destroyed) ? envelope.destroyed : [];
                this.session.withApplying(() => applyEntityState(root, { added, destroyed }));
                for (const uid of destroyed) {
                    this.pendingDeletes.delete(uid);
                }
                return;
            }

            case MSG.hubState: {
                if (Number.isFinite(envelope.tickRate) && envelope.tickRate > 0) {
                    this.hostTickRate = envelope.tickRate;
                }
                this.applyHubState(envelope.hub, Array.isArray(envelope.events) ? envelope.events : []);
                return;
            }

            case MSG.checksum: {
                if (envelope.seq !== this.lastSeq) {
                    // Deltas are still on the way, can't compare
                    return;
                }
                const own = computeStructureChecksum(root);
                if (own.hash !== envelope.hash) {
                    logger.warn(
                        "Structure checksum mismatch: host",
                        envelope.hash,
                        envelope.count,
                        "local",
                        own.hash,
                        own.count
                    );
                    this.requestResync();
                }
                return;
            }

            case MSG.snapshot: {
                this.busy = true;
                this.compression
                    .decompress(payload)
                    .then(dump => this.applyResync(envelope, dump))
                    .catch(ex => logger.error("Failed to apply resync:", ex))
                    .finally(() => (this.busy = false));
                return;
            }

            case MSG.clearItems: {
                if (!Array.isArray(envelope.uids)) {
                    return;
                }
                for (const uid of envelope.uids) {
                    const entity = root.entityMgr.findByUid(uid, false);
                    if (entity) {
                        for (const component of Object.values(entity.components)) {
                            component.clear();
                        }
                    }
                }
                return;
            }

            case MSG.waypoints: {
                const waypoints = root.hud.parts.waypoints;
                if (waypoints && Array.isArray(envelope.waypoints)) {
                    waypoints.deserialize({ waypoints: envelope.waypoints });
                }
                return;
            }

            case MSG.editSignal: {
                const entity = root.entityMgr.findByUid(envelope.uid, false);
                if (entity && root.hud.parts.constantSignalEdit) {
                    root.hud.parts.constantSignalEdit.editConstantSignal(entity, { deleteOnCancel: true });
                }
                return;
            }

            default:
                logger.warn("Ignoring message", envelope.t);
        }
    }

    /**
     * Replaces the whole structure with the one of the host
     * @param {any} envelope
     * @param {any} dump
     */
    applyResync(envelope, dump) {
        const root = this.root;
        if (!root) {
            return;
        }
        logger.log("Applying resync with", dump.entities.length, "entities");
        this.session.withApplying(() =>
            applyEntityState(root, { added: dump.entities, destroyed: [], removeOthers: true })
        );
        this.lastSeq = envelope.seq;
        this.pendingDeletes.clear();
        if (Number.isFinite(envelope.tickRate)) {
            this.hostTickRate = envelope.tickRate;
        }
        this.applyHubState(dump.hubGoals, []);
    }

    /**
     * @param {any} hub Serialized HubGoals
     * @param {any[]} events
     */
    applyHubState(hub, events) {
        const root = this.root;
        if (!hub) {
            return;
        }
        const error = root.hubGoals.deserialize(hub, root);
        if (error) {
            logger.error("Failed to apply hub state:", error);
            return;
        }

        for (const event of events) {
            if (event.type === "storyGoalCompleted") {
                root.signals.storyGoalCompleted.dispatch(event.level, event.reward);
            } else if (event.type === "upgradePurchased") {
                root.signals.upgradePurchased.dispatch(event.id);
                if (event.by === this.session.playerId) {
                    root.app.sound.playUiSound(SOUNDS.unlockUpgrade);
                }
            }
        }
    }

    requestResync() {
        const now = performance.now();
        if (now - this.lastResyncRequest < RESYNC_MIN_INTERVAL_MS) {
            return;
        }
        this.lastResyncRequest = now;
        logger.warn("Requesting resync");
        this.session.send({ t: MSG.resyncRequest });
    }
}
