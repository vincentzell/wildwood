// mods/lib/player-coords.ts
export type CoopLike = {
  localState?: () => { x?: number; y?: number; mapId?: string } | null;
  [key: string]: any;
};

export type PlayerPos = { x: number; y: number; mapId: string };

export function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function getPlayerCoords(): PlayerPos | null {
  try {
    const c = getCoop();
    const s = c?.localState?.();
    if (!s || s.x === undefined || s.y === undefined) return null;
    return {
      x: s.x,
      y: s.y,
      mapId: s.mapId ?? "unknown",
    };
  } catch {
    return null;
  }
}
