#!/usr/bin/env node
// patch.cjs — supprime misc-token-injector (redondant), garde misc-login-inject
// comme seul mod d'injection de token (usage : au login uniquement).
//
// Usage :
//   node patch.cjs              # patch + typecheck + build
//   node patch.cjs --no-build   # patch seulement
//   node patch.cjs --commit     # patch + build + commit (sans push)
//   node patch.cjs --push       # patch + build + commit + push
//
// Idempotent.

'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

const FLAGS = new Set(process.argv.slice(2));
const DO_BUILD  = !FLAGS.has('--no-build');
const DO_COMMIT = FLAGS.has('--commit') || FLAGS.has('--push');
const DO_PUSH   = FLAGS.has('--push');

const TOKEN_FILE = 'mods/misc-token-injector.ts';
const LOGIN_FILE = 'mods/misc-login-inject.ts';
const INDEX_FILE = 'mods/index.ts';

const log  = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠️ ', ...a);
const err  = (...a) => console.error('❌', ...a);

function readOrNull(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// Retourne true si succès, false si échec. Mode capture : retourne stdout+stderr.
function run(cmd, { capture = false } = {}) {
  if (capture) {
    try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }); }
    catch (e) { return (e.stdout || '') + (e.stderr || ''); }
  }
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

// ─── 1. supprimer misc-token-injector.ts ─────────────────────────────────
function removeTokenInjector() {
  log('── Suppression misc-token-injector.ts ──');
  if (!fs.existsSync(TOKEN_FILE)) {
    log(`  ✓ ${TOKEN_FILE} déjà absent`);
    return true;
  }
  const tracked = run(`git ls-files --error-unmatch "${TOKEN_FILE}"`, { capture: true });
  if (tracked && !/error/i.test(tracked) && tracked.trim().length > 0) {
    if (!run(`git rm "${TOKEN_FILE}"`)) {
      err(`git rm a échoué sur ${TOKEN_FILE}`);
      return false;
    }
    log(`  ✓ ${TOKEN_FILE} supprimé (git rm)`);
  } else {
    fs.unlinkSync(TOKEN_FILE);
    log(`  ✓ ${TOKEN_FILE} supprimé`);
  }
  return true;
}

// ─── 2. nettoyer mods/index.ts ────────────────────────────────────────────
function cleanIndex() {
  log('── Nettoyage mods/index.ts ──');
  const src0 = readOrNull(INDEX_FILE);
  if (src0 === null) { err(`${INDEX_FILE} introuvable`); return false; }

  const src = src0
    .split(/\r?\n/)
    .filter((line) => {
      if (/import\s+\{[^}]*registerTokenInjectorMod[^}]*\}\s+from\s+["']\.\/misc-token-injector["']/.test(line)) return false;
      if (/^\s*registerTokenInjectorMod\s*\(\s*\)\s*;?\s*$/.test(line)) return false;
      return true;
    })
    .join('\n');

  if (src === src0) { log('  ✓ rien à retirer (déjà clean)'); return true; }
  fs.writeFileSync(INDEX_FILE, src, 'utf8');
  log(`  ✓ ${INDEX_FILE} nettoyé (import + appel retirés)`);
  return true;
}

