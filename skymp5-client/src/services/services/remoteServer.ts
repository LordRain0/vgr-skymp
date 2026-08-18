// @ts-expect-error (TODO: Remove in 2.10.0)
import { Actor, Form, FormType, Menu, interruptCast, castSpellImmediate, printConsole, applyAnimationVariablesToActor, ActorAnimationVariables } from 'skyrimPlatform';
import {
  Cell,
  Game,
  ObjectReference,
  TESModPlatform,
  Ui,
  Utility,
  WorldSpace,
  on, // TODO: use this.controller.on instead
  once, // TODO: use this.controller.once instead
  storage, // TODO: use this.sp.storage instead
} from 'skyrimPlatform';

import * as messages from '../../messages';

/* eslint-disable @typescript-eslint/no-empty-function */
import { ObjectReferenceEx } from '../../extensions/objectReferenceEx';
import { IdManager } from '../../lib/idManager';
import { nameof } from '../../lib/nameof';
import { setActorValuePercentage } from '../../sync/actorvalues';
import { applyAppearanceToPlayer } from '../../sync/appearance';
import { applyEquipment, isBadMenuShown, isRaceMenuKeepUnequipped, setRaceMenuKeepUnequipped } from '../../sync/equipment';
import { Entry, Inventory, applyInventory, getInventory } from '../../sync/inventory';
import { Movement } from '../../sync/movement';
import { learnShouts, unlockWords } from '../../sync/shout';
import { learnSpells, removeAllSpells } from '../../sync/spell';
import { ModelApplyUtils } from '../../view/modelApplyUtils';
import { FormModel, WorldModel } from '../../view/model';
import { LoadGameService } from './loadGameService';
import { getClientLoadOrder } from "./clientLoadOrder";
import { UpdateMovementMessage } from '../messages/updateMovementMessage';
import { ChangeValuesMessage } from '../messages/changeValuesMessage';
import { UpdateAnimationMessage } from '../messages/updateAnimationMessage';
import { UpdateEquipmentMessage } from '../messages/updateEquipmentMessage';
import { RagdollService } from './ragdollService';
import { UpdateAppearanceMessage } from '../messages/updateAppearanceMessage';
import { TeleportMessage } from '../messages/teleportMessage';
import { DeathStateContainerMessage } from '../messages/deathStateContainerMessage';
import { RespawnNeededError } from '../../lib/errors';
import { OpenContainerMessage } from '../messages/openContainerMessage';
import { ActivateMessage } from '../messages/activateMessage';
import { ClientListener, CombinedController, Sp } from './clientListener';
import { HostStartMessage } from '../messages/hostStartMessage';
import { HostStopMessage } from '../messages/hostStopMessage';
import { ConnectionMessage } from '../events/connectionMessage';
import { SetInventoryMessage } from '../messages/setInventoryMessage';
import { CreateActorMessage, CreateActorMessageAdditionalProps } from '../messages/createActorMessage';
import { DestroyActorMessage } from '../messages/destroyActorMessage';
import { SetRaceMenuOpenMessage } from '../messages/setRaceMenuOpenMessage';
import { UpdatePropertyMessage } from '../messages/updatePropertyMessage';
import { TeleportMessage2 } from '../messages/teleportMessage2';

// TODO: refactor worldViewMisc into service
import {
  getObjectReference,
  getViewFromStorage,
  remoteIdToLocalId,
} from '../../view/worldViewMisc';
import { TimeService } from './timeService';
import { logTrace, logError } from '../../logging';

import { SpellCastMessage } from '../messages/spellCastMessage';
import { UpdateAnimVariablesMessage } from '../messages/updateAnimVariablesMessage';
import { MsgType } from '../../messages';

export const getPcInventory = (): Inventory | undefined => {
  const res = storage['pcInv'];
  if (typeof res === 'object' && (res as any)['entries']) {
    return res as Inventory;
  }
  return undefined;
};

const setPcInventory = (inv: Inventory): void => {
  storage['pcInv'] = inv;
};

const getExactObjectReference = (formId: number): ObjectReference | null => {
  try {
    const refr = ObjectReference.from(Game.getFormEx(formId));
    return refr && refr.getFormID() === formId ? refr : null;
  } catch (_) {
    return null;
  }
};

type MovementTarget = {
  pos: number[];
  rot: number[];
  worldOrCell: number;
  teleportPointFallback?: MovementTarget;
};

const isResolvableWorldOrCell = (worldOrCell: number): boolean => {
  try {
    const form = Game.getFormEx(worldOrCell);
    if (!form) {
      return false;
    }
    return !!Cell.from(form) || !!WorldSpace.from(form);
  } catch (_) {
    return false;
  }
};

const resolveMovementTarget = (target: MovementTarget, context: string): MovementTarget => {
  if (isResolvableWorldOrCell(target.worldOrCell)) {
    return target;
  }

  const fallback = target.teleportPointFallback;
  if (!fallback) {
    logError("RemoteServer", `${context} world/cell is unresolved and no teleportPointFallback was provided`, target.worldOrCell.toString(16));
    return target;
  }

  if (!isResolvableWorldOrCell(fallback.worldOrCell)) {
    logError(
      "RemoteServer",
      `${context} world/cell and teleportPointFallback are both unresolved`,
      target.worldOrCell.toString(16),
      fallback.worldOrCell.toString(16),
    );
    return target;
  }

  logTrace(
    "RemoteServer",
    `using teleportPointFallback for ${context}`,
    target.worldOrCell.toString(16),
    "->",
    fallback.worldOrCell.toString(16),
  );

  return fallback;
};

