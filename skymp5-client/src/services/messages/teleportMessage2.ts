import { MsgType } from "../../messages";
import { Transform } from "../../sync/movement";

export interface TeleportMessage2 {
    t: MsgType.Teleport2;
    pos: number[];
    rot: number[];
    worldOrCell: number;
    teleportPointFallback?: Transform;
}
