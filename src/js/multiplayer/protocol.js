/**
 * Multiplayer wire protocol, shared by host and clients.
 *
 * Text frames carry a JSON envelope `{ t: string, to?: number | "all", from?: number, ... }`.
 * Binary frames carry `[u32 BE header length][JSON envelope][payload bytes]`, used for
 * compressed snapshots. The relay server (electron/src/multiplayer/server.ts) uses the
 * same format and only routes messages.
 */

// Must match PROTOCOL_VERSION in electron/src/multiplayer/server.ts
export const PROTOCOL_VERSION = 1;

export const DEFAULT_PORT = 24680;

/** Message types */
export const MSG = {
    // Handshake and session (answered by the relay server)
    hello: "hello",
    welcome: "welcome",
    reject: "reject",
    playerList: "playerList",
    peerJoined: "peerJoined",
    peerLeft: "peerLeft",
    bye: "bye",

    // Host -> clients
    snapshot: "snapshot",
    delta: "delta",
    hubState: "hubState",
    checksum: "checksum",
    resync: "resync",
    tickRate: "tickRate",
    waypoints: "waypoints",
    clearItems: "clearItems",
    editSignal: "editSignal",

    // Clients -> host
    intent: "intent",
    resyncRequest: "resyncRequest",

    // Everyone -> everyone (presence)
    cursor: "cursor",
};

/** Human readable texts for rejection and disconnect reasons */
export const REASON_TEXTS = {
    "protocol-mismatch": "The host runs a different multiplayer protocol version.",
    "version-mismatch": "The host runs a different game version.",
    "wrong-password": "Wrong password.",
    "session-full": "The session is full.",
    "host-not-ready": "The host is not ready yet.",
    "host-denied": "Could not claim the host role.",
    "host-left": "The host left the game.",
    "server-stopped": "The host stopped the session.",
    "rate-limited": "Too many messages, you got disconnected.",
    "connection-lost": "The connection to the host was lost.",
    "connection-failed": "Could not connect to the host.",
};

/**
 * @param {string} reason
 */
export function describeReason(reason) {
    return REASON_TEXTS[reason] || reason;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encodes an envelope and optional binary payload into a WebSocket frame
 * @param {object} envelope
 * @param {Uint8Array=} payload
 * @returns {string|ArrayBuffer}
 */
export function encodeFrame(envelope, payload = null) {
    if (!payload) {
        return JSON.stringify(envelope);
    }
    const header = textEncoder.encode(JSON.stringify(envelope));
    const buffer = new Uint8Array(4 + header.length + payload.length);
    new DataView(buffer.buffer).setUint32(0, header.length, false);
    buffer.set(header, 4);
    buffer.set(payload, 4 + header.length);
    return buffer.buffer;
}

/**
 * Decodes a WebSocket frame
 * @param {string|ArrayBuffer} data
 * @returns {{ envelope: any, payload: Uint8Array|null }|null}
 */
export function decodeFrame(data) {
    try {
        if (typeof data === "string") {
            const envelope = JSON.parse(data);
            return isEnvelope(envelope) ? { envelope, payload: null } : null;
        }

        const bytes = new Uint8Array(data);
        if (bytes.length < 4) {
            return null;
        }
        const headerLength = new DataView(data).getUint32(0, false);
        if (headerLength > bytes.length - 4) {
            return null;
        }
        const envelope = JSON.parse(textDecoder.decode(bytes.subarray(4, 4 + headerLength)));
        // Copy so the payload owns its buffer (needed to transfer it to a worker)
        const payload = bytes.slice(4 + headerLength);
        return isEnvelope(envelope) ? { envelope, payload } : null;
    } catch (ex) {
        return null;
    }
}

function isEnvelope(value) {
    return typeof value === "object" && value !== null && typeof value.t === "string";
}

////////// Intent validation //////////

const MAX_UIDS_PER_INTENT = 100000;
const MAX_BLUEPRINT_ENTITIES = 50000;
const MAX_COORDINATE = 1e7;

/** Components a client may configure on an existing entity */
export const CONFIGURABLE_COMPONENTS = ["Lever", "ConstantSignal"];

const isInt = value => Number.isInteger(value);
const isString = (value, maxLength = 128) => typeof value === "string" && value.length <= maxLength;
const isRotation = value => [0, 90, 180, 270].includes(value);
const isTile = value =>
    typeof value === "object" &&
    value !== null &&
    isInt(value.x) &&
    isInt(value.y) &&
    Math.abs(value.x) < MAX_COORDINATE &&
    Math.abs(value.y) < MAX_COORDINATE;
const isUid = value => isInt(value) && value >= 0;
const isUidList = value => Array.isArray(value) && value.length <= MAX_UIDS_PER_INTENT && value.every(isUid);
const isWaypoint = value =>
    typeof value === "object" &&
    value !== null &&
    isString(value.label) &&
    value.label.length > 0 &&
    typeof value.center === "object" &&
    value.center !== null &&
    Number.isFinite(value.center.x) &&
    Number.isFinite(value.center.y) &&
    ["regular", "wires"].includes(value.layer);
const isSerializedEntity = value =>
    typeof value === "object" &&
    value !== null &&
    typeof value.components === "object" &&
    value.components !== null &&
    typeof value.components.StaticMapEntity === "object" &&
    value.components.StaticMapEntity !== null;

/**
 * Validators for every intent type. Intents that are not listed here are dropped.
 * @type {Record<string, (intent: any) => boolean>}
 */
const INTENT_VALIDATORS = {
    place: i =>
        isString(i.building) &&
        isString(i.variant) &&
        isTile(i.origin) &&
        isRotation(i.originalRotation) &&
        typeof i.manual === "boolean",

    delete: i => isUidList(i.uids),

    pasteBlueprint: i =>
        isTile(i.tile) &&
        typeof i.free === "boolean" &&
        Array.isArray(i.entities) &&
        i.entities.length > 0 &&
        i.entities.length <= MAX_BLUEPRINT_ENTITIES &&
        i.entities.every(isSerializedEntity),

    upgrade: i => isString(i.id),

    configure: i =>
        isUid(i.uid) &&
        CONFIGURABLE_COMPONENTS.includes(i.component) &&
        typeof i.data === "object" &&
        i.data !== null,

    clearItems: i => isUidList(i.uids),

    waypoint: i =>
        ["add", "rename", "delete"].includes(i.op) &&
        isWaypoint(i.waypoint) &&
        (i.op !== "add" || (Number.isFinite(i.waypoint.zoomLevel) && i.waypoint.zoomLevel > 0)) &&
        (i.op !== "rename" || (isString(i.label) && i.label.length > 0)),
};

/**
 * Returns whether the given intent has an allowed shape
 * @param {any} intent
 */
export function isValidIntent(intent) {
    if (typeof intent !== "object" || intent === null || typeof intent.type !== "string") {
        return false;
    }
    if (!Object.hasOwn(INTENT_VALIDATORS, intent.type)) {
        return false;
    }
    try {
        return INTENT_VALIDATORS[intent.type](intent) === true;
    } catch {
        return false;
    }
}
