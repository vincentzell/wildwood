// mods/misc-auto-ad.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-ad-enabled";
const AD_CHECK_INTERVAL_MS = 30_000;

type CoopLike = {
  claimAdGems?: () => Promise<{ ok?: boolean; error?: string }>;
  gemBalance?: () => { gems?: number };
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
let lastErrorLog = 0;

function isVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.hasAttribute("hidden")) return false;
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  return el.getClientRects().length > 0;
}

/**
 * Parse "N left today" depuis l'aria-label du bouton.
 * Ex : "Watch ad · +10 Gems · 4 left today" → 4
 */
function parseAdsLeft(label: string): number | null {
  const m = label.match(/(\d+)\s+left today/i);
  return m ? parseInt(m[1], 10) : null;
}

type AdState =
  | { kind: "available"; adsLeft: number | null }
  | { kind: "empty" }      // quota journalier à 0
  | { kind: "absent" };    // bouton pas dans le DOM / pas visible

/**
 * Source de vérité : le label du bouton natif.
 *   "N left today" avec N > 0 → pubs dispo
 *   "N left today" avec N = 0 → quota épuisé, reset demain
 *   bouton disabled / data-state=limit → idem
 */
function readAdState(): AdState {
  const btn = document.getElementById("enemyRespawnAdBtn") as HTMLButtonElement | null;
  if (!btn) return { kind: "absent" };
  if (!isVisible(btn)) return { kind: "absent" };

  const label = btn.getAttribute("aria-label") || btn.getAttribute("title") || "";
  const adsLeft = parseAdsLeft(label);

  if (adsLeft !== null && adsLeft > 0) return { kind: "available", adsLeft };
  if (adsLeft === 0) return { kind: "empty" };
  if (btn.dataset.state === "limit" || btn.disabled) return { kind: "empty" };
  // Label sans "N left", bouton actif → on tente quand même
  return { kind: "available", adsLeft: null };
}

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

  const state = readAdState();
  // "absent" : bouton pas à l'écran, rien à faire (l'utilisateur est ailleurs)
  // "empty"  : quota 0, reset demain — inutile de spammer l'API
  if (state.kind === "absent" || state.kind === "empty") return;

  // "available" : au moins 1 pub → claim
  adRunning = true;
  try {
    const result = await coop.claimAdGems();
    if (result && result.ok === false && result.error) {
      // Erreurs "attendues" : silence (auth pas prête, race avec l'UI, etc.)
      if (!/no ad|unavailable|not available|limit|not.?connected|unauthori[sz]ed/i.test(result.error)) {
        const now = Date.now();
        if (now - lastErrorLog > 60_000) {
          lastErrorLog = now;
          console.warn("[mod-auto-ad] claim refusé:", result.error);
        }
      }
    } else if (result?.ok) {
      console.info(
        `[mod-auto-ad] ✅ claim OK (avait ${state.adsLeft ?? "?"} pubs dispo)`
      );
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