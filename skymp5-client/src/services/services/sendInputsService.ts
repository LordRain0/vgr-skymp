import { ClientListener, CombinedController, Sp } from "./clientListener";
import { SinglePlayerService } from "./singlePlayerService";
import { FormModel, WorldModel } from "../../view/model";
import { MsgType } from "../../messages";
import { getMovement } from "../../sync/movementGet";

// TODO: refactor this out
import * as worldViewMisc from "../../view/worldViewMisc";

import { Animation, AnimationSource } from "../../sync/animation";
import { Actor, EquipEvent, FormType } from "skyrimPlatform";
import { getAppearance } from "../../sync/appearance";
import { ActorValues, getActorValues } from "../../sync/actorvalues";
import { getEquipment, isRaceMenuKeepUnequipped } from "../../sync/equipment";
import { nextHostAttempt } from "../../view/hostAttempts";
import { SkympClient } from "./skympClient";
import { MessageWithRefrId } from "../events/sendMessageWithRefrIdEvent";
import { UpdateMovementMessage } from "../messages/updateMovementMessage";
import { ChangeValuesMessage } from "../messages/changeValuesMessage";
import { UpdateAnimationMessage } from "../messages/updateAnimationMessage";
import { UpdateEquipmentMessage } from "../messages/updateEquipmentMessage";
import { UpdateAppearanceMessage } from "../messages/updateAppearanceMessage";
import { RemoteServer } from "./remoteServer";
import { DeathService } from "./deathService";
import { logTrace } from "../../logging";
import { AuthGameData, authGameDataStorageKey } from "../../features/authModel";
import { SettingsService } from "./settingsService";

const playerFormId = 0x14;

interface InputTargetContext {
    refrId?: number;
    owner: Actor | null;
    form?: FormModel;
}

