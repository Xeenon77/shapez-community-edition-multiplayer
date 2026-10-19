import { execFile } from "node:child_process";
import dgram from "node:dgram";
import os from "node:os";
import { PROTOCOL_VERSION, type SessionInfo } from "./server.js";

/**
 * Finds multiplayer sessions without typing addresses:
 *  - on the local network, hosts broadcast a small UDP beacon every second;
 *  - on a tailnet (no broadcasts there), the listener asks the Tailscale client
 *    for online peers and probes them at GET /info on the default port.
 */

export const DISCOVERY_PORT = 24681;
const DEFAULT_GAME_PORT = 24680;

const BEACON_INTERVAL_MS = 1000;
const ENTRY_TTL_MS = 4000;
const TAILSCALE_SCAN_INTERVAL_MS = 8000;
const TAILSCALE_PROBE_TIMEOUT_MS = 1500;
const MAX_BEACON_BYTES = 2048;

export interface DiscoveredGame extends SessionInfo {
    /** Address to connect to, including the port */
    address: string;
    source: "lan" | "tailscale";
    seenAt: number;
}

function isSessionInfo(value: unknown): value is SessionInfo {
    const info = value as SessionInfo;
    return (
        typeof info === "object" &&
        info !== null &&
        info.app === "shapez-multiplayer" &&
        typeof info.id === "string" &&
        info.id.length <= 64 &&
        typeof info.hostName === "string" &&
        info.hostName.length <= 64 &&
        typeof info.gameVersion === "string" &&
        info.gameVersion.length <= 64 &&
        Number.isInteger(info.port) &&
        info.port > 0 &&
        info.port < 65536 &&
        Number.isInteger(info.players) &&
        Number.isInteger(info.maxPlayers) &&
        typeof info.hasPassword === "boolean" &&
        info.protocol === PROTOCOL_VERSION
    );
}

/**
 * Broadcast addresses of all IPv4 LAN interfaces, plus loopback so several
 * instances on one PC see each other
 */
function getBroadcastTargets() {
    const targets = new Set(["127.0.0.1", "255.255.255.255"]);
    for (const infos of Object.values(os.networkInterfaces())) {
        for (const info of infos ?? []) {
            if (info.family !== "IPv4" || info.internal) {
                continue;
            }
            const ip = info.address.split(".").map(Number);
            const mask = info.netmask.split(".").map(Number);
            // Skip link-local and Tailscale (CGNAT range, no broadcasts)
            if ((ip[0] === 169 && ip[1] === 254) || (ip[0] === 100 && ip[1]! >= 64 && ip[1]! <= 127)) {
                continue;
            }
            targets.add(ip.map((part, i) => (part | (~mask[i]! & 255)) & 255).join("."));
        }
    }
    return [...targets];
}

/**
 * Runs on the host and announces the session on the local network
 */
export class DiscoveryBeacon {
    private socket: dgram.Socket | null = null;
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly getInfo: () => SessionInfo | null) {}

    start() {
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        socket.on("error", err => console.warn("[mp-discovery] beacon error:", err.message));
        socket.bind(() => {
            socket.setBroadcast(true);
            this.timer = setInterval(() => this.send(), BEACON_INTERVAL_MS);
            this.send();
        });
        this.socket = socket;
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.socket?.close();
        this.socket = null;
    }

    private send() {
        const info = this.getInfo();
        if (!info || !this.socket) {
            return;
        }
        const message = Buffer.from(JSON.stringify(info), "utf8");
        for (const target of getBroadcastTargets()) {
            this.socket.send(message, DISCOVERY_PORT, target, () => {
                // Unreachable targets are expected, ignore
            });
        }
    }
}

/**
 * Runs on players looking for a game. Started on demand and stopped when nobody asked for a while.
 */
export class DiscoveryListener {
    private socket: dgram.Socket | null = null;
    private readonly games = new Map<string, DiscoveredGame>();
    private tailscaleTimer: NodeJS.Timeout | null = null;
    private scanningTailscale = false;

