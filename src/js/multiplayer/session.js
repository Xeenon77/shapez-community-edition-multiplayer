import { Logger } from "../core/logging";
import { Signal } from "../core/signal";
import { MultiplayerConnection } from "./connection";
import { DEFAULT_PORT, MSG } from "./protocol";

/**
 * @typedef {import("../game/root").GameRoot} GameRoot
 * @typedef {import("../game/entity").Entity} Entity
 * @typedef {import("./connection").PlayerInfo} PlayerInfo
 * @typedef {import("./host_authority").HostAuthority} HostAuthority
 * @typedef {import("./client_applier").ClientApplier} ClientApplier
 * @typedef {"none"|"host"|"client"} SessionRole
 * @typedef {"offline"|"connected"|"reconnecting"|"disconnected"} SessionStatus
 * @typedef {{ building: string, variant: string, rotation: number } | { blueprint: number } | null} CursorSelection
 * @typedef {{
 *   samples: { t: number, x: number, y: number }[],
 *   layer: string,
 *   selection: CursorSelection,
 *   stopped: boolean,
 *   receivedAt: number,
 * }} RemoteCursor
 */

const logger = new Logger("mp/session");

const CURSOR_INTERVAL_MS = 50;
const CURSOR_SAMPLES_KEPT = 12;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];

/** Disconnect reasons after which reconnecting makes no sense */
const FATAL_REASONS = [
    "host-left",
    "server-stopped",
    "rate-limited",
    "wrong-password",
    "version-mismatch",
    "protocol-mismatch",
    "session-full",
];

/**
 * Parses "host", "host:port" or "[ipv6]:port" into a WebSocket url
 * @param {string} address
 */
export function addressToUrl(address) {
    const { host, port } = parseAddress(address);
    return "ws://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + port;
}

/**
 * Splits "host", "host:port" or "[ipv6]:port" into host and port
 * @param {string} address
 * @returns {{ host: string, port: number }}
 */
export function parseAddress(address) {
    const trimmed = address.trim();
    let host = trimmed;
    let port = DEFAULT_PORT;

    const ipv6 = trimmed.match(/^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/);
    const plain = trimmed.match(/^([^:\s/]+)(?::(\d+))?$/);
    if (ipv6) {
        host = ipv6[1];
        port = ipv6[2] ? Number(ipv6[2]) : port;
    } else if (plain) {
        host = plain[1];
        port = plain[2] ? Number(plain[2]) : port;
    } else {
        throw new Error("Invalid address: " + address);
    }

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Invalid port in address: " + address);
    }
    return { host, port };
}

/**
 * Checks the selection another player sent with their cursor
 * @param {any} sel
 * @returns {CursorSelection}
 */
function sanitizeSelection(sel) {
    if (!sel || typeof sel !== "object") {
        return null;
    }
    if (Number.isInteger(sel.blueprint)) {
        return { blueprint: sel.blueprint };
    }
    if (
        typeof sel.building === "string" &&
        sel.building.length < 64 &&
        typeof sel.variant === "string" &&
        sel.variant.length < 64 &&
        [0, 90, 180, 270].includes(sel.rotation)
    ) {
        return { building: sel.building, variant: sel.variant, rotation: sel.rotation };
    }
    return null;
}

/**
 * Holds the state of the current multiplayer session (if any). There is at
 * most one session at a time, bound to the GameRoot of the running game.
 *
 * Game code imports this module for the intercepts, so it must not import
 * game code itself (the build forbids circular imports). The host and client
 * logic classes are passed in by the UI instead.
 */
export class MultiplayerSession {
    constructor() {
        this.reset();

        this.signals = {
            /** Player list, role or status changed */
            changed: /** @type {Signal<[]>} */ (new Signal()),
            /** Connection is gone for good (clients only) */
            disconnected: /** @type {Signal<[string]>} */ (new Signal()),
        };
    }

    reset() {
        /** @type {SessionRole} */
        this.role = "none";

        /** @type {SessionStatus} */
        this.status = "offline";

        /** @type {MultiplayerConnection|null} */
        this.connection = null;

        this.playerId = 0;
        this.hostId = 0;
        this.playerName = "";

        /** @type {PlayerInfo[]} */
        this.players = [];

        /** @type {GameRoot|null} */
        this.root = null;

        /** @type {HostAuthority|null} */
        this.host = null;

        /** @type {ClientApplier|null} */
        this.client = null;

        /** Set while network state is applied, so the client intercepts let changes through */
        this.applyingRemote = false;

        /** @type {Map<number, RemoteCursor>} */
        this.remoteCursors = new Map();

        /** @type {object[]} */
        this.pendingIntents = [];
        this.intentFlushScheduled = false;

        /** @type {{ port: number, addresses: { address: string, kind: string, interface: string }[], hasPassword: boolean }|null} */
        this.hostInfo = null;

        /** @type {{ url: string, name: string, password: string }|null} */
        this.joinParams = null;

        this.lastCursorSent = 0;
        this.lastCursorKey = "";
        this.cursorStopSent = true;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
    }