const getExactActor = (formId: number): Actor | null => {
  const refr = getExactObjectReference(formId);
  return refr ? Actor.from(refr) : null;
};

let pcInvLastApply = 0;
let raceMenuKeepUnequippedSince = 0;
let raceMenuWasOpen = false;
let raceMenuOpenRequestId = 0;
let raceMenuOpenPending = false;

const raceMenuOpenRetryIntervalSeconds = 1;

const getInventoryEntryKey = (entry: Entry): string => JSON.stringify({
  baseId: entry.baseId,
  health: entry.health,
  enchantmentId: entry.enchantmentId,
  maxCharge: entry.maxCharge,
  removeEnchantmentOnUnequip: !!entry.removeEnchantmentOnUnequip,
  chargePercent: entry.chargePercent,
  name: entry.name,
  soul: entry.soul,
  poisonId: entry.poisonId,
  poisonCount: entry.poisonCount,
});

const getInventoryWithoutWornState = (inventory: Inventory): Inventory => {
  const entries = new Map<string, Entry>();

  inventory.entries.forEach((entry) => {
    const res = { ...entry };
    delete res.worn;
    delete res.wornLeft;

    const key = getInventoryEntryKey(res);
    const existing = entries.get(key);
    if (existing) {
      existing.count += res.count;
    } else {
      entries.set(key, res);
    }
  });

  return { entries: Array.from(entries.values()).filter((entry) => entry.count !== 0) };
};

const shouldSuppressPcInventoryApplyForRaceMenu = (): boolean => {
  return isRaceMenuKeepUnequipped() || Ui.isMenuOpen('RaceSex Menu');
};

const getPcInventoryForStorage = (inventory: Inventory): Inventory => {
  return shouldSuppressPcInventoryApplyForRaceMenu()
    ? getInventoryWithoutWornState(inventory)
    : inventory;
};

const beginRaceMenuKeepUnequipped = () => {
  setRaceMenuKeepUnequipped(true);
  raceMenuKeepUnequippedSince = Date.now();
};

const isRaceMenuOpenRequestPending = (): boolean => {
  return raceMenuOpenPending;
};

const updateRaceMenuKeepUnequippedState = () => {
  const raceMenuOpen = Ui.isMenuOpen('RaceSex Menu');
  if (raceMenuOpen) {
    raceMenuWasOpen = true;
    raceMenuOpenPending = false;
    return;
  }

  if (raceMenuWasOpen) {
    raceMenuWasOpen = false;
    setRaceMenuKeepUnequipped(false);
    raceMenuKeepUnequippedSince = 0;
    return;
  }

  if (isRaceMenuKeepUnequipped() && raceMenuKeepUnequippedSince === 0) {
    setRaceMenuKeepUnequipped(false);
    return;
  }

  if (
    isRaceMenuKeepUnequipped() &&
    !isRaceMenuOpenRequestPending() &&
    raceMenuKeepUnequippedSince > 0 &&
    Date.now() - raceMenuKeepUnequippedSince > 30000
  ) {
    setRaceMenuKeepUnequipped(false);
    raceMenuKeepUnequippedSince = 0;
    raceMenuOpenPending = false;
  }
};

on('update', () => {
  updateRaceMenuKeepUnequippedState();
  if (isBadMenuShown()) {
    return;
  }
  if (Date.now() - pcInvLastApply > 5000) {
    pcInvLastApply = Date.now();
    const pcInv = getPcInventory();
    if (pcInv) {
      applyInventory(Game.getPlayer()!, pcInv, false, true);
    }
  }
});

const unequipPlayerForRaceMenu = () => {
  beginRaceMenuKeepUnequipped();

  const player = Game.getPlayer();
  if (!player) {
    return;
  }

  const inventory = getPcInventory() ?? getInventory(player);
  setPcInventory(getInventoryWithoutWornState(inventory));
  player.unequipAll();
  player.queueNiNodeUpdate();
};

const shouldKeepPlayerUnequippedForRaceMenu = (msg: CreateActorMessage): boolean => {
  return msg.isMe && shouldSuppressPcInventoryApplyForRaceMenu();
};

const scheduleRaceMenuUnequip = (requestId: number, delaySeconds: number): void => {
  Utility.wait(delaySeconds).then(() => {
    if (requestId !== raceMenuOpenRequestId || !shouldSuppressPcInventoryApplyForRaceMenu()) {
      return;
    }

    unequipPlayerForRaceMenu();
  });
};

const scheduleRaceMenuOpenRetry = (requestId: number, delaySeconds: number): void => {
  Utility.wait(delaySeconds).then(() => {
    if (
      requestId !== raceMenuOpenRequestId ||
      !isRaceMenuOpenRequestPending() ||
      !isRaceMenuKeepUnequipped()
    ) {
      return;
    }

    if (Ui.isMenuOpen('RaceSex Menu')) {
      raceMenuOpenPending = false;
      return;
    }

    unequipPlayerForRaceMenu();
    Game.showRaceMenu();
    scheduleRaceMenuUnequip(requestId, 0.1);
    scheduleRaceMenuOpenRetry(requestId, raceMenuOpenRetryIntervalSeconds);
  });
};

