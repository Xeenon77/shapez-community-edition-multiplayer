import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";

/**
 * Relay server for multiplayer sessions. It runs in the main process of the
 * hosting game and only routes messages: every game decision is made by the
 * host's renderer, which connects to this server like any other peer.
 *
 * Wire format (shared with src/js/multiplayer/protocol.js):
 *  - text frames carry a JSON envelope `{ t: string, to?: number | "all", from?: number, ... }`
 *  - binary frames carry `[u32 BE header length][JSON envelope][payload bytes]`
 *
 * This file has no Electron dependency so it can also run standalone as a relay.
 */

// Must match PROTOCOL_VERSION in src/js/multiplayer/protocol.js
export const PROTOCOL_VERSION = 1;

export const MAX_PLAYERS = 4;

/** Public description of a session, served at GET /info and sent by the LAN beacon */
export interface SessionInfo {
    app: "shapez-multiplayer";
    id: string;
    protocol: number;
    gameVersion: string;
    hostName: string;
    players: number;
    maxPlayers: number;
    hasPassword: boolean;
    port: number;
}
const MAX_HOST_MESSAGE_BYTES = 128 * 1024 * 1024;
const MAX_CLIENT_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_CLIENT_MESSAGES_PER_SECOND = 400;
const HELLO_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_NAME_LENGTH = 24;

/** Messages the server answers itself instead of relaying */
const SERVER_MESSAGE_TYPES = new Set(["hello", "welcome", "reject", "peerJoined", "peerLeft", "playerList"]);

export interface ServerOptions {
    port: number;
    password?: string;
    /** Interface to bind to, defaults to all interfaces */
    bindAddress?: string;
    log?: (...args: unknown[]) => void;
}

interface Peer {
    socket: WebSocket;
    id: number;
    name: string;
    role: "host" | "client";
    alive: boolean;
    messageBudget: number;
    budgetResetAt: number;
}

interface Envelope {
    t: string;
    to?: number | "all";
    from?: number;
    [key: string]: unknown;
}

type Decoded = { envelope: Envelope; payload: Buffer | null };

function sha256(value: string) {
    return createHash("sha256").update(value, "utf8").digest();
}

export function decodeFrame(data: RawData, isBinary: boolean): Decoded | null {
    try {
        const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (!isBinary) {
            const envelope = JSON.parse(buffer.toString("utf8"));
            return isEnvelope(envelope) ? { envelope, payload: null } : null;
        }

        if (buffer.length < 4) {
            return null;
        }
        const headerLength = buffer.readUInt32BE(0);
        if (headerLength > buffer.length - 4) {
            return null;
        }
        const envelope = JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8"));
        return isEnvelope(envelope) ? { envelope, payload: buffer.subarray(4 + headerLength) } : null;
    } catch {
        return null;
    }
}

export function encodeFrame(envelope: Envelope, payload: Buffer | null): string | Buffer {
    if (!payload) {
        return JSON.stringify(envelope);
    }
    const header = Buffer.from(JSON.stringify(envelope), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length, 0);
    return Buffer.concat([length, header, payload]);
}

function isEnvelope(value: unknown): value is Envelope {
    return typeof value === "object" && value !== null && typeof (value as Envelope).t === "string";
}

function sanitizeName(name: unknown, fallback: string) {
    if (typeof name !== "string") {
        return fallback;
    }
    // Strip control characters and markup-relevant characters
    const cleaned = name
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f<>&"'`]/g, "")
        .trim()
        .slice(0, MAX_NAME_LENGTH);
    return cleaned.length > 0 ? cleaned : fallback;
}

export class MultiplayerServer {
    readonly port: number;
    /** Secret the host renderer uses to claim the host role */
    readonly hostToken = randomBytes(24).toString("hex");
    /** Identifies this session in discovery results */
    readonly sessionId = randomBytes(8).toString("hex");

    private readonly passwordHash: Buffer | null;
    private readonly log: (...args: unknown[]) => void;
    private readonly peers = new Map<number, Peer>();
    private wss: WebSocketServer | null = null;
    private httpServer: http.Server | null = null;
    private heartbeat: NodeJS.Timeout | null = null;
    private nextPeerId = 1;
    private host: Peer | null = null;
    private hostGameVersion: string | null = null;

