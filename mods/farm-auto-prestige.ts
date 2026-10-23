// mods/farm-auto-prestige.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-prestige-enabled";
const CHECK_INTERVAL_MS = 5_000;
const RETRY_COOLDOWN_MS = 30_000;

type CoopLike = {
  prestige?: () => { level?: number } | null;
  prestigeChallenge?: () => { active?: boolean } | null;
  prestigeAccount?: () => Promise<{ ok: boolean; error?: string }>;
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

async function tryPrestige(): Promise<void> {
  if (inProgress || !isAutoPrestigeEnabled()) return;
  if (Date.now() - lastAttemptTs < RETRY_COOLDOWN_MS) return;

  const coop = getCoop();
  if (!coop?.prestigeAccount || !coop.prestige) {
    if (!warnedNoApi) {
      warnedNoApi = true;
      console.warn("[mod-auto-prestige] API prestige indisponible");
    }
    return;
  }

  let currentLevel: number;
  try {
    const state = coop.prestige();
    if (!state) return;
    if (coop.prestigeChallenge?.()?.active) return;
    currentLevel = state.level ?? 0;
  } catch {
    return;
  }

  inProgress = true;
  try {
    const result = await coop.prestigeAccount();
    lastAttemptTs = Date.now();
    if (result?.ok) {
      const level = coop.prestige()?.level ?? currentLevel;
      if (level !== lastReportedLevel) {
        lastReportedLevel = level;
        console.info(`[mod-auto-prestige] Prestige réussi — niveau ${level}`);
      }
    }
  } catch {
    lastAttemptTs = Date.now();
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
          // idem
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
