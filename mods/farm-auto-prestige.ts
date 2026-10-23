// mods/farm-auto-prestige.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-prestige-enabled";
const CHECK_INTERVAL_MS = 2_000;
const RETRY_COOLDOWN_MS = 5_000;

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

function log(msg: string): void {
  console.info(`[mod-auto-prestige] ${msg}`);
}

function logBlock(reason: string): void {
  if (reason === lastBlockReason) return;
  lastBlockReason = reason;
  console.info(`[mod-auto-prestige] bloqué : ${reason}`);
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
      console.warn("[mod-auto-prestige] coop indisponible (window.wildstatCoop absent)");
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
    if (!state) {
      logBlock("prestige() retourne null");
      return;
    }
  } catch (e) {
    logBlock(`prestige() exception : ${(e as Error).message}`);
    return;
  }

  try {
    const challenge = coop.prestigeChallenge?.();
    if (challenge?.active) {
      logBlock("prestigeChallenge actif");
      return;
    }
  } catch (e) {
    logBlock(`prestigeChallenge() exception : ${(e as Error).message}`);
    return;
  }

  inProgress = true;
  lastBlockReason = "";
  log("conditions réunies, appel prestigeAccount()");
  try {
    const result = await coop.prestigeAccount();
    lastAttemptTs = Date.now();
    if (result?.ok) {
      const level = typeof result.level === "number" ? result.level : -1;
      if (level !== lastReportedLevel) {
        lastReportedLevel = level;
        log(`prestige réussi${level >= 0 ? ` — niveau ${level}` : ""}`);
      }
    } else if (result?.error) {
      log(`refus serveur : ${result.error}`);
    } else {
      log("refus serveur (sans message)");
    }
  } catch (e) {
    lastAttemptTs = Date.now();
    log(`exception : ${(e as Error).message}`);
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
    install: () => {
      if (isAutoPrestigeEnabled()) startPolling();
    },
  });
}
