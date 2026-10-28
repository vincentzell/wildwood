#!/usr/bin/env node
// fix.cjs — corrige les patches mutex mal placés : déplace `const MODULE_ID`
// au top-level (après les imports) et ajoute l'import isPausedFor s'il manque.
//
// Usage : node fix.cjs [--no-build] [--commit] [--push]

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FLAGS = new Set(process.argv.slice(2));
const DO_BUILD  = !FLAGS.has('--no-build');
const DO_COMMIT = FLAGS.has('--commit') || FLAGS.has('--push');
const DO_PUSH   = FLAGS.has('--push');

const log  = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠️ ', ...a);
const err  = (...a) => console.error('❌', ...a);

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function write(p, c) { fs.writeFileSync(p, c, 'utf8'); }
function run(cmd, { capture = false } = {}) {
  if (capture) {
    try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }); }
    catch (e) { return (e.stdout || '') + (e.stderr || ''); }
  }
  try { execSync(cmd, { stdio: 'inherit' }); return true; }
  catch { return false; }
}

/** Retourne la position juste après le dernier import du fichier. */
function findImportEndPos(content) {
  const re = /^import\s[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm;
  const matches = [...content.matchAll(re)];
  if (matches.length === 0) return -1;
  const last = matches[matches.length - 1];
  return last.index + last[0].length;
}

function fixFile(filePath) {
  let c = read(filePath);
  if (!c) return { ok: false, reason: 'lecture échouée' };
  if (!c.includes('isPausedFor(MODULE_ID)')) {
    return { ok: false, reason: 'pas de référence mutex' };
  }

  const idMatch = c.match(/id:\s*["']([^"']+)["']/);
  const id = idMatch?.[1];
  if (!id) return { ok: false, reason: 'id introuvable' };

  const before = c;

  // 1. Retire toutes les `const MODULE_ID = "..."` existantes (avec indentation)
  c = c.replace(/^[ \t]*const\s+MODULE_ID\s*=\s*["'][^"']+["'];?[ \t]*\r?\n?/gm, '');

  // 2. Vérifie l'import
  const hasImport = /from\s+["']\.\/lib\/mod-mutex["']/.test(c);

  // 3. Trouve la fin des imports
  const insertPos = findImportEndPos(c);
  if (insertPos < 0) return { ok: false, reason: 'aucun import trouvé' };

  // 4. Construit le snippet (import si manquant + const au top-level)
  const importLine = hasImport ? '' : 'import { isPausedFor } from "./lib/mod-mutex";\n';
  const constBlock = `\n// [patched:mutex] ID pour le verrou inter-mods\nconst MODULE_ID = "${id}";\n`;

  c = c.slice(0, insertPos) + '\n' + importLine + constBlock + c.slice(insertPos);

  if (c === before) return { ok: false, reason: 'aucun changement' };

  write(filePath, c);
  return { ok: true, reason: 'corrigé' };
}

function fixAll() {
  log('── Correction des patches mutex ──');
  const files = ['farm-auto-mining.ts', 'farm-auto-wood.ts', 'misc-auto-ad.ts', 'quest-auto-quest.ts'];
  const results = { fixed: [], skipped: [], failed: [] };

  for (const f of files) {
    const fullPath = path.join('mods', f);
    if (!fs.existsSync(fullPath)) { warn(f + ' absent'); continue; }
    const r = fixFile(fullPath);
    if (r.ok) { log('  ✓ ' + f + ' ' + r.reason); results.fixed.push(f); }
    else if (r.reason === 'pas de référence mutex') results.skipped.push(f);
    else { err(f + ' : ' + r.reason); results.failed.push(f); }
  }

  log('');
  log('  ' + results.fixed.length + ' corrigés · ' + results.skipped.length + ' skip · ' + results.failed.length + ' échec');
  return results;
}

function verify() {
  log('── Vérification ──');
  const files = ['farm-auto-mining.ts', 'farm-auto-wood.ts', 'misc-auto-ad.ts', 'quest-auto-quest.ts'];
  const problems = [];
  for (const f of files) {
    const fullPath = path.join('mods', f);
    if (!fs.existsSync(fullPath)) continue;
    const c = read(fullPath);
    if (!c) continue;
    if (!c.includes('isPausedFor(MODULE_ID)')) continue;

    if (!/from\s+["']\.\/lib\/mod-mutex["']/.test(c)) {
      problems.push(f + ' : import isPausedFor manquant');
    }
    const usageIdx = c.indexOf('isPausedFor(MODULE_ID)');
    const declIdx = c.indexOf('const MODULE_ID');
    if (declIdx < 0) problems.push(f + ' : const MODULE_ID absent');
    else if (declIdx > usageIdx) problems.push(f + ' : MODULE_ID déclaré après usage');
  }
  if (problems.length) {
    for (const p of problems) err(p);
    return false;
  }
  log('  ✓ OK');
  return true;
}

function build() {
  if (!DO_BUILD) { log('── Build (skip) ──'); return true; }
  log('── npm run typecheck:coop ──');
  if (!run('npm run typecheck:coop')) { err('typecheck échoué'); return false; }
  log('── npm run build:client ──');
  if (!run('npm run build:client')) { err('build échoué'); return false; }
  return true;
}

function commitPush() {
  if (!DO_COMMIT) { log('── Commit (skip) ──'); return true; }
  if (!run('git add -A')) { err('git add échoué'); return false; }
  const msg = 'fix(mods): repair mutex patches (imports + MODULE_ID placement)';
  const out = run('git commit -m "' + msg + '"', { capture: true });
  if (/nothing to commit/i.test(out)) warn('rien à commit');
  else if (/error/i.test(out)) { err('commit échoué : ' + out.trim()); return false; }
  else log('  ✓ commit fait');
  if (!DO_PUSH) return true;
  if (!run('git push origin main')) { err('push échoué'); return false; }
  log('  ✓ push fait');
  return true;
}

function main() {
  if (!fs.existsSync('mods')) { err('Lance depuis la racine.'); process.exit(1); }
  fixAll();
  if (!verify()) process.exit(2);
  if (!build()) process.exit(3);
  if (!commitPush()) process.exit(4);
  log('');
  log('✅ Terminé.');
}

main();