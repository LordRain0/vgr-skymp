import { ObjectReference } from "@skyrim-platform/skyrim-platform";
import { FormViewArray } from "src/view/formViewArray";
import { FormModel } from "src/view/model";

import * as skyrimPlatform from "skyrimPlatform";

export interface GamemodeApiSafe {
    getFormEx: (formId: number) => skyrimPlatform.Form | null;
    getObjectReference: (
        formOrId: number | skyrimPlatform.PapyrusObject | null | undefined
    ) => skyrimPlatform.ObjectReference | null;
    getActor: (
        formOrId: number | skyrimPlatform.PapyrusObject | null | undefined
    ) => skyrimPlatform.Actor | null;
    getBaseObject: (
        refr: skyrimPlatform.ObjectReference | null | undefined
    ) => skyrimPlatform.Form | null;
    getDisplayName: (
        refr: skyrimPlatform.ObjectReference | null | undefined
    ) => string;
    getName: (form: skyrimPlatform.Form | null | undefined) => string;
    getType: (form: skyrimPlatform.Form | null | undefined) => number | undefined;
}

export interface GamemodeApiCtx {
    refr: ObjectReference | undefined;
    value: unknown;
    _model: FormModel | undefined;
    sp: typeof skyrimPlatform,
    safe: GamemodeApiSafe;
    state: Record<string, unknown> | undefined;
    _view: FormViewArray | undefined;
    i: number;
    getFormIdInServerFormat: (clientsideFormId: number) => number;
    getMyFormIdInServerFormat: () => number;
    getFormIdInClientFormat: (serversideFormId: number) => number;
    get: (propName: string) => unknown;
    respawn: () => void;
}
