import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Finds a sensible default player name: the display name of the Steam account
 * that logged in last on this PC, or the system user name.
 */
export async function getDefaultPlayerName(): Promise<string | null> {
    const steamName = await readSteamPersonaName().catch(() => null);
    if (steamName) {
        return steamName;
    }
    try {
        return cleanName(os.userInfo().username);
    } catch {
        return null;
    }
}

function cleanName(name: string): string | null {
    const cleaned = name
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f<>&"'`]/g, "")
        .trim()
        .slice(0, 24);
    return cleaned.length > 0 ? cleaned : null;
}

async function readSteamPersonaName(): Promise<string | null> {
    for (const steamDir of await getSteamDirectories()) {
        let content: string;
        try {
            content = await fs.readFile(path.join(steamDir, "config", "loginusers.vdf"), "utf8");
        } catch {
            continue;
        }

        // "<steamid64>" { "AccountName" "..." "PersonaName" "..." "MostRecent" "1" ... }
        let fallback: string | null = null;
        for (const match of content.matchAll(/"\d{17}"\s*\{([^}]*)\}/g)) {
            const block = match[1]!;
            const persona = block.match(/"PersonaName"\s+"((?:[^"\\]|\\.)*)"/i)?.[1];
            if (!persona) {
                continue;
            }
            const name = cleanName(persona.replace(/\\(.)/g, "$1"));
            if (!name) {
                continue;
            }
            if (/"MostRecent"\s+"1"/i.test(block)) {
                return name;
            }
            fallback ??= name;
        }
        if (fallback) {
            return fallback;
        }
    }
    return null;
}

async function getSteamDirectories(): Promise<string[]> {
    const home = os.homedir();
    if (process.platform === "win32") {
        const fromRegistry = await new Promise<string | null>(resolve => {
            execFile(
                "reg",
                ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
                { timeout: 3000, windowsHide: true },
                (err, stdout) =>
                    resolve(err ? null : stdout.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1]?.trim() ?? null)
            );
        });
        return [fromRegistry, "C:\\Program Files (x86)\\Steam"].filter((dir): dir is string => !!dir);
    }
    if (process.platform === "darwin") {
        return [path.join(home, "Library", "Application Support", "Steam")];
    }
    return [
        path.join(home, ".steam", "steam"),
        path.join(home, ".local", "share", "Steam"),
        path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
    ];
}
