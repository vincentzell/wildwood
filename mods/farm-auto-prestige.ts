// mods/farm-auto-prestige.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-prestige-enabled";
const CHECK_INTERVAL_MS = 2_000;
const RETRY_COOLDOWN_MS = 5_000;

/** Constantes du userscript WildPote — miroir côté client. */
const PRESTIGE_FIRST_MAP = 15;
const CAMPAIGN_LENGTH = 15;

type PrestigeResult = { ok?: boolean; error?: string; level?: number };

type CoopLike = {
  prestige?: () => { level?: number } | null;
  prestigeChallenge?: () => { active?: boolean } | null;
  prestigeAccount?: () => Promise<PrestigeResult>;
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
let lastAttemptTs = 0;
let lastReportedLevel = -1;
let intervalId: number | null = null;
let warnedNoApi = false;
let lastBlockReason = "";
let lastActionResult = "";
let currentLevel: number | null = null;

function log(msg: string): void {
  console.info(`[mod-auto-prestige] ${msg}`);
}

function logBlock(reason: string): void {
  if (reason === lastBlockReason) return;
  lastBlockReason = reason;
  console.info(`[mod-auto-prestige] bloqué : ${reason}`);
}

function getPrestigeGoal(level: number | null): string {
  const lvl = level ?? 0;
  const nextLevel = lvl + 1;
  const requiredMap = PRESTIGE_FIRST_MAP + Math.max(1, nextLevel) - 1;
  const endlessStage = Math.max(0, requiredMap - CAMPAIGN_LENGTH);
  if (endlessStage > 0) return `Clear Endless ${endlessStage} boss (Warden ${endlessStage})`;
  return "Defeat Aegis Prime";
}

async function tryPrestige(): Promise<void> {
  if (inProgress) return;
  if (!isAutoPrestigeEnabled()) {
    lastBlockReason = "";
    return;
  }
  if (Date.now() - lastAttemptTs < RETRY_COOLDOWN_MS) return;

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
      const challenge = coop.prestigeChallenge();
      if (challenge?.active) {
        logBlock("prestigeChallenge actif");
        return;
      }
    } catch {
      // Challenge state is optional; the server decides whether prestige is allowed.
    }
  }

  inProgress = true;
  lastBlockReason = "";
  log("appel prestigeAccount()");
  try {
    const result = await coop.prestigeAccount();
    lastAttemptTs = Date.now();
    if (result?.ok) {
      const level = typeof result.level === "number" ? result.level : -1;
      lastActionResult = level >= 0 ? `Succès (niveau ${level})` : "Succès";
      if (level !== lastReportedLevel) {
        lastReportedLevel = level;
        log(`prestige réussi${level >= 0 ? ` — niveau ${level}` : ""}`);
      }
    } else {
      lastActionResult = result?.error ? `Refus : ${result.error}` : "Refus (sans message)";
      log(lastActionResult);
    }
  } catch (e) {
    lastAttemptTs = Date.now();
    lastActionResult = `Exception : ${(e as Error).message}`;
    log(lastActionResult);
  } finally {
    inProgress = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => {
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
  lastBlockReason = "";
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  const enabled = isAutoPrestigeEnabled();

  const line1 = document.createElement("div");
  line1.style.cssText = "display:flex;justify-content:space-between;gap:6px;margin-bottom:2px;";
  const lvl = document.createElement("span");
  lvl.innerHTML = `<span style="opacity:.55">Niveau</span> <strong>${currentLevel ?? "—"}</strong>`;
  const status = document.createElement("span");
  status.style.opacity = ".75";
  status.textContent = !enabled ? "Désactivé" : inProgress ? "Appel en cours…" : "Actif";
  line1.append(lvl, status);

  const line2 = document.createElement("div");
  line2.style.cssText = "font-size:10px;opacity:.75;";
  line2.textContent = `🎯 ${getPrestigeGoal(currentLevel)}`;

  wrap.append(line1, line2);

  if (lastBlockReason) {
    const line3 = document.createElement("div");
    line3.style.cssText = "font-size:10px;color:#ffd85b;margin-top:2px;";
    line3.textContent = `⏸ ${lastBlockReason}`;
    wrap.append(line3);
  }

  if (lastActionResult) {
    const line4 = document.createElement("div");
    line4.style.cssText = "font-size:10px;margin-top:2px;";
    line4.style.color = lastActionResult.startsWith("Succès") ? "#69e56f" : "#ff6767";
    line4.textContent = `▶ ${lastActionResult}`;
    wrap.append(line4);
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
        if (value) startPolling();
        else stopPolling();
      },
    },
    status: { render: renderStatus, intervalMs: 1500 },
    install: () => {
      if (isAutoPrestigeEnabled()) startPolling();
    },
  });
}
