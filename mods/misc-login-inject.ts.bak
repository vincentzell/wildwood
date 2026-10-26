// mods/misc-login-inject.ts
// Login Injector — UI flottante directement sur la page de login (Sign In /
// Continue as Guest / Register), pour injecter un token, passer en guest, ou
// reload. Se retire automatiquement quand le jeu démarre.

import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-login-inject-enabled";
const PENDING_KEY = "wildwood-mod-login-inject-pending";
const RELOAD_GUARD = "__wildwood_login_inject_attempted";
const ID_TOKEN_KEY = "wss://maincloud.spacetimedb.com/wildwood-coop/auth_token/spacetimeauth_id_token_v1";

function isEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== "false"; }
  catch { return true; }
}

function shouldInclude(key: string): boolean {
  return (
    /auth_token\/spacetimeauth_/.test(key) ||
    /auth_token\/legal_consent_/.test(key) ||
    /auth_token\/guest_/.test(key)
  );
}

function exportTokens(): string {
  const out: Record<string, string> = {};
  try {
    for (const k of Object.keys(localStorage)) {
      if (shouldInclude(k)) {
        const v = localStorage.getItem(k);
        if (v !== null) out[k] = v;
      }
    }
  } catch { /* idem */ }
  return JSON.stringify(out, null, 2);
}

function injectTokens(json: string): { ok: boolean; written: number; error?: string } {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(json); }
  catch (e) { return { ok: false, written: 0, error: `JSON invalide: ${(e as Error).message}` }; }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, written: 0, error: "Le JSON doit être un objet" };
  }
  let written = 0;
  try {
    for (const [k, v] of Object.entries(parsed)) {
      if (!shouldInclude(k)) continue;
      if (typeof v !== "string") continue;
      localStorage.setItem(k, v);
      written++;
    }
  } catch (e) {
    return { ok: false, written, error: `Erreur écriture: ${(e as Error).message}` };
  }
  return { ok: true, written };
}

function decodeJwt(token: string): { exp?: number; email?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch { return null; }
}

type TokenCheck = { valid: boolean; email: string; remainingMin: number; reason?: string };

function checkToken(): TokenCheck {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ID_TOKEN_KEY); } catch { /* idem */ }
  if (!raw) return { valid: false, email: "", remainingMin: 0, reason: "Aucun token" };
  const payload = decodeJwt(raw);
  if (!payload || !payload.exp) return { valid: false, email: "", remainingMin: 0, reason: "Token invalide" };
  const remainingMs = payload.exp * 1000 - Date.now();
  return {
    valid: remainingMs > 0,
    email: payload.email ?? "",
    remainingMin: Math.round(remainingMs / 60000),
    reason: remainingMs > 0 ? undefined : "Expiré",
  };
}

// [PATCH:login-inject-v1]
// ─── Détection de la page de login ───
// #hud existe dans le DOM dès le bootstrap mais est caché tant que la page
// de login est affichée (body.is-loading-game-assets). On ne peut donc PAS
// se baser sur sa seule présence : il faut vérifier la visibilité réelle.

function isElementVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.hidden) return false;
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  return el.getClientRects().length > 0;
}

function isLoginPage(): boolean {
  // 1. Si le HUD est réellement visible → on est en jeu
  const hud = document.getElementById("hud");
  if (hud && isElementVisible(hud)) return false;

  // 2. Boutons de login (visibles = page de login)
  const signIn = document.getElementById("signInFromStartBtn");
  if (signIn && isElementVisible(signIn)) return true;

  const guest = document.getElementById("continueGuestBtn");
  if (guest && isElementVisible(guest)) return true;

  // 3. Fallback : panneau de choix de compte visible
  const account = document.getElementById("accountChoicePanel");
  if (account && isElementVisible(account)) return true;

  return false;
}

// ─── State ───
let panel: HTMLElement | null = null;
let observer: MutationObserver | null = null;
let checkTimer: number | null = null;

let pendingJson = "";
try { pendingJson = localStorage.getItem(PENDING_KEY) ?? ""; } catch { /* idem */ }

function persistPending(v: string): void {
  pendingJson = v;
  try { localStorage.setItem(PENDING_KEY, v); } catch { /* idem */ }
}

