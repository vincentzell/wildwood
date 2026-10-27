// mods/misc-auto-ad.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-ad-enabled";
const AD_CHECK_INTERVAL_MS = 30_000;

type CoopLike = {
  claimAdGems?: () => Promise<{ ok?: boolean; error?: string }>;
  isConnected?: () => boolean;
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
let backoffUntilMs = 0;
let lastErrorLog = 0;

function isVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.hasAttribute("hidden")) return false;
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  return el.getClientRects().length > 0;
}

/**
 * Parse un wait au format `formatAdGemWait` :
 *   "12:34"    → 12m34s
 *   "5:12:00"  → 5h12m
 */
function parseWaitMs(message: string): number | null {
  const m = message.match(/(\d+):(\d+)(?::(\d+))?/);
  if (!m) return null;
  const hasHours = m[3] !== undefined;
  const hours = hasHours ? parseInt(m[1], 10) : 0;
  const minutes = hasHours ? parseInt(m[2], 10) : parseInt(m[1], 10);
  const seconds = hasHours ? parseInt(m[3], 10) : parseInt(m[2], 10);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

function isAdButtonPresent(): boolean {
  const btn = document.getElementById("enemyRespawnAdBtn");
  return !!btn && isVisible(btn);
}

async function tryClaimAd(): Promise<void> {
  if (adRunning) return;
  if (!isAutoAdEnabled()) return;
  if (Date.now() < backoffUntilMs) return;

  const coop = getCoop();
  if (!coop?.claimAdGems) {
    if (!warnedNoApi) {
      warnedNoApi = true;
      console.warn("[mod-auto-ad] coop.claimAdGems indisponible");
    }
    return;
  }

  if (!isAdButtonPresent()) return;

  adRunning = true;
  try {
    const result = await coop.claimAdGems();

    if (result?.ok) {
      console.info("[mod-auto-ad] ✅ claim OK (+10 gems)");
      // Le serveur vient de poser un cooldown de 30 min.
      // On continue à poller, le prochain refus sera parsé et backoffera proprement.
      return;
    }

    const error = result?.error ?? "";

    // Cooldown : "Next ad in 12:34" ou "Next ad in 5:12:00"
    if (/next ad in/i.test(error)) {
      const waitMs = parseWaitMs(error);
      if (waitMs !== null) {
        backoffUntilMs = Date.now() + waitMs + 5_000;
        console.info(`[mod-auto-ad] ⏸ cooldown ${Math.ceil(waitMs / 60_000)}min (${error})`);
      }
      return;
    }

    // Limite jour : "No more ads today · resets in 5:12:00"
    if (/no more ads today/i.test(error)) {
      const waitMs = parseWaitMs(error);
      if (waitMs !== null) {
        backoffUntilMs = Date.now() + waitMs + 5_000;
        console.info(`[mod-auto-ad] ⏸ limite jour, reset dans ${Math.ceil(waitMs / 60_000)}min`);
      }
      return;
    }

    // Auth pas prête au boot : silence, retry au prochain tick
    if (/not.?connected|unauthori[sz]ed/i.test(error)) return;

    // Autre : warn 1×/min max
    const now = Date.now();
    if (now - lastErrorLog > 60_000) {
      lastErrorLog = now;
      console.warn("[mod-auto-ad] claim refusé:", error);
    }
  } catch (e) {
    const now = Date.now();
    if (now - lastErrorLog > 60_000) {
      lastErrorLog = now;
      console.warn("[mod-auto-ad] claim exception:", (e as Error).message);
    }
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
  backoffUntilMs = 0;
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