import { app } from "electron";
import path from "node:path";

const disabledFeatures = ["HardwareMediaKeyHandling"];
app.commandLine.appendSwitch("disable-features", disabledFeatures.join(","));

export const defaultWindowTitle = "shapez CE";

// Allows running several instances side by side (e.g. to test multiplayer
// locally), each with its own saves and settings
const profile = app.commandLine.getSwitchValue("mp-profile");
if (/^[\w-]{1,32}$/.test(profile)) {
    app.setPath("userData", app.getPath("userData") + "-" + profile);
}

// This variable should be used to avoid situations where the app name
// wasn't set yet.
export const userData = app.getPath("userData");
export const executableDir = path.dirname(app.getPath("exe"));

export const pageUrl = app.isPackaged
    ? new URL("../index.html", import.meta.url).href
    : "http://localhost:3005/";

export const switches = {
    dev: app.commandLine.hasSwitch("dev"),
    safeMode: app.commandLine.hasSwitch("safe-mode"),
};
