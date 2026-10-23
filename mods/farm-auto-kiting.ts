// mods/farm-auto-kiting.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-dodge-enabled";

export function isAutoDodgeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function registerFarmAutoDodgeMod(): void {
  REGISTERED_MODS.push({
    id: "farm-auto-kiting",
    name: "Auto Kiting",
    category: "FARM",
    description:
      "Réactive l'esquive automatique du farm : cercle autour des chasers (arc balayé) et dodge des attaques en jeu. Désactivé par défaut côté jeu.",
    switch: {
      label: "On",
      get: isAutoDodgeEnabled,
      set: (value) => {
        try {
          localStorage.setItem(STORAGE_KEY, String(value));
        } catch {
          /* idem */
        }
        // Le consommateur lit isAutoDodgeEnabled() à chaque tick : rien à pousser.
      },
    },
  });
}
