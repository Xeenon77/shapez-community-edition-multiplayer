import { ClickDetector } from "../core/click_detector";
import { Logger } from "../core/logging";
import { DialogWithForm } from "../core/modal_dialog_elements";
import { FormElement, FormElementInput } from "../core/modal_dialog_forms";
import { makeDiv, removeAllChildren } from "../core/utils";
import { ClientApplier } from "./client_applier";
import { HostAuthority } from "./host_authority";
import { MultiplayerSavegame } from "./multiplayer_savegame";
import { DEFAULT_PORT, describeReason } from "./protocol";
import { addressToUrl, MP, parseAddress } from "./session";

/**
 * @typedef {import("../application").Application} Application
 * @typedef {import("../game/root").GameRoot} GameRoot
 * @typedef {import("../game/hud/parts/modal_dialogs").HUDModalDialogs} HUDModalDialogs
 * @typedef {{
 *   id: string, hostName: string, address: string, source: "lan"|"tailscale",
 *   players: number, maxPlayers: number, hasPassword: boolean, gameVersion: string
 * }} DiscoveredGame
 * @typedef {{
 *   name: string, address: string, port: number, hostPassword: string,
 *   passwords: Record<string, string>
 * }} Prefs
 */

const logger = new Logger("mp/ui");

const STORAGE_KEY = "shapez-multiplayer-prefs";

const LOCK_ICON = `<svg class="lock" viewBox="0 0 24 24" aria-label="Needs a password"><path fill="currentColor"
    d="M17 9V7A5 5 0 0 0 7 7v2H5v13h14V9zm-8-2a3 3 0 0 1 6 0v2H9zm3 6a2 2 0 0 1 1 3.7V19h-2v-2.3A2 2 0 0 1 12 13z"/></svg>`;

////////// Remembered settings //////////

/**
 * Remembered names, addresses and passwords (per machine, best effort)
 * @returns {Prefs}
 */
function loadPrefs() {
    const defaults = { name: "", address: "", port: DEFAULT_PORT, hostPassword: "", passwords: {} };
    try {
        const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
        return { ...defaults, ...stored, passwords: { ...(stored.passwords || {}) } };
    } catch {
        return defaults;
    }
}

/**
 * @param {Partial<Prefs>} changes
 */
function savePrefs(changes) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadPrefs(), ...changes }));
    } catch {
        // Not important
    }
}

/**
 * @param {string} key
 * @param {string} password
 */
function rememberPassword(key, password) {
    const passwords = loadPrefs().passwords;
    if (password) {
        passwords[key] = password;
    } else {
        delete passwords[key];
    }
    savePrefs({ passwords });
}

let defaultNamePromise = null;

/**
 * The name to show in the dialogs: the remembered one, else the Steam name of this PC
 * @returns {Promise<string>}
 */
async function getPlayerName() {
    const stored = loadPrefs().name;
    if (stored) {
        return stored;
    }
    defaultNamePromise ??= ipcRenderer.invoke("mp-get-default-name").catch(() => null);
    const name = (await defaultNamePromise) || "Player";
    savePrefs({ name });
    return name;
}

////////// Helpers //////////

/**
 * @param {string} text
 */
