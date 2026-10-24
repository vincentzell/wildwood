// mods/misc-token-injector.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-token-injector-enabled";
const PENDING_KEY = "wildwood-mod-token-injector-pending";

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

  const ta = document.createElement("textarea");
  ta.value = pendingJson;
  ta.rows = 6;
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
    navigator.clipboard.writeText(json).then(
      () => { btnExport.textContent = "✅ Copié"; setTimeout(() => { btnExport.textContent = "📤 Exporter"; }, 1500); },
      () => { btnExport.textContent = "⚠️ Manuel"; setTimeout(() => { btnExport.textContent = "📤 Exporter"; }, 1500); }
    );
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
    console.info(`[mod-token-injector] ${result.written} clé(s) injectée(s), reload...`);
    alert(`${result.written} clé(s) injectée(s). Reload en cours...`);
    location.reload();
  });

  row.append(btnExport, btnInject);
  wrap.append(row);

  return wrap;
}

export function registerTokenInjectorMod(): void {
  REGISTERED_MODS.push({
    id: "misc-token-injector",
    name: "Token Injector",
    category: "MISC",
    switch: {
      label: "On",
      get: isEnabled,
      set: (value) => {
        try { localStorage.setItem(STORAGE_KEY, String(value)); }
        catch { /* idem */ }
      },
    },
    status: { render: renderStatus, intervalMs: 2000 },
  });
}
