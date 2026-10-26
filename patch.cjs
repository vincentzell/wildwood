#!/usr/bin/env node
// patch.cjs — applique tout le fix "token avant login" :
//   1. misc-token-injector.ts : reload guard TTL (au lieu du flag sticky)
//                              + sélecteur guest corrigé (#continueGuestBtn)
//   2. supprime misc-login-inject.ts + son enregistrement dans index.ts
//   3. crée wildwood-auto-token.user.js (Tampermonkey, @run-at document-start)
//
// Usage : node patch.cjs
// Idempotent : relance sans risque.

'use strict';
const fs = require('fs');

const TOKEN_FILE = 'mods/misc-token-injector.ts';
const LOGIN_FILE = 'mods/misc-login-inject.ts';
const INDEX_FILE = 'mods/index.ts';
const USERSCRIPT = 'wildwood-auto-token.user.js';
const MARKER     = '// [patched:token-injector-v2]';

// ─── utils ────────────────────────────────────────────────────────────────
const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const replaceExact = (src, from, to) => src.includes(from) ? src.split(from).join(to) : null;

// ─── 1. token-injector : TTL guard + selector guest ──────────────────────
function patchTokenInjector() {
  const src0 = readOrNull(TOKEN_FILE);
  if (src0 === null) {
    console.error(`❌ ${TOKEN_FILE} introuvable — lance depuis la racine du repo.`);
    process.exit(1);
  }
  if (src0.includes(MARKER)) {
    console.log(`✓ ${TOKEN_FILE} déjà patché.`);
    return;
  }

  let src = src0;
  let changes = [];

  // a) Guard check : sessionStorage "1" sticky → TTL 5s
  const oldCheck = 'if (sessionStorage.getItem(RELOAD_GUARD) === "1") return;';
  const newCheck =
    '// [patched] TTL 5s au lieu du flag sticky — autorise la réinjection après expiration\n' +
    '    const _lastAttempt = parseInt(sessionStorage.getItem(RELOAD_GUARD) || "0", 10);\n' +
    '    if (Date.now() - _lastAttempt < 5000) return;';
  const a = replaceExact(src, oldCheck, newCheck);
  if (a !== null) { src = a; changes.push('guard check (flag → TTL)'); }
  else console.warn('⚠️  guard check introuvable — vérifie que la ligne est identique');

  // b) Guard set : "1" → timestamp
  const oldSet = 'sessionStorage.setItem(RELOAD_GUARD, "1");';
  const newSet = 'sessionStorage.setItem(RELOAD_GUARD, String(Date.now())); // [patched] timestamp';
  const b = replaceExact(src, oldSet, newSet);
  if (b !== null) { src = b; changes.push('guard set (flag → timestamp)'); }
  else console.warn('⚠️  guard set introuvable');

  // c) Selector guest : ajoute #continueGuestBtn (celui qui existe vraiment)
  const oldSel = '"#continueAsGuestBtn, [data-action=\'continueAsGuest\']"';
  const newSel = '"#continueGuestBtn, #continueAsGuestBtn, [data-action=\'continueAsGuest\']"';
  const c = replaceExact(src, oldSel, newSel);
  if (c !== null) { src = c; changes.push('guest selector (+#continueGuestBtn)'); }
  else console.warn('⚠️  selector guest introuvable');

  if (src === src0) {
    console.log(`✓ ${TOKEN_FILE} : aucun changement nécessaire.`);
    return;
  }

  fs.writeFileSync(`${TOKEN_FILE}.bak`, src0, 'utf8');
  fs.writeFileSync(TOKEN_FILE, src + `\n${MARKER}\n`, 'utf8');
  console.log(`✅ ${TOKEN_FILE} patché (backup .bak)`);
  changes.forEach((c) => console.log(`   • ${c}`));
}

// ─── 2. Suppression misc-login-inject + refs index.ts ────────────────────
function removeLoginInject() {
  // a) fichier
  if (fs.existsSync(LOGIN_FILE)) {
    const content = readOrNull(LOGIN_FILE);
    if (content !== null) fs.writeFileSync(`${LOGIN_FILE}.bak`, content, 'utf8');
    fs.unlinkSync(LOGIN_FILE);
    console.log(`✅ ${LOGIN_FILE} supprimé (backup .bak)`);
  } else {
    console.log(`✓ ${LOGIN_FILE} déjà absent.`);
  }

  // b) index.ts : retire import + appel
  const idx0 = readOrNull(INDEX_FILE);
  if (idx0 === null) {
    console.warn(`⚠️  ${INDEX_FILE} introuvable — nettoie l'import à la main.`);
    return;
  }
  const idx = idx0
    .split(/\r?\n/)
    .filter((line) =>
      !/misc-login-inject/i.test(line) &&
      !/\bregisterLoginInjectMod\b/i.test(line)
    )
    .join('\n');

  if (idx !== idx0) {
    fs.writeFileSync(`${INDEX_FILE}.bak`, idx0, 'utf8');
    fs.writeFileSync(INDEX_FILE, idx, 'utf8');
    console.log(`✅ ${INDEX_FILE} nettoyé (import + registerLoginInjectMod retirés)`);
  } else {
    console.log(`✓ ${INDEX_FILE} : rien à retirer.`);
  }
}

// ─── 3. Userscript Tampermonkey ──────────────────────────────────────────
function createUserscript() {
  if (fs.existsSync(USERSCRIPT)) {
    console.log(`✓ ${USERSCRIPT} existe déjà.`);
    return;
  }
  const body = `// ==UserScript==
// @name         Wildwood auto-token
// @namespace    wildwood.local
// @version      1.0
// @description  Injecte le token Wildwood AVANT le boot de l'app (zéro flash login)
// @match        https://vincentzell.github.io/wildwood/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  const ID = 'wss://maincloud.spacetimedb.com/wildwood-coop/auth_token/spacetimeauth_id_token_v1';
  // Pending partagé avec mods/misc-token-injector.ts (rempli via l'UI "📥 Injecter")
  const pending = localStorage.getItem('wildwood-mod-token-injector-pending');
  if (!pending) return;
  let parsed;
  try { parsed = JSON.parse(pending); } catch { return; }
  if (!parsed || typeof parsed !== 'object') return;

  // Vérifie l'expiration du token principal avant d'écrire
  const raw = parsed[ID];
  if (typeof raw === 'string') {
    try {
      const parts = raw.split('.');
      if (parts.length === 3) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
        const payload = JSON.parse(atob(padded));
        if (payload.exp && payload.exp * 1000 <= Date.now()) {
          console.warn('[wildwood] pending token expiré — affichage login normal');
          return;
        }
      }
    } catch { /* token opaque : tente quand même */ }
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

// ─── main ─────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync('mods') || !fs.existsSync(INDEX_FILE)) {
    console.error('❌ Lance depuis la racine du repo (mods/ et mods/index.ts requis).');
    process.exit(1);
  }

  patchTokenInjector();
  removeLoginInject();
  createUserscript();

  console.log('');
  console.log('Prochaines étapes :');
  console.log('  1. npm run build');
  console.log('  2. Ctrl+Shift+R pour recharger sans cache');
  console.log('  3. Vérifie dans la console :');
  console.log("       localStorage.getItem('wildwood-mod-token-injector-pending')  // doit exister");
  console.log('  4. Installe wildwood-auto-token.user.js dans Tampermonkey → zéro flash login au prochain chargement');
}

main();