    constructor(private readonly options: ServerOptions) {
        this.port = options.port;
        this.passwordHash = options.password ? sha256(options.password) : null;
        this.log = options.log ?? ((...args) => console.log("[mp-server]", ...args));
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            // Plain HTTP only answers GET /info, which lets other games find this session
            const httpServer = http.createServer((request, response) => {
                const info = this.getInfo();
                if (request.method === "GET" && request.url === "/info" && info) {
                    response.writeHead(200, { "content-type": "application/json" });
                    response.end(JSON.stringify(info));
                } else {
                    response.writeHead(426, { "content-type": "text/plain" });
                    response.end("This is a shapez multiplayer server");
                }
            });

            const wss = new WebSocketServer({
                server: httpServer,
                maxPayload: MAX_HOST_MESSAGE_BYTES,
                perMessageDeflate: false,
            });
            wss.on("connection", (socket, request) => this.handleConnection(socket, request));
            wss.on("error", err => this.log("server error", err));

            httpServer.once("error", reject);
            httpServer.listen(this.port, this.options.bindAddress, () => {
                httpServer.off("error", reject);
                httpServer.on("error", err => this.log("http error", err));
                this.log("listening on port", this.port);
                this.httpServer = httpServer;
                this.wss = wss;
                this.heartbeat = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
                resolve();
            });
        });
    }

    async stop() {
        if (this.heartbeat) {
            clearInterval(this.heartbeat);
            this.heartbeat = null;
        }

        for (const peer of this.peers.values()) {
            this.sendTo(peer, { t: "bye", reason: "server-stopped" });
            peer.socket.close(1001, "server stopped");
        }
        this.peers.clear();
        this.host = null;

        const wss = this.wss;
        const httpServer = this.httpServer;
        this.wss = null;
        this.httpServer = null;
        if (wss) {
            await new Promise<void>(resolve => wss.close(() => resolve()));
        }
        if (httpServer) {
            httpServer.closeAllConnections();
            await new Promise<void>(resolve => httpServer.close(() => resolve()));
        }
        this.log("stopped");
    }

    get isRunning() {
        return this.wss !== null;
    }

    /**
     * Describes the session, or returns null while the host has not joined yet
     */
    getInfo(): SessionInfo | null {
        if (!this.host || !this.isRunning) {
            return null;
        }
        return {
            app: "shapez-multiplayer",
            id: this.sessionId,
            protocol: PROTOCOL_VERSION,
            gameVersion: this.hostGameVersion ?? "",
            hostName: this.host.name,
            players: this.peers.size,
            maxPlayers: MAX_PLAYERS,
            hasPassword: this.passwordHash !== null,
            port: this.port,
        };
    }

    private handleConnection(socket: WebSocket, request: IncomingMessage) {
        const remote = request.socket.remoteAddress ?? "unknown";
        let peer: Peer | null = null;

        const helloTimeout = setTimeout(() => {
            if (!peer) {
                socket.close(4000, "hello timeout");
            }
        }, HELLO_TIMEOUT_MS);

        socket.on("message", (data, isBinary) => {
            const size = Array.isArray(data)
                ? data.reduce((sum, chunk) => sum + chunk.length, 0)
                : (data as Buffer).length;

            if (!peer) {
                if (size > 64 * 1024) {
                    socket.close(1009, "hello too large");
                    return;
                }
                const decoded = decodeFrame(data, isBinary);
                if (!decoded || decoded.envelope.t !== "hello") {
                    socket.close(4001, "expected hello");
                    return;
                }
                peer = this.handleHello(socket, decoded.envelope, remote);
                if (peer) {
                    clearTimeout(helloTimeout);
                }
                return;
            }

            if (peer.role === "client" && size > MAX_CLIENT_MESSAGE_BYTES) {
                this.log("dropping oversized message from", peer.id, size);
                return;
            }

            if (peer.role === "client" && !this.consumeBudget(peer)) {
                this.log("rate limit exceeded by", peer.id);
                this.sendTo(peer, { t: "bye", reason: "rate-limited" });
                socket.close(4008, "rate limited");
                return;
            }

            const decoded = decodeFrame(data, isBinary);
            if (!decoded) {
                return;
            }
            this.route(peer, decoded);
        });

        socket.on("pong", () => {
            if (peer) {
                peer.alive = true;
            }
        });

        socket.on("close", () => {
            clearTimeout(helloTimeout);
            if (peer) {
                this.handleDisconnect(peer);
            }
        });

        socket.on("error", err => this.log("socket error", remote, err.message));
    }

    private reject(socket: WebSocket, reason: string) {
        socket.send(JSON.stringify({ t: "reject", reason }));
        socket.close(4003, reason);
    }

    private handleHello(socket: WebSocket, hello: Envelope, remote: string): Peer | null {
        if (hello.protocol !== PROTOCOL_VERSION) {
            this.reject(socket, "protocol-mismatch");
            return null;
        }

        const wantsHost = hello.role === "host";
        if (wantsHost) {
            const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
            const token = typeof hello.hostToken === "string" ? hello.hostToken : "";
            const tokenOk =
                token.length === this.hostToken.length &&
                timingSafeEqual(Buffer.from(token), Buffer.from(this.hostToken));
            if (!isLoopback || !tokenOk || this.host) {
                this.reject(socket, "host-denied");
                return null;
            }
            this.hostGameVersion = String(hello.gameVersion ?? "");
        } else {
            if (!this.host) {
                this.reject(socket, "host-not-ready");
                return null;
            }
            if (String(hello.gameVersion ?? "") !== this.hostGameVersion) {
                this.reject(socket, "version-mismatch");
                return null;
            }
            if (this.passwordHash) {
                const given = sha256(typeof hello.password === "string" ? hello.password : "");
                if (!timingSafeEqual(given, this.passwordHash)) {
                    this.reject(socket, "wrong-password");
                    return null;
                }
            }
            if (this.peers.size >= MAX_PLAYERS) {
                this.reject(socket, "session-full");
                return null;
            }
        }

        const id = this.nextPeerId++;
        const peer: Peer = {
            socket,
            id,
            name: sanitizeName(hello.name, wantsHost ? "Host" : "Player " + id),
            role: wantsHost ? "host" : "client",
            alive: true,
            messageBudget: MAX_CLIENT_MESSAGES_PER_SECOND,
            budgetResetAt: Date.now() + 1000,
        };
        this.peers.set(id, peer);
        if (wantsHost) {
            this.host = peer;
        }

        this.log("peer joined", id, peer.name, peer.role, remote);

        this.sendTo(peer, {
            t: "welcome",
            playerId: id,
            hostId: this.host!.id,
            players: this.getPlayerList(),
        });

        if (!wantsHost) {
            this.sendTo(this.host!, { t: "peerJoined", playerId: id, name: peer.name });
        }
        this.broadcastPlayerList();
        return peer;
    }

    private handleDisconnect(peer: Peer) {
        if (!this.peers.has(peer.id)) {
            return;
        }
        this.peers.delete(peer.id);
        this.log("peer left", peer.id, peer.name);

        if (peer === this.host) {
            this.host = null;
            for (const other of this.peers.values()) {
                this.sendTo(other, { t: "bye", reason: "host-left" });
                other.socket.close(1001, "host left");
            }
            this.peers.clear();
            return;
        }

        if (this.host) {
            this.sendTo(this.host, { t: "peerLeft", playerId: peer.id });
        }
        this.broadcastPlayerList();
    }

    private route(sender: Peer, { envelope, payload }: Decoded) {
        if (SERVER_MESSAGE_TYPES.has(envelope.t)) {
            return;
        }

        envelope.from = sender.id;

        if (sender.role === "client") {
            // Presence is not authoritative, so it skips the host round-trip
            if (envelope.t === "cursor") {
                delete envelope.to;
                const frame = encodeFrame(envelope, payload);
                for (const peer of this.peers.values()) {
                    if (peer !== sender) {
                        this.sendRaw(peer, frame);
                    }
                }
                return;
            }

            if (this.host) {
                delete envelope.to;
                this.sendRaw(this.host, encodeFrame(envelope, payload));
            }
            return;
        }

        // Host messages go to one client or to everyone else
        const target = envelope.to;
        delete envelope.to;
        const frame = encodeFrame(envelope, payload);
        if (typeof target === "number") {
            const peer = this.peers.get(target);
            if (peer && peer !== sender) {
                this.sendRaw(peer, frame);
            }
            return;
        }
        for (const peer of this.peers.values()) {
            if (peer !== sender) {
                this.sendRaw(peer, frame);
            }
        }
    }

    private consumeBudget(peer: Peer) {
        const now = Date.now();
        if (now >= peer.budgetResetAt) {
            peer.budgetResetAt = now + 1000;
            peer.messageBudget = MAX_CLIENT_MESSAGES_PER_SECOND;
        }
        return --peer.messageBudget >= 0;
    }

    private checkHeartbeats() {
        for (const peer of this.peers.values()) {
            if (!peer.alive) {
                this.log("peer timed out", peer.id);
                peer.socket.terminate();
                continue;
            }
            peer.alive = false;
            peer.socket.ping();
        }
    }

    private getPlayerList() {
        return [...this.peers.values()].map(peer => ({
            id: peer.id,
            name: peer.name,
            role: peer.role,
        }));
    }

    private broadcastPlayerList() {
        const frame = JSON.stringify({ t: "playerList", players: this.getPlayerList() });
        for (const peer of this.peers.values()) {
            this.sendRaw(peer, frame);
        }
    }

    private sendTo(peer: Peer, envelope: Envelope) {
        this.sendRaw(peer, JSON.stringify(envelope));
    }

    private sendRaw(peer: Peer, frame: string | Buffer) {
        if (peer.socket.readyState === WebSocket.OPEN) {
            peer.socket.send(frame);
        }
    }
}
