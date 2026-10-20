import { BrowserWindow, IpcMainInvokeEvent, app, ipcMain } from "electron";
import os from "node:os";
import { FsJob, FsJobHandler } from "./fsjob.js";
import { ModLoader } from "./mods/loader.js";
import { allowInFirewall, checkFirewall, probeHost } from "./multiplayer/diagnostics.js";
import { DiscoveryBeacon, DiscoveryListener } from "./multiplayer/discovery.js";
import { MultiplayerServer } from "./multiplayer/server.js";
import { getDefaultPlayerName } from "./multiplayer/steam_name.js";

/** The listener stops when the join dialog stopped asking for this long */
const DISCOVERY_IDLE_MS = 10_000;

export class IpcHandler {
    private readonly savesHandler = new FsJobHandler("saves");
    private readonly modLoader: ModLoader;
    private multiplayerServer: MultiplayerServer | null = null;
    private discoveryBeacon: DiscoveryBeacon | null = null;
    private readonly discoveryListener = new DiscoveryListener();
    private discoveryIdleTimer: NodeJS.Timeout | null = null;

    constructor(modLoader: ModLoader) {
        this.modLoader = modLoader;
    }

    install(window: BrowserWindow) {
        ipcMain.handle("fs-job", this.handleFsJob.bind(this));
        ipcMain.handle("get-mods", this.getMods.bind(this));
        ipcMain.handle("set-fullscreen", this.setFullscreen.bind(this, window));
        ipcMain.handle("mp-host-start", this.startMultiplayerHost.bind(this));
        ipcMain.handle("mp-host-stop", this.stopMultiplayerHost.bind(this));
        ipcMain.handle("mp-get-addresses", this.getNetworkAddresses.bind(this));
        ipcMain.handle("mp-discover", this.discoverGames.bind(this));
        ipcMain.handle("mp-get-default-name", () => getDefaultPlayerName());
        ipcMain.handle("mp-probe-host", (_event, host: unknown, port: unknown) => {
            if (typeof host !== "string" || host.length > 255 || !Number.isInteger(port)) {
                throw new Error("Invalid address");
            }
            return probeHost(host, port as number);
        });
        ipcMain.handle("mp-check-firewall", () => checkFirewall());
        ipcMain.handle("mp-allow-firewall", () => allowInFirewall());

        app.on("before-quit", () => {
            this.stopMultiplayerHost();
            this.discoveryListener.stop();
        });

        // Not implemented
        // ipcMain.handle("open-mods-folder", ...)
    }

    private handleFsJob(_event: IpcMainInvokeEvent, job: FsJob) {
        if (job.id !== "saves") {
            throw new Error("Storages other than saves/ are not implemented yet");
        }

        return this.savesHandler.handleJob(job);
    }

    private async getMods() {
        // TODO: Split mod reloads into a different IPC request
        await this.modLoader.loadMods();
        return this.modLoader.getAllMods();
    }

    private setFullscreen(window: BrowserWindow, _event: IpcMainInvokeEvent, flag: boolean) {
        if (window.isFullScreen() != flag) {
            window.setFullScreen(flag);
        }
    }

    private async startMultiplayerHost(_event: IpcMainInvokeEvent, port: unknown, password: unknown) {
        if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new Error("Invalid port: " + port);
        }

        await this.stopMultiplayerHost();

        const server = new MultiplayerServer({
            port,
            password: typeof password === "string" && password.length > 0 ? password : undefined,
        });
        await server.start();
        this.multiplayerServer = server;

        this.discoveryBeacon = new DiscoveryBeacon(() => server.getInfo());
        this.discoveryBeacon.start();

        return {
            port,
            hostToken: server.hostToken,
            addresses: this.getNetworkAddresses(),
        };
    }

    private async stopMultiplayerHost() {
        this.discoveryBeacon?.stop();
        this.discoveryBeacon = null;

        const server = this.multiplayerServer;
        this.multiplayerServer = null;
        await server?.stop();
    }

    /**
     * Returns the sessions found on the network. The join dialog polls this.
     */
    private discoverGames() {
        this.discoveryListener.start();

        if (this.discoveryIdleTimer) {
            clearTimeout(this.discoveryIdleTimer);
        }
        this.discoveryIdleTimer = setTimeout(() => this.discoveryListener.stop(), DISCOVERY_IDLE_MS);

        return this.discoveryListener.list();
    }

    /**
     * Lists the IPv4 addresses other players could use to reach this machine
     */
    private getNetworkAddresses() {
        const result: { address: string; kind: "lan" | "tailscale"; interface: string }[] = [];
        for (const [name, infos] of Object.entries(os.networkInterfaces())) {
            for (const info of infos ?? []) {
                if (info.family !== "IPv4" || info.internal) {
                    continue;
                }
                const [a, b] = info.address.split(".").map(Number);
                if (a === 169 && b === 254) {
                    // Link-local, nobody can reach it
                    continue;
                }
                // Tailscale uses the CGNAT range 100.64.0.0/10
                const isTailscale = a === 100 && b! >= 64 && b! <= 127;
                result.push({
                    address: info.address,
                    kind: isTailscale ? "tailscale" : "lan",
                    interface: name,
                });
            }
        }
        return result;
    }
}
