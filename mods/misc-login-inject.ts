// mods/misc-login-inject.ts
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

// ─── Détection de la page de login ───────────────────────────────────────
// Signaux POSITIFS uniquement. #hud est le conteneur de l'app et reste
// visible sur la page de login — on ne l'utilise donc pas comme signal.
function isLoginPage(): boolean {
  const vis = (el: Element | null): boolean =>
    !!el && (el as HTMLElement).offsetParent !== null;
  if (vis(document.getElementById("signInFromStartBtn")))   return true;
  if (vis(document.getElementById("continueGuestBtn")))     return true;
  if (vis(document.getElementById("accountChoicePanel")))   return true;
  return false;
}

// ─── Auto-inject au boot (si pending + pas de token valide) ──────────────
function tryAutoInject(): void {
  if (!isEnabled()) return;
  try {
    if (localStorage.getItem(RELOAD_GUARD) === "1") return;
    const pending = localStorage.getItem(PENDING_KEY);
    if (!pending) return;
    // Si un token est déjà présent, ne pas écraser
    const existing = localStorage.getItem(ID_TOKEN_KEY);
    if (existing) return;
    let parsed: Record<string, string>;
    try { parsed = JSON.parse(pending); } catch { return; }
    let written = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (shouldInclude(k) && typeof v === "string") {
        localStorage.setItem(k, v);
        written++;
      }
    }
    if (written > 0) {
      console.info(`[mod-login-inject] auto-injection ${written} clé(s), reload…`);
      localStorage.setItem(RELOAD_GUARD, "1");
      location.reload();
    }
  } catch { /* idem */ }
}

let pendingJson = "";
try { pendingJson = localStorage.getItem(PENDING_KEY) ?? ""; } catch { /* idem */ }

function persistPending(v: string): void {
  pendingJson = v;
  try { localStorage.setItem(PENDING_KEY, v); } catch { /* idem */ }
}

// ─── Rendu (utilisé par l'overlay ET le mod manager) ─────────────────────
function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");

  const warnEl = document.createElement("div");
  warnEl.style.cssText = "font-size:9px;color:#ff6767;margin-bottom:4px;font-weight:bold;";
  warnEl.textContent = "⚠️ Secret. Ne partage jamais. À usage personnel.";
  wrap.append(warnEl);

  const ta = document.createElement("textarea");
  ta.value = pendingJson;
  ta.rows = 5;
  ta.placeholder = "Colle ici le JSON exporté depuis l'origine...";
  ta.style.cssText =
    "width:100%;box-sizing:border-box;background:rgba(0,0,0,.3);color:inherit;" +
    "border:1px solid rgba(255,255,255,.15);border-radius:3px;padding:4px;" +
    "font-family:monospace;font-size:9px;resize:vertical;";
  ta.addEventListener("input", () => persistPending(ta.value));
  wrap.append(ta);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:4px;margin-top:4px;";

  const btnExport = document.createElement("button");
  btnExport.textContent = "📤 Exporter";
  btnExport.style.cssText =
    "flex:1;padding:4px;background:rgba(116,216,255,.22);color:inherit;border:0;" +
    "border-radius:3px;cursor:pointer;font-size:10px;";
  btnExport.addEventListener("click", () => {
    const json = exportTokens();
    persistPending(json);
    ta.value = json;
    navigator.clipboard.writeText(json).catch(() => {
      const ta2 = document.createElement("textarea");
      ta2.value = json;
      ta2.style.cssText = "position:fixed;left:-9999px;";
      document.body.appendChild(ta2);
      ta2.select();
      document.execCommand("copy");
      document.body.removeChild(ta2);
    });
    btnExport.textContent = "✅ Copié";
    setTimeout(() => { btnExport.textContent = "📤 Exporter"; }, 1500);
  });

  const btnInject = document.createElement("button");
  btnInject.textContent = "📥 Injecter + reload";
  btnInject.style.cssText =
    "flex:1;padding:4px;background:rgba(105,229,111,.22);color:inherit;border:0;" +
    "border-radius:3px;cursor:pointer;font-size:10px;";
  btnInject.addEventListener("click", () => {
    const v = ta.value.trim();
    if (!v) { alert("Colle un JSON d'abord."); return; }
    const result = injectTokens(v);
    if (!result.ok) {
      alert(`Erreur: ${result.error ?? "inconnu"}`);
      return;
    }
    persistPending(v);
    try { localStorage.removeItem(RELOAD_GUARD); } catch { /* idem */ }
    console.info(`[mod-login-inject] ${result.written} clé(s) injectée(s), reload…`);
    location.reload();
  });

  row.append(btnExport, btnInject);
  wrap.append(row);

  // Bouton "Continue as Guest" — uniquement visible sur la page de login
  if (isLoginPage()) {
    const btnGuest = document.createElement("button");
    btnGuest.textContent = "🎮 Jouer en invité";
    btnGuest.style.cssText =
      "width:100%;margin-top:6px;padding:6px;background:rgba(255,215,90,.22);" +
      "color:inherit;border:0;border-radius:3px;cursor:pointer;" +
      "font-size:11px;font-weight:900;";
    btnGuest.addEventListener("click", () => {
      const coop = (window as unknown as { wildstatCoop?: { continueAsGuest?: () => void } }).wildstatCoop;
      if (typeof coop?.continueAsGuest === "function") {
        coop.continueAsGuest();
      } else {
        const native = document.querySelector<HTMLButtonElement>(
          "#continueGuestBtn, #continueAsGuestBtn, [data-action='continueAsGuest']"
        );
        if (native) native.click();
        else alert("wildstatCoop.continueAsGuest indisponible");
      }
    });
    wrap.append(btnGuest);
  }

  return wrap;
}

