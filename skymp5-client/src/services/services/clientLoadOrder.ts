import * as fs from "fs";
import * as path from "path";
import { Game, printConsole } from "skyrimPlatform";

type GameLike = typeof Game;

type SlotInfo = {
  kind: "full" | "light";
  index: number;
  filename: string;
};

const debugClientLoadOrder = false;

const printClientLoadOrderDebug = (message: string) => {
  if (debugClientLoadOrder) {
    printConsole(message);
  }
};

const pushUnique = (result: string[], seen: Set<string>, filename: string) => {
  if (!filename) {
    return;
  }
  const key = filename.toLowerCase();
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  result.push(filename);
};

const getAppDataListCandidates = (fileName: string) => {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return [];
  }

  return [
    path.join(localAppData, "Skyrim Special Edition", fileName),
    path.join(localAppData, "Skyrim Special Edition GOG", fileName),
    path.join(localAppData, "Skyrim VR", fileName),
  ];
};

const readPluginListFile = (fileName: string, enabledOnly: boolean) => {
  for (const pluginsPath of getAppDataListCandidates(fileName)) {
    try {
      if (!fs.existsSync(pluginsPath)) {
        continue;
      }

      return fs.readFileSync(pluginsPath, "utf8")
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"))
        .filter((line) => !enabledOnly || line.startsWith("*"))
        .map((line) => line.startsWith("*") ? line.slice(1).trim() : line)
        .filter((line) => line.length > 0);
    } catch (e) {
      printConsole(`Failed to read ${pluginsPath}: ${e}`);
    }
  }

  return [];
};

const readEnabledPluginsTxtEntries = () =>
  readPluginListFile("plugins.txt", true);

const readLoadOrderTxtEntries = () =>
  readPluginListFile("loadorder.txt", false);

const getLightModName = (game: GameLike, i: number) => {
  let filename = "";
  try {
    filename = game.getLightModName(i);
  } catch (e) {
    filename = "";
  }
  if (filename) {
    return filename;
  }
  try {
    return game.getModName(0x100 + i);
  } catch (e) {
    return "";
  }
};

const getLightModCount = (game: GameLike): number | undefined => {
  try {
    return game.getLightModCount();
  } catch (e) {
    return undefined;
  }
};

const getLightModNames = (game: GameLike) => {
  const result: string[] = [];
  const lightModCount = getLightModCount(game);
  if (lightModCount !== undefined) {
    printClientLoadOrderDebug(`Client light mod count from Game API: ${lightModCount}`);
    for (let i = 0; i < lightModCount; ++i) {
      const filename = getLightModName(game, i);
      if (filename) {
        result.push(filename);
      }
    }
    return result;
  }

  printClientLoadOrderDebug("Client light mod count unavailable, scanning compact light slots");
  for (let i = 0; i < 0x1000; ++i) {
    const filename = getLightModName(game, i);
    if (!filename) {
      break;
    }
    result.push(filename);
  }
  return result;
};

const buildClientSlotMap = (game: GameLike) => {
  const slots = new Map<string, SlotInfo>();

  try {
    for (let i = 0; i < game.getModCount(); ++i) {
      const filename = game.getModName(i);
      if (filename) {
        slots.set(filename.toLowerCase(), { kind: "full", index: i, filename });
      }
    }
  } catch (e) {
    printConsole(`Failed to enumerate full plugin slots from Game API: ${e}`);
  }

  const lightModNames = getLightModNames(game);
  for (let i = 0; i < lightModNames.length; ++i) {
    const filename = lightModNames[i];
    slots.set(filename.toLowerCase(), { kind: "light", index: i, filename });
  }

  return slots;
};

const getSlotFileNames = (slots: Map<string, SlotInfo>) =>
  Array.from(slots.values()).map((slot) => slot.filename);

const toLowerNameSet = (entries: string[]) =>
  new Set(entries.map((filename) => filename.toLowerCase()));

const printClientLoadOrderSlots = (
  loadOrder: string[],
  slots: Map<string, SlotInfo>
) => {
  for (let i = 0; i < loadOrder.length; ++i) {
    const filename = loadOrder[i];
    const slot = slots.get(filename.toLowerCase());
    if (!slot) {
      printClientLoadOrderDebug(`Client load order slot #${i}: ${filename} -> API slot unknown`);
      continue;
    }
    const slotText = slot.kind === "light"
      ? `light slot 0x${slot.index.toString(16)}`
      : `full slot 0x${slot.index.toString(16)}`;
    printClientLoadOrderDebug(`Client load order slot #${i}: ${filename} -> ${slotText}`);
  }
};

const addOrderedEntries = (
  result: string[],
  seen: Set<string>,
  entries: string[],
  shouldInclude: (filename: string) => boolean
) => {
  for (const filename of entries) {
    if (shouldInclude(filename)) {
      pushUnique(result, seen, filename);
    }
  }
};

export const getClientLoadOrder = (game: GameLike = Game) => {
  const result: string[] = [];
  const seen = new Set<string>();
  const slots = buildClientSlotMap(game);
  const apiLoadedEntries = getSlotFileNames(slots);
  const apiLoadedNames = toLowerNameSet(apiLoadedEntries);

  const pluginsTxtEntries = readEnabledPluginsTxtEntries();
  printClientLoadOrderDebug(`Client enabled plugins.txt entries: ${pluginsTxtEntries.length}`);
  const pluginsTxtEnabledNames = toLowerNameSet(pluginsTxtEntries);

  const loadOrderTxtEntries = readLoadOrderTxtEntries();
  printClientLoadOrderDebug(`Client loadorder.txt entries: ${loadOrderTxtEntries.length}`);
  if (loadOrderTxtEntries.length > 0) {
    const loadOrderTxtNames = toLowerNameSet(loadOrderTxtEntries);
    addOrderedEntries(result, seen, apiLoadedEntries, (filename) => {
      const key = filename.toLowerCase();
      return !loadOrderTxtNames.has(key) && !pluginsTxtEnabledNames.has(key);
    });
    addOrderedEntries(result, seen, loadOrderTxtEntries, (filename) => {
      const key = filename.toLowerCase();
      return pluginsTxtEnabledNames.has(key) || apiLoadedNames.has(key);
    });
    addOrderedEntries(result, seen, pluginsTxtEntries, () => true);
    printClientLoadOrderSlots(result, slots);
    return result;
  }

  if (pluginsTxtEntries.length > 0) {
    addOrderedEntries(result, seen, apiLoadedEntries, (filename) =>
      !pluginsTxtEnabledNames.has(filename.toLowerCase()));
    for (const filename of pluginsTxtEntries) {
      pushUnique(result, seen, filename);
    }
    printClientLoadOrderSlots(result, slots);
    return result;
  }

  addOrderedEntries(result, seen, apiLoadedEntries, () => true);

  printClientLoadOrderSlots(result, slots);
  return result;
};
