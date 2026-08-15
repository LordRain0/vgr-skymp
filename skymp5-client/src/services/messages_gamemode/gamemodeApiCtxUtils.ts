import {
    Actor,
    Game,
    ObjectReference,
    PapyrusObject,
} from "skyrimPlatform";
import * as skyrimPlatform from "skyrimPlatform";

import { localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";
import { GamemodeApiCtx, GamemodeApiSafe } from "./gamemodeApiCtx";

const safeCall = <T>(fn: () => T, fallback: T): T => {
    try {
        return fn();
    } catch (e) {
        return fallback;
    }
};

const getPapyrusObject = (
    formOrId: number | PapyrusObject | null | undefined
): PapyrusObject | null => {
    if (!formOrId) {
        return null;
    }
    if (typeof formOrId === "number") {
        return safeCall(() => Game.getFormEx(formOrId), null);
    }
    return formOrId;
};

const gamemodeApiSafe: GamemodeApiSafe = {
    getFormEx: (formId: number) => safeCall(() => Game.getFormEx(formId), null),
    getObjectReference: (formOrId) =>
        safeCall(() => ObjectReference.from(getPapyrusObject(formOrId)), null),
    getActor: (formOrId) =>
        safeCall(() => Actor.from(getPapyrusObject(formOrId)), null),
    getBaseObject: (refr) => safeCall(() => refr ? refr.getBaseObject() : null, null),
    getDisplayName: (refr) => safeCall(() => refr ? refr.getDisplayName() : "", ""),
    getName: (form) => safeCall(() => form ? form.getName() : "", ""),
    getType: (form) => safeCall(() => form ? form.getType() : undefined, undefined),
};

const gamemodeApiCommonCtx = {
    sp: skyrimPlatform,
    safe: gamemodeApiSafe,
    getFormIdInServerFormat: (clientsideFormId: number) =>
        localIdToRemoteId(clientsideFormId),
    getMyFormIdInServerFormat: () => localIdToRemoteId(0x14, true),
    getFormIdInClientFormat: (serversideFormId: number) =>
        remoteIdToLocalId(serversideFormId),
};

export const getGamemodeApiCommonCtx = () => gamemodeApiCommonCtx;

export const clearGamemodeApiCtxVolatile = (
    ctx: Pick<GamemodeApiCtx, "refr" | "value" | "_model">
) => {
    ctx.refr = undefined;
    ctx.value = undefined;
    ctx._model = undefined;
};
