# shapez CE – Multiplayer (unofficial fork) <img src="./electron/favicon.png" alt="shapez Logo" align="right" height="40">

<!-- prettier-ignore -->
> [!WARNING]
> **This is an unofficial fork** of [shapez Community Edition](https://github.com/tobspr-games/shapez-community-edition)
> that adds cooperative multiplayer. It is not made, endorsed or supported by tobspr Games
> or the CE team, so please don't report bugs of this fork to them.
>
> Only the source code is published here, under the GPL-3.0 like the original. There are no
> downloads and nothing is sold. The art and sounds belong to tobspr Games. If you like the game,
> [buy shapez](https://store.steampowered.com/app/1318690/shapez/).

2–4 players build in the **same world**: one shared factory, shared hub progress, upgrades and
markers. You see the other players' cursors and what they are about to place. Players who are
off screen are listed next to your markers in the top right; click one to jump to them.

**Contents**

1. [Install](#1-install)
2. [Play together](#2-play-together)
3. [Update](#3-update)
4. [Troubleshooting](#4-troubleshooting)

## 1. Install

For **Windows 10/11**. The game is built on your PC from its source code; one command does
everything.

1. Open **PowerShell**: press the <kbd>Windows</kbd> key, type `PowerShell` and press <kbd>Enter</kbd>.
2. Paste this command (right-click pastes in PowerShell) and press <kbd>Enter</kbd>:

    ```powershell
    irm https://raw.githubusercontent.com/Xeenon77/shapez-community-edition-multiplayer/master/setup.ps1 | iex
    ```

3. Wait until it says **Done!** The first time takes about 10–15 minutes, most of it downloads.
   If Windows asks whether an installer may make changes to your PC, click **Yes**.
4. The game starts by itself, and from now on you start it with **shapez Multiplayer** on your
   desktop.
5. The first time you host or join, Windows asks whether the game may use the network.
   Allow it for **private networks**. Without that, you can't find or host games.

What the command does ([read the script](setup.ps1)): it installs the free tools needed to
build the game if they're missing (Git, Node.js 22, Java and FFmpeg, via `winget`), downloads
the code to `C:\Users\<you>\shapez-community-edition-multiplayer`, builds the game and creates
the desktop shortcut. Your normal shapez saves are not touched; this version keeps its own saves.

<details>
<summary>Prefer to do it step by step?</summary>

Run these in PowerShell, one at a time:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.22 -e
winget install --id EclipseAdoptium.Temurin.21.JRE -e
winget install --id Gyan.FFmpeg -e
```

Close PowerShell, open a new one, then:

```powershell
git clone https://github.com/Xeenon77/shapez-community-edition-multiplayer.git
cd shapez-community-edition-multiplayer
npm ci
npm ci --prefix electron
npm run package-win32-x64
```

The game is then in `build_output\standalone\shapez-win32-x64\shapezio.exe`.

</details>

## 2. Play together

### Host a game (one player)

1. Click **Play** (or continue a save) to get into a game.
2. Press <kbd>Esc</kbd> and click **Host multiplayer** below the three buttons.
3. Your Steam name is filled in; you can change it. Optionally set a password, then click **Host**.

The world stays on the host's PC and is saved there as usual. Press <kbd>Esc</kbd> to see who is
playing; click the card to see the addresses or to stop hosting.

### Join a game (everybody else)

1. In the main menu, click **Join multiplayer**.
2. Games on your network show up in the list by themselves. Click one to join.
   Games with a lock ask for the password first; it is remembered for next time.
3. If the game doesn't show up, ask the host for their address: they find it under <kbd>Esc</kbd> →
   card → address list. Then open **Advanced options**, type the address and click **Join**.

Nothing from the host's world is saved on your side. If the host leaves, you can choose
**Save local copy** to keep the world as one of your own saves.

### Not on the same network?

All players need to be in the same network. If you're not at the same place, connect your PCs
with a tool that puts them into one virtual network, for example
[Tailscale](https://tailscale.com/download). The host's game then shows up in the join list
like on a local network.

### Good to know

-   Everybody needs the **same version** of the game. If the versions differ, joining fails with
    _"The host runs a different game version"_. Then all of you [update](#3-update).
-   The game doesn't pause while menus are open, because the others keep playing.
-   Opening the settings during a session leaves the game (the game asks first).
-   Items on belts can look slightly different for each player. Buildings, hub progress and upgrades
    are always the host's, and players who drift out of sync are corrected automatically.
-   The Puzzle DLC is single-player only.

## 3. Update

Run the [install command](#1-install) again. It downloads the newest version, rebuilds the game
and keeps your saves. If the game is running, it asks you to close it first.

## 4. Troubleshooting

| Problem                                                                                              | Fix                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `winget` is not recognized                                                                           | Install **App Installer** from the Microsoft Store, then run the command again.                                                                                                                                                                           |
| A tool "could not be installed"                                                                      | Restart the PC and run the command again. If it still fails, run the `winget install` line from the error message yourself.                                                                                                                               |
| Downloading or installing the dependencies failed (`ENOTFOUND`, `ETIMEDOUT`, `gifsicle`, `pngquant`) | The setup already retries three times. Check your internet connection and run the command again; downloads continue where they stopped.                                                                                                                   |
| The build fails with `EBUSY` or `EPERM`                                                              | The game is still running. Close it and run the command again.                                                                                                                                                                                            |
| The game doesn't show up in the join list                                                            | All PCs must be in the same network, the host must be hosting, and Windows must allow the game on private networks: Start → _Allow an app through Windows Firewall_ → enable **shapezio** for **Private**. Or join by address under **Advanced options**. |
| _"Wrong password"_                                                                                   | Ask the host for the password. The game asks again with an empty field.                                                                                                                                                                                   |
| _"The host runs a different game version"_                                                           | Everybody [updates](#3-update) to the newest version.                                                                                                                                                                                                     |

### Sharing a build instead

If one person has built the game, they can zip the whole
`build_output\standalone\shapez-win32-x64` folder and send it to their friends directly. Everybody
then has the same version without installing anything. When starting it, Windows may show
_"Windows protected your PC"_ because the game isn't signed; click **More info** → **Run anyway**.
Please share it only with friends who own shapez, and don't upload it publicly.

## For developers

The multiplayer code lives in `src/js/multiplayer/` (renderer) and `electron/src/multiplayer/`
(relay server and network discovery). How it works:

-   The host's game runs a small WebSocket relay in the Electron main process and announces itself
    on the local network (UDP broadcast on port `24681`).
-   Clients never change the world themselves: placing, deleting, pasting blueprints, buying
    upgrades and editing levers, signals or markers become _intents_ that go to the host.
-   The host applies them with the normal game logic and broadcasts the changed buildings, the
    hub state and the markers. Every 10 seconds the structure is compared and clients that drifted
    get a resync.

Development mode (rebuilds on every code change):

```bash
npm run gulp
```

Then, in a second terminal, start one or more game windows. `--mp-profile` gives each window its
own saves and settings, so you can host in one and join from the other:

```bash
cd electron && npx tsc && npx electron . --mp-profile=a
```

```bash
cd electron && npx electron . --mp-profile=b
```

The end-to-end test starts a host and a client, joins them over `127.0.0.1` and checks placing,
deleting, blueprints, upgrades, markers, cursors and checksums (needs `npm run gulp` running):

```bash
npm run test:multiplayer
```

Don't run `npm run package-win32-x64` while `npm run gulp` is running; both write to the
`build` folder.

---

_The original shapez CE readme follows._

# shapez Community Edition

**shapez Community Edition** (abbreviated as **CE**) is a community-maintained version of [shapez](https://store.steampowered.com/app/1318690/shapez/)!

CE was created as the tobspr Games team moved away from shapez to work full-time on the upcoming [Shapez 2](https://store.steampowered.com/app/2162800/shapez_2/).
CE aims to:

-   Continue the development of shapez as guided by the community.
-   Allow contributors to continue submitting new features and improvements to the game.
-   Provide an experimental and forgiving environment for faster development.

> [!IMPORTANT]
> CE is different from the official game published on Steam and other platforms.
> CE was forked off of the official shapez, which has [its own repository](https://github.com/tobspr-games/shapez.io).
> No plans exist to merge the two versions of shapez.

As of now, CE must be built from source and supports only a standalone build,
with no plans for re-supporting a web version.
In the future, builds of CE may provided for owners of the full version of shapez.

## Contributing

We communicate on the [official shapez Discord server](https://discord.com/invite/HN7EVzV).
For historical reasons, we have communicated in a private channel,
but we are moving to the public `#contributing` channel.
If you would like to contribute to CE, feel free to share your ideas, plans, etc. there.

In our current workflow, we (the "collaborators" of the repository) create internal branches and corresponding pull requests to work on a feature, refactor, etc.
We discuss changes in the Discord, and when 2 collaborators (including the PR creator) approve of a change, it can be merged.
See our existing [pull requests](https://github.com/tobspr-games/shapez-community-edition/pulls?q=) for examples.

If you are not a collaborator and want to submit a change,
you can fork our repo and make a pull request.
Note that because of plans to overhaul many parts of the game,
unless you are improving translations, you should probably communicate with us on Discord!

> [!TIP]
> Be aware that [pull requests to the official shapez repository](https://github.com/tobspr-games/shapez.io/pulls) are unlikely to get merged in the near future. Instead, submit them to CE!
> In fact, because the game is licensed under the [GNU GPL v3.0](https://www.gnu.org/licenses/gpl-3.0.html),
> existing pull requests can be resubmitted to CE even if you aren't the author! **This is not legal advice.**

### Code

The game uses a custom engine originally based on the YORG.io 3 game engine.
The code within the engine is relatively clean with some code for the actual game on top being hacky.

We are in the process of migrating to TypeScript and JSX/TSX.
New changes should be implemented in TypeScript if possible,
but because we are planning on overhauling many parts of the game,
there is no need to convert existing code to TypeScript.

This project is fine with using cutting-edge and bleeding-edge features
and does not intend to provide compatibility for older clients.

## Building

### Prerequisites

-   [Node.js](https://nodejs.org)
-   [ffmpeg](https://www.ffmpeg.org/download.html) for audio transcoding
-   [Java](https://www.oracle.com/java/technologies/downloads/) (or [OpenJDK](https://openjdk.org/)) to run the texture packer

### Development

-   Run `npm i` in the root folder and in `electron/`.
-   Run `npm run gulp` in the root folder to build and serve files.
    If a new browser tab opens, ignore it.
-   Open a new terminal and run `npm start` in `electron/` to open an Electron window.
    -   Use `npm start -- --dev` to run in development mode.
    -   Tip: If you open the Electron window too early, you can reload it when focused on DevTools.

### Release

-   Run `npm i` in the root folder and in `electron/`.
-   In the root folder, run `npm run package-$PLATFORM-$ARCH` where:
    -   `$PLATFORM` is `win32`, `linux` or `darwin` depending on your system.
    -   `$ARCH` is the target system architecture (`x64` or `arm64`)
-   The build will be found under `build_output/standalone` as `shapez-...`.

### Building with Docker

You can build without installing Node, Java, or ffmpeg on the host. From the repo root, build the image and run a package task with a volume so output appears in `build_output/` on your machine:

```bash
docker build -t shapez-ce-builder .
docker run --rm -v "$(pwd)/build_output:/output" shapez-ce-builder package.standalone.linux-x64
```

On Apple Silicon add `--platform linux/amd64` to the build command. For other targets use e.g. `package.standalone.win32-x64`. Darwin builds are best done on macOS.

## Credits

Thanks to [tobspr](https://tobspr.io) for creating this project!

[<img src="https://i.imgur.com/uA2wcUy.png" alt="tobspr Games">](https://tobspr.io)