    ////////// Queries used by the game code //////////

    /**
     * Whether the given game takes part in a session
     * @param {GameRoot} root
     */
    isActive(root) {
        return this.role !== "none" && this.root === root;
    }

    /**
     * Whether the given game is a multiplayer client
     * @param {GameRoot} root
     */
    isClient(root) {
        return this.role === "client" && this.root === root;
    }

    /**
     * Whether actions in the given game have to be sent to the host instead of
     * being applied locally
     * @param {GameRoot} root
     */
    interceptsActions(root) {
        return this.isClient(root) && !this.applyingRemote;
    }

    /**
     * @param {GameRoot} root
     */
    isHost(root) {
        return this.role === "host" && this.root === root;
    }

    /**
     * Runs the given function with intercepts disabled
     * @template T
     * @param {() => T} fn
     * @returns {T}
     */
    withApplying(fn) {
        const before = this.applyingRemote;
        this.applyingRemote = true;
        try {
            return fn();
        } finally {
            this.applyingRemote = before;
        }
    }

    ////////// Hooks called by the game code //////////

    /**
     * Queues an intent for the host. Intents of the same frame are sent together.
     * @param {object} intent
     */
    sendIntent(intent) {
        this.pendingIntents.push(intent);
        if (!this.intentFlushScheduled) {
            this.intentFlushScheduled = true;
            queueMicrotask(() => this.flushIntents());
        }
    }

    /**
     * Asks the host to delete a building. Deletes of the same frame share one intent.
     * @param {number} uid
     */
    requestDelete(uid) {
        if (!this.client || this.client.hasPendingDelete(uid)) {
            return;
        }
        this.client.addPendingDelete(uid);

        const last = this.pendingIntents[this.pendingIntents.length - 1];
        if (last && last.type === "delete") {
            last.uids.push(uid);
        } else {
            this.sendIntent({ type: "delete", uids: [uid] });
        }
    }

    flushIntents() {
        this.intentFlushScheduled = false;
        if (this.pendingIntents.length === 0) {
            return;
        }
        const intents = this.pendingIntents;
        this.pendingIntents = [];
        if (!this.connection || !this.connection.send({ t: MSG.intent, intents })) {
            logger.warn("Dropping", intents.length, "intents, not connected");
        }
    }

    /**
     * Called when the user changed the configuration of an entity (lever, signal) on the host
     * @param {GameRoot} root
     * @param {Entity} entity
     */
    notifyEntityConfigChanged(root, entity) {
        if (this.isHost(root)) {
            this.host.markChanged(entity);
        }
    }

    /**
     * Called when the shared markers changed on the host
     * @param {GameRoot} root
     */
    notifyWaypointsChanged(root) {
        if (this.isHost(root)) {
            this.host.markWaypointsChanged();
        }
    }

    /**
     * Called when items got cleared from buildings on the host
     * @param {GameRoot} root
     * @param {number[]} uids
     */
    notifyItemsCleared(root, uids) {
        if (this.isHost(root)) {
            this.host.broadcastItemsCleared(uids);
        }
    }

    ////////// Hosting //////////

    /**
     * Starts the relay server and joins it as host
     * @param {GameRoot} root
     * @param {{ port: number, password: string, name: string }} options
     * @param {new (root: GameRoot, session: MultiplayerSession) => HostAuthority} HostAuthorityClass
     */
    async startHosting(root, { port, password, name }, HostAuthorityClass) {
        if (this.role !== "none") {
            throw new Error("Already in a session");
        }

        const info = await ipcRenderer.invoke("mp-host-start", port, password);
        const connection = new MultiplayerConnection("ws://127.0.0.1:" + port, {
            role: "host",
            hostToken: info.hostToken,
            name,
        });

        let welcome;
        try {
            welcome = await connection.connect();
        } catch (ex) {
            await ipcRenderer.invoke("mp-host-stop");
            throw ex;
        }

        this.role = "host";
        this.status = "connected";
        this.root = root;
        this.connection = connection;
        this.playerName = name;
        this.applyWelcome(welcome);
        this.hostInfo = { port, addresses: info.addresses, hasPassword: !!password };
        this.host = new HostAuthorityClass(root, this);

        connection.signals.message.add(this.onMessage, this);
        connection.signals.closed.add(reason => {
            logger.error("Host lost its own relay connection:", reason);
            this.stop();
            root.hud?.parts.dialogs?.showWarning(
                "Multiplayer stopped",
                "The multiplayer session ended unexpectedly. Your game keeps running in single-player."
            );
        });

        logger.log("Hosting on port", port);
        this.signals.changed.dispatch();
    }

