#!/usr/bin/env node
// fix.cjs — adapte misc-auto-tech-tree.ts au vrai DOM du tree :
//   - .tech-tree-window              (détection tree ouvert)
//   - .tech-tree-choice.is-ready     (catégories Power / Utility)
//   - #techTreeViewport / #techTreeCanvas (canvas des nodes)
//   - #techTreeDetail                (dialog qui s'ouvre au clic sur un node)
//
// Usage : node fix.cjs [--no-build] [--commit] [--push]

'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

const FLAGS = new Set(process.argv.slice(2));
const DO_BUILD  = !FLAGS.has('--no-build');
const DO_COMMIT = FLAGS.has('--commit') || FLAGS.has('--push');
const DO_PUSH   = FLAGS.has('--push');

const FILE = 'mods/misc-auto-tech-tree.ts';
const MARKER = '// [patched:tech-tree-canvas]';

const log  = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠️ ', ...a);
const err  = (...a) => console.error('❌', ...a);

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function write(p, c) { fs.writeFileSync(p, c, 'utf8'); }
function run(cmd, { capture = false } = {}) {
  if (capture) {
    try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim(); }
    catch (e) { return ((e.stdout || '') + (e.stderr || '')).trim(); }
  }
  try { execSync(cmd, { stdio: 'inherit' }); return true; }
  catch { return false; }
}

// ─── Nouveaux blocs TS ──────────────────────────────────────────────────
const NEW_FIND_TREE = `function findResearchTreeButton(): HTMLElement | null {
  // Le tree est une <section class="tech-tree-window">, pas des <button data-research-id>
  const tree = document.querySelector<HTMLElement>(".tech-tree-window");
  if (tree && isVisible(tree)) return tree;
  return null;
}`;

const NEW_FIND_UPGRADE = `function findAvailableUpgrade(): HTMLButtonElement | null {
  // Niveau 1 : si le dialog détail est ouvert, cliquer le bouton de research dedans
  const detail = document.getElementById("techTreeDetail");
  if (detail && !detail.hasAttribute("hidden")) {
    const btns = detail.querySelectorAll<HTMLButtonElement>("button:not([disabled])");
    for (const btn of btns) {
      if (btn.id === "closeTechTreeDetailBtn") continue;
      if (isVisible(btn)) return btn;
    }
  }
  // Niveau 2 : sinon, cliquer une catégorie ready (Power / Utility)
  const categories = document.querySelectorAll<HTMLButtonElement>(".tech-tree-choice.is-ready");
  for (const btn of categories) {
    if (isVisible(btn)) return btn;
  }
  return null;
}

/**
 * Le tree est dessiné sur un canvas (#techTreeCanvas). On dispatch des clics
 * en grille jusqu'à ce que #techTreeDetail s'ouvre (clic sur un node).
 */
async function clickCanvasNode(): Promise<boolean> {
  const viewport = document.getElementById("techTreeViewport");
  const canvas = document.getElementById("techTreeCanvas") as HTMLCanvasElement | null;
  const map = document.getElementById("techTreeMap");
  if (!canvas || !viewport || viewport.hasAttribute("hidden")) return false;

  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;

  // Grille de positions candidates (x%, y%) — du bas (racine) vers le haut
  const positions: Array<[number, number]> = [
    [0.5, 0.85], [0.5, 0.70], [0.5, 0.55], [0.5, 0.40], [0.5, 0.25],
    [0.30, 0.85], [0.70, 0.85], [0.30, 0.70], [0.70, 0.70],
    [0.25, 0.50], [0.75, 0.50], [0.5, 0.15],
  ];

  for (const [px, py] of positions) {
    const x = rect.left + rect.width * px;
    const y = rect.top + rect.height * py;

    for (const target of [canvas, map].filter(Boolean) as HTMLElement[]) {
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
        }));
      }
    }
    await sleep(400);

    const detail = document.getElementById("techTreeDetail");
    if (detail && !detail.hasAttribute("hidden")) {
      logTech("📋 detail ouvert (clic " + Math.round(px * 100) + "% × " + Math.round(py * 100) + "%)", "ok");
      return true;
    }
  }
  return false;
}`;

const OLD_BLOCK = /const upgradeBtn = findAvailableUpgrade\(\);[\s\S]*?await sleep\(POST_ACTION_WAIT_MS\);/;
const NEW_BLOCK = `const upgradeBtn = findAvailableUpgrade();
    if (!upgradeBtn) { logTech("⚠ aucun upgrade cliquable", "warn"); return; }
    const upgradeLabel = upgradeBtn.dataset.researchTree ?? upgradeBtn.textContent?.trim().slice(0, 30) ?? "?";
    logTech("🎯 clic : " + upgradeLabel);
    upgradeBtn.click();
    await sleep(800);

    const viewport = document.getElementById("techTreeViewport");
    if (viewport && !viewport.hasAttribute("hidden")) {
      logTech("🎨 canvas ouvert — tentative clic sur node");
      const opened = await clickCanvasNode();
      if (!opened) {
        logTech("⚠ aucun node trouvé sur le canvas — clic manuel requis", "warn");
        return;
      }
      const researchBtn = findAvailableUpgrade();
      if (researchBtn) {
        logTech("🔬 clic research : " + (researchBtn.textContent?.trim().slice(0, 30) ?? "?"));
        researchBtn.click();
        await sleep(POST_ACTION_WAIT_MS);
      }
    }`;

