// mods/misc-daily-gems.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-daily-gems-enabled";
const GEM_CHECK_INTERVAL_MS = 10_000;

type CoopLike = {
  dailyGemBonusClaimable?: () => boolean;
  claimDailyGemBonus?: () => Promise<{ ok?: boolean; error?: string }>;
};

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function isDailyGemsEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let claiming = false;
let intervalId: number | null = null;
let warnedNoApi = false;

async function tryClaim(): Promise<void> {
  if (claiming) return;
  if (!isDailyGemsEnabled()) return;
  const coop = getCoop();
  if (!coop?.dailyGemBonusClaimable || !coop.claimDailyGemBonus) {
    if (!warnedNoApi) {
      warnedNoApi = true;
      console.warn("[mod-daily-gems] API claimDailyGemBonus indisponible");
    }
    return;
  }
  let claimable = false;
  try {
    claimable = coop.dailyGemBonusClaimable() === true;
  } catch {
    return;
  }
  if (!claimable) return;
  claiming = true;
  try {
    await coop.claimDailyGemBonus();
  } catch {
    // silencieux : prochain tick retentera
  } finally {
    claiming = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => {
    void tryClaim();
  }, GEM_CHECK_INTERVAL_MS);
  void tryClaim();
}

function stopPolling(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}

export function registerDailyGemsMod(): void {
  REGISTERED_MODS.push({
    id: "misc-daily-gems",
    name: "Auto Daily Gems",
    category: "MISC",
    switch: {
      label: "On",
      get: isDailyGemsEnabled,
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
      if (isDailyGemsEnabled()) startPolling();
    },
  });
}
