import { MODS } from "../mods/modloader";
import { Savegame } from "../savegame/savegame";

/**
 * @typedef {import("../application").Application} Application
 * @typedef {import("../game/root").GameRoot} GameRoot
 */

/**
 * In-memory savegame holding the world received from a multiplayer host.
 * It is never written to disk, so the client's own saves stay untouched.
 */
export class MultiplayerSavegame extends Savegame {
    /**
     * @param {Application} app
     * @param {any} dump
     */
    constructor(app, dump) {
        super(app, {
            internalId: "multiplayer",
            metaDataRef: {
                internalId: "multiplayer",
                lastUpdate: Date.now(),
                version: Savegame.getCurrentVersion(),
                level: dump?.hubGoals?.level ?? 0,
                name: "Multiplayer",
            },
        });

        this.currentData = {
            version: this.getCurrentVersion(),
            dump,
            lastUpdate: Date.now(),
            mods: MODS.getModsListForSavegame(),
        };
    }

    isSaveable() {
        return false;
    }

    writeAsync() {
        return Promise.resolve();
    }
}

/**
 * Stores the current state of a multiplayer game as a new local savegame
 * @param {GameRoot} root
 * @returns {Promise<void>}
 */
export function saveLocalCopy(root) {
    const savegame = root.app.savegameMgr.createNewSavegame();
    savegame.updateData(root);
    const date = new Date().toLocaleString();
    savegame.metaDataRef.name = "Multiplayer copy " + date;
    return savegame.writeSavegameAndMetadata();
}