// ─── Patch ──────────────────────────────────────────────────────────────
function patchFile() {
  log('── Patch ' + FILE + ' ──');
  const src0 = read(FILE);
  if (src0 === null) { err(FILE + ' introuvable'); return false; }
  if (src0.includes(MARKER)) { log('  ✓ déjà patché'); return true; }

  let src = src0;
  let changes = 0;

  // 1. findResearchTreeButton
  const treeRe = /function\s+findResearchTreeButton\s*\([^)]*\)[^{]*\{[\s\S]*?\n\}/;
  if (!treeRe.test(src)) { err('findResearchTreeButton introuvable'); return false; }
  src = src.replace(treeRe, NEW_FIND_TREE);
  changes++;
  log('  ✓ findResearchTreeButton → .tech-tree-window');

  // 2. findAvailableUpgrade + clickCanvasNode
  const upgradeRe = /function\s+findAvailableUpgrade\s*\([^)]*\)[^{]*\{[\s\S]*?\n\}/;
  if (!upgradeRe.test(src)) { err('findAvailableUpgrade introuvable'); return false; }
  src = src.replace(upgradeRe, NEW_FIND_UPGRADE);
  changes++;
  log('  ✓ findAvailableUpgrade → 2 niveaux (detail + catégorie) + clickCanvasNode');

  // 3. bloc handleReadyHint
  if (!OLD_BLOCK.test(src)) {
    warn('bloc upgrade dans handleReadyHint introuvable — fix tree appliqué mais flow canvas PAS branché');
  } else {
    src = src.replace(OLD_BLOCK, NEW_BLOCK);
    changes++;
    log('  ✓ handleReadyHint → catégorie → canvas → detail');
  }

  write(FILE, src + '\n' + MARKER + '\n');
  log('  ✓ ' + changes + ' changement(s)');
  return true;
}

// ─── Verify ─────────────────────────────────────────────────────────────
function verify() {
  log('── Vérification ──');
  const src = read(FILE);
  if (src === null) { err(FILE + ' introuvable'); return false; }
  const problems = [];
  if (!src.includes(MARKER))                       problems.push('marker absent');
  if (!src.includes('.tech-tree-window'))          problems.push('.tech-tree-window absent');
  if (!src.includes('.tech-tree-choice.is-ready')) problems.push('.tech-tree-choice.is-ready absent');
  if (!src.includes('function clickCanvasNode'))   problems.push('clickCanvasNode absent');
  if (!src.includes('techTreeViewport'))           problems.push('techTreeViewport absent');
  if (!src.includes('techTreeDetail'))             problems.push('techTreeDetail absent');
  if (problems.length) { for (const p of problems) err(p); return false; }
  log('  ✓ OK');
  return true;
}

// ─── Build ──────────────────────────────────────────────────────────────
function build() {
  if (!DO_BUILD) { log('── Build (skip) ──'); return true; }
  log('── npm run typecheck:coop ──');
  if (!run('npm run typecheck:coop')) { err('typecheck échoué'); return false; }
  log('── npm run build:client ──');
  if (!run('npm run build:client')) { err('build échoué'); return false; }
  return true;
}

// ─── Commit + push ──────────────────────────────────────────────────────
function commitPush() {
  if (!DO_COMMIT) { log('── Commit (skip) ──'); return true; }
  if (!run('git add -A')) { err('git add échoué'); return false; }
  const msg = 'fix(auto-tech-tree): target .tech-tree-window, click category then canvas node';
  const out = run('git commit -m "' + msg + '"', { capture: true });
  if (/nothing to commit/i.test(out)) warn('rien à commit');
  else if (/error/i.test(out)) { err('commit échoué : ' + out); return false; }
  else log('  ✓ commit fait');
  if (!DO_PUSH) return true;
  if (!run('git pull --rebase origin main')) { err('pull --rebase échoué'); return false; }
  if (!run('git push origin main')) { err('push échoué'); return false; }
  log('  ✓ push fait');
  return true;
}

function main() {
  if (!fs.existsSync('mods') || !fs.existsSync(FILE)) {
    err('Lance depuis la racine du repo.');
    process.exit(1);
  }
  if (!patchFile()) process.exit(2);
  if (!verify()) process.exit(3);
  if (!build()) process.exit(4);
  if (!commitPush()) process.exit(5);
  log('');
  log('✅ Terminé.');
  log('');
  log('Au prochain Research Ready, tu dois voir dans le log :');
  log('  🌳 tree ouvert');
  log('  🎯 clic : Power');
  log('  🎨 canvas ouvert — tentative clic sur node');
  log('  📋 detail ouvert (clic X% × Y%)');
  log('  🔬 clic research : ...');
  log('  ✅ actif : ⏳ ...');
  log('');
  log('Si "⚠ aucun node trouvé sur le canvas" → clique un node manuellement');
  log('et colle-moi le HTML de #techTreeDetail pour ajuster la grille.');
}

main();