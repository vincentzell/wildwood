// mods/misc-auto-ad.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-ad-enabled";
const AD_CHECK_INTERVAL_MS = 30_000;

type CoopLike = {
  claimAdGems?: () => Promise<{ ok?: boolean; error?: string }>;
  gemBalance?: () => { gems?: number };
};

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function isAutoAdEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let adRunning = false;
let intervalId: number | null = null;
let warnedNoApi = false;

async function tryClaimAd(): Promise<void> {
  if (adRunning) return;
  if (!isAutoAdEnabled()) return;
  const coop = getCoop();
  if (!coop?.claimAdGems) {
    if (!warnedNoApi) {
      warnedNoApi = true;
      console.warn("[mod-auto-ad] coop.claimAdGems indisponible");
    }
    return;
  }
  adRunning = true;
  try {
    await coop.claimAdGems();
  } catch {
    // silencieux : on retentera au prochain tick
  } finally {
    adRunning = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => {
    void tryClaimAd();
  }, AD_CHECK_INTERVAL_MS);
  void tryClaimAd();
}

function stopPolling(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}

export function registerAutoAdMod(): void {
  REGISTERED_MODS.push({
    id: "misc-auto-ad",
    name: "Auto Ad",
    category: "MISC",
    switch: {
      label: "On",
      get: isAutoAdEnabled,
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
      if (isAutoAdEnabled()) startPolling();
    },
  });
}
