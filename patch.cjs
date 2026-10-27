#!/usr/bin/env node
// patch.cjs — supprime le mod misc-open-dev (panneau dev du jeu).
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

const FILE = 'mods/misc-open-dev.ts';
const INDEX = 'mods/index.ts';

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
// 1. Supprimer le fichier
// ─────────────────────────────────────────────────────────────────────────
function removeFile() {
  log('── Suppression misc-open-dev.ts ──');
  if (!fs.existsSync(FILE)) {
    log(`  ✓ ${FILE} déjà absent`);
    return true;
  }
  const tracked = run(`git ls-files --error-unmatch "${FILE}"`, { capture: true });
  if (tracked && !/error/i.test(tracked) && tracked.trim().length > 0) {
    if (!run(`git rm "${FILE}"`)) {
      err(`git rm a échoué sur ${FILE}`);
      return false;
    }
    log(`  ✓ ${FILE} supprimé (git rm)`);
  } else {
    fs.unlinkSync(FILE);
    log(`  ✓ ${FILE} supprimé`);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Nettoyer mods/index.ts (import + appel)
// ─────────────────────────────────────────────────────────────────────────
function cleanIndex() {
  log('── Nettoyage mods/index.ts ──');
  const src0 = readOrNull(INDEX);
  if (src0 === null) { err(`${INDEX} introuvable`); return false; }

  const src = src0
    .split(/\r?\n/)
    .filter((line) => {
      // import de misc-open-dev
      if (/import\s+\{[^}]*registerOpenDevMod[^}]*\}\s+from\s+["']\.\/misc-open-dev["']/.test(line)) return false;
      // appel registerOpenDevMod();
      if (/^\s*registerOpenDevMod\s*\(\s*\)\s*;?\s*$/.test(line)) return false;
      return true;
    })
    .join('\n');

  if (src === src0) {
    log('  ✓ rien à retirer (déjà clean)');
    return true;
  }
  fs.writeFileSync(INDEX, src, 'utf8');
  log(`  ✓ ${INDEX} nettoyé (import + appel retirés)`);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Vérification
// ─────────────────────────────────────────────────────────────────────────
function verify() {
  log('── Vérification ──');
  const problems = [];

  if (fs.existsSync(FILE)) problems.push(`${FILE} encore présent`);

  const idx = readOrNull(INDEX);
  if (idx === null) problems.push(`${INDEX} introuvable`);
  else {
    if (/misc-open-dev/.test(idx))       problems.push(`${INDEX} : import misc-open-dev encore présent`);
    if (/registerOpenDevMod/.test(idx))  problems.push(`${INDEX} : appel registerOpenDevMod encore présent`);
  }

  // Aucune autre référence ailleurs dans mods/
  try {
    const files = fs.readdirSync('mods', { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.ts'))
      .map(e => `mods/${e.name}`)
      .filter(p => p !== FILE && p !== INDEX);
    for (const f of files) {
      const c = readOrNull(f);
      if (c && /misc-open-dev|registerOpenDevMod|isOpenDevEnabled/.test(c)) {
        problems.push(`${f} : référence résiduelle à open-dev`);
      }
    }
  } catch { /* readdir a échoué, pas critique */ }

  if (problems.length) {
    for (const p of problems) err(p);
    return false;
  }
  log('  ✓ Aucune référence résiduelle');
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
  const msg = 'chore(mods): remove misc-open-dev';
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
  if (!fs.existsSync('mods') || !fs.existsSync(INDEX)) {
    err('Lance depuis la racine du repo (mods/ + mods/index.ts requis).');
    process.exit(1);
  }

  const steps = [
    ['Suppression',  removeFile],
    ['Index clean',  cleanIndex],
    ['Verify',       verify],
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
    log('  git commit -m "chore(mods): remove misc-open-dev"');
    log('  git push origin main');
  }
  log('');
  log('Nettoyage navigateur (une seule fois), console du jeu :');
  log('  localStorage.removeItem("wildwood-mod-open-dev-enabled");');
}

main();