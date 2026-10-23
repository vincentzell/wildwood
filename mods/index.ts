// mods/index.ts
import { installModMenu } from "./modmenu";
import { registerFarmAutoDodgeMod } from "./farm-auto-kiting";
import { REGISTERED_MODS } from "./registry";

export function installAllMods(): void {
  registerFarmAutoDodgeMod();
  for (const mod of REGISTERED_MODS) mod.install?.();
  installModMenu();
}
