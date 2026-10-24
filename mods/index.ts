// mods/index.ts
import { installModMenu } from "./modmenu";
import { registerFarmAutoDodgeMod } from "./farm-auto-kiting";
import { registerAutoRetreatRegenMod } from "./farm-auto-retreat-regen";
import { registerAutoPrestigeMod } from "./farm-auto-prestige";
import { registerAutoAdMod } from "./misc-auto-ad";
import { registerDailyGemsMod } from "./misc-daily-gems";
import { registerAutoQuestMod } from "./quest-auto-quest";
import { registerAutoFarmBossMod } from "./farm-auto-boss";
import { registerAutoFarmAllCardsMod } from "./card-auto-farm";
import { registerAutoFarmTargetCardsMod } from "./card-auto-target";
import { registerAutoTechTreeMod } from "./misc-auto-tech-tree";
import { registerAutoUpgradeMod } from "./misc-auto-upgrade";
import { registerOpenDevMod } from "./misc-open-dev";
import { REGISTERED_MODS } from "./registry";
import { registerTokenInjectorMod } from "./misc-token-injector";

export function installAllMods(): void {
  registerFarmAutoDodgeMod();
  registerAutoRetreatRegenMod();
  registerAutoPrestigeMod();
  registerAutoAdMod();
  registerDailyGemsMod();
  registerAutoQuestMod();
  registerAutoFarmBossMod();
  registerAutoFarmAllCardsMod();
  registerAutoFarmTargetCardsMod();
  registerAutoTechTreeMod();
  registerAutoUpgradeMod();
  registerOpenDevMod();
  for (const mod of REGISTERED_MODS) mod.install?.();
  registerTokenInjectorMod();
  installModMenu();
}
