/** A boss's first clear in a prestige run: its map, how far into the run's active play, and when. */
export type RunBossClear = { mapId: string; playedMicros: number; clearedAtMicros: number };

/** The stored list (player_run_timing.bossClears), read leniently: a malformed entry is skipped, not fatal. */
export function parseRunBossClears(json: string): RunBossClear[] {
  try {
    const value = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter(entry => Array.isArray(entry) && typeof entry[0] === "string" && Number.isFinite(entry[1]) && Number.isFinite(entry[2]))
      .map(([mapId, playedMicros, clearedAtMicros]) => ({ mapId, playedMicros, clearedAtMicros }));
  } catch {
    return [];
  }
}