// ─── UI ───
function buildPanel(): HTMLElement {
  const box = document.createElement("div");
  box.id = "wildwood-login-inject";
  box.style.cssText = `
    position: fixed; top: 12px; right: 12px; z-index: 9999999;
    width: 340px; max-width: calc(100vw - 24px);
    background: rgba(20, 20, 20, 0.95); color: #f5f5e9;
    border: 2px solid #050a06; border-radius: 9px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.6);
    font: 12px/1.3 Arial, sans-serif;
    -webkit-user-select: none; user-select: none;
    display: flex; flex-direction: column;
  `;

  // Header
  const header = document.createElement("div");
  header.style.cssText = `
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,.14);
    font-weight: 900; font-size: 11px; text-transform: uppercase;
    letter-spacing: .05em; color: #74d8ff;
  `;
  header.textContent = "🔐 Login Injector";

  const btnClose = document.createElement("button");
  btnClose.textContent = "×";
  btnClose.style.cssText = `
    background: transparent; border: 0; color: #888; cursor: pointer;
    font-size: 18px; padding: 0 4px; line-height: 1;
  `;
  btnClose.title = "Masquer (relancer via ce bouton si besoin)";
  btnClose.addEventListener("click", () => { box.style.display = "none"; });
  header.append(btnClose);

  // Body
  const body = document.createElement("div");
  body.style.cssText = "padding: 10px; display: flex; flex-direction: column; gap: 8px;";

  // Warning
  const warn = document.createElement("div");
  warn.style.cssText = "font-size: 9px; color: #ff6767; font-weight: bold;";
  warn.textContent = "⚠️ Secret. Ne partage jamais. Usage personnel.";
  body.append(warn);

  // Statut token
  const status = document.createElement("div");
  status.style.cssText = "font-size: 10px; padding: 4px 6px; border-radius: 3px; background: rgba(0,0,0,.3);";
  const updateStatus = () => {
    const check = checkToken();
    if (check.valid) {
      status.textContent = `✓ ${check.email || "(connecté)"} · valide ${check.remainingMin}min`;
      status.style.color = "#69e56f";
    } else {
      status.textContent = `⏸ ${check.reason ?? "non connecté"}`;
      status.style.color = "#ffd85b";
    }
  };
  updateStatus();
  body.append(status);

  // Textarea
  const ta = document.createElement("textarea");
  ta.value = pendingJson;
  ta.rows = 6;
  ta.placeholder = "Colle ici le JSON exporté depuis l'autre compte…";
  ta.style.cssText = `
    width: 100%; box-sizing: border-box;
    background: rgba(0,0,0,.4); color: #f5f5e9;
    border: 1px solid rgba(255,255,255,.15); border-radius: 3px;
    padding: 6px; font-family: monospace; font-size: 9px;
    resize: vertical; outline: none;
  `;
  ta.addEventListener("input", () => persistPending(ta.value));
  body.append(ta);

  // Actions row 1
  const row1 = document.createElement("div");
  row1.style.cssText = "display: flex; gap: 4px;";

  const btnExport = document.createElement("button");
  btnExport.textContent = "📤 Exporter";
  btnExport.style.cssText = `
    flex: 1; padding: 6px; background: rgba(116,216,255,.22); color: inherit;
    border: 0; border-radius: 3px; cursor: pointer; font-size: 10px; font-weight: bold;
  `;
  btnExport.addEventListener("click", async () => {
    const json = exportTokens();
    persistPending(json);
    ta.value = json;
    try { await navigator.clipboard.writeText(json); }
    catch {
      const tmp = document.createElement("textarea");
      tmp.value = json;
      tmp.style.cssText = "position:fixed;left:-9999px;";
      document.body.appendChild(tmp);
      tmp.select();
      document.execCommand("copy");
      document.body.removeChild(tmp);
    }
    btnExport.textContent = "✅ Copié";
    setTimeout(() => { btnExport.textContent = "📤 Exporter"; }, 1500);
  });

  const btnInject = document.createElement("button");
  btnInject.textContent = "📥 Injecter + reload";
  btnInject.style.cssText = `
    flex: 1; padding: 6px; background: rgba(105,229,111,.22); color: inherit;
    border: 0; border-radius: 3px; cursor: pointer; font-size: 10px; font-weight: bold;
  `;
  btnInject.addEventListener("click", () => {
    const v = ta.value.trim();
    if (!v) { alert("Colle un JSON d'abord."); return; }
    const result = injectTokens(v);
    if (!result.ok) { alert(`Erreur: ${result.error ?? "inconnu"}`); return; }
    persistPending(v);
    try { sessionStorage.removeItem(RELOAD_GUARD); } catch { /* idem */ }
    console.info(`[login-inject] ${result.written} clé(s) injectée(s), reload…`);
    location.reload();
  });

  row1.append(btnExport, btnInject);
  body.append(row1);

  // Actions row 2
  const row2 = document.createElement("div");
  row2.style.cssText = "display: flex; gap: 4px;";

  const btnGuest = document.createElement("button");
  btnGuest.textContent = "🎮 Guest";
  btnGuest.style.cssText = `
    flex: 1; padding: 6px; background: rgba(255,215,90,.22); color: inherit;
    border: 0; border-radius: 3px; cursor: pointer; font-size: 10px; font-weight: bold;
  `;
  btnGuest.addEventListener("click", () => {
    const coop = (window as unknown as { wildstatCoop?: { continueAsGuest?: () => void } }).wildstatCoop;
    if (typeof coop?.continueAsGuest === "function") {
      coop.continueAsGuest();
    } else {
      const native = document.querySelector<HTMLButtonElement>(
        "#continueGuestBtn"
      );
      if (native) native.click();
      else alert("continueAsGuest indisponible — le jeu n'est pas encore chargé");
    }
  });

  const btnReload = document.createElement("button");
  btnReload.textContent = "🔄 Reload";
  btnReload.style.cssText = `
    flex: 1; padding: 6px; background: rgba(255,103,103,.22); color: inherit;
    border: 0; border-radius: 3px; cursor: pointer; font-size: 10px; font-weight: bold;
  `;
  btnReload.addEventListener("click", () => location.reload());

  row2.append(btnGuest, btnReload);
  body.append(row2);

  // Timestamps
  const meta = document.createElement("div");
  meta.style.cssText = "font-size: 8px; color: #666; text-align: center;";
  meta.textContent = `v1 · pending=${pendingJson ? "oui" : "non"}`;
  body.append(meta);

  box.append(header, body);

  // Auto-refresh du statut toutes les 2s
  const statusTimer = setInterval(() => {
    if (!document.body.contains(box)) { clearInterval(statusTimer); return; }
    updateStatus();
    meta.textContent = `v1 · pending=${pendingJson ? "oui" : "non"}`;
  }, 2000);

  return box;
}

