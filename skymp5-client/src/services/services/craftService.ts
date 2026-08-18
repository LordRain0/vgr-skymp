// TODO: refactor this out
import { localIdToRemoteId } from "../../view/worldViewMisc";

import { Actor, ContainerChangedEvent } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { Inventory } from "../../sync/inventory";
import { MsgType } from "../../messages";
import { logTrace, logError } from "../../logging";

type FurnitureId = number;

interface CraftStreak {
    removedFromPlayer: Inventory;
    addedToPlayer: Inventory;
    flushScheduled: boolean;
    lastChangeAt: number;
}

export class CraftService extends ClientListener {
    constructor(private sp: Sp, private controller: CombinedController) {
        super();
        controller.on('containerChanged', (e) => this.onContainerChanged(e));
    }

    private addInventoryEntry(inventory: Inventory, baseId: number, count: number) {
        const existing = inventory.entries.find((entry) => entry.baseId === baseId);
        if (existing) {
            existing.count += count;
            return;
        }
        inventory.entries.push({ baseId, count });
    }

    private getOrCreateCraftStreak(furnitureId: FurnitureId) {
        let streak = this.furnitureStreak.get(furnitureId);
        if (!streak) {
            streak = {
                removedFromPlayer: { entries: [] },
                addedToPlayer: { entries: [] },
                flushScheduled: false,
                lastChangeAt: Date.now(),
            };
            this.furnitureStreak.set(furnitureId, streak);
        }
        return streak;
    }

    private scheduleCraftFlush(furnitureId: FurnitureId) {
        const streak = this.furnitureStreak.get(furnitureId);
        if (!streak || streak.flushScheduled) {
            return;
        }

        streak.flushScheduled = true;
        this.controller.once("update", () => this.flushCraftStreak(furnitureId));
    }

    private flushCraftStreak(furnitureId: FurnitureId) {
        const maxPendingTimeMs = 1000;
        const streak = this.furnitureStreak.get(furnitureId);
        if (!streak) {
            return;
        }

        streak.flushScheduled = false;

        if (!streak.removedFromPlayer.entries.length || !streak.addedToPlayer.entries.length) {
            if (Date.now() - streak.lastChangeAt > maxPendingTimeMs) {
                this.furnitureStreak.delete(furnitureId);
                return;
            }
            this.scheduleCraftFlush(furnitureId);
            return;
        }

        this.furnitureStreak.delete(furnitureId);

        const workbench = localIdToRemoteId(furnitureId);
        if (!workbench) {
            logError(this, `localIdToRemoteId returned 0 for furnitureId`, furnitureId);
            return;
        }

        const resultObjectId = streak.addedToPlayer.entries[0].baseId;
        const craftInputObjects = streak.removedFromPlayer;

        logTrace(this, `Sending craft workbench`, workbench, `resultObjectId`, resultObjectId, `craftInputObjects`, JSON.stringify(craftInputObjects.entries));

        this.controller.emitter.emit("sendMessage", {
            message: {
                t: MsgType.CraftItem,
                data: { workbench, craftInputObjects, resultObjectId },
            },
            reliability: "reliable"
        });
    }

    private onContainerChanged(e: ContainerChangedEvent) {
        const oldContainerId = e.oldContainer ? e.oldContainer.getFormID() : 0;
        const newContainerId = e.newContainer ? e.newContainer.getFormID() : 0;
        const baseObjId = e.baseObj ? e.baseObj.getFormID() : 0;
        if (oldContainerId !== 0x14 && newContainerId !== 0x14) {
          return;
        }

        const furnitureRef = (this.sp.Game.getPlayer() as Actor).getFurnitureReference();
        if (!furnitureRef) {
          return;
        }

        const furnitureId = furnitureRef.getFormID();
        const streak = this.getOrCreateCraftStreak(furnitureId);
        streak.lastChangeAt = Date.now();

        if (oldContainerId === 0x14 && newContainerId === 0) {
            this.addInventoryEntry(streak.removedFromPlayer, baseObjId, e.numItems);
            logTrace(this,
                `Adding baseObjId`, baseObjId.toString(16), `numItems`, e.numItems, `to craft`,
            );
            this.scheduleCraftFlush(furnitureId);
        } else if (oldContainerId === 0 && newContainerId === 0x14) {
            logTrace(this, 'Finishing craft');
            this.addInventoryEntry(streak.addedToPlayer, baseObjId, e.numItems);
            this.scheduleCraftFlush(furnitureId);
        }
    }

    private furnitureStreak = new Map<FurnitureId, CraftStreak>();
}
