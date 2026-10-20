import { execFile } from "node:child_process";
import net from "node:net";

/**
 * Connection diagnostics: why can't a player join?
 *  - probeHost: can this PC open a connection to the host at all?
 *  - checkFirewall: does Windows Firewall let other PCs connect to this game?
 *  - allowInFirewall: replaces the game's firewall rules with one that allows it
 *    (asks for admin rights through the normal Windows prompt)
 */

const PROBE_TIMEOUT_MS = 4000;

export type ProbeResult =
    | { status: "ok"; info: unknown }
    | { status: "timeout" | "refused" | "unreachable" | "error"; code?: string };

/**
 * Opens a plain TCP connection to the host and asks for the session info
 */
export async function probeHost(host: string, port: number): Promise<ProbeResult> {
    const tcp = await new Promise<ProbeResult>(resolve => {
        const socket = net.connect({ host, port });
        const done = (result: ProbeResult) => {
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(PROBE_TIMEOUT_MS, () => done({ status: "timeout" }));
        socket.once("connect", () => done({ status: "ok", info: null }));
        socket.once("error", (err: NodeJS.ErrnoException) => {
            switch (err.code) {
                case "ECONNREFUSED":
                    return done({ status: "refused" });
                case "ETIMEDOUT":
                    return done({ status: "timeout" });
                case "EHOSTUNREACH":
                case "ENETUNREACH":
                case "ENOTFOUND":
                case "EADDRNOTAVAIL":
                    return done({ status: "unreachable", code: err.code });
                default:
                    return done({ status: "error", code: err.code });
            }
        });
    });
    if (tcp.status !== "ok") {
        return tcp;
    }

    try {
        const urlHost = host.includes(":") ? `[${host}]` : host;
        const response = await fetch(`http://${urlHost}:${port}/info`, {
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return { status: "ok", info: response.ok ? await response.json() : null };
    } catch {
        return { status: "ok", info: null };
    }
}

export interface FirewallNetwork {
    name: string;
    alias: string;
    /** Public, Private or DomainAuthenticated */
    category: string;
    status: "allowed" | "blocked" | "no-rule";
}

export type FirewallReport =
    | { supported: false }
    | { supported: true; ok: boolean; networks: FirewallNetwork[]; program: string };

function runPowerShell(script: string, timeout = 20000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
            { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))
        );
    });
}

const quotePs = (value: string) => "'" + value.replace(/'/g, "''") + "'";

const asArray = <T>(value: T | T[] | null | undefined): T[] =>
    value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * Checks whether Windows Firewall lets other PCs connect to this game, for
 * every network this PC is connected to
 */
export async function checkFirewall(program = process.execPath): Promise<FirewallReport> {
    if (process.platform !== "win32") {
        return { supported: false };
    }

    const script = `
        $exe = ${quotePs(program)}
        $networks = @(Get-NetConnectionProfile | ForEach-Object {
            @{ name = "$($_.Name)"; alias = "$($_.InterfaceAlias)"; category = "$($_.NetworkCategory)" }
        })
        $rules = @(Get-NetFirewallApplicationFilter | Where-Object { $_.Program -ieq $exe } | ForEach-Object {
            $rule = $_ | Get-NetFirewallRule
            @{ enabled = "$($rule.Enabled)"; direction = "$($rule.Direction)"; action = "$($rule.Action)"; profile = "$($rule.Profile)" }
        })
        @{ networks = $networks; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
    `;

    const data = JSON.parse(await runPowerShell(script));
    type Rule = { enabled: string; direction: string; action: string; profile: string };
    const rules = asArray<Rule>(data.rules).filter(r => r.enabled === "True" && r.direction === "Inbound");

    const coversProfile = (rule: Rule, profile: string) =>
        rule.profile === "Any" || rule.profile.split(/,\s*/).includes(profile);

    const networks: FirewallNetwork[] = asArray<Omit<FirewallNetwork, "status">>(data.networks).map(n => {
        const profile = n.category === "DomainAuthenticated" ? "Domain" : n.category;
        // In Windows Firewall a block rule wins over an allow rule
        let status: FirewallNetwork["status"] = "no-rule";
        if (rules.some(r => r.action === "Block" && coversProfile(r, profile))) {
            status = "blocked";
        } else if (rules.some(r => r.action === "Allow" && coversProfile(r, profile))) {
            status = "allowed";
        }
        return { ...n, status };
    });

    return { supported: true, ok: networks.every(n => n.status === "allowed"), networks, program };
}

/**
 * Removes the game's firewall rules (including block rules from a dismissed
 * Windows prompt) and adds one that allows other PCs to connect. Windows asks
 * the player for admin rights first.
 * @returns whether it was done (false if the player declined)
 */
export async function allowInFirewall(program = process.execPath): Promise<boolean> {
    if (process.platform !== "win32") {
        return false;
    }
    const exe = program.replace(/"/g, "");
    const commands =
        `/c netsh advfirewall firewall delete rule name=all program="${exe}" & ` +
        `netsh advfirewall firewall add rule name="shapez Multiplayer" dir=in action=allow ` +
        `program="${exe}" enable=yes profile=any`;
    const script = `
        try {
            $process = Start-Process cmd.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ${quotePs(commands)}
            exit $process.ExitCode
        } catch {
            exit 1223
        }
    `;
    try {
        await runPowerShell(script, 120000);
        return true;
    } catch {
        return false;
    }
}
