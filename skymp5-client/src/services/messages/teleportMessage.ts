import { MsgType } from "../../messages";
import { Transform } from "../../sync/movement";

export interface TeleportMessage {
    t: MsgType.Teleport;
    idx: number;
    pos: number[];
    rot: number[];
    worldOrCell: number;
    teleportPointFallback?: Transform;
}
