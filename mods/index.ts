// mods/index.ts
import { installModMenu } from "./modmenu";
import { registerFarmAutoDodgeMod } from "./farm-auto-kiting";
import { registerAutoPrestigeMod } from "./farm-auto-prestige";
import { registerAutoAdMod } from "./misc-auto-ad";
import { registerDailyGemsMod } from "./misc-daily-gems";
import { registerAutoQuestMod } from "./quest-auto-quest";
import { REGISTERED_MODS } from "./registry";

export function installAllMods(): void {
  registerFarmAutoDodgeMod();
  registerAutoPrestigeMod();
  registerAutoAdMod();
  registerDailyGemsMod();
  registerAutoQuestMod();
  for (const mod of REGISTERED_MODS) mod.install?.();
  installModMenu();
}
