import { globalConfig } from "../../../core/config";
import { gMetaBuildingRegistry } from "../../../core/global_registries";
import { Vector } from "../../../core/vector";
import { removeAllChildren } from "../../../core/utils";
import { saveLocalCopy } from "../../../multiplayer/multiplayer_savegame";
import { showHostDialog, showSessionDialog } from "../../../multiplayer/multiplayer_ui";
import { describeReason } from "../../../multiplayer/protocol";
import { MP } from "../../../multiplayer/session";
import { getCodeFromBuildingData } from "../../building_codes";
import { StaticMapEntityComponent } from "../../components/static_map_entity";
import { Entity } from "../../entity";
import { BaseHUDPart } from "../base_hud_part";
import { enumNotificationType } from "./notifications";

const PLAYER_COLORS = [
    "#e2524a",
    "#3b9ae1",
    "#38c172",
    "#f4b400",
    "#9b59b6",
    "#ef7d31",
    "#1abc9c",
    "#e84393",
];

/**
 * Cursors are sent every 50 ms. Between updates the motion is extrapolated from
 * the last two samples, at most this far ahead (in case an update is late).
 */
const CURSOR_MAX_PREDICTION_MS = 50;

/**
 * Only part of the measured speed is extrapolated, so stops and turns overshoot less
 */
const CURSOR_PREDICTION_FACTOR = 0.8;

/** Two samples further apart than this don't give a usable speed */
const CURSOR_MAX_SAMPLE_GAP_MS = 250;

/** Cursors that did not move for this long are drawn faded */
const CURSOR_IDLE_FADE_MS = 60000;

/**
 * @param {number} playerId
 */
