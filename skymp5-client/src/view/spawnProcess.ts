import { ObjectReference, Game, Actor, MotionType } from "skyrimPlatform";
import { Appearance, applyTints } from "../sync/appearance";
import { NiPoint3 } from "../sync/movement";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";

const getExactObjectReference = (formId: number): ObjectReference | null => {
  try {
    const refr = ObjectReference.from(Game.getFormEx(formId));
    return refr && refr.getFormID() === formId ? refr : null;
  } catch (_) {
    return null;
  }
};

export class SpawnProcess {
  constructor(
    appearance: Appearance | null,
    pos: NiPoint3,
    refrId: number,
    private callback: () => void,
  ) {
    const refr = getExactObjectReference(refrId);
    if (!refr) {
      return;
    }

    void refr.setPosition(...pos)
      .then(() => this.enable(appearance, refrId))
      .catch(() => {});
  }

  private enable(appearance: Appearance | null, refrId: number) {
    const refr = getExactObjectReference(refrId);
    if (!refr) {
      return;
    }

    const ac = Actor.from(refr);
    if (ac && appearance) {
      applyTints(ac, appearance);
    }
    void refr.enable(false)
      .then(() => this.resurrect(refrId))
      .catch(() => {});
  }

  private resurrect(refrId: number) {
    const refr = getExactObjectReference(refrId);
    if (!refr) {
      return;
    }

    const ac = Actor.from(refr);
    if (ac) {
      void ac.resurrect().then(() => {
        this.callback();
      }).catch(() => {});
      return;
    }

    const base = refr.getBaseObject();
    if (!base) {
      return;
    }

    ObjectReferenceEx.dealWithRef(refr, base);

    void refr.setMotionType(MotionType.Keyframed, true)
      .then(() => this.callback())
      .catch(() => {});
  }
}
