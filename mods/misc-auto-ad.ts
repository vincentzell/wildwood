// mods/misc-auto-ad.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-ad-enabled";
const AD_CHECK_INTERVAL_MS = 30_000;
const POST_CLAIM_BACKOFF_MS = 30 * 60_000 + 5_000;  // 30 min serveur + marge
const POST_CLICK_BACKOFF_MS = 35_000;                 // laisse la pub se jouer

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
 * Parse un wait au format `formatAdGemWait` du serveur :
 *   "12:34"    → 12m 34s
 *   "5:12:00"  → 5h 12m
 * Retourne null si pas de pattern "M:SS" ou "H:MM:SS".
 */
function parseWaitMs(message: string): number | null {
  const m = message.match(/(\d+):(\d+)(?::(\d+))?/);
  if (!m) return null;
  const hasHours = m[3] !== undefined;
  const hours = hasHours ? parseInt(m[1], 10) : 0;
  const minutes = hasHours ? parseInt(m[2], 10) : parseInt(m[1], 10);
  const seconds = hasHours ? parseInt(m[3], 10) : parseInt(m[2], 10);
  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Clic robuste : `.click()` puis fallback dispatch d'événements souris
 * (comme le fait WildPote pour les boutons qui écoutent pointerdown).
 */
function simulerClic(el: HTMLElement | null): boolean {
  if (!el) return false;
  try {
    el.click();
    return true;
  } catch {
    /* fallthrough */
  }
  try {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      }));
    }
    return true;
  } catch {
    return false;
  }
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

  const btnMain = document.getElementById("enemyRespawnAdBtn") as HTMLButtonElement | null;
  if (!btnMain || !isVisible(btnMain)) return;

  // Skip préventif si le bouton dit qu'on est en cooldown / limite
  const dataState = btnMain.dataset.state;
  if (dataState === "cooldown" || dataState === "limit") return;

  adRunning = true;
  try {
    // ─── Étape 1 : API directe (rapide si pub déjà regardée) ──────────
    let direct: { ok?: boolean; error?: string } | null = null;
    try {
      direct = await coop.claimAdGems();
    } catch (e) {
      const now = Date.now();
      if (now - lastErrorLog > 60_000) {
        lastErrorLog = now;
        console.warn("[mod-auto-ad] claim exception:", (e as Error).message);
      }
      return;
    }

    if (direct?.ok) {
      console.info("[mod-auto-ad] ✅ claim OK (+10 gems)");
      backoffUntilMs = Date.now() + POST_CLAIM_BACKOFF_MS;
      return;
    }

    const error = direct?.error ?? "";

    // ─── Étape 2 : pub pas regardée → clic pour ouvrir la pub ─────────
    // Le serveur refuse avec "Finish the ad first." tant qu'aucune pub
    // n'a été regardée. On clique sur le bouton natif, on attend que la
    // pub s'ouvre puis se termine, et le prochain tick re-tentera l'API.
    if (/finish the ad first/i.test(error)) {
      console.info("[mod-auto-ad] 🎬 ouverture pub (fallback clic)");
      simulerClic(btnMain);

      // Certains builds affichent une confirmation après le 1er clic.
      await new Promise((r) => setTimeout(r, 1_500));
      const btnConfirm = document.getElementById("enemyRespawnAdConfirm");
      if (btnConfirm && isVisible(btnConfirm)) {
        simulerClic(btnConfirm);
      }

      backoffUntilMs = Date.now() + POST_CLICK_BACKOFF_MS;
      return;
    }

    // ─── Étape 3 : cooldown ou limite jour → backoff parsé ────────────
    if (/next ad in/i.test(error)) {
      const waitMs = parseWaitMs(error) ?? POST_CLAIM_BACKOFF_MS;
      backoffUntilMs = Date.now() + waitMs + 5_000;
      console.info(`[mod-auto-ad] ⏸ cooldown ${Math.ceil(waitMs / 60_000)}min`);
      return;
    }
    if (/no more ads today/i.test(error)) {
      const waitMs = parseWaitMs(error) ?? 3_600_000;
      backoffUntilMs = Date.now() + waitMs + 5_000;
      console.info(`[mod-auto-ad] ⏸ limite jour, reset dans ${Math.ceil(waitMs / 60_000)}min`);
      return;
    }

    // ─── Étape 4 : pas connecté → silence, retry au prochain tick ─────
    if (/not.?connected|unauthori[sz]ed|not.?signed/i.test(error)) return;

    // ─── Autre erreur : warn 1×/min ───────────────────────────────────
    const now = Date.now();
    if (now - lastErrorLog > 60_000) {
      lastErrorLog = now;
      console.warn("[mod-auto-ad] claim refusé:", error);
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
          /* idem */
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