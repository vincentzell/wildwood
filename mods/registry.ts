// mods/registry.ts
export type Mod = {
  id: string;
  name: string;
  install?: () => void;
};

export const REGISTERED_MODS: Mod[] = [];
