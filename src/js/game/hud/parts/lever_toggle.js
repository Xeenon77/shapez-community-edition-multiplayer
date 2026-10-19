import { STOP_PROPAGATION } from "../../../core/signal";
import { Vector } from "../../../core/vector";
import { MP } from "../../../multiplayer/session";
import { enumMouseButton } from "../../camera";
import { BaseHUDPart } from "../base_hud_part";

export class HUDLeverToggle extends BaseHUDPart {
    initialize() {
        this.root.camera.downPreHandler.add(this.downPreHandler, this);
    }

    /**
     * @param {Vector} pos
     * @param {enumMouseButton} button
     */
    downPreHandler(pos, button) {
        const tile = this.root.camera.screenToWorld(pos).toTileSpace();
        const contents = this.root.map.getLayerContentXY(tile.x, tile.y, "regular");
        if (contents) {
            const leverComp = contents.components.Lever;
            if (leverComp) {
                if (button === enumMouseButton.left) {
                    if (MP.interceptsActions(this.root)) {
                        MP.sendIntent({
                            type: "configure",
                            uid: contents.uid,
                            component: "Lever",
                            data: { toggled: !leverComp.toggled },
                        });
                    } else {
                        leverComp.toggled = !leverComp.toggled;
                        MP.notifyEntityConfigChanged(this.root, contents);
                    }
                    return STOP_PROPAGATION;
                } else if (button === enumMouseButton.right) {
                    if (!this.root.hud.parts.buildingPlacer.currentMetaBuilding) {
                        this.root.logic.tryDeleteBuilding(contents);
                    }
                    return STOP_PROPAGATION;
                }
            }
        }
    }
}