function mountUI(): void {
  if (panel) return;
  if (!isLoginPage()) return;
  if (!isEnabled()) return;
  panel = buildPanel();
  document.body.append(panel);
  console.info("[login-inject] UI montée sur la page de login");
}

function unmountUI(): void {
  if (!panel) return;
  panel.remove();
  panel = null;
  console.info("[login-inject] UI retirée (jeu chargé)");
}

function syncVisibility(): void {
  if (isLoginPage()) mountUI();
  else unmountUI();
}

// ─── Détection du passage login → jeu ───
// On observe le body pour détecter l'apparition de #hud.
function startObserver(): void {
  if (observer) return;
  observer = new MutationObserver(() => {
    syncVisibility();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (checkTimer !== null) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

// ─── Auto-injection (comme le mod original) ───
function tryAutoInject(): void {
  if (!isEnabled()) return;
  try {
    if (sessionStorage.getItem(RELOAD_GUARD) === "1") return;
    const pending = localStorage.getItem(PENDING_KEY);
    if (!pending) return;
    const check = checkToken();
    if (check.valid) return;
    let parsed: Record<string, string>;
    try { parsed = JSON.parse(pending); } catch { return; }
    const idToken = parsed[ID_TOKEN_KEY];
    if (!idToken) return;
    const payload = decodeJwt(idToken);
    if (!payload || !payload.exp) return;
    if (payload.exp * 1000 <= Date.now()) {
      console.warn("[login-inject] pending token expiré, ré-extrais un token frais");
      return;
    }
    let written = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (shouldInclude(k) && typeof v === "string") {
        localStorage.setItem(k, v);
        written++;
      }
    }
    if (written > 0) {
      console.info(`[login-inject] auto-injection ${written} clé(s), reload…`);
      sessionStorage.setItem(RELOAD_GUARD, "1");
      location.reload();
    }
  } catch { /* idem */ }
}

// ─── Enregistrement ───
export function registerLoginInjectMod(): void {
  REGISTERED_MODS.push({
    id: "misc-login-inject",
    name: "Login Injector",
    category: "MISC",
    loginCompatible: true,
    description: "UI flottante sur la page Sign In / Guest / Register pour injecter un token.",
    switch: {
      label: "On",
      get: isEnabled,
      set: (value) => {
        try { localStorage.setItem(STORAGE_KEY, String(value)); }
        catch { /* idem */ }
        if (value) { syncVisibility(); startObserver(); }
        else { unmountUI(); stopObserver(); }
      },
    },
    status: {
      render: () => {
        // Sur login, l'UI inline est déjà visible → pas besoin de rendu dans le panneau.
        // En jeu, on affiche un mini statut.
        const w = document.createElement("div");
        w.style.cssText = "font-size:10px;opacity:.75;";
        if (isLoginPage()) {
          w.textContent = "🔐 UI visible sur la page de login (en haut à droite)";
        } else {
          const check = checkToken();
          w.textContent = check.valid
            ? `✓ ${check.email || "(connecté)"} · ${check.remainingMin}min`
            : `⏸ ${check.reason ?? "non connecté"}`;
          w.style.color = check.valid ? "#69e56f" : "#ffd85b";
        }
        return w;
      },
      intervalMs: 2000,
    },
    install: () => {
      if (!isEnabled()) return;
      tryAutoInject();
      startObserver();
      // Filet de sécurité : si le body n'était pas prêt au boot
      checkTimer = window.setInterval(syncVisibility, 1000);
      syncVisibility();
    },
  });
}