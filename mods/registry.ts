// mods/registry.ts
export type ModCategory = "FARM" | "QUEST" | "CARD" | "MISC";

export type Mod = {
  id: string;
  name: string;
  category: ModCategory;
  description?: string;
  switch?: {
    label: string;
    get: () => boolean;
    set: (value: boolean) => void;
  };
  install?: () => void;
};

export const REGISTERED_MODS: Mod[] = [];
