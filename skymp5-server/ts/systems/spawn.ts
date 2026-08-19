import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";

type Mp = any; // TODO
type StartPoints = Settings["startPoints"];

function randomInteger(min: number, max: number) {
  const rand = min + Math.random() * (max + 1 - min);
  return Math.floor(rand);
}

export class Spawn implements System {
  systemName = "Spawn";
  constructor(private log: Log) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const settingsObject = await Settings.get();
    const listenerFn = (userId: number, userProfileId: number, discordRoleIds: string[], discordId?: string) => {
      const { startPoints } = settingsObject;
      let actorId = ctx.svr.getActorsByProfileId(userProfileId)[0];
      if (actorId) {
        this.log("Loading character", actorId.toString(16));
        const needsRaceMenu = this.repairActorBeforeEnable(actorId, startPoints, ctx);
        ctx.svr.setEnabled(actorId, true);
        ctx.svr.setUserActor(userId, actorId);
        if (needsRaceMenu) {
          // The changeForm has no appearance saved (login never finished the
          // race menu, or the doc was corrupted). Reopen the race menu instead
          // of streaming a bare actor to every neighbor.
          ctx.svr.setRaceMenuOpen(actorId, true);
        }
      } else {
        const idx = randomInteger(0, startPoints.length - 1);
        actorId = ctx.svr.createActor(
          0,
          startPoints[idx].pos,
          startPoints[idx].angleZ,
          this.resolveWorldOrCellId(startPoints[idx].worldOrCell, ctx),
          userProfileId
        );
        this.log("Creating character", actorId.toString(16));
        ctx.svr.setUserActor(userId, actorId);
        ctx.svr.setRaceMenuOpen(actorId, true);
      }

      const mp = ctx.svr as unknown as Mp;
      mp.set(actorId, "private.discordRoles", discordRoleIds);

      if (discordId !== undefined) {
        // This helps us to test if indexes registration works in LoadForm or not
        if (mp.get(actorId, "private.indexed.discordId") !== discordId) {
          mp.set(actorId, "private.indexed.discordId", discordId);
        }

        const forms = mp.findFormsByPropertyValue("private.indexed.discordId", discordId) as number[];
        console.log(`Found forms ${forms}`);
      }
    };
    ctx.gm.on("spawnAllowed", listenerFn);
    (ctx.svr as any)._onSpawnAllowed = listenerFn;
  }

  disconnect(userId: number, ctx: SystemContext): void {
    const actorId = ctx.svr.getUserActor(userId);
    if (actorId !== 0) {
      ctx.svr.setEnabled(actorId, false);
    }
  }

  // Defensive pre-enable validation for a returning character. Corrupted
  // changeForms (no appearance, or a worldOrCellDesc resolving to form 0)
  // used to stream broken actors to every client, which the client's per-form
  // render loop does not tolerate. Never throws; on any validation error the
  // login proceeds exactly as before.
  private repairActorBeforeEnable(actorId: number, startPoints: StartPoints, ctx: SystemContext): boolean {
    let needsRaceMenu = false;
    const mp = ctx.svr as unknown as Mp;

    try {
      const appearance = mp.get(actorId, "appearance");
      if (appearance === null || appearance === undefined) {
        needsRaceMenu = true;
        this.log("Actor", actorId.toString(16), "has no appearance, reopening race menu");
      }
    } catch (e) {
      this.log("Appearance check skipped for", actorId.toString(16), e);
    }

    try {
      const worldOrCellDesc = String(mp.get(actorId, "worldOrCellDesc") || "");
      if (this.resolvesToFormZero(worldOrCellDesc, mp)) {
        const idx = randomInteger(0, startPoints.length - 1);
        const point = startPoints[idx];
        const cellOrWorldDesc = this.toCellOrWorldDesc(point.worldOrCell, mp);
        if (cellOrWorldDesc) {
          mp.set(actorId, "locationalData", {
            cellOrWorldDesc,
            pos: point.pos,
            rot: [0, 0, point.angleZ],
          });
          this.log("Actor", actorId.toString(16), "was in the void cell, teleported to a start point");
        }
      }
    } catch (e) {
      this.log("Location check skipped for", actorId.toString(16), e);
    }

    return needsRaceMenu;
  }

  // An empty desc or one that maps back to formId 0 means the actor sits in
  // the non-existent "void" cell (a corrupted or NaN-created changeForm).
  private resolvesToFormZero(worldOrCellDesc: string, mp: Mp): boolean {
    if (!worldOrCellDesc) {
      return true;
    }
    try {
      return Number(mp.getIdFromDesc(worldOrCellDesc)) === 0;
    } catch (e) {
      return false; // cannot resolve - leave the actor untouched
    }
  }

  // startPoints[].worldOrCell may be numeric-like ("0x3c") or a form desc
  // ("8002:VGR-Additions.esp"); locationalData wants the desc string.
  private toCellOrWorldDesc(worldOrCell: string | number, mp: Mp): string {
    const raw = String(worldOrCell);
    if (raw.indexOf(":") !== -1) {
      return raw;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
      try {
        return String(mp.getDescFromId(numeric));
      } catch (e) {
        // fall through
      }
    }
    return "";
  }

  // createActor wants a numeric formId. The old "+worldOrCell" coercion made
  // NaN out of desc strings like "8002:VGR-Additions.esp", which created new
  // characters in cell 0 (the void) - the source of the corrupted docs.
  private resolveWorldOrCellId(worldOrCell: string | number, ctx: SystemContext): number {
    const numeric = Number(worldOrCell);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric;
    }
    try {
      const mp = ctx.svr as unknown as Mp;
      const resolved = Number(mp.getIdFromDesc(String(worldOrCell)));
      if (Number.isFinite(resolved) && resolved > 0) {
        return resolved;
      }
    } catch (e) {
      this.log("Failed to resolve start point worldOrCell", worldOrCell, e);
    }
    return +worldOrCell; // original behavior as the last resort
  }
}
