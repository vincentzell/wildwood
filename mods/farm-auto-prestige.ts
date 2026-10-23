// mods/farm-auto-prestige.ts
import { BOSS_REWARD_CLAIM_BITS } from "../shared/rules";
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-prestige-enabled";
const CHECK_INTERVAL_MS = 2_000;

const PRESTIGE_FIRST_MAP = 15;
const CAMPAIGN_LENGTH = 15;

type PrestigeResult = { ok?: boolean; error?: string; level?: number };

type CoopLike = {
  prestige?: () => { level?: number } | null;
  prestigeChallenge?: () => { active?: boolean } | null;
  prestigeAccount?: () => Promise<PrestigeResult>;
  savedProgress?: () => { bossRewardClaims?: number | null } | null;
  proceduralCompleted?: () => number;
  localState?: () => { mapId?: string } | null;
};

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function isAutoPrestigeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let inProgress = false;
let intervalId: number | null = null;
let warnedNoApi = false;
let currentLevel: number | null = null;
let lastActionResult = "";
let lastGoalKey = "";
let lastRejectedFor = "";
let lastSuccessfulFor = "";
let mapAtLastAttempt = "";

function log(msg: string): void {
  console.info(`[mod-auto-prestige] ${msg}`);
}

function getPrestigeGoal(level: number | null): { text: string; key: string } {
  const lvl = level ?? 0;
  const nextLevel = lvl + 1;
  const requiredMap = PRESTIGE_FIRST_MAP + Math.max(1, nextLevel) - 1;
  const endlessStage = Math.max(0, requiredMap - CAMPAIGN_LENGTH);
  if (endlessStage > 0) {
    return {
      text: `Clear Endless ${endlessStage} boss (Warden ${endlessStage})`,
      key: `endless_${endlessStage}`,
    };
  }
  return { text: "Defeat Aegis Prime", key: "prime" };
}

/** Reads the locally subscribed claim mask and Endless completion count. */
function isGoalCompleted(coop: CoopLike, goalKey: string): boolean {
  if (goalKey === "prime") {
    const claims = coop.savedProgress?.()?.bossRewardClaims;
    const aegisBit = BOSS_REWARD_CLAIM_BITS.aegisPrime;
    return claims != null && (claims & aegisBit) === aegisBit;
  }
  if (goalKey.startsWith("endless_")) {
    const stage = Number.parseInt(goalKey.slice("endless_".length), 10);
    return Number.isFinite(stage) && (coop.proceduralCompleted?.() ?? 0) >= stage;
  }
  return false;
}

async function tryPrestige(): Promise<void> {
  if (inProgress || !isAutoPrestigeEnabled()) return;

  const coop = getCoop();
  if (!coop) {
    if (!warnedNoApi) {
      warnedNoApi = true;
      console.warn("[mod-auto-prestige] coop indisponible");
    }
    return;
  }
  if (!coop.prestigeAccount) {
    if (!warnedNoApi) {
      warnedNoApi = true;
      console.warn("[mod-auto-prestige] coop.prestigeAccount absent");
    }
    return;
  }

  try {
    const state = coop.prestige?.();
    currentLevel = typeof state?.level === "number" ? state.level : null;
  } catch {
    currentLevel = null;
  }

  if (coop.prestigeChallenge) {
    try {
      if (coop.prestigeChallenge()?.active) return;
    } catch {
      // The server remains authoritative if this optional state is unavailable.
    }
  }

  const goal = getPrestigeGoal(currentLevel);
  if (goal.key !== lastGoalKey) {
    lastGoalKey = goal.key;
    if (!lastRejectedFor) lastActionResult = "";
  }

  if (!isGoalCompleted(coop, goal.key)) return;
  if (lastRejectedFor || lastSuccessfulFor === goal.key) return;

  inProgress = true;
  mapAtLastAttempt = coop.localState?.()?.mapId ?? "";
  try {
    const result = await coop.prestigeAccount();
    if (result?.ok) {
      const level = typeof result.level === "number" ? result.level : -1;
      lastSuccessfulFor = goal.key;
      lastActionResult = level >= 0 ? `Succès (niveau ${level})` : "Succès";
      log(lastActionResult);
    } else if (result?.error) {
      lastRejectedFor = result.error;
      lastActionResult = `Refus : ${result.error}`;
      log(`${lastActionResult} — retry uniquement sur événement`);
    } else {
      lastRejectedFor = "refus sans message";
      lastActionResult = "Refus (sans message)";
      log(lastActionResult);
    }
  } catch (e) {
    lastRejectedFor = `exception : ${(e as Error).message}`;
    lastActionResult = lastRejectedFor;
    log(lastActionResult);
  } finally {
    inProgress = false;
  }
}