// ─── Overlay flottant sur la page de login ───────────────────────────────
let _overlayMounted = false;
const OVERLAY_ID = "wildwood-login-inject-overlay";

function mountLoginOverlay(): void {
  if (_overlayMounted) return;
  if (document.getElementById(OVERLAY_ID)) return;
  if (!isLoginPage()) return;
  _overlayMounted = true;

  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  host.dataset.wildwoodMod = "login-inject";
  host.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:2147483647;" +
    "width:320px;max-height:calc(100vh - 32px);overflow:auto;" +
    "padding:10px;background:rgba(20,20,30,.95);color:#e0e0e0;" +
    "border:1px solid rgba(255,255,255,.2);border-radius:6px;" +
    "font-family:system-ui,sans-serif;font-size:11px;" +
    "box-shadow:0 4px 20px rgba(0,0,0,.5);";
  host.appendChild(renderStatus());
  document.body.appendChild(host);

  // Démontage dès qu'on quitte la page de login
  const obs = new MutationObserver(() => {
    if (!isLoginPage()) {
      host.remove();
      _overlayMounted = false;
      obs.disconnect();
    }
  });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true });
}

function watchLoginPage(): void {
  if (isLoginPage()) { mountLoginOverlay(); return; }
  const obs = new MutationObserver(() => {
    if (isLoginPage()) { mountLoginOverlay(); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true, subtree: true, attributes: true });
  setTimeout(() => obs.disconnect(), 60000);
}

// ─── Enregistrement ──────────────────────────────────────────────────────
export function registerLoginInjectMod(): void {
  REGISTERED_MODS.push({
    id: "misc-login-inject",
    name: "Login Inject",
    category: "MISC",
    loginCompatible: true,
    switch: {
      label: "On",
      get: isEnabled,
      set: (value) => {
        try { localStorage.setItem(STORAGE_KEY, String(value)); }
        catch { /* idem */ }
      },
    },
    status: { render: renderStatus, intervalMs: 2000 },
    install: () => {
      tryAutoInject();
      watchLoginPage();
    },
  });
}
