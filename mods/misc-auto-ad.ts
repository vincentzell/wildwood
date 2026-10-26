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
/** Timestamp (ms) avant lequel on ne retente pas (limite journalière atteinte). */
let limitUntilMs = 0;
let lastLimitLog = 0;

function isVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.hasAttribute("hidden")) return false;
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  return el.getClientRects().length > 0;
}

/** Parse "resets in HH:MM:SS" → ms, ou null si le pattern est absent. */
function parseResetMs(label: string): number | null {
  const m = label.match(/resets in (\d+):(\d+):(\d+)/);
  if (!m) return null;
  const ms = (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

type AdState =
  | { kind: "available" }
  | { kind: "limit"; resetMs: number | null }
  | { kind: "absent" };

/** Inspecte le bouton natif pour déterminer si une pub est réellement disponible. */
function readAdState(): AdState {
  const btn = document.getElementById("enemyRespawnAdBtn") as HTMLButtonElement | null;
  if (!btn) return { kind: "absent" };
  if (!isVisible(btn)) return { kind: "absent" };

  // data-state="limit" = quota journalier épuisé (bouton reste visible + disabled)
  if (btn.dataset.state === "limit" || btn.disabled) {
    const label = btn.getAttribute("aria-label") || btn.getAttribute("title") || "";
    return { kind: "limit", resetMs: parseResetMs(label) };
  }
  return { kind: "available" };
}

async function tryClaimAd(): Promise<void> {
  if (adRunning) return;
  if (!isAutoAdEnabled()) return;

  // Backoff actif : on attend le reset sans spammer le DOM toutes les 30s
  if (limitUntilMs > 0) {
    if (Date.now() < limitUntilMs) return;
    limitUntilMs = 0; // reset passé, on réessaie
  }

  const coop = getCoop();
  if (!coop?.claimAdGems) {
    if (!warnedNoApi) {
      warnedNoApi = true;
      console.warn("[mod-auto-ad] coop.claimAdGems indisponible");
    }
    return;
  }

  const state = readAdState();
  if (state.kind === "absent") return;
  if (state.kind === "limit") {
    // Programme le backoff jusqu'au reset (+10s de marge)
    if (state.resetMs !== null) {
      limitUntilMs = Date.now() + state.resetMs + 10_000;
    } else {
      // Reset inconnu → au moins 1h de backoff
      limitUntilMs = Date.now() + 60 * 60 * 1000;
    }
    // Log une seule fois par heure max
    if (Date.now() - lastLimitLog > 60 * 60 * 1000) {
      lastLimitLog = Date.now();
      const until = new Date(limitUntilMs).toLocaleTimeString("fr-FR", { hour12: false });
      console.info(`[mod-auto-ad] limite atteinte, reprise après ${until}`);
    }
    return;
  }

  // state.kind === "available"
  adRunning = true;
  try {
    const result = await coop.claimAdGems();
    if (result && result.ok === false && result.error) {
      // Cas "no ad available" → pas de log, mais on pourrait backoff court
      if (!/no ad|unavailable|not available|limit/i.test(result.error)) {
        console.warn("[mod-auto-ad] claim refusé:", result.error);
      }
    }
  } catch {
    // silencieux : le prochain tick retentera
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
  limitUntilMs = 0;
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