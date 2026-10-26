import { MINING_NODE_KINDS, MINING_NODES, MINING_VEINS, canMineRock, miningBreakSeconds, miningGain, miningRockOre, type MiningNode } from "./mining";
import { WOOD_STANDS, WOOD_TREE_NODES, WOODCUTTING_LOGS, WOODCUTTING_RESPAWN_SECONDS, canChopStand, woodcuttingChopSeconds, woodcuttingGain, type WoodTree } from "./woodcutting";
import { gatherRespawnMs } from "./gather-respawn";

/**
 * What time away is collected as: the player is shown all three on return and picks one. Fighting is
 * shared/offline-progress.ts; mining and chopping work the deepest vein or stand the player could work when they left.
 */
export type OfflineActivity = "fight" | "mine" | "chop";
export const offlineActivity = (value: unknown): OfflineActivity | null =>
  value === "fight" || value === "mine" || value === "chop" ? value : null;

/** Mining and chopping away run at this share of the speed of playing, as offline gold is half. */
export const OFFLINE_GATHER_SPEED = .5;
/** Walking from one rock or tree to the next. */
export const OFFLINE_GATHER_WALK_SECONDS = 2.5;
/** A bound on the loop, well past what eight hours at full speed can break. */
const OFFLINE_GATHER_MAX_BREAKS = 20_000;

type Spot<T> = { at: T; seconds: (skill: number) => number; respawnSeconds: number; gain: number; value: number };

/**
 * Every break in `seconds` away, in order: the free spot that pays most per second next, waiting when none is free.
 * Skill grows with each break, so later breaks are quicker; the spots stay the ones picked at the start.
 */
function simulate<T>(spots: readonly Spot<T>[], skill: number, seconds: number) {
  const readyAt = spots.map(() => 0), breaks: T[] = [], budget = Math.max(0, seconds) * OFFLINE_GATHER_SPEED;
  let now = 0;
  while (spots.length && breaks.length < OFFLINE_GATHER_MAX_BREAKS) {
    let best = -1, bestRate = -1;
    for (let i = 0; i < spots.length; i++) {
      if (readyAt[i] > now) continue;
      const rate = spots[i].value / (spots[i].seconds(skill) + OFFLINE_GATHER_WALK_SECONDS);
      if (rate > bestRate) { best = i; bestRate = rate; }
    }
    if (best < 0) { now = Math.min(...readyAt); continue; }
    const end = now + OFFLINE_GATHER_WALK_SECONDS + spots[best].seconds(skill);
    if (end > budget) break;
    now = end;
    readyAt[best] = now + spots[best].respawnSeconds;
    skill += spots[best].gain;
    breaks.push(spots[best].at);
  }
  return { breaks, skill };
}

/** The deepest vein this Mining opens, and its ore rocks (crystal rocks are left to playing). */
export function offlineMiningVein(mining: number) {
  const vein = MINING_VEINS.reduce((deepest, _, index) => canMineRock({ kind: "small", vein: index }, mining) ? index : deepest, 0);
  return { vein, rocks: MINING_NODES.filter(node => node.vein === vein && node.kind !== "crystal") };
}

export function simulateOfflineMining(input: { mining: number; seconds: number; cardSpeed?: number; pickaxe?: number; respawnRank?: number }) {
  const { vein, rocks } = offlineMiningVein(input.mining);
  const spots = rocks.map((node): Spot<MiningNode> => ({
    at: node, gain: miningGain(node),
    seconds: skill => miningBreakSeconds(node, skill, input.cardSpeed ?? 0, input.pickaxe ?? 0),
    respawnSeconds: gatherRespawnMs(MINING_NODE_KINDS[node.kind].respawnSeconds, input.respawnRank ?? 0) / 1_000,
    // A Mysterious rock's Starshard is worth walking to first.
    value: miningRockOre(node) + (node.kind === "mysterious" ? 10 : 0),
  }));
  return { vein, ...simulate(spots, input.mining, input.seconds) };
}

/** The deepest stand this Woodcutting opens, and its trees. */
export function offlineWoodStand(woodcutting: number) {
  const stand = WOOD_STANDS.reduce((deepest, entry, index) => canChopStand(entry, woodcutting) ? index : deepest, 0);
  return { stand, trees: WOOD_TREE_NODES.filter(tree => tree.stand === stand) };
}

export function simulateOfflineChopping(input: { woodcutting: number; seconds: number; cardSpeed?: number; hatchet?: number; respawnRank?: number }) {
  const { stand, trees } = offlineWoodStand(input.woodcutting);
  const spots = trees.map((tree): Spot<WoodTree> => ({
    at: tree, gain: woodcuttingGain(tree), value: WOODCUTTING_LOGS,
    seconds: skill => woodcuttingChopSeconds(tree, skill, input.hatchet ?? 0, input.cardSpeed ?? 0),
    respawnSeconds: gatherRespawnMs(WOODCUTTING_RESPAWN_SECONDS, input.respawnRank ?? 0) / 1_000,
  }));
  return { stand, ...simulate(spots, input.woodcutting, input.seconds) };
}
