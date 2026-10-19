// End-to-end test for multiplayer: starts two Electron instances (host and
// client) with separate profiles, joins them over 127.0.0.1 and checks that
// building, deleting, blueprints and upgrades end up identical on both.
//
// Requires the dev server: run `npm run gulp` in the repo root first.
// Usage: node tests/multiplayer/e2e.mjs [--keep-open] [--screenshots=<dir>]

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const electronDir = path.join(repoRoot, "electron");
const electronPath = createRequire(path.join(electronDir, "package.json"))("electron");

const args = process.argv.slice(2);
const keepOpen = args.includes("--keep-open");
const screenshotDir = args.find(a => a.startsWith("--screenshots="))?.split("=")[1] ?? null;

const PORT = 24690;
const runId = Date.now().toString(36);

let failures = 0;
function check(condition, message) {
    if (condition) {
        console.log("  ok   " + message);
    } else {
        failures++;
        console.log("  FAIL " + message);
    }
}

async function launch(profile) {
    const app = await _electron.launch({
        executablePath: electronPath,
        args: [".", `--mp-profile=${profile}`],
        cwd: electronDir,
    });
    const page = await app.firstWindow();
    if (process.env.MP_DEBUG) {
        for (const stream of [app.process().stdout, app.process().stderr]) {
            stream.on("data", data => {
                for (const line of String(data).split(/\r?\n/)) {
                    if (line.includes("mp-")) {
                        console.log(`    [${profile}] ${line.trim()}`);
                    }
                }
            });
        }
    }
    const errors = [];
    page.on("console", msg => {
        if (msg.type() === "error") {
            errors.push(msg.text());
        }
    });
    page.on("pageerror", err => errors.push("pageerror: " + err.message));
    const userData = await app.evaluate(({ app }) => app.getPath("userData"));
    return { app, page, errors, userData, profile };
}

/** Waits until the game runs and no dialog is open */
async function waitForGame(page) {
    await page.waitForFunction(() => window.globalRoot?.gameState?.stage === "s10_gameRunning", null, {
        timeout: 90000,
    });
    await closeDialogs(page);
}

async function closeDialogs(page) {
    await page.evaluate(() => {
        const dialogs = window.globalRoot.hud.parts.dialogs;
        for (const dialog of [...dialogs.dialogStack]) {
            dialogs.closeDialog(dialog);
        }
    });
}

/** Lists all buildings as comparable strings */
function listBuildings(page) {
    return page.evaluate(() => {
        const result = [];
        for (const [uid, entity] of window.globalRoot.entityMgr.getFrozenUidSearchMap()) {
            const s = entity.components.StaticMapEntity;
            if (s) {
                result.push(`${uid}@${s.origin.x},${s.origin.y} r${s.rotation} c${s.code}`);
            }
        }
        return result.sort();
    });
}

function entityAt(page, x, y, layer = "regular") {
    return page.evaluate(
        ([x, y, layer]) => {
            const entity = window.globalRoot.map.getLayerContentXY(x, y, layer);
            if (!entity) {
                return null;
            }
            const s = entity.components.StaticMapEntity;
            return { uid: entity.uid, rotation: s.rotation, code: s.code };
        },
        [x, y, layer]
    );
}

/**
 * Fills a dialog input. Dialogs move the focus one frame after opening, which
 * can redirect typed text, so wait for that and check the result.
 */
async function fillInput(page, formId, value) {
    const input = page.locator(`input[data-formid="${formId}"]`);
    await input.waitFor();
    await page.waitForTimeout(150);
    for (let attempt = 0; attempt < 3; ++attempt) {
        await input.fill(value);
        if ((await input.inputValue()) === value) {
            return;
        }
    }
    throw new Error(`Could not fill ${formId}`);
}

function waitFor(page, fn, arg, timeout = 5000) {
    return page
        .waitForFunction(fn, arg, { timeout })
        .then(() => true)
        .catch(() => false);
}

