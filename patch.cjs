#!/usr/bin/env node
// patch.cjs — retire le bouton "📤 Exporter" et la fonction exportTokens()
// de misc-login-inject.ts. Le textarea contient déjà le JSON persisté (via
// persistPending), donc copier suffit pour "exporter" manuellement. Le bouton
// n'apporte rien : il relisait les mêmes clés que l'app utilise déjà.
//
// Usage :
//   node patch.cjs              # patch + typecheck + build
//   node patch.cjs --no-build   # patch seulement
//   node patch.cjs --commit     # patch + build + commit
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

const LOGIN_FILE = 'mods/misc-login-inject.ts';

const log  = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠️ ', ...a);
const err  = (...a) => console.error('❌', ...a);

function readOrNull(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function run(cmd, { capture = false } = {}) {
  if (capture) {
    try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }); }
    catch (e) { return (e.stdout || '') + (e.stderr || ''); }
  }
  try { execSync(cmd, { stdio: 'inherit' }); return true; }
  catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Retire le bloc btnExport (création + listener)
// ─────────────────────────────────────────────────────────────────────────
function removeExportButtonBlock() {
  log('── Suppression bloc btnExport ──');
  const src0 = readOrNull(LOGIN_FILE);
  if (src0 === null) { err(`${LOGIN_FILE} introuvable`); return false; }

  if (!src0.includes('const btnExport = document.createElement')) {
    log('  ✓ bloc btnExport déjà absent');
    return true;
  }

  const startIdx = src0.indexOf('const btnExport = document.createElement');
  const endIdx = src0.indexOf('const btnInject = document.createElement');
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    err('bloc btnExport introuvable (start/end) — patch exact requis');
    return false;
  }

  let src = src0.slice(0, startIdx) + src0.slice(endIdx);

  // row.append(btnExport, btnInject) → row.append(btnInject)
  const before = src;
  src = src.replace(/row\.append\(\s*btnExport\s*,\s*btnInject\s*\)/, 'row.append(btnInject)');
  if (src === before) {
    warn('row.append(btnExport, btnInject) introuvable — vérifie manuellement');
  }

  fs.writeFileSync(LOGIN_FILE, src, 'utf8');
  log('  ✓ bloc btnExport retiré + row.append corrigé');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Retire la fonction exportTokens()
// ─────────────────────────────────────────────────────────────────────────
function removeExportTokensFn() {
  log('── Suppression fonction exportTokens() ──');
  const src0 = readOrNull(LOGIN_FILE);
  if (src0 === null) { err(`${LOGIN_FILE} introuvable`); return false; }

  if (!/function\s+exportTokens\s*\(/.test(src0)) {
    log('  ✓ exportTokens() déjà absent');
    return true;
  }

  // Match `\nfunction exportTokens(): string { ... \n}` (top-level, brace at col 0)
  const re = /\nfunction\s+exportTokens\s*\(\s*\)\s*:\s*string\s*\{[\s\S]*?\n\}\n/;
  if (!re.test(src0)) {
    err('exportTokens() introuvable (signature différente ?) — patch exact requis');
    return false;
  }

  const src = src0.replace(re, '\n');
  fs.writeFileSync(LOGIN_FILE, src, 'utf8');
  log('  ✓ exportTokens() supprimé');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Vérification
// ─────────────────────────────────────────────────────────────────────────
function verify() {
  log('── Vérification ──');
  const src = readOrNull(LOGIN_FILE);
  if (src === null) { err(`${LOGIN_FILE} introuvable`); return false; }

  const problems = [];
  if (src.includes('📤 Exporter'))              problems.push('texte "📤 Exporter" encore présent');
  if (src.includes('const btnExport'))          problems.push('const btnExport encore présent');
  if (/function\s+exportTokens/.test(src))      problems.push('exportTokens() encore présent');
  if (/row\.append\(\s*btnExport/.test(src))    problems.push('row.append(btnExport…) encore présent');

  if (!src.includes('📥 Injecter + reload'))    problems.push('bouton inject disparu (régression)');
  if (!src.includes('row.append(btnInject)'))   problems.push('row.append(btnInject) manquant');

  if (problems.length) {
    for (const p of problems) err(p);
    return false;
  }
  log(`  ✓ ${LOGIN_FILE} : OK (bouton export retiré, inject intact)`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 4. typecheck + build
// ─────────────────────────────────────────────────────────────────────────
function buildAndTypecheck() {
  if (!DO_BUILD) { log('── Build (skip: --no-build) ──'); return true; }
  log('── npm run typecheck:coop ──');
  if (!run('npm run typecheck:coop')) { err('typecheck:coop a échoué'); return false; }
  log('── npm run build:client ──');
  if (!run('npm run build:client')) { err('build:client a échoué'); return false; }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 5. commit + push
// ─────────────────────────────────────────────────────────────────────────
function commitAndPush() {
  if (!DO_COMMIT) { log('── Commit/push (skip : utilise --commit ou --push) ──'); return true; }
  log('── git add + commit ──');
  if (!run('git add -A')) { err('git add a échoué'); return false; }
  const msg = 'chore(login-inject): remove useless export button, textarea is the backup';
  const out = run(`git commit -m "${msg}"`, { capture: true });
  if (/nothing to commit/i.test(out)) warn('git commit : rien à commit (déjà fait ?)');
  else if (/error/i.test(out)) { err('git commit a échoué : ' + out.trim()); return false; }
  else log('  ✓ commit fait');

  if (!DO_PUSH) { log('  ✓ (skip push — utilise --push)'); return true; }
  log('── git push origin main ──');
  if (!run('git push origin main')) { err('git push a échoué'); return false; }
  log('  ✓ push fait');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync('mods') || !fs.existsSync(LOGIN_FILE)) {
    err('Lance depuis la racine du repo (mods/misc-login-inject.ts requis).');
    process.exit(1);
  }

  const steps = [
    ['Remove btnExport',  removeExportButtonBlock],
    ['Remove exportFn',   removeExportTokensFn],
    ['Verify',            verify],
    ['Build',             buildAndTypecheck],
    ['Commit/push',       commitAndPush],
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
    log('  git commit -m "chore(login-inject): remove useless export button, textarea is the backup"');
    log('  git push origin main');
  }
  log('');
  log('Après hard-reload, la carte Login Inject ressemble à :');
  log('  ⚠️ Secret. Ne partage jamais. À usage personnel.');
  log('  ✓ user@example.com · valide 42min');
  log('  [textarea avec le JSON persisté]');
  log('  [📥 Injecter + reload]     ← pleine largeur');
  log('');
  log('Pour "exporter", sélectionne le contenu du textarea et Ctrl+C.');
  log('C\'est exactement ce que l\'ancien bouton te donnait, sans le bouton.');
}

main();