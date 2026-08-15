module.exports = (mp) => {
  const LOG = "[VGR TransformRace]";
  const PROPERTY_NAME = "vgrTransformRace";

  const RACE_DESCS = {
    "Argonian": "13740:Skyrim.esm",
    "Breton": "13741:Skyrim.esm",
    "Dark Elf": "13742:Skyrim.esm",
    "Dunmer": "13742:Skyrim.esm",
    "High Elf": "13743:Skyrim.esm",
    "Altmer": "13743:Skyrim.esm",
    "Imperial": "13744:Skyrim.esm",
    "Khajiit": "13745:Skyrim.esm",
    "Nord": "13746:Skyrim.esm",
    "Orc": "13747:Skyrim.esm",
    "Redguard": "13748:Skyrim.esm",
    "Wood Elf": "13749:Skyrim.esm",
    "Bosmer": "13749:Skyrim.esm",
    //"Alduin": "e7713:Skyrim.esm",
    "Dragon": "12e82:Skyrim.esm",
    "Werewolf": "1e17b:Dragonborn.esm",
    "Vampire Lord": "283a:Dawnguard.esm",
    "Dragon Priest": "131ef:Skyrim.esm",
    "Draugr": "d53:Skyrim.esm",
    "Dremora": "131f0:Skyrim.esm",
    "Frostbite Spider": "131f8:Skyrim.esm",
    "Giant": "131f9:Skyrim.esm",
    "Mammoth": "131fa:Skyrim.esm",
    "Sabre Cat": "131fb:Skyrim.esm",
    "Skeleton": "eb872:Skyrim.esm",
    "Troll": "131fc:Skyrim.esm",
    "Wolf": "13202:Skyrim.esm",
    "Chaurus": "131eb:Skyrim.esm",
    "Falmer": "131f4:Skyrim.esm",
    "Spriggan": "13204:Skyrim.esm",
    "Flame Atronach": "131f5:Skyrim.esm",
    "Frost Atronach": "131f6:Skyrim.esm",
    "Dwarven Centurion": "131f1:Skyrim.esm",
    "Dwarven Sphere": "131f2:Skyrim.esm",
    "Dwarven Spider": "131f3:Skyrim.esm"
  };

  const applyTransformRace = `
    const asNumber = (value) => {
      const n = Number(value || 0);
      return Number.isFinite(n) ? n : 0;
    };

    const transform = ctx.value;
    const transformObj = transform && typeof transform === "object" ? transform : {};
    const key = String(transformObj.key || "");
    const raceIdServer = asNumber(transformObj.raceId);
    const appearance = ctx.get("appearance");
    const fallbackRaceIdServer = appearance && typeof appearance === "object"
      ? asNumber(appearance.raceId)
      : 0;
    const nextRaceIdServer = raceIdServer || fallbackRaceIdServer;

    if (!nextRaceIdServer) return;

    const nextRaceIdClient = ctx.getFormIdInClientFormat(nextRaceIdServer);
    if (!nextRaceIdClient) return;

    const state = ctx.state || {};
    if (
      state.vgrTransformRaceLastRaceId === nextRaceIdClient &&
      state.vgrTransformRaceLastKey === key
    ) {
      return;
    }

    const actor = ctx.safe.getActor(ctx.refr);
    if (!actor) return;

    const race = ctx.sp.Race.from(ctx.safe.getFormEx(nextRaceIdClient));
    if (!race) return;
	
	ctx.sp.once("update", () => {
		try {
		  actor.setRace(race);
		} catch (e) {
		}

		try {
		  actor.queueNiNodeUpdate();
		} catch (e) {
		}
	});

    state.vgrTransformRaceLastRaceId = nextRaceIdClient;
    state.vgrTransformRaceLastKey = key;
  `;

  const resolveTransformRace = (key) => {
    const normalizedKey = String(key || "");
    if (!normalizedKey) {
      return null;
    }

    const desc = RACE_DESCS[normalizedKey];
    if (!desc) {
      throw new Error(
        `${LOG} Unknown race key '${normalizedKey}'. Known keys: ${Object.keys(RACE_DESCS).join(", ")}`
      );
    }

    const raceId = mp.getIdFromDesc(desc);
    const lookup = mp.lookupEspmRecordById(raceId);
    const record = lookup && lookup.record;
    if (!record || record.type !== "RACE") {
      throw new Error(`${LOG} '${normalizedKey}' resolved to ${raceId.toString(16)}, but it is not a RACE record`);
    }

    return {
      key: normalizedKey,
      desc,
      raceId,
    };
  };

  mp.makeProperty(PROPERTY_NAME, {
    isVisibleByOwner: true,
    isVisibleByNeighbors: true,
    updateOwner: applyTransformRace,
    updateNeighbor: applyTransformRace,
  });

  mp.vgrSetTransformRace = (actorId, key) => {
    const transform = resolveTransformRace(key);
    mp.set(actorId, PROPERTY_NAME, transform);
    return transform;
  };

  mp.vgrClearTransformRace = (actorId) => {
    mp.set(actorId, PROPERTY_NAME, null);
  };

  mp.vgrGetTransformRaceKeys = () => Object.keys(RACE_DESCS);

  console.log(LOG, "loaded keys:", mp.vgrGetTransformRaceKeys().join(", "));
};