/** Places a building through the normal game logic (intercepted on clients) */
function placeBuilding(page, buildingId, x, y, rotation = 0) {
    return page.evaluate(
        ([buildingId, x, y, rotation]) => {
            const root = window.globalRoot;
            const meta = root.hud.parts.buildingsToolbar.buildingHandles[buildingId].metaBuilding;
            const origin = root.camera.center.copy();
            origin.x = x;
            origin.y = y;
            const { rotation: finalRotation, rotationVariant } =
                meta.computeOptimalDirectionAndRotationVariantAtTile({
                    root,
                    tile: origin,
                    rotation,
                    variant: "default",
                    layer: meta.getLayer(),
                });
            const entity = root.logic.tryPlaceBuilding({
                origin,
                rotation: finalRotation,
                rotationVariant,
                originalRotation: rotation,
                variant: "default",
                building: meta,
            });
            return { placedLocally: !!entity, sentToHost: root.logic.lastPlacementWasRemote };
        },
        [buildingId, x, y, rotation]
    );
}

async function screenshot(peer, name) {
    if (screenshotDir) {
        await fs.mkdir(screenshotDir, { recursive: true });
        await peer.page.screenshot({ path: path.join(screenshotDir, `${name}.png`) });
    }
}

async function main() {
    try {
        await fetch("http://localhost:3005/");
    } catch {
        console.error("Dev server not reachable on http://localhost:3005 - run `npm run gulp` first.");
        process.exit(2);
    }

    console.log("Compiling electron main process ...");
    execSync("npx tsc", { cwd: electronDir, stdio: "inherit" });

    console.log("Starting host and client ...");
    const host = await launch(`e2e-host-${runId}`);
    const client = await launch(`e2e-client-${runId}`);
    const peers = [host, client];

    try {
        // ---- Host: new game, then host it through the card in the pause menu
        await host.page.click(".playButton");
        await waitForGame(host.page);
        await host.page.keyboard.press("Escape");
        check(
            (await host.page.innerText("#ingame_HUD_SettingsMenu .multiplayerCard"))
                .toLowerCase()
                .includes("host multiplayer"),
            "pause menu offers hosting"
        );
        await host.page.click("#ingame_HUD_SettingsMenu .multiplayerCard");
        check(
            ((await host.page.inputValue('input[data-formid="mpName"]')) || "").length > 0,
            "host dialog has a default name"
        );
        await fillInput(host.page, "mpName", "Hosty");
        await fillInput(host.page, "mpPassword", "secret");
        await host.page.click(".ingameDialog .mpCollapsible .toggle");
        await fillInput(host.page, "mpPort", String(PORT));
        await host.page.click(".ingameDialog button:has-text('Host')");
        check(
            await waitFor(host.page, () => window.shapezMultiplayer.role === "host", null, 10000),
            "host started a session"
        );
        await closeDialogs(host.page);

        // ---- Client: the host shows up in the join dialog by itself
        await client.page.click(".joinMultiplayerButton");
        const discovered = client.page.locator(".mpGameList .game", { hasText: "Hosty" });
        check(
            await discovered
                .waitFor({ timeout: 10000 })
                .then(() => true)
                .catch(() => false),
            "client discovers the hosted game on the network"
        );
        check((await discovered.locator(".lock").count()) === 1, "discovered game shows a lock");
        check(
            (await client.page.locator('.ingameDialog input[data-formid="mpPassword"]').count()) === 0,
            "join dialog does not ask for a password up front"
        );
        const joinText = (await client.page.innerText(".ingameDialog")).toLowerCase();
        check(
            joinText.includes("games on your local network") && !joinText.includes("tailscale"),
            "join dialog talks about the local network only"
        );
        check(
            (await client.page.getAttribute('input[data-formid="mpName"]', "placeholder")) ===
                "Enter your name ...",
            "name field has a placeholder"
        );
        // The Join button is only for typed addresses
        const joinButton = ".ingameDialog button:has-text('Join')";
        check(!(await client.page.isVisible(joinButton)), "Join button is hidden without an address");
        await client.page.click(".ingameDialog .mpCollapsible .toggle");
        await fillInput(client.page, "mpAddress", "127.0.0.1:1");
        check(await client.page.isVisible(joinButton), "Join button appears once an address is typed");
        await fillInput(client.page, "mpAddress", "");
        await screenshot(client, "join-dialog");

        // Clicking a game with a password asks for it in a second step
        await fillInput(client.page, "mpName", "Clienty");
        await discovered.click();
        check(
            await client.page
                .locator('input[data-formid="mpPassword"]')
                .waitFor({ timeout: 5000 })
                .then(() => true)
                .catch(() => false),
            "password game asks for the password in a second step"
        );
        await screenshot(client, "password-dialog");

        // Wrong password first, then the right one
        await fillInput(client.page, "mpPassword", "wrong");
        await client.page.click(".ingameDialog button:has-text('Join')");
        check(
            await waitFor(
                client.page,
                () => document.body.innerText.toLowerCase().includes("wrong password, try again"),
                null,
                10000
            ),
            "wrong password is rejected"
        );
        await fillInput(client.page, "mpPassword", "secret");
        await client.page.click(".ingameDialog button:has-text('Join')");
        await waitForGame(client.page);
        check(
            await client.page.evaluate(() => window.shapezMultiplayer.role === "client"),
            "client joined and loaded the world"
        );
        check(
            await waitFor(host.page, () => window.shapezMultiplayer.players.length === 2),
            "host sees 2 players"
        );
        check(
            JSON.stringify(await listBuildings(host.page)) ===
                JSON.stringify(await listBuildings(client.page)),
            "initial world is identical"
        );
        check(
            await client.page.evaluate(
                () =>
                    (JSON.parse(localStorage.getItem("shapez-multiplayer-prefs")).passwords || {})[
                        "host:Hosty"
                    ] === "secret"
            ),
            "password is remembered"
        );

        // ---- Session cards in the pause menu
        await host.page.keyboard.press("Escape");
        const hostCard = (
            await host.page.innerText("#ingame_HUD_SettingsMenu .multiplayerCard")
        ).toLowerCase();
        check(
            hostCard.includes("hosting") && hostCard.includes("clienty"),
            "host card shows hosting and players"
        );
        await host.page.keyboard.press("Escape");
        await client.page.keyboard.press("Escape");
        const clientCard = (
            await client.page.innerText("#ingame_HUD_SettingsMenu .multiplayerCard")
        ).toLowerCase();
        check(clientCard.includes("joined hosty's game"), "client card shows the joined game");
        await screenshot(client, "client-pause-menu");
        await client.page.keyboard.press("Escape");
        await closeDialogs(host.page);
        await closeDialogs(client.page);

        // ---- Clients can't save, and settings explain how to get there
        check(
            await client.page.evaluate(() =>
                document.querySelector("#ingame_HUD_GameMenu .button.save").classList.contains("mpHidden")
            ),
            "save icon is hidden for the client"
        );
        check(
            !(await host.page.evaluate(() =>
                document.querySelector("#ingame_HUD_GameMenu .button.save").classList.contains("mpHidden")
            )),
            "save icon stays for the host"
        );
        await client.page.evaluate(() => window.globalRoot.gameState.goToSettings());
        check(
            await client.page.isVisible(".ingameDialog button:has-text('Go to settings')"),
            "settings dialog offers a Go to settings button"
        );
        await screenshot(client, "settings-blocked");
        await closeDialogs(client.page);

        // ---- Client places a belt
        const placed = await placeBuilding(client.page, "belt", 5, 3, 0);
        check(placed.sentToHost && !placed.placedLocally, "client placement is sent to the host");
        check(
            await waitFor(host.page, () => !!window.globalRoot.map.getLayerContentXY(5, 3, "regular")),
            "belt placed by client exists on host"
        );
        await waitFor(client.page, () => !!window.globalRoot.map.getLayerContentXY(5, 3, "regular"));
        const hostBelt = await entityAt(host.page, 5, 3);
        const clientBelt = await entityAt(client.page, 5, 3);
        check(hostBelt && clientBelt && hostBelt.uid === clientBelt.uid, "belt has the same uid on both");

        // ---- Client places a miner, host places a belt row next to it
        await placeBuilding(client.page, "miner", 8, 3, 0);
        for (let x = 5; x <= 7; ++x) {
            await placeBuilding(host.page, "belt", x, 4, 90);
        }
        check(
            await waitFor(
                client.page,
                () =>
                    !!window.globalRoot.map.getLayerContentXY(8, 3, "regular") &&
                    !!window.globalRoot.map.getLayerContentXY(7, 4, "regular")
            ),
            "miner (client) and belts (host) exist on client"
        );
        check(
            (await entityAt(host.page, 8, 3))?.uid === (await entityAt(client.page, 8, 3))?.uid,
            "miner has the same uid on both"
        );

        // ---- Client places belts with the real mouse (building placer)
        await client.page.evaluate(() => {
            const root = window.globalRoot;
            root.camera.desiredCenter = null;
            root.camera.center.x = 0;
            root.camera.center.y = 0;
            root.hud.parts.buildingPlacer.currentMetaBuilding.set(
                root.hud.parts.buildingsToolbar.buildingHandles.belt.metaBuilding
            );
        });
        const dragPath = await client.page.evaluate(() => {
            const root = window.globalRoot;
            const toScreen = (tx, ty) => {
                const v = root.camera.center.copy();
                v.x = tx * 32 + 16;
                v.y = ty * 32 + 16;
                const s = root.camera.worldToScreen(v);
                return { x: s.x, y: s.y };
            };
            return [toScreen(-6, 6), toScreen(-2, 6)];
        });
        await client.page.mouse.move(dragPath[0].x, dragPath[0].y);
        await client.page.mouse.down();
        await client.page.mouse.move(dragPath[1].x, dragPath[1].y, { steps: 10 });
        await client.page.mouse.up();
        await client.page.waitForTimeout(200);
        await client.page.evaluate(() => {
            const placer = window.globalRoot.hud.parts.buildingPlacer;
            placer.abortDragging();
            placer.currentMetaBuilding.set(null);
        });
        await closeDialogs(client.page);
        check(
            await waitFor(host.page, () =>
                [-6, -5, -4, -3, -2].every(x => !!window.globalRoot.map.getLayerContentXY(x, 6, "regular"))
            ),
            "belts dragged with the mouse on the client exist on host"
        );

        if (process.env.MP_DEBUG) {
            console.log("after drag:", await listBuildings(host.page));
        }

        // ---- Cursor presence
        await client.page.mouse.move(400, 300);
        await client.page.mouse.move(420, 320);
        check(
            await waitFor(host.page, () => window.shapezMultiplayer.remoteCursors.size > 0),
            "host sees the client's cursor"
        );
        await host.page.mouse.move(500, 400);
        await host.page.mouse.move(520, 420);
        check(
            await waitFor(client.page, () => window.shapezMultiplayer.remoteCursors.size > 0),
            "client sees the host's cursor"
        );
        if (process.env.MP_DEBUG) {
            console.log(
                await host.page.evaluate(() => ({
                    cursors: [...window.shapezMultiplayer.remoteCursors],
                    center: window.globalRoot.camera.center,
                    zoom: window.globalRoot.camera.zoomLevel,
                }))
            );
            await screenshot(host, "host-cursor");
            await screenshot(client, "client-cursor");
        }

        // ---- What a player holds is sent along with the cursor
        const clientId = await client.page.evaluate(() => window.shapezMultiplayer.playerId);
        await client.page.evaluate(() => {
            const root = window.globalRoot;
            root.hud.parts.buildingPlacer.currentMetaBuilding.set(
                root.hud.parts.buildingsToolbar.buildingHandles.belt.metaBuilding
            );
        });
        await client.page.mouse.move(700, 500);
        await client.page.mouse.move(720, 510);
        check(
            await waitFor(
                host.page,
                id => window.shapezMultiplayer.remoteCursors.get(id)?.selection?.building === "belt",
                clientId
            ),
            "host sees which building the client holds"
        );
        if (screenshotDir) {
            await host.page.evaluate(id => {
                const root = window.globalRoot;
                const pos = root.hud.parts.multiplayerOverlay.displayedCursors.get(id);
                root.camera.desiredCenter = null;
                root.camera.center.x = pos.x;
                root.camera.center.y = pos.y;
            }, clientId);
            await host.page.waitForTimeout(400);
            await screenshot(host, "host-sees-selection");
        }
        await client.page.evaluate(() =>
            window.globalRoot.hud.parts.buildingPlacer.currentMetaBuilding.set(null)
        );

        // ---- Players who are off screen show up in the marker list
        await host.page.evaluate(() => {
            const camera = window.globalRoot.camera;
            camera.desiredCenter = null;
            camera.center.x += 20000;
        });
        const offscreenEntry = host.page.locator("#ingame_HUD_Waypoints .mpPlayer", { hasText: "Clienty" });
        check(
            await offscreenEntry
                .waitFor({ timeout: 5000 })
                .then(() => true)
                .catch(() => false),
            "off-screen player is listed next to the markers"
        );
        await screenshot(host, "host-offscreen-player");
        await offscreenEntry.click();
        check(
            await waitFor(host.page, () => window.globalRoot.camera.desiredCenter !== null, null, 2000),
            "clicking the player moves the camera to them"
        );
        await host.page.waitForTimeout(1500);

        // ---- Markers are shared
        if (process.env.MP_DEBUG) {
            for (const peer of peers) {
                console.log(
                    "   ",
                    peer.profile,
                    JSON.stringify(
                        await peer.page.evaluate(() => ({
                            role: window.shapezMultiplayer.role,
                            status: window.shapezMultiplayer.status,
                            open: window.shapezMultiplayer.connection?.isOpen,
                            players: window.shapezMultiplayer.players.length,
                            stage: window.globalRoot.gameState.stage,
                        }))
                    )
                );
            }
        }
        await client.page.evaluate(() => {
            const root = window.globalRoot;
            const pos = root.camera.center.copy();
            pos.x = 640;
            pos.y = 320;
            root.hud.parts.waypoints.addWaypoint("Client marker", pos);
        });
        await host.page.evaluate(() => {
            const root = window.globalRoot;
            const pos = root.camera.center.copy();
            pos.x = -640;
            pos.y = 320;
            root.hud.parts.waypoints.addWaypoint("Host marker", pos);
        });
        // Runs in the page, so the labels are passed as argument
        const hasMarkers = labels =>
            labels.every(label =>
                window.globalRoot.hud.parts.waypoints.waypoints.some(w => w.label === label)
            );
        const markerLabels = ["Client marker", "Host marker"];
        check(
            await waitFor(host.page, hasMarkers, markerLabels),
            "marker created by the client exists on the host"
        );
        check(
            await waitFor(client.page, hasMarkers, markerLabels),
            "marker created by the host exists on the client"
        );
        await client.page.evaluate(() => {
            const waypoints = window.globalRoot.hud.parts.waypoints;
            waypoints.deleteWaypoint(waypoints.waypoints.find(w => w.label === "Host marker"));
        });
        check(
            await waitFor(
                host.page,
                () => !window.globalRoot.hud.parts.waypoints.waypoints.some(w => w.label === "Host marker")
            ),
            "marker deleted by the client is gone on the host"
        );

        // ---- Upgrades and blueprints need shapes: give the shared hub some
        await host.page.evaluate(() => {
            const root = window.globalRoot;
            root.hubGoals.gainedRewards.add("reward_blueprints");
            const upgrades = root.gameMode.getUpgrades();
            for (const requirement of upgrades.belt[0].required) {
                root.hubGoals.storedShapes[requirement.shape] = 100000;
            }
            root.hubGoals.storedShapes[root.gameMode.getBlueprintShapeKey()] = 100000;
        });
        check(
            await waitFor(
                client.page,
                () =>
                    window.globalRoot.hubGoals.isRewardUnlocked("reward_blueprints") &&
                    window.globalRoot.hubGoals.getShapesStoredByKey(
                        window.globalRoot.gameMode.getBlueprintShapeKey()
                    ) > 50000,
                null,
                4000
            ),
            "hub state reaches the client"
        );

        // ---- Client buys an upgrade
        const levelBefore = await host.page.evaluate(() =>
            window.globalRoot.hubGoals.getUpgradeLevel("belt")
        );
        await client.page.evaluate(() => window.globalRoot.hubGoals.tryUnlockUpgrade("belt"));
        check(
            await waitFor(
                host.page,
                before => window.globalRoot.hubGoals.getUpgradeLevel("belt") === before + 1,
                levelBefore
            ),
            "upgrade bought by client applies on host"
        );
        check(
            await waitFor(
                client.page,
                before => window.globalRoot.hubGoals.getUpgradeLevel("belt") === before + 1,
                levelBefore
            ),
            "upgrade level reaches the client"
        );

        // ---- Client pastes a blueprint of the host's belt row (5..7, 4) at offset +10 y
        const sourceUids = await host.page.evaluate(() =>
            [5, 6, 7].map(x => window.globalRoot.map.getLayerContentXY(x, 4, "regular").uid)
        );
        await client.page.evaluate(uids => {
            const root = window.globalRoot;
            root.hud.parts.blueprintPlacer.createBlueprintFromBuildings(uids, false);
            const blueprint = root.hud.parts.blueprintPlacer.currentBlueprint.get();
            const tile = root.camera.center.copy();
            tile.x = 6;
            tile.y = 14;
            blueprint.tryPlace(root, tile);
            root.hud.parts.blueprintPlacer.abortPlacement();
        }, sourceUids);
        check(
            await waitFor(client.page, () =>
                [5, 6, 7].every(x => !!window.globalRoot.map.getLayerContentXY(x, 14, "regular"))
            ),
            "blueprint pasted by client exists on client (via host)"
        );
        check(
            JSON.stringify(await entityAt(host.page, 6, 14)) ===
                JSON.stringify(await entityAt(client.page, 6, 14)),
            "blueprint entity identical on both"
        );

        // ---- Deletes in both directions
        await client.page.evaluate(() => {
            const root = window.globalRoot;
            root.logic.tryDeleteBuilding(root.map.getLayerContentXY(5, 3, "regular"));
            root.logic.tryDeleteBuilding(root.map.getLayerContentXY(8, 3, "regular"));
        });
        await host.page.evaluate(() => {
            const root = window.globalRoot;
            root.logic.tryDeleteBuilding(root.map.getLayerContentXY(7, 14, "regular"));
        });
        check(
            await waitFor(
                host.page,
                () =>
                    !window.globalRoot.map.getLayerContentXY(5, 3, "regular") &&
                    !window.globalRoot.map.getLayerContentXY(8, 3, "regular")
            ),
            "client deletes apply on host"
        );
        check(
            await waitFor(
                client.page,
                () =>
                    !window.globalRoot.map.getLayerContentXY(5, 3, "regular") &&
                    !window.globalRoot.map.getLayerContentXY(7, 14, "regular")
            ),
            "deletes reach the client"
        );

        await screenshot(host, "host");
        await screenshot(client, "client");

        // ---- Structure stays identical and the checksum never asked for a resync
        console.log("Waiting 25 s for checksum rounds ...");
        await client.page.waitForTimeout(25000);
        const hostList = await listBuildings(host.page);
        const clientList = await listBuildings(client.page);
        if (process.env.MP_DEBUG) {
            console.log("at end:", hostList);
        }
        check(
            JSON.stringify(hostList) === JSON.stringify(clientList),
            `structure identical after 25 s (${hostList.length} buildings)`
        );
        check(
            await client.page.evaluate(() => window.shapezMultiplayer.client.lastResyncRequest === -Infinity),
            "no checksum mismatch / resync was needed"
        );
        const hub = await Promise.all(
            peers.map(p =>
                p.page.evaluate(() => {
                    const h = window.globalRoot.hubGoals;
                    return JSON.stringify({ level: h.level, upgrades: h.upgradeLevels });
                })
            )
        );
        check(hub[0] === hub[1], "hub level and upgrades identical");

        // ---- Host leaves: client gets the disconnect dialog
        await host.page.evaluate(() => window.shapezMultiplayer.stop());
        check(
            await waitFor(
                client.page,
                () => document.body.innerText.toLowerCase().includes("save local copy"),
                null,
                10000
            ),
            "client is offered a local copy when the host leaves"
        );
        await screenshot(client, "client-disconnected");

        for (const peer of peers) {
            const relevant = peer.errors.filter(e => !e.includes("Failed to load resource"));
            check(relevant.length === 0, `no console errors on ${peer.profile}`);
            if (relevant.length > 0) {
                console.log("    " + relevant.slice(0, 10).join("\n    "));
            }
        }
    } finally {
        if (failures > 0) {
            for (const peer of peers) {
                for (const error of peer.errors.slice(0, 8)) {
                    console.log(`    [${peer.profile}] ${error.slice(0, 400)}`);
                }
            }
        }
        if (keepOpen) {
            console.log("--keep-open: leaving windows open, press Ctrl+C to exit");
            await new Promise(() => {});
        }
        for (const peer of peers) {
            await peer.app.close().catch(() => {});
            await fs.rm(peer.userData, { recursive: true, force: true }).catch(() => {});
        }
    }

    console.log(failures === 0 ? "\nAll multiplayer checks passed." : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
