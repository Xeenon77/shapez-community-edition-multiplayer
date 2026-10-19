import { DefaultCompression } from "../core/compression";
import { gComponentRegistry, gMetaBuildingRegistry } from "../core/global_registries";
import { Logger } from "../core/logging";
import { Vector } from "../core/vector";
import { Blueprint } from "../game/blueprint";
import { enumHubGoalRewards } from "../game/tutorial_goals";
import { SavegameSerializer } from "../savegame/savegame_serializer";
import { computeStructureChecksum, createEntityFromPayload, verifyEntityPayload } from "./entity_sync";
import { isValidIntent, MSG } from "./protocol";

/**
 * @typedef {import("../game/root").GameRoot} GameRoot
 * @typedef {import("../game/entity").Entity} Entity
 * @typedef {import("./session").MultiplayerSession} MultiplayerSession
 */

const logger = new Logger("mp/host");

const HUB_SYNC_INTERVAL_MS = 1000;
const CHECKSUM_INTERVAL_MS = 10000;
const SNAPSHOT_MIN_INTERVAL_MS = 5000;
const MAX_INTENTS_PER_MESSAGE = 20000;

/**
 * Runs on the host: applies intents from clients with the regular game logic
 * and broadcasts the resulting changes.
 */
export class HostAuthority {
    /**
     * @param {GameRoot} root
     * @param {MultiplayerSession} session
     */
    constructor(root, session) {
        this.root = root;
        this.session = session;

        /** Entities added or changed since the last flush @type {Map<number, Entity>} */
        this.dirty = new Map();

        /** Uids destroyed since the last flush @type {Set<number>} */
        this.destroyed = new Set();

        /** Notable hub events since the last hub sync */
        this.hubEvents = [];
        this.hubDirty = false;
        this.waypointsDirty = false;

        /** Sequence number of the last sent delta */
        this.seq = 0;

        /** @type {{ from: number, intents: any[] }[]} */
        this.intentQueue = [];

        /** Messages to send right after the next delta @type {object[]} */
        this.followUps = [];

        /** Number of snapshots being compressed. Deltas wait for them to keep the order. */
        this.pendingSnapshots = 0;

        /** @type {Map<number, number>} */
        this.lastSnapshotSent = new Map();

        /** Player whose intent is being applied, null for the host's own actions */
        this.currentIntentPlayer = null;

        this.lastHubSync = 0;
        this.lastChecksum = performance.now();

        this.compression = new DefaultCompression();

        const signals = root.signals;
        signals.entityAdded.add(this.markChanged, this);
        signals.entityChanged.add(this.markChanged, this);
        signals.entityDestroyed.add(this.onEntityDestroyed, this);
        signals.storyGoalCompleted.add(this.onStoryGoalCompleted, this);
        signals.upgradePurchased.add(this.onUpgradePurchased, this);
    }

    cleanup() {
        const signals = this.root.signals;
        signals.entityAdded.remove(this.markChanged);
        signals.entityChanged.remove(this.markChanged);
        signals.entityDestroyed.remove(this.onEntityDestroyed);
        signals.storyGoalCompleted.remove(this.onStoryGoalCompleted);
        signals.upgradePurchased.remove(this.onUpgradePurchased);
    }

    ////////// Change tracking //////////

    /**
     * @param {Entity} entity
     */
    markChanged(entity) {
        if (entity.components.StaticMapEntity) {
            this.destroyed.delete(entity.uid);
            this.dirty.set(entity.uid, entity);
        }
    }

    /**
     * @param {Entity} entity
     */
    onEntityDestroyed(entity) {
        if (entity.components.StaticMapEntity) {
            this.dirty.delete(entity.uid);
            this.destroyed.add(entity.uid);
        }
    }

    /**
     * @param {number} level
     * @param {string} reward
     */
    onStoryGoalCompleted(level, reward) {
        this.hubEvents.push({ type: "storyGoalCompleted", level, reward });
        this.hubDirty = true;
    }

    /**
     * @param {string} upgradeId
     */
    onUpgradePurchased(upgradeId) {
        this.hubEvents.push({
            type: "upgradePurchased",
            id: upgradeId,
            by: this.currentIntentPlayer ?? this.session.playerId,
        });
        this.hubDirty = true;
    }

    markWaypointsChanged() {
        this.waypointsDirty = true;
    }

    /**
     * @param {number[]} uids
     */
    broadcastItemsCleared(uids) {
        this.followUps.push({ t: MSG.clearItems, to: "all", uids });
    }

    ////////// Messages //////////

