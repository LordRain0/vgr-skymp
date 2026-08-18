import {
  Actor,
  Ammo,
  Game,
  ObjectReference,
  Shout,
  Spell,
  storage,
  Ui,
  setInventory,
} from 'skyrimPlatform';

import { Entry, Inventory, getInventory, sanitizeInventoryForSerialization } from './inventory';

export const enum SpellType {
  Left,
  Right,
  Voice,
  Instant,
}

export const getEquipedSpell = (
  refr: ObjectReference,
  spellType: SpellType,
): number => {
  const actor = Actor.from(refr);

  if (!actor) {
    return 0;
  }

  switch (spellType) {
    case SpellType.Left: {
      const spell = actor.getEquippedSpell(SpellType.Left);
      return spell ? spell.getFormID() : 0;
    }
    case SpellType.Right: {
      const spell = actor.getEquippedSpell(SpellType.Right);
      return spell ? spell.getFormID() : 0;
    }
    case SpellType.Voice: {
      const spell = actor.getEquippedSpell(SpellType.Voice);
      return spell ? spell.getFormID() : 0;
    }
    case SpellType.Instant: {
      const spell = actor.getEquippedSpell(SpellType.Instant);
      return spell ? spell.getFormID() : 0;
    }
    default: {
      return 0;
    }
  }
};

export interface Equipment {
  inv: Inventory;
  leftSpell?: number;
  rightSpell?: number;
  voiceSpell?: number;
  equippedShout?: number;
  instantSpell?: number;
  numChanges: number;
}

const raceMenuKeepUnequippedStorageKey = 'skympRaceMenuKeepUnequipped';

export const setRaceMenuKeepUnequipped = (value: boolean): void => {
  storage[raceMenuKeepUnequippedStorageKey] = value;
};

export const isRaceMenuKeepUnequipped = (): boolean => {
  return storage[raceMenuKeepUnequippedStorageKey] === true;
};

const filterWorn = (inv: Inventory): Inventory => {
  return { entries: inv.entries.filter((x) => x.worn || x.wornLeft) };
};

const removeUnnecessaryExtra = (inv: Inventory, ignoreAmmo: boolean): Inventory => {
  return {
    entries: inv.entries.map((x) => {
      const r: Entry = JSON.parse(JSON.stringify(x));
      r.chargePercent = r.maxCharge;
      if (ignoreAmmo) {
        r.count = Ammo.from(Game.getFormEx(x.baseId)) ? r.count : 1;
      } else {
        r.count = Ammo.from(Game.getFormEx(x.baseId)) ? 1000 : 1;
      }
      delete r.name;
      return r;
    }),
  };
};

export const getEquipment = (ac: Actor, numChanges: number): Equipment => {
  const shout = ac.getEquippedShout();

  return {
    inv: sanitizeInventoryForSerialization(filterWorn(getInventory(ac))),
    leftSpell: getEquipedSpell(ac, SpellType.Left),
    rightSpell: getEquipedSpell(ac, SpellType.Right),
    voiceSpell: shout ? 0 : getEquipedSpell(ac, SpellType.Voice),
    equippedShout: shout ? shout.getFormID() : 0,
    instantSpell: getEquipedSpell(ac, SpellType.Instant),
    numChanges,
  };
};

export const syncSpellEquipment = (
  ac: Actor,
  spellBaseId: number | undefined,
  spellType: SpellType,
) => {
  if (spellBaseId !== undefined && spellBaseId > 0) {
    ac.equipSpell(Spell.from(Game.getFormEx(spellBaseId)), spellType);
  } else {
    const equipedSpell = ac.getEquippedSpell(spellType);

    if (equipedSpell) {
      ac.unequipSpell(equipedSpell, spellType);
    }
  }
};

export const syncShoutEquipment = (
  ac: Actor,
  shoutBaseId: number | undefined,
) => {
  if (shoutBaseId !== undefined && shoutBaseId > 0) {
    const shout = Shout.from(Game.getFormEx(shoutBaseId));
    if (shout) {
      ac.addShout(shout);
      ac.equipShout(shout);
    }
  } else {
    const equippedShout = ac.getEquippedShout();

    if (equippedShout) {
      ac.unequipShout(equippedShout);
    }
  }
};

export const applyEquipment = (ac: Actor, eq: Equipment): boolean => {
  ac.removeAllItems(null, false, true);

  ac.unequipAll();

  ac.removeAllItems(null, false, true);

  const newInventory = removeUnnecessaryExtra(filterWorn(eq.inv), ac.getFormID() === 0x14);

  setInventory(ac.getFormID(), newInventory);

  syncSpellEquipment(ac, eq.leftSpell, SpellType.Left);
  syncSpellEquipment(ac, eq.rightSpell, SpellType.Right);
  if (eq.equippedShout !== undefined && eq.equippedShout > 0) {
    syncSpellEquipment(ac, undefined, SpellType.Voice);
    syncShoutEquipment(ac, eq.equippedShout);
  } else {
    syncShoutEquipment(ac, undefined);
    syncSpellEquipment(ac, eq.voiceSpell, SpellType.Voice);
  }
  syncSpellEquipment(ac, eq.instantSpell, SpellType.Instant);

  return true;
};

export const isBadMenuShown = (): boolean => {
  return (
    Ui.isMenuOpen('InventoryMenu') ||
    Ui.isMenuOpen('FavoritesMenu') ||
    Ui.isMenuOpen('MagicMenu') ||
    Ui.isMenuOpen('ContainerMenu') ||
    Ui.isMenuOpen('RaceSex Menu') ||
    isRaceMenuKeepUnequipped() ||
    Ui.isMenuOpen('Crafting Menu') // Actually I don't think it causes crashes
  );
};
