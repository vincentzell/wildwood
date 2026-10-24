// mods/index.ts
import { installModMenu } from "./modmenu";
import { registerFarmAutoDodgeMod } from "./farm-auto-kiting";
import { registerAutoPrestigeMod } from "./farm-auto-prestige";
import { registerAutoAdMod } from "./misc-auto-ad";
import { registerDailyGemsMod } from "./misc-daily-gems";
import { registerAutoQuestMod } from "./quest-auto-quest";
import { registerAutoCardBossMod } from "./card-auto-boss";
import { REGISTERED_MODS } from "./registry";

export function installAllMods(): void {
  registerFarmAutoDodgeMod();
  registerAutoPrestigeMod();
  registerAutoAdMod();
  registerDailyGemsMod();
  registerAutoQuestMod();
  registerAutoCardBossMod();
  console.info("[mods] after AutoCardBoss, count:", REGISTERED_MODS.length,
    "ids:", REGISTERED_MODS.map(m => m.id));
  for (const mod of REGISTERED_MODS) mod.install?.();
  console.info("[mods] before menu, count:", REGISTERED_MODS.length,
    "ids:", REGISTERED_MODS.map(m => m.id));
  installModMenu();
}