function resetRejectionOnMapChange(): void {
  if (!lastRejectedFor) return;
  const coop = getCoop();
  const currentMap = coop?.localState?.()?.mapId ?? "";
  if (mapAtLastAttempt && currentMap && currentMap !== mapAtLastAttempt) {
    log(`map changée (${mapAtLastAttempt} → ${currentMap}), reset refus`);
    lastRejectedFor = "";
    lastActionResult = "";
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => {
    resetRejectionOnMapChange();
    void tryPrestige();
  }, CHECK_INTERVAL_MS);
  void tryPrestige();
}

function stopPolling(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
  inProgress = false;
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  const enabled = isAutoPrestigeEnabled();
  const coop = getCoop();
  const goal = getPrestigeGoal(currentLevel);
  const completed = coop ? isGoalCompleted(coop, goal.key) : false;

  const line1 = document.createElement("div");
  line1.style.cssText = "display:flex;justify-content:space-between;gap:6px;margin-bottom:2px;";
  const lvl = document.createElement("span");
  lvl.innerHTML = `<span style="opacity:.55">Niveau</span> <strong>${currentLevel ?? "—"}</strong>`;
  const status = document.createElement("span");
  status.style.opacity = ".75";
  status.textContent = !enabled ? "Désactivé"
    : inProgress ? "Appel…"
    : completed ? (lastRejectedFor ? "Refusé" : "Prêt")
    : "En attente";
  line1.append(lvl, status);

  const line2 = document.createElement("div");
  line2.style.cssText = "font-size:10px;opacity:.75;";
  line2.textContent = `🎯 ${goal.text}${completed ? " ✓" : ""}`;
  wrap.append(line1, line2);

  if (!enabled) return wrap;

  if (!completed) {
    const line = document.createElement("div");
    line.style.cssText = "font-size:10px;color:#ffd85b;margin-top:2px;";
    line.textContent = "⏳ Objectif non complété";
    wrap.append(line);
  } else if (lastRejectedFor) {
    const line = document.createElement("div");
    line.style.cssText = "font-size:10px;color:#ff6767;margin-top:2px;";
    line.textContent = `▶ ${lastActionResult}`;
    wrap.append(line);
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:9px;opacity:.55;margin-top:1px;";
    hint.textContent = "Retry sur changement de map ou toggle off/on";
    wrap.append(hint);
  } else if (lastActionResult) {
    const line = document.createElement("div");
    line.style.cssText = "font-size:10px;color:#69e56f;margin-top:2px;";
    line.textContent = `▶ ${lastActionResult}`;
    wrap.append(line);
  }

  return wrap;
}

export function registerAutoPrestigeMod(): void {
  REGISTERED_MODS.push({
    id: "farm-auto-prestige",
    name: "Auto Prestige",
    category: "FARM",
    switch: {
      label: "On",
      get: isAutoPrestigeEnabled,
      set: (value) => {
        try {
          localStorage.setItem(STORAGE_KEY, String(value));
        } catch {
          /* idem */
        }
        if (value) {
          lastRejectedFor = "";
          lastActionResult = "";
          startPolling();
        } else {
          stopPolling();
        }
      },
    },
    status: { render: renderStatus, intervalMs: 1500 },
    install: () => {
      if (isAutoPrestigeEnabled()) startPolling();
    },
  });
}
