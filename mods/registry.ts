// mods/registry.ts
export type ModCategory = "FARM" | "QUEST" | "CARD" | "MISC" | "TRADE";

export type ModStatus = {
  /** Rendu d'un bloc HTML affiché sous le switch. Appelé ~1.5s. */
  render: () => HTMLElement;
  /** Intervalle de rafraîchissement en ms (défaut : 1500). */
  intervalMs?: number;
};

export type Mod = {
  id: string;
  name: string;
  category: ModCategory;
  description?: string;
  /** Afficher ce mod sur la page de login (avant le démarrage du jeu). */
  loginCompatible?: boolean;
  /** Optionnel : un switch affiché sur la carte, persisté par le mod lui-même. */
  switch?: {
    label: string;
    get: () => boolean;
    set: (value: boolean) => void;
  };
  status?: ModStatus;
  install?: () => void;
};

export const REGISTERED_MODS: Mod[] = [];