// ─── 3. vérifier login-inject.ts ──────────────────────────────────────────
function verifyLoginInject() {
  log('── Vérification misc-login-inject.ts ──');
  const src = readOrNull(LOGIN_FILE);
  if (src === null) { err(`${LOGIN_FILE} introuvable`); return false; }

  const problems = [];
  if (!/export\s+function\s+registerLoginInjectMod/.test(src))
    problems.push('export registerLoginInjectMod manquant');
  if (!/function\s+isLoginPage/.test(src))
    problems.push('isLoginPage() manquant');
  if (/getElementById\(\s*["']hud["']\s*\)/.test(src))
    problems.push('référence #hud encore présente (bug reviendra)');

  if (problems.length) {
    for (const p of problems) err(`${LOGIN_FILE}: ${p}`);
    return false;
  }
  log(`  ✓ ${LOGIN_FILE} : OK (fix #hud en place)`);
  return true;
}

// ─── 4. vérifier index.ts ─────────────────────────────────────────────────
function verifyIndex() {
  log('── Vérification mods/index.ts ──');
  const src = readOrNull(INDEX_FILE);
  if (src === null) { err(`${INDEX_FILE} introuvable`); return false; }

  const problems = [];
  if (!/from\s+["']\.\/misc-login-inject["']/.test(src))
    problems.push('import misc-login-inject manquant');
  if (!/\bregisterLoginInjectMod\s*\(\s*\)/.test(src))
    problems.push('appel registerLoginInjectMod() manquant');
  if (/misc-token-injector|registerTokenInjectorMod/.test(src))
    problems.push('référence token-injector encore présente');

  if (problems.length) {
    for (const p of problems) err(`${INDEX_FILE}: ${p}`);
    return false;
  }
  log(`  ✓ ${INDEX_FILE} : OK`);
  return true;
}

// ─── 5. typecheck + build ─────────────────────────────────────────────────
function buildAndTypecheck() {
  if (!DO_BUILD) { log('── Build (skip: --no-build) ──'); return true; }
  log('── npm run typecheck:coop ──');
  if (!run('npm run typecheck:coop')) { err('typecheck:coop a échoué'); return false; }
  log('── npm run build:client ──');
  if (!run('npm run build:client')) { err('build:client a échoué'); return false; }
  return true;
}

// ─── 6. commit + push ─────────────────────────────────────────────────────
function commitAndPush() {
  if (!DO_COMMIT) { log('── Commit/push (skip : utilise --commit ou --push) ──'); return true; }
  log('── git add + commit ──');
  if (!run('git add -A')) { err('git add a échoué'); return false; }
  const msg = 'refactor(mods): remove token-injector, login-inject is login-only';
  const out = run(`git commit -m "${msg}"`, { capture: true });
  if (/nothing to commit/i.test(out)) {
    warn('git commit : rien à commit (déjà fait ?)');
  } else if (/error/i.test(out) && !/nothing to commit/i.test(out)) {
    err('git commit a échoué : ' + out.trim());
    return false;
  } else {
    log('  ✓ commit fait');
  }

  if (!DO_PUSH) { log('  ✓ (skip push — utilise --push)'); return true; }
  log('── git push origin main ──');
  if (!run('git push origin main')) { err('git push a échoué'); return false; }
  log('  ✓ push fait');
  return true;
}

// ─── main ─────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync('mods') || !fs.existsSync(INDEX_FILE)) {
    err('Lance depuis la racine du repo (mods/ + mods/index.ts requis).');
    process.exit(1);
  }

  const steps = [
    ['Suppression',  removeTokenInjector],
    ['Index clean',  cleanIndex],
    ['Verify login', verifyLoginInject],
    ['Verify index', verifyIndex],
    ['Build',        buildAndTypecheck],
    ['Commit/push',  commitAndPush],
  ];
  for (const [name, fn] of steps) {
    if (!fn()) { err(`Étape "${name}" a échoué — arrêt.`); process.exit(2); }
  }

  log('');
  log('✅ Terminé.');
  if (!DO_COMMIT) {
    log('');
    log('Commit + push manuels :');
    log('  git add -A');
    log('  git commit -m "refactor(mods): remove token-injector, login-inject is login-only"');
    log('  git push origin main');
  }
  log('');
  log('Nettoyage navigateur (une seule fois), console du jeu :');
  log('  localStorage.removeItem("wildwood-mod-token-injector-enabled");');
  log('  localStorage.removeItem("wildwood-mod-token-injector-pending");');
  log('  sessionStorage.removeItem("__wt_auto_inject_attempted");');
}

main();