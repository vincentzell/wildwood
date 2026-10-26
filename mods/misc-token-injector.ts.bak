// mods/misc-token-injector.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-token-injector-enabled";
const PENDING_KEY = "wildwood-mod-token-injector-pending";
const RELOAD_GUARD = "__wt_auto_inject_attempted";
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
  if (!raw) return { valid: false, email: "", remainingMin: 0, reason: "Aucun token (pas connecté)" };
  const payload = decodeJwt(raw);
  if (!payload || !payload.exp) return { valid: false, email: "", remainingMin: 0, reason: "Token invalide" };
  const remainingMs = payload.exp * 1000 - Date.now();
  return {
    valid: remainingMs > 0,
    email: payload.email ?? "",
    remainingMin: Math.round(remainingMs / 60000),
    reason: remainingMs > 0 ? undefined : "Token expiré",
  };
}

function tryAutoInject(): void {
  if (!isEnabled()) return;
  try {
    // [patched] TTL 5s au lieu du flag sticky — autorise la réinjection après expiration
    const _lastAttempt = parseInt(sessionStorage.getItem(RELOAD_GUARD) || "0", 10);
    if (Date.now() - _lastAttempt < 5000) return;
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
      console.warn("[mod-token-injector] pending token expiré, ré-extrais un token frais");
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
      console.info(`[mod-token-injector] auto-injection ${written} clé(s), reload…`);
      sessionStorage.setItem(RELOAD_GUARD, String(Date.now())); // [patched] timestamp
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

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");

  const warn = document.createElement("div");
  warn.style.cssText = "font-size:9px;color:#ff6767;margin-bottom:4px;font-weight:bold;";
  warn.textContent = "⚠️ Secret. Ne partage jamais. À usage personnel.";
  wrap.append(warn);

  const check = checkToken();
  const info = document.createElement("div");
  info.style.cssText = "font-size:9px;margin-bottom:4px;";
  if (check.valid) {
    info.style.color = "#69e56f";
    info.textContent = `✓ ${check.email} · valide ${check.remainingMin}min`;
  } else {
    info.style.color = "#ffd85b";
    info.textContent = `⏸ ${check.reason ?? "Non connecté"}`;
  }
  wrap.append(info);

  if (pendingJson) {
    const pendingInfo = document.createElement("div");
    pendingInfo.style.cssText = "font-size:8px;opacity:.55;margin-bottom:4px;";
    pendingInfo.textContent = "Token en mémoire (auto-réinjecté au boot si expiré).";
    wrap.append(pendingInfo);
  }

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
    try { sessionStorage.removeItem(RELOAD_GUARD); } catch { /* idem */ }
    console.info(`[mod-token-injector] ${result.written} clé(s) injectée(s), reload…`);
    location.reload();
  });

  row.append(btnExport, btnInject);
  wrap.append(row);

  // Bouton "Continue as Guest" — uniquement visible hors jeu (page de login)
  const onLoginPage = !document.getElementById("hud");
  if (onLoginPage) {
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

export function registerTokenInjectorMod(): void {
  REGISTERED_MODS.push({
        id: "misc-token-injector",
    name: "Token Injector",
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
    install: () => tryAutoInject(),
  });
}

// [patched:token-injector-v2]