// TODO: split this service into EquipmentService, MovementService, AnimationService, ActorValueService, HostAttemptsService
export class SendInputsService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        this.controller.on("update", () => this.onUpdate());
        this.controller.on("equip", (e) => this.onEquip(e));
        this.controller.on("unequip", (e) => this.onUnequip(e));
        this.controller.on("loadGame", () => this.onLoadGame());
    }

    private onUpdate() {
        if (!this.singlePlayerService.isSinglePlayer) {
            const player = this.sp.Game.getPlayer()!;
            this.sendInputs(player);

            const isPlayerCasting = player.getAnimationVariableBool("IsCastingRight")
                || player.getAnimationVariableBool("IsCastingLeft")
                || player.getAnimationVariableBool("IsCastingDual");

            if (isPlayerCasting) {
                this.prevCastingDetectedTime = Date.now();
            }
        }
    }

    private onEquip(event: EquipEvent) {
        if (this.isRaceMenuEquipmentSuppressed()) {
            return;
        }

        if (!event.actor || !event.baseObj) {
            return;
        }

        if (event.actor.getFormID() !== playerFormId) {
            return;
        }

        const type = event.baseObj.getType();
        if (type !== FormType.Book && type !== FormType.Potion && type !== FormType.Ingredient) {
            // Trigger UpdateEquipment only for equips that are not spell tomes, potions, ingredients
            this.equipmentChanged = true;
        }

        // Send OnEquip for any equips including spell tomes, potions, ingredients
        // Otherwise, the server won't trigger spell learn, potion drink, ingredient eat and Papyrus scripts
        this.controller.emitter.emit("sendMessage", {
            message: { t: MsgType.OnEquip, baseId: event.baseObj.getFormID() },
            reliability: "unreliable"
        });
    }

    private onUnequip(event: EquipEvent) {
        if (this.isRaceMenuEquipmentSuppressed()) {
            return;
        }

        if (!event.actor || !event.baseObj) {
            return;
        }

        if (event.actor.getFormID() === playerFormId) {
            this.equipmentChanged = true;
        }
    }

    private onLoadGame() {
        // Currently only armor is equipped after relogging (see remoteServer.ts)
        // This hack forces sending /equipment without weapons/ back to the server
        this.sp.Utility.wait(3).then(() => (this.equipmentChanged = true));
    }

    private sendInputs(player: Actor) {
        const hosted = Array.isArray(this.sp.storage['hosted'])
            ? this.sp.storage['hosted'] as number[]
            : [];
        const targets = ([undefined] as Array<number | undefined>).concat(
            hosted,
        );
        const modelSource = this.controller.lookupListener(RemoteServer);
        const world = modelSource.getWorldModel();
        const formByRefrId = hosted.length > 1
            ? this.makeFormByRefrId(world)
            : undefined;

        targets.forEach((target) => {
            const targetContext = this.getInputTargetContext(
                target,
                world,
                formByRefrId,
                player,
            );
            this.sendMovement(targetContext);
            this.sendAnimation(targetContext);
            this.sendAppearance(targetContext, player);
            this.sendEquipment(targetContext, player);
            this.sendActorValuePercentage(targetContext, player);
        });
        this.sendHostAttempts();
    }

    private sendMovement(target: InputTargetContext) {
        const owner = target.owner;
        if (!owner) {
          return;
        }

        const _refrId = target.refrId;
        const refrIdStr = `${_refrId}`;
        const sendMovementRateMs = 130;
        const now = Date.now();
        const last = this.lastSendMovementMoment.get(refrIdStr);
        if (!last || now - last > sendMovementRateMs) {
            const message: MessageWithRefrId<UpdateMovementMessage> = {
                t: MsgType.UpdateMovement,
                data: getMovement(owner, target.form),
                _refrId
            };
            this.controller.emitter.emit("sendMessageWithRefrId", {
                message,
                reliability: "unreliable"
            });
            this.lastSendMovementMoment.set(refrIdStr, now);
        }
    }

    private sendActorValuePercentage(target: InputTargetContext, player: Actor) {
        const canSend = target.form && (target.form.isDead ?? false) === false;
        if (!canSend) {
          return;
        }

        if (!target.owner) {
          return;
        }

        const av = getActorValues(player);
        const currentTime = Date.now();
        if (
            this.actorValuesNeedUpdate === false &&
            this.prevValues.health === av.health &&
            this.prevValues.stamina === av.stamina &&
            this.prevValues.magicka === av.magicka
        ) {
            return;
        }


        if (
            currentTime - this.prevActorValuesUpdateTime < 2000 &&
            this.actorValuesNeedUpdate === false
        ) {
            return;
        }

        // Delaying actor values update due to casting
        // TODO: use partial updates for actor values once server finally supports it
        // i.e. keep sending health and stamina during casting, but delay magicka update
        if (
            currentTime - this.prevCastingDetectedTime < 500 &&
            av.health > 0 // don't delay death actor value update
        ) {
            return;
        }

        const deathService = this.controller.lookupListener(DeathService);
        if (deathService.isBusy()) {
            logTrace(this, "Not sending actor values, death service is busy");
            return;
        }

        const message: MessageWithRefrId<ChangeValuesMessage> = {
            t: MsgType.ChangeValues,
            data: av,
            _refrId: target.refrId
        };
        this.controller.emitter.emit("sendMessageWithRefrId", {
            message,
            reliability: "unreliable"
        });
        this.actorValuesNeedUpdate = false;
        this.prevValues = av;
        this.prevActorValuesUpdateTime = currentTime;

    }

    private sendAnimation(target: InputTargetContext) {
        const owner = target.owner;
        if (!owner) {
          return;
        }

        // Extermly important that it's a local id since AnimationSource depends on it
        const refrIdStr = owner.getFormID().toString(16);

        let animSource = this.playerAnimSource.get(refrIdStr);
        if (!animSource) {
            animSource = new AnimationSource(owner);
            this.playerAnimSource.set(refrIdStr, animSource);
        }
        const anim = animSource.getAnimation();

        const lastAnimationSent = this.lastAnimationSent.get(refrIdStr);
        if (
            !lastAnimationSent ||
            anim.numChanges !== lastAnimationSent.numChanges
        ) {
            // Drink potion anim from this mod https://www.nexusmods.com/skyrimspecialedition/mods/97660
            if (anim.animEventName !== '' && !anim.animEventName.startsWith("DrinkPotion_")) {
                this.lastAnimationSent.set(refrIdStr, anim);
                this.updateActorValuesAfterAnimation(anim.animEventName);
                const message: MessageWithRefrId<UpdateAnimationMessage> = {
                    t: MsgType.UpdateAnimation,
                    data: anim,
                    _refrId: target.refrId
                };
                this.controller.emitter.emit("sendMessageWithRefrId", {
                    message,
                    reliability: "unreliable"
                });
            }
        }
    }

    private sendAppearance(target: InputTargetContext, player: Actor) {
        if (target.refrId) {
          return;
        }
        const shown = this.sp.Ui.isMenuOpen('RaceSex Menu');
        if (shown != this.isRaceSexMenuShown) {
            this.isRaceSexMenuShown = shown;
            if (!shown) {
                this.sp.printConsole('Exited from race menu');

                const appearance = getAppearance(player);
                this.syncCharacterMetadataFromAppearance(appearance);
                // TODO: log appearance contents to debug appearance issues?
                const message: MessageWithRefrId<UpdateAppearanceMessage> = {
                    t: MsgType.UpdateAppearance,
                    data: appearance,
                    _refrId: target.refrId
                };
                this.controller.emitter.emit("sendMessageWithRefrId", {
                    message,
                    reliability: "reliable"
                });
            }
        }
    }

    private syncCharacterMetadataFromAppearance(appearance: { name?: string }) {
        const authGameData = this.sp.storage[authGameDataStorageKey] as AuthGameData | undefined;
        const remoteAuthData = authGameData?.remote;
        const profileId = remoteAuthData?.masterApiId;
        const name = `${appearance.name || ''}`.trim();

        if (!remoteAuthData?.session || !Number.isInteger(profileId) || !name) {
            return;
        }

        const settingsService = this.controller.lookupListener(SettingsService);
        const client = new this.sp.HttpClient(settingsService.getMasterUrl());

        client.post(`/api/users/me/characters/${profileId}/update`, {
            body: JSON.stringify({ name }),
            contentType: 'application/json',
            headers: {
                authorization: remoteAuthData.session,
            },
            // @ts-ignore
        }, (res) => {
            if (res.status === 200) {
                logTrace(this, `Synced character name "${name}" for profileId ${profileId}`);
            } else {
                logTrace(this, `Failed to sync character name for profileId ${profileId}: status ${res.status}`);
            }
        });
    }

    private sendEquipment(target: InputTargetContext, player: Actor) {
        if (target.refrId) {
          return;
        }
        if (this.isRaceMenuEquipmentSuppressed()) {
            this.equipmentChanged = false;
            return;
        }
        if (this.equipmentChanged) {
            this.equipmentChanged = false;

            ++this.numEquipmentChanges;

            const eq = getEquipment(
                player,
                this.numEquipmentChanges,
            );
            const message: MessageWithRefrId<UpdateEquipmentMessage> = {
                t: MsgType.UpdateEquipment,
                data: eq,
                _refrId: target.refrId
            };

            this.controller.emitter.emit("sendMessageWithRefrId", {
                message,
                reliability: "reliable"
            });
        }
    }

    private sendHostAttempts() {
        const remoteId = nextHostAttempt();
        if (!remoteId) {
          return;
        }

        this.controller.emitter.emit("sendMessage", {
            message: {
                t: MsgType.Host,
                remoteId
            },
            reliability: "unreliable"
        });
    }

    private getInputTargetContext(
        refrId: number | undefined,
        world: WorldModel,
        formByRefrId: Map<number, FormModel> | undefined,
        player: Actor,
    ): InputTargetContext {
        return {
            refrId,
            owner: this.getInputOwner(refrId, player),
            form: this.getForm(refrId, world, formByRefrId),
        };
    }

    private getInputOwner(_refrId: number | undefined, player: Actor) {
        return _refrId
            ? this.sp.Actor.from(this.sp.Game.getFormEx(worldViewMisc.remoteIdToLocalId(_refrId)))
            : player;
    }

    private getForm(
        refrId: number | undefined,
        world: WorldModel,
        formByRefrId: Map<number, FormModel> | undefined,
    ): FormModel | undefined {
        const form = refrId
            ? formByRefrId?.get(refrId) ?? world.forms.find((f) => f?.refrId === refrId)
            : world.forms[world.playerCharacterFormIdx];
        return form;
    }

    private makeFormByRefrId(world: WorldModel) {
        const formByRefrId = new Map<number, FormModel>();
        for (const form of world.forms) {
            if (form?.refrId !== undefined) {
                formByRefrId.set(form.refrId, form);
            }
        }
        return formByRefrId;
    }

    private isRaceMenuEquipmentSuppressed() {
        return isRaceMenuKeepUnequipped() || this.sp.Ui.isMenuOpen('RaceSex Menu');
    }

    private updateActorValuesAfterAnimation(animName: string) {
        if (
            animName === 'JumpLand' ||
            animName === 'JumpLandDirectional' ||
            animName === 'DeathAnim'
        ) {
            this.actorValuesNeedUpdate = true;
        }
    }

    private get singlePlayerService() {
        return this.controller.lookupListener(SinglePlayerService);
    }

    private lastSendMovementMoment = new Map<string, number>();
    private playerAnimSource = new Map<string, AnimationSource>(); // TODO: make service
    private lastAnimationSent = new Map<string, Animation>();
    private actorValuesNeedUpdate = false;
    private isRaceSexMenuShown = false;
    private equipmentChanged = false;
    private numEquipmentChanges = 0;
    private prevValues: ActorValues = { health: 0, stamina: 0, magicka: 0 };
    private prevActorValuesUpdateTime = 0;
    private prevCastingDetectedTime = 0;
}
