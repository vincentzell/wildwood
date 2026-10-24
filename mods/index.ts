// mods/index.ts
import { installModMenu } from "./modmenu";
import { registerFarmAutoDodgeMod } from "./farm-auto-kiting";
import { registerAutoPrestigeMod } from "./farm-auto-prestige";
import { registerAutoAdMod } from "./misc-auto-ad";
import { registerDailyGemsMod } from "./misc-daily-gems";
import { registerAutoQuestMod } from "./quest-auto-quest";
import { registerAutoFarmBossMod } from "./farm-auto-boss";
import { registerAutoFarmAllCardsMod } from "./card-auto-farm";
import { registerAutoFarmTargetCardsMod } from "./card-auto-target";
import { registerAutoTechTreeMod } from "./misc-auto-tech-tree";
import { registerAutoUpgradeMod } from "./misc-auto-upgrade";
import { REGISTERED_MODS } from "./registry";

export function installAllMods(): void {
  registerFarmAutoDodgeMod();
  registerAutoPrestigeMod();
  registerAutoAdMod();
  registerDailyGemsMod();
  registerAutoQuestMod();
  registerAutoFarmBossMod();
  registerAutoFarmAllCardsMod();
  registerAutoFarmTargetCardsMod();
  registerAutoTechTreeMod();
  registerAutoUpgradeMod();
  for (const mod of REGISTERED_MODS) mod.install?.();
  installModMenu();
}