export class RemoteServer extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("hostStartMessage", (e) => this.onHostStartMessage(e));
    this.controller.emitter.on("hostStopMessage", (e) => this.onHostStopMessage(e));
    this.controller.emitter.on("setInventoryMessage", (e) => this.onSetInventoryMessage(e));
    this.controller.emitter.on("openContainerMessage", (e) => this.onOpenContainerMessage(e));
    this.controller.emitter.on("updateMovementMessage", (e) => this.onUpdateMovementMessage(e));
    this.controller.emitter.on("updateAnimationMessage", (e) => this.onUpdateAnimationMessage(e));
    this.controller.emitter.on("updateEquipmentMessage", (e) => this.onUpdateEquipmentMessage(e));
    this.controller.emitter.on("changeValuesMessage", (e) => this.onChangeValuesMessage(e));
    this.controller.emitter.on("updateAppearanceMessage", (e) => this.onUpdateAppearanceMessage(e));
    this.controller.emitter.on("teleportMessage", (e) => this.onTeleportMessage(e));
    this.controller.emitter.on("teleportMessage2", (e) => this.onTeleportMessage(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
    this.controller.emitter.on("destroyActorMessage", (e) => this.onDestroyActorMessage(e));
    this.controller.emitter.on("setRaceMenuOpenMessage", (e) => this.onSetRaceMenuOpenMessage(e));
    this.controller.emitter.on("updatePropertyMessage", (e) => this.onUpdatePropertyMessage(e));
    this.controller.emitter.on("deathStateContainerMessage", (e) => this.onDeathStateContainerMessage(e));

    this.controller.emitter.on("connectionAccepted", () => this.handleConnectionAccepted());

    this.controller.emitter.on("spellCastMessage", (e) => this.onSpellCastMessage(e));
    this.controller.emitter.on("updateAnimVariablesMessage", (e) => this.onUpdateAnimVariablesMessage(e));

  }

  private onHostStartMessage(event: ConnectionMessage<HostStartMessage>) {
    const msg = event.message;
    const target = msg.target;

    let hosted = storage['hosted'];
    if (typeof hosted !== typeof []) {
      // if you try to switch to Set please checkout .concat usage.
      // concat compiles but doesn't work as expected
      hosted = new Array<number>();
      storage['hosted'] = hosted;
    }

    if (!(hosted as Array<unknown>).includes(target)) {
      (hosted as Array<unknown>).push(target);
    }
  }

  private onHostStopMessage(event: ConnectionMessage<HostStopMessage>) {
    const msg = event.message;
    const target = msg.target;
    logTrace(this, 'hostStop ' + target.toString(16));

    const hosted = storage['hosted'] as Array<number>;
    if (typeof hosted === typeof []) {
      storage['hosted'] = hosted.filter((x) => x !== target);
    }
  }

  private onSetInventoryMessage(event: ConnectionMessage<SetInventoryMessage>): void {
    this.numSetInventory++;

    const msg = event.message;
    once('update', () => {
      setPcInventory(getPcInventoryForStorage(msg.inventory));

      let blocked = false;

      this.controller.emitter.emit('queryBlockSetInventoryEvent', {
        block: () => blocked = true
      });

      if (!blocked) {
        pcInvLastApply = shouldSuppressPcInventoryApplyForRaceMenu() ? Date.now() : 0;
      }
    });
  }

  private onOpenContainerMessage(event: ConnectionMessage<OpenContainerMessage>): void {
    once('update', async () => {
      await Utility.wait(0.1); // Give a chance to update inventory

      const remoteId = event.message.target;
      const localId = remoteIdToLocalId(remoteId);
      const refr = getExactObjectReference(localId);

      if (refr === null) {
        logError(this, 'onOpenContainerMessage - refr not found', 'remoteId', remoteId.toString(16), 'localId', localId.toString(16));
        return;
      }

      refr.activate(Game.getPlayer(), true);

      const baseObject = refr.getBaseObject();
      const baseType = baseObject?.getType();

      let functionChecker: (() => boolean) | null = null;
      let factName = "";
      let delaySeconds = -1.0;
      if (baseType === FormType.Container) {
        functionChecker = () => Ui.isMenuOpen("ContainerMenu");
        factName = "'ContainerMenu open'";
        delaySeconds = 0.0;
      } else if (baseType === FormType.Furniture) {
        functionChecker = () => !!Game.getPlayer()?.getFurnitureReference();
        factName = "'getFurnitureReference not null'";
        delaySeconds = 1.0;
      }

      if (functionChecker === null) {
        logTrace(this, "onOpenContainerMesage - not a container or furniture", baseType);
        return;
      }

      // In SkyMP containers have 2-nd, closing activation under the hood.
      // This differs from Skyrim's behavior, where it's just one activation.

      (async () => {
        logTrace(this, "onOpenContainerMesage - waiting for", factName, "to be true");
        while (!functionChecker()) await Utility.wait(0.1);

        logTrace(this, "onOpenContainerMesage - waiting for", factName, "to be false");
        while (functionChecker()) await Utility.wait(0.1);

        logTrace(this, "onOpenContainerMesage - menu closed", factName);

        const message: ActivateMessage = {
          t: messages.MsgType.Activate,
          data: {
            caster: 0x14, target: event.message.target, isSecondActivation: true
          }
        };

        logTrace(this, "onOpenContainerMesage - waiting", delaySeconds, "seconds before sending ActivateMessage");

        Utility.waitMenuMode(delaySeconds).then(() => {
          this.controller.emitter.emit("sendMessage", {
            message: message,
            reliability: "reliable"
          });

          logTrace(this, "onOpenContainerMesage - sent ActivateMessage", message);
        });
      })();
    });
  }

  private onTeleportMessage(event: ConnectionMessage<TeleportMessage> | ConnectionMessage<TeleportMessage2>): void {
    const msg = event.message;
    once('update', () => {
      const id = ("idx" in msg && typeof msg.idx === "number") ? this.getIdManager().getId(msg.idx) : this.getMyActorIndex();
      const refr = id === this.getMyActorIndex() ? Game.getPlayer() : getObjectReference(id);
      logTrace(this,
        `Teleporting id`, id, `refrId`, refr?.getFormID().toString(16), `...`,
        msg.pos,
        'cell/world is',
        msg.worldOrCell.toString(16),
      );
      const ragdollService = this.controller.lookupListener(RagdollService);

      const refrId = refr?.getFormID();

      const removeRagdollCallback = () => {
        const target = id === this.getMyActorIndex()
          ? resolveMovementTarget(msg, "teleport")
          : msg;

        if (id === this.getMyActorIndex()) {
          storage['vgrLastTeleportTarget'] = {
            id,
            refrId: refrId ?? null,
            pos: target.pos,
            rot: target.rot,
            worldOrCell: target.worldOrCell,
            time: Date.now(),
          };
        }

        TESModPlatform.moveRefrToPosition(
          ObjectReference.from(Game.getFormEx(refrId || 0)),
          Cell.from(Game.getFormEx(target.worldOrCell)),
          WorldSpace.from(Game.getFormEx(target.worldOrCell)),
          target.pos[0],
          target.pos[1],
          target.pos[2],
          target.rot[0],
          target.rot[1],
          target.rot[2],
        );
      };
      const actor = Actor.from(refr);
      if (actor /*&& actor.getFormID() === 0x14*/) {
        ragdollService.safeRemoveRagdollFromWorld(actor, removeRagdollCallback);
      } else {
        removeRagdollCallback();
      }
    });
  }

  private onCreateActorMessage(event: ConnectionMessage<CreateActorMessage>): void {
    const msg = event.message;
    this.traceCreateActorMessage(msg);

    if (this.skipFormViewCreation(msg)) {
      const refrId = msg.refrId!;
      this.onceLoad(refrId, (refr: ObjectReference) => {
        if (refr) {
          ObjectReferenceEx.dealWithRef(refr, refr.getBaseObject() as Form);
          if (msg.props) {
            if (msg.props.inventory) {
              ModelApplyUtils.applyModelInventory(refr, msg.props.inventory);
            }
            ModelApplyUtils.applyModelIsOpen(refr, !!msg.props['isOpen']);
            ModelApplyUtils.applyModelIsHarvested(
              refr,
              !!msg.props['isHarvested'],
            );

            ModelApplyUtils.applyModelNodeScale(refr, msg.props.setNodeScale);

            ModelApplyUtils.applyModelNodeTextureSet(refr, msg.props.setNodeTextureSet);

            ModelApplyUtils.applyModelIsDisabled(refr, !!msg.props['disabled']);

            // TODO: move to a separate module
            const animation = msg.props.lastAnimation;
            if (typeof animation === "string") {
              const refrid = refr.getFormID();

              (async () => {
                for (let i = 0; i < 5; i++) {
                  // retry. pillars in bleakfalls are not reliable for some reason
                  let res2 = getExactObjectReference(refrid)?.playAnimation(animation);
                  if (res2) {
                    break;
                  }
                  await Utility.wait(2);
                }
              })();
            }


            let displayName = msg.props.displayName;

            // keep in sync with spSnippetService.ts
            if (typeof displayName === "string") {

              const replaceValue = refr.getBaseObject()?.getName();

              if (replaceValue !== undefined) {
                displayName = displayName.replace(/%original_name%/g, replaceValue);
              } else {
                logError(this, "Couldn't get a replaceValue for SetDisplayName, refr.getFormID() was", refr.getFormID().toString(16));
              }

              refr.setDisplayName(displayName, true);
              logTrace(this, `calling setDisplayName`, displayName, `for`, refr.getFormID().toString(16));
            }
          }
        } else {
          logError(this, 'Failed to apply model to', refrId.toString(16));
        }
      });
      return;
    }

    const i = this.getIdManager().allocateIdFor(msg.idx);
    if (this.worldModel.forms.length <= i) {
      this.worldModel.forms.length = i + 1;
    }

    let movement: Movement | undefined = undefined;
    // TODO: better check if it is an npc (not an object reference)
    if (msg.refrId !== undefined && msg.refrId >= 0xff000000) {
      movement = {
        pos: msg.transform.pos,
        rot: msg.transform.rot,
        worldOrCell: msg.transform.worldOrCell,
        runMode: 'Standing',
        direction: 0,
        isInJumpState: false,
        isSneaking: false,
        isBlocking: false,
        isWeapDrawn: false,
        isDead: false,
        healthPercentage: 1.0,
        speed: 0,
      };
    }

    const form: FormModel = {
      idx: msg.idx,
      movement,
      numMovementChanges: 0,
      numAppearanceChanges: 0,
      baseId: msg.baseId,
      refrId: msg.refrId,
      baseRecordType: msg.baseRecordType,
      isMyClone: msg.isMe,
    };
    this.worldModel.forms[i] = form;

    if (msg.appearance) {
      form.appearance = msg.appearance;
    }

    if (msg.equipment) {
      form.equipment = msg.equipment;
    }

    if (msg.isDead) {
      form.isDead = msg.isDead;
    }

    if (msg.animation) {
      form.animation = msg.animation;
    }

    if (msg.props) {
      for (const propName in msg.props) {
        (form as Record<string, unknown>)[propName] = msg.props[propName as keyof CreateActorMessageAdditionalProps];
      }
    }

    msg.customPropsJsonDumps.forEach(element => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(element.propValueJsonDump);
      } catch (e) {
        if (e instanceof SyntaxError) {
          logError(this, "createActor", msg.refrId?.toString(16), "failed to parse custom prop", element.propName, element.propValueJsonDump, e.message);
        } else {
          throw e;
        }
      }
      (form as Record<string, unknown>)[element.propName] = parsed;
    });

    if (msg.isMe) {
      this.worldModel.playerCharacterFormIdx = i;
      this.worldModel.playerCharacterRefrId = msg.refrId || 0;
    }

    // TODO: move to a separate module

    if (msg.props && !msg.props.isHostedByOther) {
    }

    if (msg.props && msg.props.isRaceMenuOpen && msg.isMe) {
      this.onSetRaceMenuOpenMessage({ message: { t: MsgType.SetRaceMenuOpen, open: true } });
    }

    const numSetInventory = this.numSetInventory;
    let pcMagicApplied = false;

    const applyPcMagic = () => {
      if (!msg.isMe || !msg.props || pcMagicApplied) {
        return;
      }

      const player = Game.getPlayer();
      if (!player) {
        return;
      }

      pcMagicApplied = true;

      if (msg.props.learnedSpells) {
        removeAllSpells(player);
        learnSpells(player, msg.props.learnedSpells);
        logTrace(this,
          `player learnedSpells:`, JSON.stringify(msg.props.learnedSpells),
        );
      }

      if (msg.props.learnedShouts) {
        learnShouts(player, msg.props.learnedShouts);
        logTrace(this,
          `player learnedShouts:`, JSON.stringify(msg.props.learnedShouts),
        );
      }

      if (msg.props.unlockedWords) {
        unlockWords(msg.props.unlockedWords);
        logTrace(this,
          `player unlockedWords:`, JSON.stringify(msg.props.unlockedWords),
        );
      }
    };

    const applyPcInv = () => {
      applyPcMagic();

      const keepUnequippedForRaceMenu = shouldKeepPlayerUnequippedForRaceMenu(msg);

      if (msg.equipment && !keepUnequippedForRaceMenu) {
        applyEquipment(Game.getPlayer()!, msg.equipment)
      } else if (keepUnequippedForRaceMenu) {
        unequipPlayerForRaceMenu();
      }

      if (numSetInventory !== this.numSetInventory) {
        logTrace(this, 'Skipping inventory apply due to newer setInventory message');
        return;
      }

      if (msg.props && msg.props.inventory) {
        this.onSetInventoryMessage({
          message: {
            t: MsgType.SetInventory,
            inventory: keepUnequippedForRaceMenu
              ? getInventoryWithoutWornState(msg.props.inventory)
              : msg.props.inventory
          }
        });
      }
    };

    if (msg.isMe && msg.props &&
      (msg.props.learnedSpells || msg.props.learnedShouts ||
        msg.props.unlockedWords)) {
      once('update', () => {
        Utility.wait(1).then(applyPcMagic);
      });
    }

    if (msg.isMe) {
      if (msg.props?.isDead) {
        once("update", () => {
          this.controller.emitter.emit("applyDeathStateEvent", {
            actor: Game.getPlayer()!,
            isDead: true
          });
        });
      }
    }

    if (msg.isMe) {
      const spawnTask = { running: false };
      once('update', () => {
        const createActorTarget = resolveMovementTarget({
          ...msg.transform,
          teleportPointFallback: msg.teleportPointFallback,
        }, "createActor");
        // Use MoveRefrToPosition to spawn if possible (not in main menu)
        // In case of connection lost this is essential
        if (!spawnTask.running) {
          spawnTask.running = true;
          logTrace(this, 'Using moveRefrToPosition to spawn player');
          (async () => {
            while (true) {
              logTrace(this, 'Spawning...');
              TESModPlatform.moveRefrToPosition(
                Game.getPlayer(),
                Cell.from(Game.getFormEx(createActorTarget.worldOrCell)),
                WorldSpace.from(Game.getFormEx(createActorTarget.worldOrCell)),
                createActorTarget.pos[0],
                createActorTarget.pos[1],
                createActorTarget.pos[2],
                createActorTarget.rot[0],
                createActorTarget.rot[1],
                createActorTarget.rot[2],
              );
              await Utility.wait(1);
              const pl = Game.getPlayer();
              if (!pl) {
                break;
              }
              const pos = [
                pl.getPositionX(),
                pl.getPositionY(),
                pl.getPositionZ(),
              ];
              const sqr = (x: number) => x * x;
              const distance = Math.sqrt(
                sqr(pos[0] - createActorTarget.pos[0]) +
                sqr(pos[1] - createActorTarget.pos[1]),
              );
              if (distance < 256) {
                break;
              }
            }
          })();
          // Unfortunatelly it requires two calls to work
          Utility.wait(1).then(applyPcInv);
          Utility.wait(1.3).then(applyPcInv);
          // Note: appearance part was copy-pasted
          if (msg.appearance) {
            applyAppearanceToPlayer(msg.appearance);
          }
        }

        if (msg.props) {
          const baseActorValues = new Map<string, unknown>([
            ['healRate', msg.props.healRate],
            ['healRateMult', msg.props.healRateMult],
            ['health', msg.props.health],
            ['magickaRate', msg.props.magickaRate],
            ['magickaRateMult', msg.props.magickaRateMult],
            ['magicka', msg.props.magicka],
            ['staminaRate', msg.props.staminaRate],
            ['staminaRateMult', msg.props.staminaRateMult],
            ['stamina', msg.props.stamina],
            ['healthPercentage', msg.props.healthPercentage],
            ['staminaPercentage', msg.props.staminaPercentage],
            ['magickaPercentage', msg.props.magickaPercentage],
          ]);

          const player = Game.getPlayer();
          if (player) {
            baseActorValues.forEach((value, key) => {
              if (typeof value === 'number') {
                if (key.includes('Percentage')) {
                  const subKey = key.replace('Percentage', '');
                  const subValue = baseActorValues.get(subKey);
                  if (typeof subValue === 'number') {
                    setActorValuePercentage(player, subKey, value);
                  }
                } else {
                  player.setActorValue(key, value);
                }
              }
            });
          }
        }
      });
      once('tick', () => {
        once('tick', () => {
          if (!spawnTask.running) {
            spawnTask.running = true;

            const loadOrder = getClientLoadOrder(this.sp.Game);

            const loadGameTarget = resolveMovementTarget({
              ...msg.transform,
              teleportPointFallback: msg.teleportPointFallback,
            }, "loadGame");

            logTrace(this, `loading game in world/cell`, loadGameTarget.worldOrCell.toString(16));
            const loadGameService = this.controller.lookupListener(LoadGameService);
            loadGameService.loadGame(
              loadGameTarget.pos,
              loadGameTarget.rot,
              loadGameTarget.worldOrCell,
              msg.appearance
                ? {
                  name: msg.appearance.name,
                  raceId: msg.appearance.raceId,

                  // TODO: In types, isFemale is under face, but in the reality SP expects it here. Fix required.
                  // @ts-expect-error
                  isFemale: msg.appearance.isFemale,

                  face: {
                    hairColor: msg.appearance.hairColor,
                    bodySkinColor: msg.appearance.skinColor,
                    headTextureSetId: msg.appearance.headTextureSetId,
                    headPartIds: msg.appearance.headpartIds,
                    presets: msg.appearance.presets
                  },
                }
                : undefined,
              loadOrder,
              { minutes: 0, seconds: 0, hours: this.controller.lookupListener(TimeService).getTime().newGameHourValue }
            );
            once('update', () => {
              applyPcInv();
              Utility.wait(0.3).then(applyPcInv);
              // Note: appearance part was copy-pasted
              if (msg.appearance) {
                applyAppearanceToPlayer(msg.appearance);
              }
            });
          }
        });
      });
    }
  }

  private traceCreateActorMessage(msg: CreateActorMessage): void {
    if (this.sp.settings["skymp5-client"]?.["debugCreateActor"] !== true) {
      return;
    }

    const hex = (value: number | undefined) =>
      value === undefined ? "<none>" : `0x${value.toString(16)}`;
    const props = msg.props ? Object.keys(msg.props) : [];
    const path = this.skipFormViewCreation(msg) ? "directApply" : "formView";

    logTrace(
      this,
      "CreateActor",
      `path=${path}`,
      `idx=${msg.idx}`,
      `refrId=${hex(msg.refrId)}`,
      `baseId=${hex(msg.baseId)}`,
      `world=${hex(msg.transform.worldOrCell)}`,
      `isMe=${msg.isMe}`,
      `baseRecordType=${msg.baseRecordType ?? "<none>"}`,
      `hasEquipment=${!!msg.equipment}`,
      `equipmentEntries=${msg.equipment?.inv?.entries.length ?? 0}`,
      `hasAppearance=${!!msg.appearance}`,
      `hasAnimation=${!!msg.animation}`,
      `hasProps=${!!msg.props}`,
      `propNames=${props.length ? props.join(",") : "<none>"}`,
      `customProps=${msg.customPropsJsonDumps.length}`,
    );
  }

  private onDestroyActorMessage(event: ConnectionMessage<DestroyActorMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);
    this.worldModel.forms[i] = undefined;
    getViewFromStorage()?.syncFormArray(this.worldModel);

    // Shrink to fit
    while (1) {
      const length = this.worldModel.forms.length;
      if (!length) {
        break;
      }
      if (this.worldModel.forms[length - 1]) {
        break;
      }
      this.worldModel.forms.length = length - 1;
    }

    if (this.worldModel.playerCharacterFormIdx === i) {
      this.worldModel.playerCharacterFormIdx = -1;
      this.worldModel.playerCharacterRefrId = 0;

      // TODO: move to a separate module
      once('update', () => Game.quitToMainMenu());
    }

    this.getIdManager().freeIdFor(msg.idx);
  }

  private onUpdateMovementMessage(event: ConnectionMessage<UpdateMovementMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateMovementMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    form.movement = msg.data;
    if (!form.numMovementChanges) {
      form.numMovementChanges = 0;
    }
    form.numMovementChanges++;
  }

  private onUpdateAnimationMessage(event: ConnectionMessage<UpdateAnimationMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateAnimationMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    form.animation = msg.data;
  }

  private onUpdateAppearanceMessage(event: ConnectionMessage<UpdateAppearanceMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateAppearanceMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    form.appearance = msg.data || undefined;
    if (!form.numAppearanceChanges) {
      form.numAppearanceChanges = 0;
    }
    form.numAppearanceChanges++;

    const newAppearance = msg.data;

    if (i === this.getMyActorIndex() && newAppearance) {
      this.controller.once("update", () => {
        applyAppearanceToPlayer(newAppearance);
        logTrace(this, "Applied appearance to the player");
      });
    }
  }

  private onUpdateEquipmentMessage(event: ConnectionMessage<UpdateEquipmentMessage>): void {
    const msg = event.message;

    const i = this.getIdManager().getId(msg.idx);

    const form = this.worldModel.forms[i];

    if (form === undefined) {
      logError(this, `onUpdateEquipmentMessage - Form with idx`, msg.idx, `not found`);
      return;
    }

    form.equipment = msg.data;
  }

  private onUpdatePropertyMessage(event: ConnectionMessage<UpdatePropertyMessage>): void {
    const msg = event.message;
    const msgData = this.extractUpdatePropertyMessageData(msg);

    if (this.skipFormViewCreation(msg)) {
      const refrId = msg.refrId!;
      once('update', () => {
        const refr = getExactObjectReference(refrId);
        if (!refr) {
          logError(this, 'UpdateProperty: refr not found');
          return;
        }
        if (msg.propName === 'inventory') {
          ModelApplyUtils.applyModelInventory(refr, msgData as Inventory);
        } else if (msg.propName === 'isOpen') {
          ModelApplyUtils.applyModelIsOpen(refr, !!msgData);
        } else if (msg.propName === 'isHarvested') {
          ModelApplyUtils.applyModelIsHarvested(refr, !!msgData);
        } else if (msg.propName === 'disabled') {
          ModelApplyUtils.applyModelIsDisabled(refr, !!msgData);
        }
      });
      return;
    }
    const i = this.getIdManager().getId(msg.idx);
    const form = this.worldModel.forms[i];
    (form as Record<string, unknown>)[msg.propName] = msgData;
  }

  private onDeathStateContainerMessage(event: ConnectionMessage<DeathStateContainerMessage>): void {
    const msg = event.message;

    logTrace(this, `Received death state:`, JSON.stringify(msg.tIsDead));

    const id = this.getIdManager().getId(msg.tIsDead.idx);
    const form = this.worldModel.forms[id];

    if (form === undefined) {
      logError(this, `onDeathStateContainerMessage - Form with idx`, msg.tIsDead.idx, `not found`);
      return;
    }

    if (msg.tIsDead.propName !== nameof<FormModel>('isDead')) {
      logError(this, `onDeathStateContainerMessage - Invalid propName`, msg.tIsDead.propName);
      return;
    }

    const msgData = this.extractUpdatePropertyMessageData(msg.tIsDead);
    if (typeof msgData !== 'boolean') {
      logError(this, `onDeathStateContainerMessage - Invalid data`, msgData);
      return;
    }

    if (msg.tChangeValues) {
      this.onChangeValuesMessage({ message: msg.tChangeValues });
    }
    once('update', () => this.onUpdatePropertyMessage({ message: msg.tIsDead }));

    if (msg.tTeleport) {
      this.onTeleportMessage({ message: msg.tTeleport });
    }

    once('update', () => {
      const actor =
        id === this.getWorldModel().playerCharacterFormIdx
          ? Game.getPlayer()!
          : getExactActor(remoteIdToLocalId(form.refrId ?? 0));
      if (actor) {
        try {
          this.controller.emitter.emit("applyDeathStateEvent", {
            actor: actor,
            isDead: msgData
          });
        } catch (e) {
          if (e instanceof RespawnNeededError) {
            const actorId = actor.getFormID();
            const currentActor = actorId === 0x14
              ? Game.getPlayer()
              : getExactActor(actorId);
            if (currentActor && currentActor.getFormID() === actorId) {
              currentActor.disableNoWait(false);
              void currentActor.delete().catch(() => {});
            }
          } else {
            throw e;
          }
        }
      }
    });
  }

  private handleConnectionAccepted(): void {
    this.worldModel.forms = [];
    this.worldModel.playerCharacterFormIdx = -1;
    this.worldModel.playerCharacterRefrId = 0;

    logTrace(this, "Handle connection accepted");
  }

  private onChangeValuesMessage(event: ConnectionMessage<ChangeValuesMessage>): void {
    const msg = event.message;

    once('update', () => {
      const id = this.getIdManager().getId(msg.idx);
      const refr = id === this.getMyActorIndex() ? Game.getPlayer() : getObjectReference(id);
      const ac = Actor.from(refr);
      if (!ac) {
        return;
      }

      const { health, stamina, magicka } = msg.data;
      if (typeof health === "number") {
        setActorValuePercentage(ac, 'health', health);
      }
      if (typeof stamina === "number") {
        setActorValuePercentage(ac, 'stamina', stamina);
      }
      if (typeof magicka === "number") {
        setActorValuePercentage(ac, 'magicka', magicka);
      }
    });
  }

  private onSetRaceMenuOpenMessage(event: ConnectionMessage<SetRaceMenuOpenMessage>): void {
    const msg = event.message;

    if (msg.open) {
      raceMenuOpenRequestId++;
      const requestId = raceMenuOpenRequestId;
      raceMenuOpenPending = true;
      beginRaceMenuKeepUnequipped();

      // wait 0.3s cause we can see visual bugs when teleporting
      // and showing this menu at the same time in onConnect
      once('update', () =>
        Utility.wait(0.3).then(() => {
          if (requestId !== raceMenuOpenRequestId || !isRaceMenuKeepUnequipped()) {
            return;
          }

          unequipPlayerForRaceMenu();
          Game.showRaceMenu();
          scheduleRaceMenuUnequip(requestId, 0.1);
          scheduleRaceMenuUnequip(requestId, 1.1);
          scheduleRaceMenuUnequip(requestId, 1.5);
          scheduleRaceMenuOpenRetry(requestId, raceMenuOpenRetryIntervalSeconds);
        }),
      );
    } else {
      raceMenuOpenRequestId++;
      setRaceMenuKeepUnequipped(false);
      raceMenuKeepUnequippedSince = 0;
      raceMenuWasOpen = false;
      raceMenuOpenPending = false;
      // TODO: Implement closeMenu in SkyrimPlatform
    }
  }

  /** Packet handlers end **/

  getWorldModel(): WorldModel {
    return this.worldModel;
  }

  getMyActorIndex(): number {
    return this.worldModel.playerCharacterFormIdx;
  }

  getMyRemoteRefrId(): number {
    return this.worldModel.playerCharacterRefrId;
  }

  getIdManager() {
    return this.idManager_;
  }

  private get worldModel(): WorldModel {
    if (typeof storage["worldModel"] === "function") {
      storage["worldModel"] = { forms: [], playerCharacterFormIdx: -1, playerCharacterRefrId: 0 };
    }
    return storage["worldModel"] as WorldModel;
  }

  private get idManager_(): IdManager {
    if (typeof storage["idManager"] === "function") {
      // Note: full IdManager object preserved across hot-reloads, including methods.
      storage["idManager"] = new IdManager();
    }
    return storage["idManager"] as IdManager;
  }

  private onceLoad(
    refrId: number,
    callback: (refr: ObjectReference) => void,
    maxAttempts: number = 120,
  ) {
    once('update', () => {
      const refr = getExactObjectReference(refrId);
      if (refr) {
        callback(refr);
      } else {
        maxAttempts--;
        if (maxAttempts > 0) {
          once('update', () => this.onceLoad(refrId, callback, maxAttempts));
        } else {
          logError(this, 'Failed to load object reference ' + refrId.toString(16));
        }
      }
    });
  };

  private skipFormViewCreation(
    msg: UpdatePropertyMessage | CreateActorMessage,
  ) {
    // Optimization added in #1186, however it doesn't work for doors for some reason
    return msg.refrId && msg.refrId < 0xff000000 && msg.baseRecordType !== 'DOOR';
  };

  private extractUpdatePropertyMessageData(updatePropertyMessage: UpdatePropertyMessage) {
    let msgData: unknown = updatePropertyMessage.data;

    if (updatePropertyMessage.dataDump !== undefined) {
      try {
        msgData = JSON.parse(updatePropertyMessage.dataDump);
      } catch (e) {
        if (e instanceof SyntaxError) {
          logError(this, 'extractUpdatePropertyMessageData - Failed to parse dataDump', updatePropertyMessage.dataDump);
          return;
        } else {
          throw e;
        }
      }
    }

    return msgData;
  }

  private onSpellCastMessage(event: ConnectionMessage<SpellCastMessage>): void {
    const msg = event.message;

    once('update', () => {
      const ac = Actor.from(Game.getFormEx(remoteIdToLocalId(msg.data.caster)));
      if (!ac) {
        return;
      }

      const actorAnimationVariables: ActorAnimationVariables = {
        booleans: new Uint8Array(msg.data.actorAnimationVariables.booleans),
        floats: new Uint8Array(msg.data.actorAnimationVariables.floats),
        integers: new Uint8Array(msg.data.actorAnimationVariables.integers)
      };

      if (msg.data.interruptCast) {
        interruptCast(ac.getFormID(), msg.data.castingSource, actorAnimationVariables);
        return;
      }

      const spell = ac.getEquippedSpell(msg.data.castingSource);
      if (spell) {
        castSpellImmediate(ac.getFormID(), msg.data.castingSource, spell.getFormID(), remoteIdToLocalId(msg.data.target),
          msg.data.aimAngle, msg.data.aimHeading, actorAnimationVariables);
      }
    });
  }

  private onUpdateAnimVariablesMessage(event: ConnectionMessage<UpdateAnimVariablesMessage>): void {
    const msg = event.message;

    once('update', () => {
      const ac = Actor.from(Game.getFormEx(remoteIdToLocalId(msg.data.actorRemoteId)));
      if (!ac) {
        return;
      }

      const actorAnimationVariables: ActorAnimationVariables = {
        booleans: new Uint8Array(msg.data.actorAnimationVariables.booleans),
        floats: new Uint8Array(msg.data.actorAnimationVariables.floats),
        integers: new Uint8Array(msg.data.actorAnimationVariables.integers)
      };

      const isApplyed = applyAnimationVariablesToActor(ac.getFormID(), actorAnimationVariables);

      if (!isApplyed) {
        logError(this, 'Failed apply AnimationVariables to actor with id: ' + ac.getFormID().toString(16));
      }
    });
  }

  private numSetInventory = 0;
}
