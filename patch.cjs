#!/usr/bin/env node
// patch.cjs — fix complet "token avant login + overlay sur login page"
// Usage : node patch.cjs (depuis la racine du repo)
// Idempotent.

'use strict';
const fs = require('fs');

const TOKEN_FILE = 'mods/misc-token-injector.ts';
const LOGIN_FILE = 'mods/misc-login-inject.ts';
const INDEX_FILE = 'mods/index.ts';
const USERSCRIPT = 'wildwood-auto-token.user.js';

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const rep = (src, from, to) => src.includes(from) ? src.split(from).join(to) : null;

// ─────────────────────────────────────────────────────────────────────────
// 1. Patches sur misc-token-injector.ts
// ─────────────────────────────────────────────────────────────────────────
function patchTokenInjector() {
  const src0 = readOrNull(TOKEN_FILE);
  if (src0 === null) {
    console.error(`❌ ${TOKEN_FILE} introuvable.`);
    process.exit(1);
  }
  let src = src0;
  const applied = [];
  const skipped = [];

  // ── 1a. Guard check : sessionStorage "1" sticky → TTL 5s
  if (!src.includes('TTL 5s au lieu du flag sticky')) {
    const r = rep(
      src,
      'if (sessionStorage.getItem(RELOAD_GUARD) === "1") return;',
      '// [patched] TTL 5s au lieu du flag sticky — autorise la réinjection après expiration\n' +
      '    const _lastAttempt = parseInt(sessionStorage.getItem(RELOAD_GUARD) || "0", 10);\n' +
      '    if (Date.now() - _lastAttempt < 5000) return;'
    );
    if (r !== null) { src = r; applied.push('guard check (flag → TTL 5s)'); }
    else skipped.push('guard check (introuvable)');
  }

  // ── 1b. Guard set : "1" → timestamp
  if (!src.includes('[patched] timestamp')) {
    const r = rep(
      src,
      'sessionStorage.setItem(RELOAD_GUARD, "1");',
      'sessionStorage.setItem(RELOAD_GUARD, String(Date.now())); // [patched] timestamp'
    );
    if (r !== null) { src = r; applied.push('guard set (flag → timestamp)'); }
    else skipped.push('guard set (introuvable)');
  }

  // ── 1c. Guest selector : ajoute #continueGuestBtn (celui que ton DOM expose)
  if (!src.includes('#continueGuestBtn')) {
    const r = rep(
      src,
      `"#continueAsGuestBtn, [data-action='continueAsGuest']"`,
      `"#continueGuestBtn, #continueAsGuestBtn, [data-action='continueAsGuest']"`
    );
    if (r !== null) { src = r; applied.push('guest selector (+#continueGuestBtn)'); }
    else skipped.push('guest selector (introuvable)');
  }

  // ── 1d. onLoginPage : !#hud → isLoginPage()
  if (!src.includes('const onLoginPage = isLoginPage();')) {
    const r = rep(
      src,
      'const onLoginPage = !document.getElementById("hud");',
      'const onLoginPage = isLoginPage(); // [patched] positive signals, pas #hud'
    );
    if (r !== null) { src = r; applied.push('onLoginPage → isLoginPage()'); }
    else skipped.push('onLoginPage (introuvable)');
  }

  // ── 1e. Injecte isLoginPage + mountLoginOverlay + watchLoginPage
  if (!src.includes('function isLoginPage(): boolean')) {
    const anchor = 'export function registerTokenInjectorMod(): void {';
    const block = `
// ─── [patched:overlay] Login-page overlay ───────────────────────────────
// Détection par signaux POSITIFS uniquement — jamais #hud (qui est le
// conteneur de l'app et est visible même sur la page de login).
function isLoginPage(): boolean {
  const vis = (el: Element | null): boolean =>
    !!el && (el as HTMLElement).offsetParent !== null;
  if (vis(document.getElementById("signInFromStartBtn"))) return true;
  if (vis(document.getElementById("continueGuestBtn")))   return true;
  if (vis(document.getElementById("accountChoicePanel"))) return true;
  return false;
}

let _overlayMounted = false;

function mountLoginOverlay(): void {
  if (_overlayMounted) return;
  if (document.getElementById("wildwood-token-injector-overlay")) return;
  if (!isLoginPage()) return;
  _overlayMounted = true;

  const host = document.createElement("div");
  host.id = "wildwood-token-injector-overlay";
  host.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:2147483647;" +
    "width:320px;max-height:calc(100vh - 32px);overflow:auto;" +
    "padding:10px;background:rgba(20,20,30,.95);color:#e0e0e0;" +
    "border:1px solid rgba(255,255,255,.2);border-radius:6px;" +
    "font-family:system-ui,sans-serif;font-size:11px;" +
    "box-shadow:0 4px 20px rgba(0,0,0,.5);";
  host.appendChild(renderStatus());
  document.body.appendChild(host);

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

`;
    if (src.includes(anchor)) {
      src = src.replace(anchor, block + anchor);
      applied.push('isLoginPage + mountLoginOverlay + watchLoginPage ajoutés');
    } else {
      skipped.push('insertion overlay (anchor introuvable)');
    }
  }

  // ── 1f. install() : ajoute watchLoginPage
  if (!src.includes('install: () => { tryAutoInject(); watchLoginPage(); }')) {
    const r = rep(
      src,
      'install: () => tryAutoInject(),',
      'install: () => { tryAutoInject(); watchLoginPage(); },'
    );
    if (r !== null) { src = r; applied.push('install() wire watchLoginPage'); }
    else skipped.push('install() (introuvable)');
  }

  if (src === src0) {
    console.log(`✓ ${TOKEN_FILE} : aucun changement.`);
    return;
  }
  fs.writeFileSync(`${TOKEN_FILE}.bak`, src0, 'utf8');
  fs.writeFileSync(TOKEN_FILE, src, 'utf8');
  console.log(`✅ ${TOKEN_FILE} patché (backup .bak)`);
  applied.forEach((c) => console.log(`   • ${c}`));
  skipped.forEach((c) => console.warn(`   ⚠️  ${c}`));
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Supprime misc-login-inject.ts + refs index.ts
// ─────────────────────────────────────────────────────────────────────────
function removeLoginInject() {
  if (fs.existsSync(LOGIN_FILE)) {
    const c = readOrNull(LOGIN_FILE);
    if (c !== null) fs.writeFileSync(`${LOGIN_FILE}.bak`, c, 'utf8');
    fs.unlinkSync(LOGIN_FILE);
    console.log(`✅ ${LOGIN_FILE} supprimé (backup .bak)`);
  } else {
    console.log(`✓ ${LOGIN_FILE} déjà absent.`);
  }

  const idx0 = readOrNull(INDEX_FILE);
  if (idx0 === null) { console.warn(`⚠️  ${INDEX_FILE} introuvable.`); return; }
  const idx = idx0
    .split(/\r?\n/)
    .filter((l) => !/misc-login-inject/i.test(l) && !/\bregisterLoginInjectMod\b/i.test(l))
    .join('\n');
  if (idx !== idx0) {
    fs.writeFileSync(`${INDEX_FILE}.bak`, idx0, 'utf8');
    fs.writeFileSync(INDEX_FILE, idx, 'utf8');
    console.log(`✅ ${INDEX_FILE} nettoyé (import + registerLoginInjectMod)`);
  } else {
    console.log(`✓ ${INDEX_FILE} : rien à retirer.`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Userscript Tampermonkey (document-start = avant boot app)
// ─────────────────────────────────────────────────────────────────────────
function createUserscript() {
  if (fs.existsSync(USERSCRIPT)) {
    console.log(`✓ ${USERSCRIPT} existe déjà.`);
    return;
  }
  const body = `// ==UserScript==
// @name         Wildwood auto-token
// @namespace    wildwood.local
// @version      1.1
// @description  Injecte le token Wildwood AVANT le boot de l'app (zéro flash login)
// @match        https://vincentzell.github.io/wildwood/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  const ID = 'wss://maincloud.spacetimedb.com/wildwood-coop/auth_token/spacetimeauth_id_token_v1';
  const pending = localStorage.getItem('wildwood-mod-token-injector-pending');
  if (!pending) return;
  let parsed;
  try { parsed = JSON.parse(pending); } catch { return; }
  if (!parsed || typeof parsed !== 'object') return;

  // Vérifie l'expiration du JWT avant d'écrire
  const raw = parsed[ID];
  if (typeof raw === 'string') {
    try {
      const parts = raw.split('.');
      if (parts.length === 3) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
        const payload = JSON.parse(atob(padded));
        if (payload.exp && payload.exp * 1000 <= Date.now()) {
          console.warn('[wildwood] pending token expiré — login page affichée');
          return;
        }
      }
    } catch { /* opaque : tente quand même */ }
  }

  let written = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && /auth_token\\/(spacetimeauth_|legal_consent_|guest_)/.test(k)) {
      localStorage.setItem(k, v);
      written++;
    }
  }
  if (written > 0) console.info('[wildwood] auto-token injecté avant boot:', written, 'clé(s)');
})();
`;
  fs.writeFileSync(USERSCRIPT, body, 'utf8');
  console.log(`✅ ${USERSCRIPT} créé.`);
  console.log('   → Glisse le fichier dans le dashboard Tampermonkey pour l\'installer.');
}

// ─────────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync('mods') || !fs.existsSync(INDEX_FILE)) {
    console.error('❌ Lance depuis la racine du repo.');
    process.exit(1);
  }
  patchTokenInjector();
  removeLoginInject();
  createUserscript();
  console.log('');
  console.log('Prochaines étapes :');
  console.log('  1. npm run build');
  console.log('  2. Ctrl+Shift+R');
  console.log('  3. Console : localStorage.getItem("wildwood-mod-token-injector-pending") doit exister');
  console.log('  4. Tampermonkey : installer wildwood-auto-token.user.js');
  console.log('  5. Recharger → token injecté avant boot → pas de login');
  console.log('');
  console.log('Si le token est expiré / absent :');
  console.log('  → login page apparaît → overlay en haut à droite');
  console.log('  → coller un JSON frais → 📥 Injecter + reload');
  console.log('  → ou 🎮 Jouer en invité');
}

main();