export function getPlayerColor(playerId) {
    return PLAYER_COLORS[(playerId - 1 + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

/**
 * Predicts where a remote cursor is now: the last received position, moved on
 * with the speed between the last two samples
 * @param {import("../../../multiplayer/session").RemoteCursor} cursor
 * @param {number} now
 */
function predictCursor(cursor, now) {
    const samples = cursor.samples;
    if (samples.length === 0) {
        return null;
    }
    const last = samples[samples.length - 1];
    if (cursor.stopped || samples.length < 2) {
        return { x: last.x, y: last.y };
    }
    const previous = samples[samples.length - 2];
    const gap = last.t - previous.t;
    if (gap <= 0 || gap > CURSOR_MAX_SAMPLE_GAP_MS) {
        return { x: last.x, y: last.y };
    }
    const ahead = Math.min(now - last.t, CURSOR_MAX_PREDICTION_MS) * CURSOR_PREDICTION_FACTOR;
    return {
        x: last.x + ((last.x - previous.x) / gap) * ahead,
        y: last.y + ((last.y - previous.y) / gap) * ahead,
    };
}

/**
 * Draws the other players' cursors (with what they hold), lists players who are
 * off screen next to the markers, and drives the multiplayer session once per frame.
 */
export class HUDMultiplayerOverlay extends BaseHUDPart {
    initialize() {
        this.disconnectDialogShown = false;

        /** Smoothed cursor positions, per player @type {Map<number, { x: number, y: number }>} */
        this.displayedCursors = new Map();

        /** Fake entities for drawing other players' placement previews @type {Map<number, { key: string, entity: Entity }>} */
        this.ghostEntities = new Map();
        this.lastUpdateTime = performance.now();

        /** @type {HTMLElement|null} */
        this.playerListElement = this.playerListElement || null;
        this.playerListKey = "";
        /** @type {Map<number, { element: HTMLElement, canvas: HTMLCanvasElement }>} */
        this.playerEntries = new Map();

        this.knownPlayers = new Map(MP.players.map(p => [p.id, p.name]));
        this.lastStatus = MP.status;

        MP.attachRoot(this.root);
        MP.signals.changed.add(this.onSessionChanged, this);
        MP.signals.disconnected.add(this.onDisconnected, this);
    }

    cleanup() {
        super.cleanup();
        MP.signals.changed.remove(this.onSessionChanged);
        MP.signals.disconnected.remove(this.onDisconnected);
        MP.detachRoot(this.root);
    }

    ////////// Pause menu card //////////

    /**
     * Text for the multiplayer card in the pause menu
     * @returns {{ kind: "none"|"host"|"client", title: string, details: string }}
     */
    describeSession() {
        if (!MP.isActive(this.root)) {
            return { kind: "none", title: "Host multiplayer", details: "Let friends join this game" };
        }

        const players = MP.players.length + "/4 players";
        const others = MP.players.filter(p => p.id !== MP.playerId).map(p => p.name);

        if (MP.role === "host") {
            return {
                kind: "host",
                title: "Hosting multiplayer",
                details: others.length > 0 ? players + ": " + others.join(", ") : "Waiting for players",
            };
        }

        const host = MP.players.find(p => p.role === "host");
        let details = players;
        if (MP.status === "reconnecting") {
            details = "Reconnecting ...";
        } else if (MP.status === "disconnected") {
            details = "Disconnected";
        }
        return {
            kind: "client",
            title: "Joined " + (host ? host.name + "'s game" : "a game"),
            details,
        };
    }

    onSessionCardClicked() {
        this.root.hud.parts.settingsMenu.close();
        if (MP.isActive(this.root)) {
            showSessionDialog(this.root);
        } else {
            showHostDialog(this.root);
        }
    }

    ////////// Notifications //////////

    onSessionChanged() {
        if (!MP.isActive(this.root)) {
            this.knownPlayers = new Map();
            return;
        }

        const notify = (text, type) => this.root.hud.signals.notification.dispatch(text, type);

        // Joins and leaves
        const current = new Map(MP.players.map(p => [p.id, p.name]));
        if (this.knownPlayers.size > 0 && MP.status === "connected") {
            for (const [id, name] of current) {
                if (!this.knownPlayers.has(id) && id !== MP.playerId) {
                    notify(name + " joined the game", enumNotificationType.info);
                }
            }
            for (const [id, name] of this.knownPlayers) {
                if (!current.has(id)) {
                    notify(name + " left the game", enumNotificationType.info);
                }
            }
        }
        if (current.size > 0) {
            this.knownPlayers = current;
        }

        // Connection state of clients
        if (MP.status !== this.lastStatus) {
            if (MP.status === "reconnecting") {
                notify("Connection to the host lost, reconnecting ...", enumNotificationType.warning);
            } else if (MP.status === "connected" && this.lastStatus === "reconnecting") {
                notify("Reconnected to the host", enumNotificationType.success);
            }
            this.lastStatus = MP.status;
        }
    }

    /**
     * @param {string} reason
     */
    onDisconnected(reason) {
        if (this.disconnectDialogShown) {
            return;
        }
        this.disconnectDialogShown = true;

        const dialogs = this.root.hud.parts.dialogs;
        const signals = dialogs.showWarning(
            "Disconnected",
            describeReason(reason) + "<br><br>You can keep a copy of the world as a local savegame.",
            ["mpBackToMenu:bad", "mpSaveCopy:good"]
        );

        signals.mpBackToMenu.add(() => this.leaveToMenu());
        signals.mpSaveCopy.add(() => {
            const closeLoading = dialogs.showLoadingDialog("Saving ...");
            saveLocalCopy(this.root)
                .catch(err => {
                    console.error("Failed to save local copy:", err);
                })
                .then(() => {
                    closeLoading();
                    this.leaveToMenu();
                });
        });
    }

    leaveToMenu() {
        MP.stop();
        this.root.gameState.goBackToMenu();
    }

    ////////// Players in the marker list //////////

    /**
     * Called by the marker list whenever it re-renders, so the player entries stay at its end
     * @param {HTMLElement} listElement
     */
    mountPlayerList(listElement) {
        if (!this.playerListElement) {
            this.playerListElement = document.createElement("div");
            this.playerListElement.classList.add("mpPlayers");
        }
        listElement.appendChild(this.playerListElement);
    }

    /**
     * Keeps one entry per player whose cursor is off screen
     */
    updatePlayerList() {
        if (!this.playerListElement) {
            return;
        }

        const visible = this.root.camera.getVisibleRect();
        const offscreen = [];
        if (MP.isActive(this.root)) {
            for (const [playerId, pos] of this.displayedCursors) {
                const player = MP.getPlayer(playerId);
                if (player && !visible.containsPoint(pos.x, pos.y)) {
                    offscreen.push({ player, pos });
                }
            }
        }

        // Only rebuild the DOM when the set of players changes
        const key = offscreen.map(e => e.player.id + ":" + e.player.name).join("|");
        if (key !== this.playerListKey) {
            this.playerListKey = key;
            removeAllChildren(this.playerListElement);
            this.cleanupClickDetectors();
            this.playerEntries.clear();

            for (const { player } of offscreen) {
                const element = document.createElement("div");
                element.classList.add("waypoint", "hub", "mpPlayer");
                const canvas = document.createElement("canvas");
                canvas.width = 48;
                canvas.height = 48;
                element.appendChild(canvas);
                const label = document.createElement("span");
                label.innerText = player.name;
                element.appendChild(label);
                this.playerListElement.appendChild(element);

                this.trackClicks(element, () => this.jumpToPlayer(player.id));
                this.playerEntries.set(player.id, { element, canvas });
            }
        }

        // Point each arrow from the screen center towards the player
        const center = this.root.camera.center;
        for (const { player, pos } of offscreen) {
            const entry = this.playerEntries.get(player.id);
            if (!entry) {
                continue;
            }
            const ctx = entry.canvas.getContext("2d");
            ctx.clearRect(0, 0, 48, 48);
            ctx.save();
            ctx.translate(24, 24);
            ctx.rotate(Math.atan2(pos.y - center.y, pos.x - center.x));
            ctx.beginPath();
            ctx.moveTo(18, 0);
            ctx.lineTo(-12, -13);
            ctx.lineTo(-5, 0);
            ctx.lineTo(-12, 13);
            ctx.closePath();
            ctx.fillStyle = getPlayerColor(player.id);
            ctx.fill();
            ctx.restore();
        }
    }

    /**
     * @param {number} playerId
     */
    jumpToPlayer(playerId) {
        const cursor = MP.remoteCursors.get(playerId);
        const pos = this.displayedCursors.get(playerId);
        if (!cursor || !pos) {
            return;
        }
        this.root.currentLayer = /** @type {Layer} */ (cursor.layer);
        this.root.camera.setDesiredCenter(new Vector(pos.x, pos.y));
    }

    ////////// Frame //////////

    update() {
        MP.update(this.root);

        const now = performance.now();
        const dt = Math.min(0.1, (now - this.lastUpdateTime) / 1000);
        this.lastUpdateTime = now;

        // Follow the predicted position closely; the smoothing only hides corrections
        const smoothing = 1 - Math.exp(-dt * 30);
        for (const [playerId, cursor] of MP.remoteCursors) {
            const target = predictCursor(cursor, now);
            if (!target) {
                continue;
            }
            const shown = this.displayedCursors.get(playerId);
            if (!shown || Math.hypot(target.x - shown.x, target.y - shown.y) > 3000) {
                // First sample or a jump across the map: no sliding
                this.displayedCursors.set(playerId, target);
            } else {
                shown.x += (target.x - shown.x) * smoothing;
                shown.y += (target.y - shown.y) * smoothing;
            }
        }
        for (const playerId of this.displayedCursors.keys()) {
            if (!MP.remoteCursors.has(playerId)) {
                this.displayedCursors.delete(playerId);
                this.ghostEntities.delete(playerId);
            }
        }

        this.updatePlayerList();
    }

    /**
     * Draws the other players' cursors and what they hold (world space)
     * @param {import("../../../core/draw_parameters").DrawParameters} parameters
     */
    draw(parameters) {
        if (!MP.isActive(this.root) || this.displayedCursors.size === 0) {
            return;
        }

        const ctx = parameters.context;
        const scale = 1 / Math.max(0.1, parameters.zoomLevel);
        const now = performance.now();
        const drawRect = parameters.visibleRect.expandedInAllDirections(200 * scale);

        for (const [playerId, pos] of this.displayedCursors) {
            const cursor = MP.remoteCursors.get(playerId);
            if (!cursor || !drawRect.containsPoint(pos.x, pos.y)) {
                continue;
            }
            const player = MP.getPlayer(playerId);
            const color = getPlayerColor(playerId);
            const otherLayer = cursor.layer !== this.root.currentLayer;
            const idle = now - cursor.receivedAt > CURSOR_IDLE_FADE_MS;

            // What they are about to place, like the own placement preview
            if (cursor.selection && "building" in cursor.selection && !otherLayer) {
                this.drawRemotePlacement(parameters, playerId, pos, cursor.selection, color);
            }

            ctx.save();
            ctx.translate(pos.x, pos.y);
            ctx.scale(scale, scale);
            ctx.globalAlpha = otherLayer || idle ? 0.45 : 1;

            if (cursor.selection && "blueprint" in cursor.selection) {
                this.drawBlueprintTag(ctx);
            }

            // Arrow
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, 18);
            ctx.lineTo(4.5, 14);
            ctx.lineTo(8, 21);
            ctx.lineTo(11, 19.5);
            ctx.lineTo(7.5, 12.8);
            ctx.lineTo(13, 12.5);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 1.5;
            ctx.fill();
            ctx.stroke();

            // Name tag
            if (player) {
                const label = player.name + (otherLayer ? " (" + cursor.layer + ")" : "");
                ctx.font = "bold 12px GameFont";
                const width = ctx.measureText(label).width;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.roundRect(14, 18, width + 10, 18, 4);
                ctx.fill();
                ctx.fillStyle = "#fff";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(label, 19, 27.5);
            }

            ctx.restore();
        }
    }

    /**
     * Small "Blueprint" tag next to the cursor (cursor space, unscaled)
     * @param {CanvasRenderingContext2D} ctx
     */
    drawBlueprintTag(ctx) {
        ctx.font = "bold 11px GameFont";
        const label = "Blueprint";
        const width = ctx.measureText(label).width;
        ctx.fillStyle = "rgba(74, 163, 223, 0.9)";
        ctx.beginPath();
        ctx.roundRect(16, -14, width + 10, 16, 4);
        ctx.fill();
        ctx.fillStyle = "#fff";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(label, 21, -5.5);
    }

    /**
     * Returns a fake entity to draw another player's placement preview with
     * @param {number} playerId
     * @param {import("../../meta_building").MetaBuilding} building
     * @param {string} variant
     */
    getGhostEntity(playerId, building, variant) {
        const key = building.getId() + "/" + variant;
        const cached = this.ghostEntities.get(playerId);
        if (cached && cached.key === key) {
            return cached.entity;
        }

        // Same setup as the building placer
        const entity = new Entity(null);
        building.setupEntityComponents(entity, null);
        entity.addComponent(
            new StaticMapEntityComponent({
                origin: new Vector(0, 0),
                rotation: 0,
                tileSize: building.getDimensions(variant).copy(),
                code: getCodeFromBuildingData(building, variant, 0),
            })
        );
        building.updateVariants(entity, 0, variant);
        entity.layer = building.getLayer();

        this.ghostEntities.set(playerId, { key, entity });
        return entity;
    }

    /**
     * Draws the building another player holds where they would place it (world space)
     * @param {import("../../../core/draw_parameters").DrawParameters} parameters
     * @param {number} playerId
     * @param {{ x: number, y: number }} pos
     * @param {{ building: string, variant: string, rotation: number }} selection
     * @param {string} color
     */
    drawRemotePlacement(parameters, playerId, pos, selection, color) {
        if (!gMetaBuildingRegistry.hasId(selection.building)) {
            return;
        }
        const building = gMetaBuildingRegistry.findById(selection.building);
        if (!building.getAvailableVariants(this.root).includes(selection.variant)) {
            return;
        }

        const tileSize = globalConfig.tileSize;
        const tile = new Vector(Math.floor(pos.x / tileSize), Math.floor(pos.y / tileSize));
        const { rotation, rotationVariant } = building.computeOptimalDirectionAndRotationVariantAtTile({
            root: this.root,
            tile,
            rotation: selection.rotation,
            variant: selection.variant,
            layer: building.getLayer(),
        });

        const entity = this.getGhostEntity(playerId, building, selection.variant);
        const staticComp = entity.components.StaticMapEntity;
        staticComp.origin = tile;
        staticComp.rotation = rotation;
        building.updateVariants(entity, rotationVariant, selection.variant);
        staticComp.code = getCodeFromBuildingData(building, selection.variant, rotationVariant);

        // Outline in the player's color, so it's clearly not your own preview
        const ctx = parameters.context;
        const bounds = staticComp.getTileSpaceBounds();
        const inset = 3;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(
            bounds.x * tileSize + inset,
            bounds.y * tileSize + inset,
            bounds.w * tileSize - 2 * inset,
            bounds.h * tileSize - 2 * inset,
            4
        );
        ctx.stroke();
        ctx.globalAlpha = 0.12;
        ctx.fill();

        // Transparent building that follows the cursor, like when placing yourself
        ctx.globalAlpha = 0.55;
        const sprite = building.getBlueprintSprite(rotationVariant, selection.variant);
        staticComp.origin = new Vector(pos.x / tileSize - 0.5, pos.y / tileSize - 0.5);
        staticComp.drawSpriteOnBoundsClipped(parameters, sprite);
        staticComp.origin = tile;

        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
    }
}