    /**
     * @param {any} envelope
     * @param {Uint8Array|null} payload
     */
    onMessage(envelope, payload) {
        switch (envelope.t) {
            case MSG.peerJoined:
                logger.log("Player joined:", envelope.playerId, envelope.name);
                this.sendSnapshot(envelope.playerId, true);
                break;

            case MSG.peerLeft:
                logger.log("Player left:", envelope.playerId);
                this.lastSnapshotSent.delete(envelope.playerId);
                break;

            case MSG.intent:
                if (Array.isArray(envelope.intents) && typeof envelope.from === "number") {
                    this.intentQueue.push({
                        from: envelope.from,
                        intents: envelope.intents.slice(0, MAX_INTENTS_PER_MESSAGE),
                    });
                }
                break;

            case MSG.resyncRequest:
                if (typeof envelope.from === "number") {
                    logger.warn("Player", envelope.from, "requested a resync");
                    this.sendSnapshot(envelope.from, false);
                }
                break;

            default:
                logger.warn("Ignoring message", envelope.t, "from", envelope.from);
        }
    }

    update() {
        if (this.intentQueue.length > 0) {
            const queue = this.intentQueue;
            this.intentQueue = [];
            for (const { from, intents } of queue) {
                for (const intent of intents) {
                    this.applyIntent(from, intent);
                }
            }
        }

        this.flush();

        const now = performance.now();
        if (now - this.lastHubSync > HUB_SYNC_INTERVAL_MS) {
            this.sendHubState();
        }

        if (now - this.lastChecksum > CHECKSUM_INTERVAL_MS && this.pendingSnapshots === 0) {
            this.lastChecksum = now;
            this.session.send({
                t: MSG.checksum,
                to: "all",
                seq: this.seq,
                ...computeStructureChecksum(this.root),
            });
        }
    }

    /**
     * Sends everything that changed since the last flush
     */
    flush() {
        if (this.pendingSnapshots > 0) {
            // Keep the order: the snapshot has to arrive before any newer delta
            return;
        }

        if (this.dirty.size > 0 || this.destroyed.size > 0) {
            const added = [];
            for (const entity of this.dirty.values()) {
                if (!entity.destroyed && !entity.queuedForDestroy) {
                    added.push(entity.serialize());
                }
            }
            const destroyed = [...this.destroyed];
            this.dirty.clear();
            this.destroyed.clear();

            this.session.send({ t: MSG.delta, to: "all", seq: ++this.seq, added, destroyed });
        }

        if (this.hubDirty) {
            this.sendHubState();
        }

        if (this.waypointsDirty && this.root.hud.parts.waypoints) {
            this.waypointsDirty = false;
            this.session.send({
                t: MSG.waypoints,
                to: "all",
                waypoints: this.root.hud.parts.waypoints.serialize().waypoints,
            });
        }

        for (const message of this.followUps) {
            this.session.send(message);
        }
        this.followUps = [];
    }

    sendHubState() {
        this.lastHubSync = performance.now();
        this.hubDirty = false;
        const events = this.hubEvents;
        this.hubEvents = [];
        this.session.send({
            t: MSG.hubState,
            to: "all",
            hub: this.root.hubGoals.serialize(),
            tickRate: this.root.dynamicTickrate.currentTickRate,
            events,
        });
    }

    /**
     * Sends the whole world to one player. Used for joining and for resyncs.
     * @param {number} playerId
     * @param {boolean} force Skip the rate limit (joins)
     */
    async sendSnapshot(playerId, force) {
        const now = performance.now();
        if (!force && now - (this.lastSnapshotSent.get(playerId) ?? -Infinity) < SNAPSHOT_MIN_INTERVAL_MS) {
            return;
        }
        this.lastSnapshotSent.set(playerId, now);

        // Everything before the snapshot goes out first
        this.flush();

        const dump = new SavegameSerializer().generateDumpFromGameRoot(this.root, false);
        const envelope = {
            t: MSG.snapshot,
            to: playerId,
            seq: this.seq,
            gameModeId: this.root.gameMode.getId(),
            tickRate: this.root.dynamicTickrate.currentTickRate,
        };

        this.pendingSnapshots++;
        try {
            const bytes = await this.compression.compress(dump);
            logger.log("Sending snapshot to", playerId, "(" + Math.round(bytes.length / 1024) + " KiB)");
            this.session.send(envelope, bytes);
        } catch (ex) {
            logger.error("Failed to create snapshot:", ex);
        } finally {
            this.pendingSnapshots--;
        }
    }

    ////////// Intents //////////

    /**
     * Applies an intent of a client with the regular game logic
     * @param {number} from
     * @param {any} intent
     */
    applyIntent(from, intent) {
        if (!isValidIntent(intent)) {
            logger.warn("Dropping invalid intent from", from, intent?.type);
            return;
        }

        this.currentIntentPlayer = from;
        try {
            this.session.withApplying(() => this.applyValidIntent(from, intent));
        } catch (ex) {
            logger.error("Failed to apply intent", intent.type, "from", from, ex);
        } finally {
            this.currentIntentPlayer = null;
        }
    }

