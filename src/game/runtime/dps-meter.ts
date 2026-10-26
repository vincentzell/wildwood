/** The local player's damage per second over the last few seconds, for the on-screen DPS readout. */
export const DPS_WINDOW_MS = 5_000;
/** The DPS breakdown reads a longer window, so procs and skills settle into their share. */
export const DPS_BREAKDOWN_WINDOW_MS = 20_000;

/** Where a hit came from, and the name the DPS breakdown shows for it. */
export const DAMAGE_SOURCE_NAMES = {
  "bow-hit": "Shots", "bow-storm": "Arrow Storm", "bow-ricochet": "Ricochet",
  "sword-hit": "Sword", "sword-cleave": "Cleave", "sword-split-shot": "Split Shot",
  "sword-spin": "Whirlwind", "sword-wave": "Shockwave", "sword-deflect": "Deflect",
  "staff-direct": "Staff Bolt", "staff-splash": "Bolt Blast", "staff-chain": "Chain", "staff-meteor": "Meteor",
  "card-koi": "Koi Crits", "card-splash": "Splash", "card-chain": "Chain Lightning", "card-reap": "Reap",
  "card-burn": "Burn", "card-poison": "Poison", "card-reflect-splash": "Prism", "reflect": "Reflect",
} as const;
export type DamageSource = keyof typeof DAMAGE_SOURCE_NAMES;

export function createDpsMeter(now: () => number = () => performance.now()) {
  const hits: { at: number; amount: number; source: DamageSource }[] = [];
  const prune = (at: number) => { while (hits.length && at - hits[0].at > DPS_BREAKDOWN_WINDOW_MS) hits.shift(); };
  /** Damage over the time the hits cover, at least a second and at most the window, so a fight's first hits read true. */
  const seconds = (at: number, firstAt: number, window: number) => Math.min(window, Math.max(1_000, at - firstAt)) / 1_000;
  return {
    record(amount: number, source: DamageSource) {
      if (!(amount > 0) || !Number.isFinite(amount)) return;
      const at = now();
      prune(at);
      hits.push({ at, amount, source });
    },
    perSecond() {
      const at = now();
      prune(at);
      const recent = hits.filter(hit => at - hit.at <= DPS_WINDOW_MS);
      if (!recent.length) return 0;
      return recent.reduce((sum, hit) => sum + hit.amount, 0) / seconds(at, recent[0].at, DPS_WINDOW_MS);
    },
    /** Each source's damage per second over the breakdown window, biggest first. */
    breakdown() {
      const at = now();
      prune(at);
      if (!hits.length) return [];
      const totals = new Map<DamageSource, number>();
      for (const hit of hits) totals.set(hit.source, (totals.get(hit.source) ?? 0) + hit.amount);
      const span = seconds(at, hits[0].at, DPS_BREAKDOWN_WINDOW_MS);
      return [...totals].map(([source, damage]) => ({ source, perSecond: damage / span })).sort((a, b) => b.perSecond - a.perSecond);
    },
  };
}

/** The game's own meter: the combat wiring records each hit, the HUD readout reads it. */
export const playerDps = createDpsMeter();
