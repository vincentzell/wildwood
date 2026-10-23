import { leaderboardEligible } from "../../shared/leaderboard-window";
import { createAutoFarmResumeStore } from "../../src/app/auto-farm-resume";
import type { MapId } from "../../src/game/world";
import { bossStateForMap } from "../../src/game/runtime/boss/boss-registry";
import type { createProceduralBossController } from "../../src/game/runtime/boss/procedural-boss-controller";
import type { CoopAccess } from "../../src/game/runtime/coop-access";
import type { createGameBootstrap } from "../../src/game/runtime/game-bootstrap";
import type { createMapController } from "../../src/game/runtime/map-controller";
import { liveRewardText, soulRewardCapped, type RewardLabelContext } from "../../src/game/runtime/reward-labels";
import type { createResearchController } from "../../src/game/runtime/research-controller";
import { aggroPullCamps, forcedAggroGroups } from "../../src/game/runtime/auto-farm/aggro-picks";
import { createAutoFarmProgress } from "../../src/game/runtime/auto-farm/auto-farm-build";
import { createAutoFarmController } from "./auto-farm-controller";

type FarmConnection = "ready" | "recovering" | "ended";

export type AutoFarmWiringDeps = {
  coop: CoopAccess;
  world: Pick<ReturnType<typeof createGameBootstrap>, "player" | "enemies" | "enemyShots" | "spawnSites" | "bosses" | "inventory" | "mapConfig">;
  currentMapId: () => MapId;
  isArenaScene: () => boolean;
  moveSpeed: () => number;
  connection: () => FarmConnection;
  /** Systems created after Auto Farm, read only while it runs. */
  later: {
    session: () => { isRunning: () => boolean; isPaused: () => boolean } | undefined;
    mapController: () => Pick<ReturnType<typeof createMapController>, "isMapTransitioning" | "isCutsceneActive" | "portalIsUnlocked" | "serverMovePending">;
    proceduralBoss: () => Pick<ReturnType<typeof createProceduralBossController>, "boss">;
    playerCombat: () => { feedsOnAdds: () => boolean };
    research: () => Pick<ReturnType<typeof createResearchController>, "ranks" | "rewardMultiplier" | "criticalChance" | "criticalDamageMultiplier">;
    soulCritDamage: () => number;
    rewardContext: () => RewardLabelContext;
  };
};

/**
 * Auto Farm (and Auto Mine and Auto Chop in the Town's gathering areas), with
 * what it reads of the live build to decide when to move on or fight a boss.
 */
export function createAutoFarm(deps: AutoFarmWiringDeps) {
  const { coop, currentMapId, later } = deps;
  const { player, enemies, spawnSites, bosses, inventory, mapConfig } = deps.world;
  const client = coop.client;
  const equippedWeapon = () => inventory.equippedRightHand || inventory.equippedLeftHand;
  const isTraveling = () => later.mapController().isMapTransitioning() || later.mapController().isCutsceneActive();
  const mapBoss = () => later.proceduralBoss().boss() ?? bossStateForMap(bosses, currentMapId());
  const mapPortals = () => {
    const config = mapConfig[currentMapId()];
    return [config.portal, "secondaryPortal" in config ? config.secondaryPortal : null];
  };

  // Dragon credit unlocks autofarm, as does any prestige (which resets that credit but proves the Dragon fell),
  // so autofarm never depends on the current boss's health or respawn state.
  const farmUnlocked = () => leaderboardEligible(coop.savedProgress()?.desertUnlocked, client?.prestige?.()?.level);
  const farmUnavailable = () => {
    if (!farmUnlocked()) return "Defeat the Dragon to unlock autofarm";
    // A duel pauses the farm (below); its health, 0 for the loser until the result closes, is the duel's.
    if (!later.session()?.isRunning() || player.hp <= 0 && !deps.isArenaScene()) return "Start your adventure to farm";
    if (isTraveling()) return "Autofarm stopped for travel";
    if (!coop.connected()) return "Connect to the server to farm";
    return null;
  };

  const farmProgress = createAutoFarmProgress({
    mapId: currentMapId, fetchBalance: mapId => client?.mapIndexBalance?.(mapId),
    base: () => ({ maxHp: player.baseMaxHp, damage: player.damage, attackRate: player.attackRate, armor: player.armor, regen: player.regen }),
    equipment: () => ({
      equippedHead: inventory.equippedHead, equippedChest: inventory.equippedChest, equippedFeet: inventory.equippedFeet,
      equippedRightHand: inventory.equippedRightHand, equippedLeftHand: inventory.equippedLeftHand,
    }),
    weaponSkills: () => coop.weaponSkills(equippedWeapon()),
    research: () => later.research().ranks(),
    upgradeLevel: coop.itemLevel, cards: () => client?.activeCardTotals?.(),
    rewardMultiplier: () => later.research().rewardMultiplier(),
    minAttackInterval: coop.attackCap,
    criticalChance: () => later.research().criticalChance(),
    criticalMultiplier: (extra = 0) => later.research().criticalDamageMultiplier(later.soulCritDamage(), (player.critRating ?? 0) + extra),
    reflectOnly: () => Boolean(client?.prestigeChallenge?.()?.active),
    mapBoss,
    portalUnlocked: portal => later.mapController().portalIsUnlocked(portal as never),
    portals: mapPortals,
  });

  const autoFarm = createAutoFarmController({
    resumeStore: createAutoFarmResumeStore(),
    player, enemies, spawnSites,
    enemyShots: deps.world.enemyShots,
    mapId: currentMapId,
    pullCamps: () => client?.aggroChallenge?.()?.active ? 0
      : aggroPullCamps(client?.bonusOff?.().includes("challenge.aggro") ? null : client?.aggroChallenge?.()),
    forcedGroups: () => forcedAggroGroups(client?.aggroChallenge?.(), coop.localIdentity()),
    equippedWeapon,
    rewardCapped: (reward, soul) => soul
      ? soulRewardCapped(soul, later.rewardContext())
      : liveRewardText(reward, later.rewardContext()) === "Capped",
    localIdentity: coop.localIdentity, mining: () => client,
    connection: () => deps.connection() === "ready" && (!coop.connected() || !later.session()?.isRunning() || isTraveling())
      ? "recovering" : deps.connection(),
    unavailable: farmUnavailable,
    paused: () => Boolean(later.session()?.isPaused()) || deps.isArenaScene(),
    feedsOnAdds: () => later.playerCombat().feedsOnAdds(),
    serverMovePending: () => later.mapController().serverMovePending(),
    speed: deps.moveSpeed,
    obstacles: () => {
      const obstacles = mapPortals().flatMap(portal => portal
        ? [{ x: portal.x, y: portal.y - portal.height * .32, r: Math.max(60, portal.width * .6) + player.r + 24 }] : []);
      const boss = mapBoss();
      if (boss && !boss.dead) obstacles.push({ x: boss.x, y: boss.y, r: boss.r + player.r + 40 });
      return obstacles;
    },
    ...farmProgress,
  });

  return { autoFarm, farmUnlocked, farmUnavailable };
}