    /**
     * @param {number} from
     * @param {any} intent
     */
    applyValidIntent(from, intent) {
        const root = this.root;
        switch (intent.type) {
            case "place": {
                if (!gMetaBuildingRegistry.hasId(intent.building)) {
                    return;
                }
                const building = gMetaBuildingRegistry.findById(intent.building);
                if (
                    !building.getIsUnlocked(root) ||
                    !building.getAvailableVariants(root).includes(intent.variant)
                ) {
                    return;
                }

                // Same as the building placer: the final rotation depends on the
                // neighbours, which are only up to date on the host
                const tile = new Vector(intent.origin.x, intent.origin.y);
                const { rotation, rotationVariant } =
                    building.computeOptimalDirectionAndRotationVariantAtTile({
                        root,
                        tile,
                        rotation: intent.originalRotation,
                        variant: intent.variant,
                        layer: building.getLayer(),
                    });

                const entity = root.logic.tryPlaceBuilding({
                    origin: tile,
                    rotation,
                    originalRotation: intent.originalRotation,
                    rotationVariant,
                    variant: intent.variant,
                    building,
                });

                if (entity && intent.manual) {
                    // Smart tunnels etc. Dialogs are skipped on the host (see ConstantSignalSystem)
                    root.signals.entityManuallyPlaced.dispatch(entity);
                    if (entity.components.ConstantSignal) {
                        this.followUps.push({ t: MSG.editSignal, to: from, uid: entity.uid });
                    }
                }
                return;
            }

            case "delete": {
                const remove = () => {
                    for (const uid of intent.uids) {
                        const entity = root.entityMgr.findByUid(uid, false);
                        if (entity && entity.components.StaticMapEntity) {
                            root.logic.tryDeleteBuilding(entity);
                        }
                    }
                };
                if (intent.uids.length > 1) {
                    root.logic.performBulkOperation(remove);
                } else {
                    remove();
                }
                return;
            }

            case "pasteBlueprint": {
                if (!root.hubGoals.isRewardUnlocked(enumHubGoalRewards.reward_blueprints)) {
                    return;
                }
                const entities = [];
                for (const payload of intent.entities) {
                    const error = verifyEntityPayload(payload);
                    if (error) {
                        logger.warn("Dropping blueprint with invalid entity:", error);
                        return;
                    }
                    entities.push(createEntityFromPayload(root, payload));
                }
                const blueprint = new Blueprint(entities);
                blueprint.isNextPasteFree = intent.free;
                if (blueprint.canAfford(root)) {
                    blueprint.tryPlace(root, new Vector(intent.tile.x, intent.tile.y));
                }
                return;
            }

            case "upgrade": {
                if (Object.hasOwn(root.gameMode.getUpgrades(), intent.id)) {
                    root.hubGoals.tryUnlockUpgrade(intent.id);
                }
                return;
            }

            case "configure": {
                const entity = root.entityMgr.findByUid(intent.uid, false);
                const component = entity?.components[intent.component];
                if (!component) {
                    return;
                }
                const componentClass = gComponentRegistry.findById(intent.component);
                const error = /** @type {any} */ (componentClass).verify(intent.data);
                if (error) {
                    logger.warn("Invalid configure intent:", error);
                    return;
                }
                component.deserialize(intent.data, root);
                this.markChanged(entity);
                return;
            }

            case "waypoint": {
                const waypoints = root.hud.parts.waypoints;
                if (!waypoints) {
                    return;
                }
                const { op, waypoint } = intent;
                const label = waypoint.label.slice(0, 128);
                if (op === "add") {
                    waypoints.insertWaypoint({
                        label,
                        center: { x: waypoint.center.x, y: waypoint.center.y },
                        zoomLevel: waypoint.zoomLevel,
                        layer: waypoint.layer,
                    });
                    return;
                }
                const existing = waypoints.findWaypoint(waypoint);
                if (!existing) {
                    return;
                }
                if (op === "rename") {
                    existing.label = intent.label.slice(0, 128);
                    waypoints.sortWaypoints();
                    waypoints.rerenderWaypointList();
                    this.markWaypointsChanged();
                } else {
                    waypoints.deleteWaypoint(existing);
                }
                return;
            }

            case "clearItems": {
                const cleared = [];
                for (const uid of intent.uids) {
                    const entity = root.entityMgr.findByUid(uid, false);
                    if (entity) {
                        for (const component of Object.values(entity.components)) {
                            component.clear();
                        }
                        cleared.push(uid);
                    }
                }
                this.broadcastItemsCleared(cleared);
                return;
            }
        }
    }
}
