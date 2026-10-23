// mods/farm-auto-dodge.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-dodge-enabled";

export function isAutoDodgeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function apply(value: boolean): void {
  (globalThis as { __WILDWOOD_MOD_AUTO_DODGE__?: boolean }).__WILDWOOD_MOD_AUTO_DODGE__ = value;
}

export function registerFarmAutoDodgeMod(): void {
  REGISTERED_MODS.push({
    id: "farm-auto-dodge",
    name: "Auto-dodge (natif)",
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
        apply(value);
      },
    },
    install: () => apply(isAutoDodgeEnabled()),
  });
}
