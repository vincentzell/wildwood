// mods/misc-auto-ad.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-ad-enabled";
const AD_CHECK_INTERVAL_MS = 5_000;      // poll rapide pour réagir aux fins de cooldown
const PUB_DURATION_MS = 35_000;          // 30s de pub + 5s de marge
const DIALOG_TIMEOUT_MS = 5_000;
const RETRY_AFTER_ERROR_MS = 60_000;

type CoopLike = {
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
let backoffUntilMs = 0;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function isVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.hasAttribute("hidden")) return false;
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  return el.getClientRects().length > 0;
}

/** Parse "Next ad in MM:SS" ou "Next ad in H:MM:SS" → secondes. */
function parseWaitSeconds(label: string): number | null {
  const m = label.match(/(?:Next ad in|resets in)\s+(\d+):(\d+)(?::(\d+))?/i);
  if (!m) return null;
  return m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}

/** Parse "N left today" → N. */
function parseAdsLeft(label: string): number | null {
  const m = label.match(/(\d+)\s+left today/i);
  return m ? +m[1] : null;
}

/**
 * Cycle complet d'une pub, tel qu'observé sur le jeu :
 *   1. clic #enemyRespawnAdBtn      → dialog s'ouvre
 *   2. clic #enemyRespawnAdConfirm  → "Watch Ad"
 *   3. bouton → checking → showing (timer 30s côté client)
 *   4. bouton → cooldown, label "Next ad in MM:SS" (crédit serveur appliqué)
 *   5. backoff jusqu'à la fin du cooldown
 *
 * Important : claimAdGems() NE DOIT PAS être appelé. Le jeu crédite tout seul
 * quand le timer de pub se termine. Appeler claimAdGems() en parallèle
 * retourne {ok:true} sans rien créditer (faux positif) ou "Finish the ad first".
 */
async function runOneAd(): Promise<void> {
  const btn = document.getElementById("enemyRespawnAdBtn") as HTMLButtonElement | null;
  if (!btn || !isVisible(btn)) return;

  const label = btn.getAttribute("aria-label") ?? "";
  const adsLeft = parseAdsLeft(label);
  if (adsLeft === 0) {
    console.info("[mod-auto-ad] ⏸ 0 ads restantes, attente reset jour");
    backoffUntilMs = Date.now() + 60 * 60_000;
    return;
  }

  console.info("[mod-auto-ad] 🎬 démarrage cycle pub");

  // ── 1. Ouvre le dialog
  btn.click();
  await sleep(400);

  // ── 2. Attend #enemyRespawnAdPrompt
  let prompt: HTMLElement | null = null;
  const dialogStart = Date.now();
  while (Date.now() - dialogStart < DIALOG_TIMEOUT_MS) {
    prompt = document.getElementById("enemyRespawnAdPrompt");
    if (prompt && isVisible(prompt)) break;
    await sleep(200);
  }
  if (!prompt || !isVisible(prompt)) {
    console.warn("[mod-auto-ad] ⚠️ dialog pub introuvable (bouton sans effet ?)");
    backoffUntilMs = Date.now() + RETRY_AFTER_ERROR_MS;
    return;
  }

  // ── 3. Clic sur #enemyRespawnAdConfirm
  const confirmBtn = document.getElementById("enemyRespawnAdConfirm") as HTMLButtonElement | null;
  if (!confirmBtn || !isVisible(confirmBtn)) {
    console.warn("[mod-auto-ad] ⚠️ bouton confirm introuvable");
    // Ferme le dialog pour ne pas bloquer
    (document.getElementById("enemyRespawnAdCancel") as HTMLButtonElement | null)?.click();
    backoffUntilMs = Date.now() + RETRY_AFTER_ERROR_MS;
    return;
  }
  confirmBtn.click();
  console.info(`[mod-auto-ad] ▶ pub lancée, attente ${PUB_DURATION_MS / 1000}s…`);

  // ── 4. Attend la fin de la pub
  await sleep(PUB_DURATION_MS);

  // ── 5. Lit le nouvel état : cooldown attendu
  const newLabel = btn.getAttribute("aria-label") ?? "";
  const waitSec = parseWaitSeconds(newLabel);
  if (waitSec !== null) {
    backoffUntilMs = Date.now() + waitSec * 1000 + 2_000;
    console.info(`[mod-auto-ad] ✅ pub OK · cooldown ${Math.ceil(waitSec / 60)}min`);
  } else {
    // Pas de cooldown = quelque chose a cloché
    backoffUntilMs = Date.now() + RETRY_AFTER_ERROR_MS;
    console.info("[mod-auto-ad] ⚠️ état post-pub inattendu:", newLabel);
  }
}

async function tick(): Promise<void> {
  if (adRunning) return;
  if (!isAutoAdEnabled()) return;
  if (Date.now() < backoffUntilMs) return;

  const coop = getCoop();
  if (!coop?.isConnected?.()) return;

  const btn = document.getElementById("enemyRespawnAdBtn") as HTMLButtonElement | null;
  if (!btn || !isVisible(btn)) return;

  const state = btn.dataset.state ?? "";
  const label = btn.getAttribute("aria-label") ?? "";

  // Cooldown ou limite jour → parse le wait et backoff
  if (state === "cooldown" || state === "limit") {
    const waitSec = parseWaitSeconds(label);
    if (waitSec !== null) {
      backoffUntilMs = Date.now() + waitSec * 1000 + 2_000;
    } else {
      backoffUntilMs = Date.now() + 5 * 60_000;
    }
    return;
  }

  // Pub déjà en cours (état transitoire) → on laisse finir
  if (state !== "browser") return;

  adRunning = true;
  try {
    await runOneAd();
  } catch (e) {
    console.warn("[mod-auto-ad] exception:", (e as Error).message);
    backoffUntilMs = Date.now() + RETRY_AFTER_ERROR_MS;
  } finally {
    adRunning = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => { void tick(); }, AD_CHECK_INTERVAL_MS);
  void tick();
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
        try { localStorage.setItem(STORAGE_KEY, String(value)); }
        catch { /* idem */ }
        if (value) startPolling();
        else stopPolling();
      },
    },
    install: () => {
      if (isAutoAdEnabled()) startPolling();
    },
  });
}