    ////////// Joining //////////

    /**
     * Connects to a host and waits for the world snapshot
     * @param {{ address: string, name: string, password: string }} options
     * @param {new (session: MultiplayerSession) => ClientApplier} ClientApplierClass
     * @returns {Promise<{ dump: any, gameModeId: string }>}
     */
    async join({ address, name, password }, ClientApplierClass) {
        if (this.role !== "none") {
            this.stop();
        }

        const url = addressToUrl(address);
        const connection = new MultiplayerConnection(url, { role: "client", name, password });
        const welcome = await connection.connect();

        this.role = "client";
        this.status = "connected";
        this.connection = connection;
        this.playerName = name;
        this.joinParams = { url, name, password };
        this.applyWelcome(welcome);
        this.client = new ClientApplierClass(this);

        connection.signals.message.add(this.onMessage, this);
        connection.signals.closed.add(this.onClientConnectionClosed, this);
        this.signals.changed.dispatch();

        try {
            return await this.client.waitForInitialSnapshot();
        } catch (ex) {
            this.stop();
            throw ex;
        }
    }

    /**
     * @param {string} reason
     */
    onClientConnectionClosed(reason) {
        logger.warn("Connection closed:", reason);
        this.connection = null;
        this.remoteCursors.clear();

        if (FATAL_REASONS.includes(reason) || this.reconnectAttempt >= RECONNECT_DELAYS_MS.length) {
            this.status = "disconnected";
            this.signals.changed.dispatch();
            this.signals.disconnected.dispatch(reason);
            return;
        }

        this.status = "reconnecting";
        this.signals.changed.dispatch();
        const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt++];
        this.reconnectTimer = setTimeout(() => this.tryReconnect(), delay);
    }

    async tryReconnect() {
        this.reconnectTimer = null;
        if (this.role !== "client" || !this.joinParams) {
            return;
        }

        const { url, name, password } = this.joinParams;
        const connection = new MultiplayerConnection(url, { role: "client", name, password });
        try {
            const welcome = await connection.connect();
            if (this.role !== "client") {
                // Left in the meantime
                connection.close();
                return;
            }
            logger.log("Reconnected as player", welcome.playerId);
            this.connection = connection;
            this.status = "connected";
            this.reconnectAttempt = 0;
            this.applyWelcome(welcome);

            // The host sends a fresh snapshot to every joining peer, which the
            // client applies as a full resync
            this.client.onReconnected();

            connection.signals.message.add(this.onMessage, this);
            connection.signals.closed.add(this.onClientConnectionClosed, this);
            this.signals.changed.dispatch();
        } catch (ex) {
            if (this.role === "client") {
                this.onClientConnectionClosed(ex.message || "connection-failed");
            }
        }
    }

    ////////// Common //////////

    /**
     * @param {import("./connection").WelcomeMessage} welcome
     */
    applyWelcome(welcome) {
        this.playerId = welcome.playerId;
        this.hostId = welcome.hostId;
        this.players = welcome.players;
    }

    /**
     * Sends a message through the relay
     * @param {object} envelope
     * @param {Uint8Array=} payload
     */
    send(envelope, payload = null) {
        return this.connection ? this.connection.send(envelope, payload) : false;
    }

    /**
     * Binds the session to the root of the game that just started (client) or
     * checks the root of the hosted game
     * @param {GameRoot} root
     */
    attachRoot(root) {
        if (this.role === "client" && this.client && !this.root) {
            this.root = root;
            this.client.attach(root);
        }
    }

    /**
     * Called when a game gets destroyed
     * @param {GameRoot} root
     */
    detachRoot(root) {
        if (this.root === root) {
            this.stop();
        }
    }

    /**
     * Ends the session (stops hosting, or leaves the host)
     */
    stop() {
        if (this.role === "none") {
            return;
        }
        logger.log("Leaving session, role was", this.role);

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        this.flushIntents();
        this.host?.cleanup();
        this.client?.cleanup();
        this.connection?.close();

        const wasHost = this.role === "host";
        this.reset();
        if (wasHost) {
            ipcRenderer.invoke("mp-host-stop").catch(err => logger.warn("Failed to stop server:", err));
        }
        this.signals.changed.dispatch();
    }

    /**
     * @param {any} envelope
     * @param {Uint8Array|null} payload
     */
    onMessage(envelope, payload) {
        switch (envelope.t) {
            case MSG.playerList: {
                if (Array.isArray(envelope.players)) {
                    this.players = envelope.players;
                    const ids = new Set(this.players.map(p => p.id));
                    for (const id of this.remoteCursors.keys()) {
                        if (!ids.has(id)) {
                            this.remoteCursors.delete(id);
                        }
                    }
                    this.signals.changed.dispatch();
                }
                return;
            }

            case MSG.cursor: {
                if (
                    typeof envelope.from === "number" &&
                    Number.isFinite(envelope.x) &&
                    Number.isFinite(envelope.y)
                ) {
                    const now = performance.now();
                    const cursor = this.remoteCursors.get(envelope.from) || {
                        samples: [],
                        layer: "regular",
                        selection: null,
                        stopped: true,
                        receivedAt: now,
                    };
                    cursor.samples.push({ t: now, x: envelope.x, y: envelope.y });
                    if (cursor.samples.length > CURSOR_SAMPLES_KEPT) {
                        cursor.samples.shift();
                    }
                    cursor.layer = envelope.layer === "wires" ? "wires" : "regular";
                    cursor.selection = sanitizeSelection(envelope.sel);
                    cursor.stopped = envelope.stop === true;
                    cursor.receivedAt = now;
                    this.remoteCursors.set(envelope.from, cursor);
                }
                return;
            }

            case MSG.bye:
                // The closed handler takes care of it
                return;
        }

        if (this.role === "host") {
            this.host?.onMessage(envelope, payload);
        } else if (this.role === "client") {
            this.client?.onMessage(envelope, payload);
        }
    }

    /**
     * Called once per frame by the multiplayer HUD part
     * @param {GameRoot} root
     */
    update(root) {
        if (!this.isActive(root)) {
            return;
        }
        this.host?.update();
        this.client?.update();
        this.sendCursor(root);
    }

    /**
     * @param {GameRoot} root
     */
    sendCursor(root) {
        const now = performance.now();
        if (now - this.lastCursorSent < CURSOR_INTERVAL_MS || this.status !== "connected") {
            return;
        }
        const mouse = root.app.mousePosition;
        if (!mouse) {
            return;
        }
        const world = root.camera.screenToWorld(mouse);
        const x = Math.round(world.x);
        const y = Math.round(world.y);
        const layer = root.currentLayer;
        const sel = this.getCursorSelection(root);
        const key = x + "/" + y + "/" + layer + "/" + JSON.stringify(sel);
        if (key === this.lastCursorKey) {
            // Tell the others once that the cursor stopped, so they stop predicting its motion
            if (!this.cursorStopSent) {
                this.cursorStopSent = true;
                this.lastCursorSent = now;
                this.send({ t: MSG.cursor, to: "all", x, y, layer, sel, stop: true });
            }
            return;
        }
        this.lastCursorKey = key;
        this.lastCursorSent = now;
        this.cursorStopSent = false;
        this.send({ t: MSG.cursor, to: "all", x, y, layer, sel });
    }

    /**
     * What the local player holds in their hand, shown next to their cursor for the others
     * @param {GameRoot} root
     * @returns {CursorSelection}
     */
    getCursorSelection(root) {
        const blueprint = root.hud.parts.blueprintPlacer?.currentBlueprint.get();
        if (blueprint) {
            return { blueprint: blueprint.getCost() };
        }
        const placer = root.hud.parts.buildingPlacer;
        const building = placer?.currentMetaBuilding.get();
        if (building) {
            return {
                building: building.getId(),
                variant: placer.currentVariant.get(),
                rotation: placer.currentBaseRotation,
            };
        }
        return null;
    }

    /**
     * @param {number} playerId
     */
    getPlayer(playerId) {
        return this.players.find(p => p.id === playerId) || null;
    }
}

export const MP = new MultiplayerSession();

// Handy for debugging and for the automated multiplayer tests
/** @type {any} */ (window).shapezMultiplayer = MP;