function escapeHtml(text) {
    return String(text).replace(
        /[&<>"']/g,
        ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
    );
}

const isValidName = value => value.trim().length > 0 && value.trim().length <= 24;
const isValidPort = value => /^\d+$/.test(value) && Number(value) >= 1024 && Number(value) <= 65535;
const isValidAddress = value => {
    try {
        addressToUrl(value);
        return true;
    } catch {
        return false;
    }
};

/**
 * Description line at the top of a dialog, with some room below it
 * @param {string} html
 */
function description(html) {
    return `<div class="mpDesc">${html}</div>`;
}

/**
 * Gives the dialog that was opened last the multiplayer layout
 * (cancel on the left, confirm on the right, readable placeholders)
 * @param {HUDModalDialogs} dialogs
 */
function styleLastDialog(dialogs) {
    dialogs.dialogStack[dialogs.dialogStack.length - 1]?.element?.classList.add("mpDialog");
}

/**
 * Shakes a dialog to show that something is missing
 * @param {DialogWithForm<any>} dialog
 */
function shakeDialog(dialog) {
    dialog.dialogElem.classList.remove("errorShake");
    requestAnimationFrame(() => dialog.dialogElem?.classList.add("errorShake"));
}

/**
 * Section of a form that is collapsed until clicked, e.g. "Advanced options"
 */
class FormElementCollapsible extends FormElement {
    /**
     * @param {object} param0
     * @param {string} param0.id
     * @param {string} param0.label
     * @param {FormElement<any>[]} param0.children
     */
    constructor({ id, label, children }) {
        super(id, label);
        this.children = children;
        /** @type {HTMLElement} */
        this.element = null;
    }

    getHtml() {
        return `
            <div class="formElement mpCollapsible" data-formId="${this.id}">
                <div class="toggle">${this.label}</div>
                <div class="body">
                    ${this.children.map(child => child.getHtml()).join("")}
                </div>
            </div>
        `;
    }

    bindEvents(parent, clickTrackers) {
        this.element = this.getFormElement(parent);

        const toggle = new ClickDetector(this.element.querySelector(".toggle"), { preventDefault: true });
        toggle.click.add(() => this.setOpen(!this.element.classList.contains("open")));
        clickTrackers.push(toggle);

        for (const child of this.children) {
            child.bindEvents(parent, clickTrackers);
        }
    }

    /**
     * @param {boolean} open
     */
    setOpen(open) {
        this.element.classList.toggle("open", open);
        if (open) {
            this.children[0]?.focus();
        }
    }

    isValid() {
        return this.children.every(child => child.isValid());
    }

    getValue() {
        return null;
    }

    focus() {
        // Stays closed
    }
}

/**
 * Live list of the sessions found on the network, polled from the main process
 */
class FormElementGameList extends FormElement {
    /**
     * @param {{
     *   id: string,
     *   onChoose: (game: DiscoveredGame) => void,
     *   onFirewallFix: () => Promise<void>,
     * }} param0
     */
    constructor({ id, onChoose, onFirewallFix }) {
        super(id, "Games on your local network");
        this.onChoose = onChoose;
        this.onFirewallFix = onFirewallFix;
        /** Firewall problems on this PC, checked once nothing was found @type {FirewallNetwork[]|null|undefined} */
        this.firewallProblems = undefined;
        /** @type {HTMLElement|null} */
        this.element = null;
        /** @type {ClickDetector[]} */
        this.clickTrackers = null;
        /** @type {ClickDetector[]} */
        this.rowDetectors = [];
        this.lastRenderKey = null;
        this.wasAttached = false;
        this.pollsWithoutGames = 0;
    }

    getHtml() {
        return `
            <div class="formElement">
                <label>${this.label}</label>
                <div class="mpGameList" data-formId="${this.id}"></div>
            </div>
        `;
    }

    bindEvents(parent, clickTrackers) {
        this.element = this.getFormElement(parent);
        this.clickTrackers = clickTrackers;
        this.render([]);
        this.poll();
    }

    async poll() {
        if (!this.element) {
            return;
        }
        if (this.element.isConnected) {
            this.wasAttached = true;
        } else if (this.wasAttached) {
            // Dialog closed
            return;
        }

        try {
            this.render(await ipcRenderer.invoke("mp-discover"));
        } catch (ex) {
            logger.warn("Discovery failed:", ex);
        }
        setTimeout(() => this.poll(), 1000);
    }

    /**
     * @param {DiscoveredGame[]} games
     */
    render(games) {
        this.pollsWithoutGames = games.length === 0 ? this.pollsWithoutGames + 1 : 0;
        const searching = this.pollsWithoutGames <= 3;

        const key =
            JSON.stringify(games.map(g => [g.id, g.address, g.players, g.hasPassword, g.hostName])) +
            searching +
            JSON.stringify(this.firewallProblems ?? null);
        if (key === this.lastRenderKey) {
            return;
        }
        this.lastRenderKey = key;

        for (const detector of this.rowDetectors) {
            detector.cleanup();
            const index = this.clickTrackers.indexOf(detector);
            if (index >= 0) {
                this.clickTrackers.splice(index, 1);
            }
        }
        this.rowDetectors = [];
        removeAllChildren(this.element);

        if (games.length === 0) {
            const empty = makeDiv(this.element, null, ["empty"]);
            empty.classList.toggle("searching", searching);
            empty.innerText = searching
                ? "Searching for games ..."
                : "No games found. Ask the host to start hosting, or enter an address under Advanced options.";

            if (!searching) {
                this.renderFirewallHint();
            }
            return;
        }

        for (const game of games) {
            const compatible = game.gameVersion === G_BUILD_VERSION;
            const row = makeDiv(this.element, null, ["game"]);
            row.classList.toggle("incompatible", !compatible);

            // innerText only: discovery data comes from the network
            const text = makeDiv(row, null, ["text"]);
            makeDiv(text, null, ["host"]).innerText = game.hostName;
            makeDiv(text, null, ["details"]).innerText = [
                game.players + "/" + game.maxPlayers + " players",
                compatible ? null : "other version (" + game.gameVersion + ")",
            ]
                .filter(Boolean)
                .join(" · ");

            if (game.hasPassword) {
                row.insertAdjacentHTML("beforeend", LOCK_ICON);
            }

            if (compatible) {
                const detector = new ClickDetector(row, { consumeEvents: true, preventDefault: true });
                detector.click.add(() => this.onChoose(game));
                this.rowDetectors.push(detector);
                this.clickTrackers.push(detector);
            }
        }
    }

    /**
     * Games on the network can't be found when the firewall blocks this game
     */
    renderFirewallHint() {
        if (this.firewallProblems === undefined) {
            this.firewallProblems = null;
            checkFirewall().then(report => {
                this.firewallProblems = firewallProblems(report);
                this.lastRenderKey = null;
                this.render([]);
            });
            return;
        }
        if (!this.firewallProblems || this.firewallProblems.length === 0) {
            return;
        }

        const hint = makeDiv(this.element, null, ["firewallHint"]);
        makeDiv(hint, null, ["text"]).innerText =
            "Windows Firewall blocks this game on " +
            this.firewallProblems.map(network => network.alias).join(", ") +
            ", which can hide games on your network.";
        const button = document.createElement("button");
        button.classList.add("styledButton");
        button.innerText = "Allow in firewall";
        hint.appendChild(button);

        const detector = new ClickDetector(button, { consumeEvents: true, preventDefault: true });
        detector.click.add(async () => {
            await this.onFirewallFix();
            // Check again after the change
            this.firewallProblems = undefined;
            this.lastRenderKey = null;
        });
        this.rowDetectors.push(detector);
        this.clickTrackers.push(detector);
    }

    getValue() {
        return null;
    }
}

////////// Firewall //////////

/**
 * @typedef {{ name: string, alias: string, category: string, status: "allowed"|"blocked"|"no-rule" }} FirewallNetwork
 * @typedef {{ supported: false } | { supported: true, ok: boolean, networks: FirewallNetwork[] }} FirewallReport
 */

/**
 * Asks the main process whether Windows Firewall lets other PCs connect to this game
 * @returns {Promise<FirewallReport|null>} null if the check itself failed
 */
async function checkFirewall() {
    try {
        return await ipcRenderer.invoke("mp-check-firewall");
    } catch (ex) {
        logger.warn("Firewall check failed:", ex);
        return null;
    }
}

/**
 * @param {FirewallReport|null} report
 */
function firewallProblems(report) {
    if (!report || !report.supported) {
        return [];
    }
    return report.networks.filter(network => network.status !== "allowed");
}

/**
 * @param {FirewallNetwork[]} networks
 */
function describeBlockedNetworks(networks) {
    const rows = networks
        .map(network => {
            const kind = network.category === "Public" ? "public network" : "private network";
            const how = network.status === "blocked" ? "blocked" : "not allowed yet";
            return `<li>${escapeHtml(network.alias)} &ndash; ${escapeHtml(network.name)} (${kind}, ${how})</li>`;
        })
        .join("");
    return `<ul class="mpAddressList">${rows}</ul>`;
}

/**
 * Lets the player replace the game's firewall rules with one that allows
 * connections; Windows asks for admin rights
 * @param {HUDModalDialogs} dialogs
 * @param {(text: string, type: string) => void} notify
 */
async function allowInFirewall(dialogs, notify) {
    const closeLoading = dialogs.showLoadingDialog("Waiting for Windows ...");
    let done = false;
    try {
        done = await ipcRenderer.invoke("mp-allow-firewall");
    } catch (ex) {
        logger.warn("Changing the firewall failed:", ex);
    }
    const remaining = firewallProblems(await checkFirewall());
    closeLoading();

    if (done && remaining.length === 0) {
        notify("Firewall updated, other players can connect now", "success");
    } else {
        dialogs.showWarning(
            "Firewall not changed",
            "Windows Firewall still blocks the game" +
                (done ? "." : " (the Windows prompt was declined).") +
                "<br><br>You can also allow it yourself: Start &rarr; <em>Allow an app through Windows Firewall</em> " +
                "&rarr; <em>Change settings</em> &rarr; tick <strong>Private</strong> and <strong>Public</strong> " +
                "for every <strong>shapezio</strong> entry."
        );
    }
}

/**
 * Warns the host when other PCs can't connect because of the firewall
 * @param {GameRoot} root
 * @param {FirewallNetwork[]} problems
 */
function showHostFirewallWarning(root, problems) {
    const dialogs = root.hud.parts.dialogs;
    const text = `
        Windows Firewall doesn't let other PCs connect to this game on:
        ${describeBlockedNetworks(problems)}
        Your friends can see the game, but joining fails with <em>Could not connect to the host</em>.
        <br><br>
        <strong>Allow in firewall</strong> fixes this; Windows asks for permission first. It lets other
        PCs connect to this game (and nothing else) on all networks.
    `;
    const signals = dialogs.showWarning("Friends can't join yet", text, [
        "later:bad:escape",
        "mpAllowFirewall:good",
    ]);
    styleLastDialog(dialogs);
    signals.mpAllowFirewall.add(() =>
        allowInFirewall(dialogs, (message, type) => root.hud.signals.notification.dispatch(message, type))
    );
}

/**
 * Checks the firewall after hosting started. A missing rule can mean Windows is
 * still showing its own prompt, so that case is checked again a bit later.
 * @param {GameRoot} root
 */
async function checkHostFirewall(root) {
    let problems = firewallProblems(await checkFirewall());
    if (problems.length > 0 && problems.every(network => network.status === "no-rule")) {
        await new Promise(resolve => setTimeout(resolve, 20000));
        problems = firewallProblems(await checkFirewall());
    }
    if (problems.length > 0 && MP.isHost(root)) {
        showHostFirewallWarning(root, problems);
    }
}

/**
 * Explains why joining an address failed, by testing the connection
 * @param {string} address
 * @returns {Promise<string>} HTML
 */
async function diagnoseConnection(address) {
    let host, port;
    try {
        ({ host, port } = parseAddress(address));
    } catch {
        return "The address <strong>" + escapeHtml(address) + "</strong> is not valid.";
    }
    const where = "<strong>" + escapeHtml(host + ":" + port) + "</strong>";

    let probe;
    try {
        probe = await ipcRenderer.invoke("mp-probe-host", host, port);
    } catch (ex) {
        return "Could not connect to " + where + ".";
    }

    switch (probe.status) {
        case "timeout":
            return `
                The host's PC at ${where} didn't answer.<br><br>
                This almost always means <strong>Windows Firewall on the host's PC blocks the game</strong>.
                The host should press <kbd>Esc</kbd> and click the multiplayer card: the game checks the
                firewall there and can fix it.<br><br>
                Also check that both PCs are in the same network.`;
        case "refused":
            return `
                The PC at ${where} is reachable, but nothing is hosting there any more.<br><br>
                Ask the host to host the game again, and check that the port matches.`;
        case "unreachable":
            return `
                This PC can't reach ${where}.<br><br>
                Both PCs need to be in the same network (the same Wi-Fi, or the same virtual network).`;
        case "ok":
            if (probe.info && probe.info.gameVersion && probe.info.gameVersion !== G_BUILD_VERSION) {
                return describeReason("version-mismatch");
            }
            return `
                The host's PC at ${where} answers, but joining still failed.<br><br>
                Make sure you both use the newest version of the game, then try again.`;
        default:
            return (
                "Could not connect to " +
                where +
                (probe.code ? " (" + escapeHtml(probe.code) + ")" : "") +
                "."
            );
    }
}

////////// Hosting //////////

/**
 * Shows the dialog to host the running game
 * @param {GameRoot} root
 */
export async function showHostDialog(root) {
    if (MP.isActive(root)) {
        showSessionDialog(root);
        return;
    }

    const dialogs = root.hud.parts.dialogs;
    const prefs = loadPrefs();

    const nameInput = new FormElementInput({
        id: "mpName",
        label: "Your name",
        placeholder: "Enter your name ...",
        defaultValue: await getPlayerName(),
        validator: isValidName,
    });
    const passwordInput = new FormElementInput({
        id: "mpPassword",
        label: "Password (optional)",
        placeholder: "No password",
        defaultValue: prefs.hostPassword,
    });
    const portInput = new FormElementInput({
        id: "mpPort",
        label: "Port",
        placeholder: String(DEFAULT_PORT),
        defaultValue: String(prefs.port || DEFAULT_PORT),
        validator: isValidPort,
    });
    const advanced = new FormElementCollapsible({
        id: "mpHostAdvanced",
        label: "Advanced options",
        children: [portInput],
    });

    const dialog = new DialogWithForm({
        app: root.app,
        title: "Host multiplayer",
        desc: description("Up to 3 friends can join this game and play with you."),
        formElements: [nameInput, passwordInput, advanced],
        buttons: ["cancel:bad:escape", "mpHost:good:enter"],
        confirmButtonId: "mpHost",
    });
    dialogs.internalShowDialog(dialog);
    styleLastDialog(dialogs);

    dialog.buttonSignals.mpHost.add(async () => {
        const name = nameInput.getValue().trim();
        const port = Number(portInput.getValue());
        const password = passwordInput.getValue();
        savePrefs({ name, port, hostPassword: password });

        const closeLoading = dialogs.showLoadingDialog("Starting session ...");
        try {
            await MP.startHosting(root, { port, password, name }, HostAuthority);
            closeLoading();
            root.hud.signals.notification.dispatch(
                "Hosting! Friends find your game under Join multiplayer.",
                "success"
            );
            checkHostFirewall(root);
        } catch (ex) {
            closeLoading();
            logger.warn("Failed to host:", ex);
            dialogs.showWarning(
                "Could not host",
                "The session could not be started: " +
                    escapeHtml(describeReason(ex.message || String(ex))) +
                    "<br><br>Maybe another program uses port " +
                    port +
                    "? You can pick another one in the advanced options."
            );
        }
    });
}

/**
 * Lists the players of the session as HTML
 */
function renderPlayerListHtml() {
    const rows = MP.players
        .map(player => {
            const tags = [player.role === "host" ? "host" : null, player.id === MP.playerId ? "you" : null]
                .filter(Boolean)
                .join(", ");
            return `<li>${escapeHtml(player.name)}${tags ? ` <span class="tags">(${tags})</span>` : ""}</li>`;
        })
        .join("");
    return `<ul class="mpPlayerList">${rows}</ul>`;
}

/**
 * Details of the running session, opened from the pause menu
 * @param {GameRoot} root
 */
export async function showSessionDialog(root) {
    const dialogs = root.hud.parts.dialogs;

    if (MP.role === "host" && MP.hostInfo) {
        const info = MP.hostInfo;

        const closeChecking = dialogs.showLoadingDialog("Checking the connection ...");
        const report = await checkFirewall();
        closeChecking();
        if (!MP.isHost(root)) {
            return;
        }
        const problems = firewallProblems(report);
        let firewallText = "";
        if (problems.length > 0) {
            firewallText = `
                <br><br><strong>Windows Firewall blocks other PCs</strong> on:
                ${describeBlockedNetworks(problems)}
                Click <strong>Allow in firewall</strong> so your friends can connect.`;
        } else if (report && report.supported) {
            firewallText = "<br><br>Windows Firewall lets other PCs connect to this game.";
        }

        const addresses = info.addresses
            .map(a => `<li><strong>${escapeHtml(a.address)}:${info.port}</strong></li>`)
            .join("");

        const text = `
            ${MP.players.length}/4 players are in your game:
            ${renderPlayerListHtml()}
            Friends on your network find this game under <em>Join multiplayer</em>
            in the main menu. ${info.hasPassword ? "They need the password you set." : "No password is set."}
            <br><br>
            If it doesn't show up for them, they can enter one of these addresses in the advanced options:
            <ul class="mpAddressList">${addresses || "<li>No network address found</li>"}</ul>
            ${firewallText}
        `;
        const buttons = ["mpStopHosting:bad", "ok:good:escape"];
        if (problems.length > 0) {
            buttons.splice(1, 0, "mpAllowFirewall:good");
        }
        const signals = dialogs.showInfo("Hosting multiplayer", text, buttons);
        styleLastDialog(dialogs);
        signals.mpAllowFirewall?.add(() =>
            allowInFirewall(dialogs, (message, type) => root.hud.signals.notification.dispatch(message, type))
        );
        signals.mpStopHosting.add(() => {
            MP.stop();
            root.hud.signals.notification.dispatch("Stopped hosting", "info");
        });
        return;
    }

    if (MP.role === "client") {
        const host = MP.players.find(p => p.role === "host");
        const hostName = host ? host.name : "the host";
        const text = `
            You are playing in ${escapeHtml(hostName)}'s world with ${MP.players.length - 1} other player(s):
            ${renderPlayerListHtml()}
            Everything you build is saved on ${escapeHtml(hostName)}'s PC. To host a game yourself, leave this one first.
        `;
        const signals = dialogs.showInfo("Joined " + escapeHtml(hostName) + "'s game", text, [
            "mpLeave:bad",
            "ok:good:escape",
        ]);
        styleLastDialog(dialogs);
        signals.mpLeave.add(() => {
            MP.stop();
            root.gameState.goBackToMenu();
        });
    }
}

////////// Joining //////////

/**
 * Shows the join dialog in the main menu and loads the host's world
 * @param {Application} app
 * @param {HUDModalDialogs} dialogs
 * @param {(stateId: string, payload: object) => void} moveToState
 */
export async function showJoinDialog(app, dialogs, moveToState) {
    const reopen = () => showJoinDialog(app, dialogs, moveToState);
    const prefs = loadPrefs();

    const nameInput = new FormElementInput({
        id: "mpName",
        label: "Your name",
        placeholder: "Enter your name ...",
        defaultValue: await getPlayerName(),
        validator: isValidName,
    });
    const addressInput = new FormElementInput({
        id: "mpAddress",
        label: "Host address (IP or IP:port)",
        placeholder: "e.g. 192.168.1.20:" + DEFAULT_PORT,
        defaultValue: prefs.address,
        validator: value => value.trim() === "" || isValidAddress(value),
    });

    /** @type {DialogWithForm<"cancel"|"mpJoin">} */
    let dialog = null;

    /**
     * Closes the list and starts joining, if the name is fine
     * @param {{ address: string, label: string, passwordKey: string, needsPassword: boolean }} target
     * @param {boolean} closeDialog
     */
    const choose = (target, closeDialog = true) => {
        if (!nameInput.isValid()) {
            nameInput.focus();
            shakeDialog(dialog);
            return;
        }
        const name = nameInput.getValue().trim();
        savePrefs({ name });
        if (closeDialog) {
            dialog.closeRequested.dispatch();
        }

        const remembered = loadPrefs().passwords[target.passwordKey] || "";
        if (target.needsPassword && !remembered) {
            askForPassword({ app, dialogs, moveToState, reopen, name, target, wrong: false });
        } else {
            joinGame({ app, dialogs, moveToState, reopen, name, target, password: remembered });
        }
    };

    const gameList = new FormElementGameList({
        id: "mpGames",
        onFirewallFix: () =>
            allowInFirewall(dialogs, message => dialogs.showInfo("Windows Firewall", escapeHtml(message))),
        onChoose: game =>
            choose({
                address: game.address,
                label: game.hostName + "'s game",
                passwordKey: "host:" + game.hostName,
                needsPassword: game.hasPassword,
            }),
    });

    const advanced = new FormElementCollapsible({
        id: "mpJoinAdvanced",
        label: "Advanced options",
        children: [addressInput],
    });

    dialog = new DialogWithForm({
        app,
        title: "Join multiplayer",
        desc: description(
            "Click a game to join it. Nothing is saved on your side unless you save a local copy."
        ),
        formElements: [nameInput, gameList, advanced],
        buttons: ["cancel:bad:escape", "mpJoin:good:enter"],
        confirmButtonId: "mpJoin",
    });

    // "Join" is for typed addresses: without one, show where to enter it instead of closing
    const handleButton = dialog.internalButtonHandler.bind(dialog);
    dialog.internalButtonHandler = (id, ...payload) => {
        const address = addressInput.getValue().trim();
        if (id === "mpJoin" && (address === "" || !isValidAddress(address))) {
            advanced.setOpen(true);
            addressInput.focus();
            shakeDialog(dialog);
            return;
        }
        handleButton(id, ...payload);
    };
    dialog.buttonSignals.mpJoin.add(() => {
        const address = addressInput.getValue().trim();
        savePrefs({ address });
        // The dialog closes by itself after a button
        choose({ address, label: address, passwordKey: "addr:" + address, needsPassword: false }, false);
    });

    dialogs.internalShowDialog(dialog);
    styleLastDialog(dialogs);

    // "Join" only makes sense for a typed address, games in the list join on click
    const joinButton = dialog.element.querySelector(".buttons button.good");
    const updateJoinButton = () => {
        joinButton?.classList.toggle("mpInvisible", addressInput.getValue().trim() === "");
    };
    addressInput.element.addEventListener("input", updateJoinButton);
    updateJoinButton();
}

/**
 * Second step for games with a password
 * @param {object} param0
 */
function askForPassword({ app, dialogs, moveToState, reopen, name, target, wrong }) {
    const passwordInput = new FormElementInput({
        id: "mpPassword",
        label: wrong ? "Wrong password, try again" : "Password",
        placeholder: "Enter the password ...",
        defaultValue: "",
    });

    const dialog = new DialogWithForm({
        app,
        title: "Password required",
        desc: description(escapeHtml(target.label) + " needs a password."),
        formElements: [passwordInput],
        buttons: ["cancel:bad:escape", "mpJoin:good:enter"],
        confirmButtonId: "mpJoin",
    });
    dialogs.internalShowDialog(dialog);
    styleLastDialog(dialogs);

    dialog.buttonSignals.cancel.add(reopen);
    dialog.buttonSignals.mpJoin.add(() =>
        joinGame({ app, dialogs, moveToState, reopen, name, target, password: passwordInput.getValue() })
    );
}

/**
 * Connects, waits for the world and starts the game
 * @param {object} param0
 */
async function joinGame({ app, dialogs, moveToState, reopen, name, target, password }) {
    const closeLoading = dialogs.showLoadingDialog("Joining " + target.label + " ...");
    try {
        const { dump, gameModeId } = await MP.join(
            { address: target.address, name, password },
            ClientApplier
        );
        closeLoading();
        rememberPassword(target.passwordKey, password);
        moveToState("InGameState", {
            savegame: new MultiplayerSavegame(app, dump),
            gameModeId,
        });
    } catch (ex) {
        closeLoading();
        const reason = ex.message || String(ex);
        logger.warn("Failed to join:", reason);

        if (reason === "wrong-password") {
            // Remembered password is outdated, or the game needs one after all
            rememberPassword(target.passwordKey, "");
            askForPassword({ app, dialogs, moveToState, reopen, name, target, wrong: password !== "" });
            return;
        }

        let text = escapeHtml(describeReason(reason));
        if (reason === "connection-failed") {
            const closeChecking = dialogs.showLoadingDialog("Checking the connection ...");
            text = await diagnoseConnection(target.address);
            closeChecking();
        }
        const { ok } = dialogs.showWarning("Could not join", text);
        ok.add(reopen);
    }
}
