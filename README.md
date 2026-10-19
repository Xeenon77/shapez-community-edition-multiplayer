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

1. [Install the tools](#1-install-the-tools-once)
2. [Download the game code](#2-download-the-game-code)
3. [Build the game](#3-build-the-game)
4. [Start the game](#4-start-the-game)
5. [Play together](#5-play-together)
6. [Update to a new version](#6-update-to-a-new-version)
7. [Troubleshooting](#7-troubleshooting)

The guide is for **Windows 10/11**. The first time takes about 15 minutes, most of it waiting for
downloads. Everybody who plays together needs to do this (or see
[Sharing a build](#sharing-a-build-instead)).

## 1. Install the tools (once)

The game is built on your PC from its source code. That needs four free tools.

1. Open **PowerShell**: press the <kbd>Windows</kbd> key, type `PowerShell` and press <kbd>Enter</kbd>.
2. Paste these commands one at a time (right-click pastes in PowerShell) and press <kbd>Enter</kbd>
   after each. Accept the questions that pop up with **Yes**.

    ```powershell
    winget install --id Git.Git -e
    ```

    ```powershell
    winget install --id OpenJS.NodeJS.22 -e
    ```

    ```powershell
    winget install --id EclipseAdoptium.Temurin.21.JRE -e
    ```

    ```powershell
    winget install --id Gyan.FFmpeg -e
    ```

    That's Git (downloads the code), Node.js 22 (builds the game), Java (packs the textures) and
    FFmpeg (converts the sounds). If a tool is already installed, winget says so; that's fine.

3. **Close PowerShell and open a new one**, so it finds the new tools.
4. Check that everything is there. Each command should print a version number:

    ```powershell
    git --version; node --version; java -version; ffmpeg -version
    ```

    `node --version` should start with `v22`. If a command says _"not recognized"_, see
    [Troubleshooting](#7-troubleshooting).

## 2. Download the game code

In PowerShell, run these commands one at a time. They put the game into a folder
`shapez-community-edition-multiplayer` in your user folder (e.g. `C:\Users\<you>`).

```powershell
cd ~
```

```powershell
git clone https://github.com/Xeenon77/shapez-community-edition-multiplayer.git
```

```powershell
cd shapez-community-edition-multiplayer
```

## 3. Build the game

Still in the same PowerShell window (inside the `shapez-community-edition-multiplayer` folder),
run these commands one at a time. Each one can take a few minutes; wait until the prompt
(`PS C:\...>`) comes back before running the next one. Warnings in yellow are normal.

```powershell
npm ci
```

```powershell
npm ci --prefix electron
```

```powershell
npm run package-win32-x64
```

The last command ends with a line like `Packages created: [ '..\build_output\standalone\shapez-win32-x64' ]`.
The game is now in this folder:

```
shapez-community-edition-multiplayer\build_output\standalone\shapez-win32-x64
```

## 4. Start the game

1. Open the folder above in the Explorer. You can also open it from PowerShell:

    ```powershell
    explorer build_output\standalone\shapez-win32-x64
    ```

2. Double-click **`shapezio.exe`**.
   Tip: right-click it → **Show more options** → **Send to** → **Desktop (create shortcut)**,
   so you can start it from the desktop next time.
3. The first time you host or join, Windows asks whether the game may use the network.
   Allow it for **private networks**. Without that, you can't find or host games.

Your normal shapez saves are not touched; this version keeps its own saves.

## 5. Play together

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
    _"The host runs a different game version"_. Then all of you [update](#6-update-to-a-new-version).
-   The game doesn't pause while menus are open, because the others keep playing.
-   Opening the settings during a session leaves the game (the game asks first).
-   Items on belts can look slightly different for each player. Buildings, hub progress and upgrades
    are always the host's, and players who drift out of sync are corrected automatically.
-   The Puzzle DLC is single-player only.

## 6. Update to a new version

Open PowerShell and run these commands one at a time:

```powershell
cd ~\shapez-community-edition-multiplayer
```

```powershell
git pull
```

```powershell
npm ci
```

```powershell
npm ci --prefix electron
```

```powershell
npm run package-win32-x64
```

Close the game before running the last command. Your saves are kept.

## 7. Troubleshooting

| Problem                                                          | Fix                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `winget` is not recognized                                       | Install **App Installer** from the Microsoft Store, then open a new PowerShell.                                                                                                                                                                           |
| `git`, `node`, `npm`, `java` or `ffmpeg` is not recognized       | Close PowerShell and open a new one. If it still fails, run its `winget install` command again, or restart the PC.                                                                                                                                        |
| PowerShell says running scripts is disabled (when running `npm`) | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, answer `Y`, then try again.                                                                                                                                                                    |
| The build fails with `spawn ffmpeg ENOENT` or a Java error       | FFmpeg or Java isn't found. Open a new PowerShell and check with `ffmpeg -version` and `java -version`.                                                                                                                                                   |
| The build fails with `EBUSY` or `EPERM`                          | The game is still running. Close it and run the command again.                                                                                                                                                                                            |
| The game doesn't show up in the join list                        | All PCs must be in the same network, the host must be hosting, and Windows must allow the game on private networks: Start → _Allow an app through Windows Firewall_ → enable **shapezio** for **Private**. Or join by address under **Advanced options**. |
| _"Wrong password"_                                               | Ask the host for the password. The game asks again with an empty field.                                                                                                                                                                                   |
| _"The host runs a different game version"_                       | Everybody [updates](#6-update-to-a-new-version) to the latest version.                                                                                                                                                                                    |

### Sharing a build instead

If one person has built the game, they can zip the whole `shapez-win32-x64` folder and send it to
their friends directly. Everybody then has the same version without installing the tools. When
starting it, Windows may show _"Windows protected your PC"_ because the game isn't signed; click
**More info** → **Run anyway**. Please share it only with friends who own shapez, and don't upload
it publicly.

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
