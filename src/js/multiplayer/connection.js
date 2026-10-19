import { Logger } from "../core/logging";
import { Signal } from "../core/signal";
import { decodeFrame, encodeFrame, MSG, PROTOCOL_VERSION } from "./protocol";

const logger = new Logger("mp/connection");

const CONNECT_TIMEOUT_MS = 10000;

/**
 * @typedef {{ id: number, name: string, role: "host"|"client" }} PlayerInfo
 * @typedef {{ t: "welcome", playerId: number, hostId: number, players: PlayerInfo[] }} WelcomeMessage
 */

/**
 * A single WebSocket connection to the relay server. Reconnecting is done by
 * the session, which creates a new connection.
 */
export class MultiplayerConnection {
    /**
     * @param {string} url ws:// url of the relay server
     * @param {object} hello Fields sent with the hello message
     */
    constructor(url, hello) {
        this.url = url;
        this.hello = hello;

        /** @type {WebSocket|null} */
        this.socket = null;

        this.closedByUs = false;
        this.isOpen = false;

        /** Last reason the server gave in a bye or reject message */
        this.closeReason = null;

        this.signals = {
            message: /** @type {Signal<[any, Uint8Array|null]>} */ (new Signal()),
            closed: /** @type {Signal<[string]>} */ (new Signal()),
        };
    }

    /**
     * Opens the connection and performs the handshake
     * @returns {Promise<WelcomeMessage>}
     */
    connect() {
        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = reason => {
                if (!settled) {
                    settled = true;
                    reject(new Error(reason));
                }
            };

            let socket;
            try {
                socket = new WebSocket(this.url);
            } catch (ex) {
                fail("connection-failed");
                return;
            }
            socket.binaryType = "arraybuffer";
            this.socket = socket;

            const timeout = setTimeout(() => {
                fail("connection-failed");
                socket.close();
            }, CONNECT_TIMEOUT_MS);

            socket.addEventListener("open", () => {
                this.send({
                    t: MSG.hello,
                    protocol: PROTOCOL_VERSION,
                    gameVersion: G_BUILD_VERSION,
                    ...this.hello,
                });
            });

            socket.addEventListener("message", ev => {
                const decoded = decodeFrame(ev.data);
                if (!decoded) {
                    logger.warn("Dropping malformed frame");
                    return;
                }
                const { envelope, payload } = decoded;

                if (!settled) {
                    if (envelope.t === MSG.welcome) {
                        settled = true;
                        clearTimeout(timeout);
                        this.isOpen = true;
                        resolve(envelope);
                    } else if (envelope.t === MSG.reject) {
                        clearTimeout(timeout);
                        this.closeReason = String(envelope.reason);
                        fail(this.closeReason);
                    }
                    return;
                }

                if (envelope.t === MSG.bye) {
                    this.closeReason = String(envelope.reason);
                }
                this.signals.message.dispatch(envelope, payload);
            });

            socket.addEventListener("close", () => {
                clearTimeout(timeout);
                const wasOpen = this.isOpen;
                this.isOpen = false;
                if (!settled) {
                    fail(this.closeReason || "connection-failed");
                    return;
                }
                if (wasOpen) {
                    this.signals.closed.dispatch(this.closeReason || "connection-lost");
                }
            });

            socket.addEventListener("error", () => {
                // A close event always follows, which handles everything
                logger.warn("Socket error on", this.url);
            });
        });
    }

    /**
     * Sends a message
     * @param {object} envelope
     * @param {Uint8Array=} payload
     */
    send(envelope, payload = null) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return false;
        }
        this.socket.send(encodeFrame(envelope, payload));
        return true;
    }

    /**
     * Amount of bytes queued but not sent yet
     */
    getBufferedAmount() {
        return this.socket ? this.socket.bufferedAmount : 0;
    }

    close() {
        this.closedByUs = true;
        this.isOpen = false;
        this.signals.closed.removeAll();
        this.signals.message.removeAll();
        if (this.socket) {
            this.socket.close(1000, "bye");
            this.socket = null;
        }
    }
}
