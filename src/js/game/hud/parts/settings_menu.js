import { InputReceiver } from "../../../core/input_receiver";
import { formatBigNumberFull, makeDiv } from "../../../core/utils";
import { MP } from "../../../multiplayer/session";
import { T } from "../../../translations";
import { BeltComponent } from "../../components/belt";
import { StaticMapEntityComponent } from "../../components/static_map_entity";
import { KEYMAPPINGS, KeyActionMapper } from "../../key_action_mapper";
import { BaseHUDPart } from "../base_hud_part";
import { DynamicDomAttach } from "../dynamic_dom_attach";

export class HUDSettingsMenu extends BaseHUDPart {
    createElements(parent) {
        this.background = makeDiv(parent, "ingame_HUD_SettingsMenu", ["ingameDialog"]);

        this.menuElement = makeDiv(this.background, null, ["menuElement"]);

        if (this.root.gameMode.hasHub()) {
            this.statsElement = makeDiv(
                this.background,
                null,
                ["statsElement"],
                `
            <strong>${T.ingame.settingsMenu.beltsPlaced}</strong><span class="beltsPlaced"></span>
            <strong>${T.ingame.settingsMenu.buildingsPlaced}</strong><span class="buildingsPlaced"></span>
            <strong>${T.ingame.settingsMenu.playtime}</strong><span class="playtime"></span>

            `
            );
        }

        this.buttonContainer = makeDiv(this.menuElement, null, ["buttons"]);

        const buttons = [
            {
                id: "continue",
                action: () => this.close(),
            },
            {
                id: "settings",
                action: () => this.goToSettings(),
            },
            {
                id: "menu",
                action: () => this.returnToMenu(),
            },
        ];

        for (let i = 0; i < buttons.length; ++i) {
            const { action, id } = buttons[i];

            const element = document.createElement("button");
            element.classList.add("styledButton");
            element.classList.add(id);
            this.buttonContainer.appendChild(element);

            this.trackClicks(element, action);
        }

        if (this.root.hud.parts.multiplayerOverlay) {
            // Hosting / joined state of the multiplayer session
            this.multiplayerCard = document.createElement("button");
            this.multiplayerCard.classList.add("styledButton", "multiplayerCard");
            this.multiplayerCardTitle = makeDiv(this.multiplayerCard, null, ["title"]);
            this.multiplayerCardDetails = makeDiv(this.multiplayerCard, null, ["details"]);
            this.menuElement.appendChild(this.multiplayerCard);
            this.multiplayerCardKey = null;

            this.trackClicks(this.multiplayerCard, () =>
                this.root.hud.parts.multiplayerOverlay.onSessionCardClicked()
            );
        }
    }

    /**
     * Updates the multiplayer card, players can join while the menu is open
     */
    updateMultiplayerCard() {
        if (!this.multiplayerCard) {
            return;
        }
        const { kind, title, details } = this.root.hud.parts.multiplayerOverlay.describeSession();
        const key = kind + title + details;
        if (key === this.multiplayerCardKey) {
            return;
        }
        this.multiplayerCardKey = key;
        this.multiplayerCard.dataset.kind = kind;
        this.multiplayerCardTitle.innerText = title;
        this.multiplayerCardDetails.innerText = details;
    }

    isBlockingOverlay() {
        return this.visible;
    }

    returnToMenu() {
        if (MP.isHost(this.root) && MP.players.length > 1) {
            const { ok } = this.root.hud.parts.dialogs.showWarning(
                "End multiplayer session?",
                "You are hosting. Leaving the game ends the session for everyone.",
                ["cancel:good:escape", "ok:bad:enter"]
            );
            ok.add(() => this.root.gameState.goBackToMenu());
            return;
        }
        this.root.gameState.goBackToMenu();
    }

    goToSettings() {
        this.root.gameState.goToSettings();
    }

    shouldPauseGame() {
        return this.visible;
    }

    shouldPauseRendering() {
        return this.visible;
    }

    initialize() {
        this.root.keyMapper.getBinding(KEYMAPPINGS.general.back).add(this.show, this);

        this.domAttach = new DynamicDomAttach(this.root, this.background, {
            attachClass: "visible",
        });

        this.inputReceiver = new InputReceiver("settingsmenu");
        this.keyActionMapper = new KeyActionMapper(this.root, this.inputReceiver);
        this.keyActionMapper.getBinding(KEYMAPPINGS.general.back).add(this.close, this);

        this.close();
    }

    show() {
        this.visible = true;
        this.root.app.inputMgr.makeSureAttachedAndOnTop(this.inputReceiver);

        const totalMinutesPlayed = Math.ceil(this.root.time.now() / 60);

        this.updateMultiplayerCard();

        if (this.root.gameMode.hasHub()) {
            /** @type {HTMLElement} */
            const playtimeElement = this.statsElement.querySelector(".playtime");
            /** @type {HTMLElement} */
            const buildingsPlacedElement = this.statsElement.querySelector(".buildingsPlaced");
            /** @type {HTMLElement} */
            const beltsPlacedElement = this.statsElement.querySelector(".beltsPlaced");

            playtimeElement.innerText = T.global.time.xMinutes.replace("<x>", `${totalMinutesPlayed}`);

            buildingsPlacedElement.innerText = formatBigNumberFull(
                this.root.entityMgr.getAllWithComponent(StaticMapEntityComponent).length -
                    this.root.entityMgr.getAllWithComponent(BeltComponent).length
            );

            beltsPlacedElement.innerText = formatBigNumberFull(
                this.root.entityMgr.getAllWithComponent(BeltComponent).length
            );
        }
    }

    close() {
        this.visible = false;
        this.root.app.inputMgr.makeSureDetached(this.inputReceiver);
        this.update();
    }

    cleanup() {
        super.cleanup();

        // Detach the input receiver when leaving InGameState
        this.root.app.inputMgr.makeSureDetached(this.inputReceiver);
    }

    update() {
        this.domAttach.update(this.visible);
        if (this.visible) {
            this.updateMultiplayerCard();
        }
    }
}