    get isRunning() {
        return this.socket !== null;
    }

    start() {
        if (this.socket) {
            return;
        }
        const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
        socket.on("error", err => console.warn("[mp-discovery] listener error:", err.message));
        socket.on("message", (message, rinfo) => this.onBeacon(message, rinfo));
        socket.bind(DISCOVERY_PORT);
        this.socket = socket;

        this.scanTailscale();
        this.tailscaleTimer = setInterval(() => this.scanTailscale(), TAILSCALE_SCAN_INTERVAL_MS);
    }

    stop() {
        if (this.tailscaleTimer) {
            clearInterval(this.tailscaleTimer);
            this.tailscaleTimer = null;
        }
        this.socket?.close();
        this.socket = null;
        this.games.clear();
    }

    list(): DiscoveredGame[] {
        const now = Date.now();
        for (const [id, game] of this.games) {
            if (now - game.seenAt > (game.source === "lan" ? ENTRY_TTL_MS : TAILSCALE_SCAN_INTERVAL_MS * 2)) {
                this.games.delete(id);
            }
        }
        return [...this.games.values()].sort((a, b) => a.hostName.localeCompare(b.hostName));
    }

    private onBeacon(message: Buffer, rinfo: dgram.RemoteInfo) {
        if (message.length > MAX_BEACON_BYTES) {
            return;
        }
        let info: unknown;
        try {
            info = JSON.parse(message.toString("utf8"));
        } catch {
            return;
        }
        if (!isSessionInfo(info)) {
            return;
        }

        // The same host is heard on several interfaces; keep loopback if we
        // got it, since that is guaranteed to work on this PC
        const existing = this.games.get(info.id);
        const address = rinfo.address + ":" + info.port;
        const keepExisting =
            existing &&
            existing.source === "lan" &&
            existing.address.startsWith("127.") &&
            rinfo.address !== "127.0.0.1";

        this.games.set(info.id, {
            ...info,
            address: keepExisting ? existing.address : address,
            source: "lan",
            seenAt: Date.now(),
        });
    }

    private scanTailscale() {
        if (this.scanningTailscale) {
            return;
        }
        this.scanningTailscale = true;

        execFile("tailscale", ["status", "--json"], { timeout: 3000, windowsHide: true }, (err, stdout) => {
            if (err) {
                // Tailscale is not installed or not running
                this.scanningTailscale = false;
                return;
            }
            let peers: string[] = [];
            try {
                const status = JSON.parse(stdout) as {
                    Peer?: Record<string, { Online?: boolean; TailscaleIPs?: string[] }>;
                };
                peers = Object.values(status.Peer ?? {})
                    .filter(peer => peer.Online)
                    .map(peer => (peer.TailscaleIPs ?? []).find(ip => ip.includes(".")))
                    .filter((ip: unknown): ip is string => typeof ip === "string")
                    .slice(0, 64);
            } catch {
                // Unexpected output
            }

            Promise.all(peers.map(ip => this.probe(ip))).finally(() => {
                this.scanningTailscale = false;
            });
        });
    }

    private async probe(ip: string) {
        try {
            const response = await fetch(`http://${ip}:${DEFAULT_GAME_PORT}/info`, {
                signal: AbortSignal.timeout(TAILSCALE_PROBE_TIMEOUT_MS),
            });
            if (!response.ok) {
                return;
            }
            const info = await response.json();
            if (!isSessionInfo(info) || !this.socket) {
                return;
            }
            // A LAN entry for the same host stays: it is the faster route
            if (this.games.get(info.id)?.source === "lan") {
                return;
            }
            this.games.set(info.id, {
                ...info,
                address: ip + ":" + info.port,
                source: "tailscale",
                seenAt: Date.now(),
            });
        } catch {
            // Not hosting, or not reachable
        }
    }
}
