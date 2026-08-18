import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ChangeFormNpc } from "skyrimPlatform";
import { logError, logTrace } from "../../logging";

const summarizeChangeFormNpc = (changeFormNpc?: ChangeFormNpc): string => {
    if (!changeFormNpc) {
        return "<none>";
    }

    const face = changeFormNpc.face;
    return JSON.stringify({
        name: changeFormNpc.name ?? "<none>",
        raceId: changeFormNpc.raceId ? `0x${changeFormNpc.raceId.toString(16)}` : "<none>",
        hasFace: !!face,
        headTextureSetId: face?.headTextureSetId ? `0x${face.headTextureSetId.toString(16)}` : "<none>",
        headPartCount: face?.headPartIds?.length ?? 0,
        headPartIds: face?.headPartIds?.map((id) => `0x${id.toString(16)}`) ?? [],
        presetCount: face?.presets?.length ?? 0,
        bodySkinColor: face?.bodySkinColor ?? "<none>",
        hairColor: face?.hairColor ?? "<none>",
    });
};

export class LoadGameService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("loadGame", () => this.onLoadGame());
    }

    public loadGame(pos: number[], rot: number[], worldOrCell: number, changeFormNpc?: ChangeFormNpc, loadOrder?: string[], time?: { seconds: number, minutes: number, hours: number }) {
        logTrace(
            this,
            "loadGame requested",
            `worldOrCell=0x${worldOrCell.toString(16)}`,
            `pos=${JSON.stringify(pos)}`,
            `rot=${JSON.stringify(rot)}`,
            `loadOrderCount=${loadOrder?.length ?? 0}`,
            `time=${time ? JSON.stringify(time) : "<none>"}`,
            `changeFormNpc=${summarizeChangeFormNpc(changeFormNpc)}`,
        );

        try {
            // @ts-ignore
            this.sp.loadGame(pos, rot, worldOrCell, changeFormNpc, loadOrder, time);
        } catch (e) {
            logError(this, "loadGame with appearance failed, retrying without changeFormNpc", String(e));
            // Hotfix non-vanilla headparts bug
            try {
                // @ts-ignore
                this.sp.loadGame(pos, rot, worldOrCell, undefined, loadOrder, time);
            } catch (fallbackError) {
                logError(this, "loadGame without changeFormNpc failed", String(fallbackError));
                throw fallbackError;
            }
        }
        this._isCausedBySkyrimPlatform = true;
    }

    private onLoadGame() {
        try {
            const gameLoadEvent = {
                isCausedBySkyrimPlatform: this._isCausedBySkyrimPlatform
            };
            this.controller.emitter.emit("gameLoad", gameLoadEvent);
        } catch (e) {
            this.controller.once("tick", () => {
                this._isCausedBySkyrimPlatform = false;
            });
            throw e;
        }
        this.controller.once("tick", () => {
            this._isCausedBySkyrimPlatform = false;
        });
    }

    private _isCausedBySkyrimPlatform = false;
}
