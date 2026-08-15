import {
  Cell,
  CellFullyLoadedEvent,
  Form,
  FormType,
  MoveAttachDetachEvent,
  ObjectLoadedEvent,
  ObjectReference,
  isPickupableItem as nativeIsPickupableItem,
} from "skyrimPlatform";
import { logError } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";

export class DisableClutterPhysicsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("objectLoaded", (e) => this.onObjectLoaded(e));
    this.controller.on("moveAttachDetach", (e) => this.onMoveAttachDetach(e));
    this.controller.on("cellFullyLoaded", (e) => this.onCellFullyLoaded(e));
    this.controller.on("update", () => this.processQueuedCellRefs());
  }

  private onObjectLoaded(e: ObjectLoadedEvent): void {
    if (!e.isLoaded) {
      return;
    }

    this.processRef(this.toObjectReference(e.object), "objectLoaded");
  }

  private onMoveAttachDetach(e: MoveAttachDetachEvent): void {
    if (!e.isCellAttached) {
      return;
    }

    this.processRef(e.movedRef, "moveAttachDetach");
  }

  private onCellFullyLoaded(e: CellFullyLoadedEvent): void {
    for (const formType of DisableClutterPhysicsService.clutterFormTypes) {
      this.queueCellRefs(e.cell, formType, "cellFullyLoaded");
    }
  }

  private queueCellRefs(
    cell: Cell | null,
    formType: FormType,
    source: string,
  ): void {
    if (!cell) {
      return;
    }

    const cellId = cell.getFormID();
    let numRefs = 0;
    try {
      numRefs = cell.getNumRefs(formType);
    } catch (e) {
      logError(this, source, "getNumRefs failed", e);
      return;
    }

    if (numRefs === 0) {
      return;
    }

    this.pendingCellScans.push({
      cellId,
      formType,
      nextIndex: 0,
      source,
    });
  }

  private processQueuedCellRefs(): void {
    let remainingRefs = DisableClutterPhysicsService.maxCellRefsPerUpdate;

    while (remainingRefs > 0 && this.pendingCellScans.length > 0) {
      const scan = this.pendingCellScans[0];
      const cell = this.lookupCell(scan.cellId);
      if (!cell) {
        this.pendingCellScans.shift();
        continue;
      }

      let numRefs = 0;
      try {
        numRefs = cell.getNumRefs(scan.formType);
      } catch (_) {
        this.pendingCellScans.shift();
        continue;
      }

      if (scan.nextIndex >= numRefs) {
        this.pendingCellScans.shift();
        continue;
      }

      const endIndex = Math.min(scan.nextIndex + remainingRefs, numRefs);

      for (; scan.nextIndex < endIndex; ++scan.nextIndex) {
        try {
          this.processRef(
            cell.getNthRef(scan.nextIndex, scan.formType),
            scan.source,
            scan.formType,
          );
        } catch (_) {
          this.pendingCellScans.shift();
          return;
        }

        --remainingRefs;
      }

      if (scan.nextIndex >= numRefs) {
        this.pendingCellScans.shift();
      }
    }
  }

  private processRef(
    ref: ObjectReference | null,
    source: string,
    knownBaseType?: FormType,
  ): void {
    if (!ref) {
      return;
    }

    let refId: number | null = null;
    try {
      refId = ref.getFormID();
      if (
        refId >= 0xff000000 ||
        this.inFlightRefs.has(refId) ||
        this.isIgnoredGeneratedPluginRef(refId)
      ) {
        return;
      }

      if (!this.shouldDisablePhysics(ref, knownBaseType)) {
        return;
      }

      const currentRefId = refId;
      this.inFlightRefs.add(currentRefId);
      void ref.setMotionType(this.sp.MotionType.Keyframed, false)
        .then(() => this.inFlightRefs.delete(currentRefId))
        .catch((e) => {
          this.inFlightRefs.delete(currentRefId);
          logError(
            this,
            source,
            "setMotionType failed",
            "ref",
            currentRefId.toString(16),
            e,
          );
        });
    } catch (e) {
      if (refId !== null) {
        this.inFlightRefs.delete(refId);
      }
      logError(
        this,
        source,
        "processRef failed",
        "ref",
        refId !== null ? refId.toString(16) : "unknown",
        e,
      );
    }
  }

  private lookupCell(cellId: number): Cell | null {
    try {
      const cell = this.sp.Cell.from(this.sp.Game.getFormEx(cellId));
      return cell?.getFormID() === cellId ? cell : null;
    } catch (_) {
      return null;
    }
  }

  private toObjectReference(form: Form | null): ObjectReference | null {
    try {
      return this.sp.ObjectReference.from(form);
    } catch (_) {
      return null;
    }
  }

  private shouldDisablePhysics(
    ref: ObjectReference,
    knownBaseType?: FormType,
  ): boolean {
    if (
      knownBaseType !== undefined &&
      knownBaseType !== FormType.Light
    ) {
      return DisableClutterPhysicsService.simplePhysicsFormTypes.has(
        knownBaseType,
      );
    }

    const base = this.getBaseObject(ref);
    if (!base) {
      return false;
    }

    const baseType = this.getFormType(base);
    if (baseType === null) {
      return false;
    }

    if (baseType === FormType.Light) {
      return this.isPickupableBase(base);
    }

    return DisableClutterPhysicsService.simplePhysicsFormTypes.has(
      baseType,
    );
  }

  private isPickupableBase(base: Form): boolean {
    const baseId = this.getFormId(base);
    if (baseId === null) {
      return false;
    }

    const cachedValue = this.pickupableBaseCache.get(baseId);
    if (cachedValue !== undefined) {
      return cachedValue;
    }

    let value = false;
    try {
      value = nativeIsPickupableItem(baseId);
    } catch (_) {
      value = false;
    }

    this.pickupableBaseCache.set(baseId, value);
    return value;
  }

  private getBaseObject(ref: ObjectReference): Form | null {
    try {
      return ref.getBaseObject();
    } catch (_) {
      return null;
    }
  }

  private getFormType(form: Form): FormType | null {
    try {
      return form.getType();
    } catch (_) {
      return null;
    }
  }

  private getFormId(form: Form): number | null {
    try {
      return form.getFormID();
    } catch (_) {
      return null;
    }
  }

  private isIgnoredGeneratedPluginRef(refId: number): boolean {
    this.ensureIgnoredGeneratedPluginIndexes();

    const fullIndex = refId >>> 24;
    if (fullIndex === 0xfe) {
      const lightIndex = (refId >>> 12) & 0xfff;
      return this.ignoredGeneratedLightPluginIndexes.has(lightIndex);
    }

    return this.ignoredGeneratedPluginIndexes.has(fullIndex);
  }

  private ensureIgnoredGeneratedPluginIndexes(): void {
    if (this.ignoredGeneratedPluginIndexesInitialized) {
      return;
    }

    this.ignoredGeneratedPluginIndexesInitialized = true;

    for (const filename of DisableClutterPhysicsService.ignoredGeneratedFullPluginNames) {
      try {
        const index = this.sp.Game.getModByName(filename);
        if (Number.isFinite(index) && index >= 0 && index < 0xfe) {
          this.ignoredGeneratedPluginIndexes.add(index);
        }
      } catch (_) {}
    }

    try {
      const lightModCount = this.sp.Game.getLightModCount();
      for (let index = 0; index < lightModCount; ++index) {
        const filename = this.sp.Game.getLightModName(index).toLowerCase();
        if (DisableClutterPhysicsService.ignoredGeneratedLightPluginNames.has(filename)) {
          this.ignoredGeneratedLightPluginIndexes.add(index);
        }
      }
    } catch (_) {}
  }

  private pendingCellScans: CellScan[] = [];
  private inFlightRefs = new Set<number>();
  private pickupableBaseCache = new Map<number, boolean>();
  private ignoredGeneratedPluginIndexesInitialized = false;
  private ignoredGeneratedPluginIndexes = new Set<number>();
  private ignoredGeneratedLightPluginIndexes = new Set<number>();

  private static readonly maxCellRefsPerUpdate = 64;

  private static readonly simplePhysicsFormTypesList = [
    FormType.Ammo,
    FormType.Armor,
    FormType.Book,
    FormType.Container,
    FormType.Ingredient,
    FormType.Potion,
    FormType.ScrollItem,
    FormType.SoulGem,
    FormType.Weapon,
    FormType.Misc,
  ];

  private static readonly simplePhysicsFormTypes = new Set<FormType>(
    DisableClutterPhysicsService.simplePhysicsFormTypesList,
  );

  private static readonly clutterFormTypes = [
    ...DisableClutterPhysicsService.simplePhysicsFormTypesList,
    FormType.Light,
  ];

  private static readonly ignoredGeneratedFullPluginNames = [
    "DynDOLOD.esm",
    "DynDOLOD.esp",
  ];

  private static readonly ignoredGeneratedLightPluginNames = new Set([
    "occlusion.esp",
  ]);
}

interface CellScan {
  cellId: number;
  formType: FormType;
  nextIndex: number;
  source: string;
}
