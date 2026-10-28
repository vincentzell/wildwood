#!/usr/bin/env node
// fix-research.cjs — corrige le flow Research Ready :
// - utilise TOWN_RESEARCH_POSITION (vraie position calculée) au lieu d'un
//   (5780, 5305) hardcodé
// - supprime le UP inutile
// - vérifie le téléport par CHANGEMENT de position (pas seulement mapId)
// - dump DOM si le tree n'est pas trouvé (pour ajuster le sélecteur)
//
// Usage : node fix-research.cjs [--no-build] [--commit] [--push]

'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

const FLAGS = new Set(process.argv.slice(2));
const DO_BUILD  = !FLAGS.has('--no-build');
const DO_COMMIT = FLAGS.has('--commit') || FLAGS.has('--push');
const DO_PUSH   = FLAGS.has('--push');

const FILE = 'mods/misc-auto-tech-tree.ts';
const MARKER = '// [patched:research-position-v2]';

const log  = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠️ ', ...a);
const err  = (...a) => console.error('❌', ...a);

function readOrNull(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function write(p, c) { fs.writeFileSync(p, c, 'utf8'); }
function run(cmd, { capture = false } = {}) {
  if (capture) {
    try { return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim(); }
    catch (e) { return ((e.stdout || '') + (e.stderr || '')).trim(); }
  }
  try { execSync(cmd, { stdio: 'inherit' }); return true; }
  catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────
function patchFile() {
  log('── Patch misc-auto-tech-tree.ts ──');
  const src0 = readOrNull(FILE);
  if (src0 === null) { err(FILE + ' introuvable'); return false; }
  if (src0.includes(MARKER)) { log('  ✓ déjà patché'); return true; }

  let src = src0;

  // 1. Ajouter l'import TOWN_RESEARCH_POSITION
  if (!src.includes('TOWN_RESEARCH_POSITION')) {
    const importAnchor = /^(import\s+\{[^}]*\}\s+from\s+["']\.\/lib\/mod-mutex["'];?\s*)$/m;
    if (!importAnchor.test(src)) {
      // fallback : ajoute après le dernier import
      const imports = [...src.matchAll(/^import\s[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm)];
      if (imports.length === 0) { err('aucun import trouvé'); return false; }
      const last = imports[imports.length - 1];
      const idx = last.index + last[0].length;
      src = src.slice(0, idx)
        + '\nimport { TOWN_RESEARCH_POSITION } from "../shared/town";\n' + MARKER
        + src.slice(idx);
    } else {
      src = src.replace(importAnchor, '$1\nimport { TOWN_RESEARCH_POSITION } from "../shared/town";\n' + MARKER);
    }
    log('  ✓ import TOWN_RESEARCH_POSITION ajouté');
  }

  // 2. Remplacer TOWN_POSITION par TOWN_RESEARCH_POSITION (usage + déclaration)
  src = src.replace(
    /const TOWN_POSITION\s*=\s*\{[^}]*\};?[^\n]*/,
    '// TOWN_POSITION remplacé par TOWN_RESEARCH_POSITION (import)'
  );
  src = src.replace(/TOWN_POSITION\.x/g, 'TOWN_RESEARCH_POSITION.x');
  src = src.replace(/TOWN_POSITION\.y/g, 'TOWN_RESEARCH_POSITION.y');
  src = src.replace(/TOWN_POSITION\b/g, 'TOWN_RESEARCH_POSITION');
  log('  ✓ TOWN_POSITION → TOWN_RESEARCH_POSITION');

  // 3. Remplacer le bloc waitFor + UP par le nouveau flow
  // Ancre : "const prevMapId" jusqu'à "logTech(\"🌳 tree ouvert\")" inclus
  const oldBlockRe = /const prevMapId = coop\.localState\?\.\(\)\?\.mapId \?\? null;[\s\S]*?logTech\("🌳 tree ouvert"\);/;
  if (!oldBlockRe.test(src)) {
    err('bloc flow introuvable — le fichier a peut-être été modifié à la main');
    return false;
  }

  const newBlock = `const prevMapId = coop.localState?.()?.mapId ?? null;
    const prevPos = coop.localState?.() ?? null;
    logTech("📍 position avant : " + (prevMapId ?? "?") + " (" + Math.round(prevPos?.x ?? 0) + "," + Math.round(prevPos?.y ?? 0) + ")");
    logTech("🎯 cible : (" + Math.round(TOWN_RESEARCH_POSITION.x) + "," + Math.round(TOWN_RESEARCH_POSITION.y) + ")");

    hint.click();
    logTech("👆 clic sur Research Ready (téléport direct attendu)");

    // Vérifie qu'on a bougé : delta de position > 500 px OU proche de la station
    const moved = await waitFor(() => {
      const st = coop.localState?.();
      if (!st) return false;
      const moved = Math.hypot((st.x ?? 0) - (prevPos?.x ?? 0), (st.y ?? 0) - (prevPos?.y ?? 0)) > 500;
      const nearStation = Math.hypot((st.x ?? 0) - TOWN_RESEARCH_POSITION.x, (st.y ?? 0) - TOWN_RESEARCH_POSITION.y) < 200;
      return moved || nearStation;
    }, TRAVEL_TIMEOUT_MS);
    if (!moved) {
      const st = coop.localState?.();
      logTech("❌ téléport non détecté (pos=" + Math.round(st?.x ?? 0) + "," + Math.round(st?.y ?? 0) + ")", "bad");
      return;
    }
    await sleep(500);
    const st = coop.localState?.();
    const distToStation = Math.hypot((st?.x ?? 0) - TOWN_RESEARCH_POSITION.x, (st?.y ?? 0) - TOWN_RESEARCH_POSITION.y);
    logTech("✅ téléport détecté · pos=(" + Math.round(st?.x ?? 0) + "," + Math.round(st?.y ?? 0) + ") distStation=" + Math.round(distToStation) + "px");

    // Le tree devrait s'ouvrir automatiquement (proximity). Cherche un bouton.
    const treeOpen = await waitFor(() => findResearchTreeButton() !== null, TREE_OPEN_TIMEOUT_MS);
    if (!treeOpen) {
      logTech("❌ tree pas ouvert — dump DOM pour diag", "bad");
      // Dump DOM utile pour ajuster findAvailableUpgrade
      const dumpSelectors = [
        "button[data-research-id]",
        "[data-research-id]",
        "[class*='research']",
        "[id*='research']",
        "dialog[open]",
        ".modal",
      ];
      for (const sel of dumpSelectors) {
        const els = [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null);
        if (els.length > 0) {
          logTech("  " + sel + " : " + els.length + " éléments", "info");
          els.slice(0, 5).forEach((e, i) => {
            const tag = e.tagName;
            const id = e.id ? "#" + e.id : "";
            const cls = e.className ? "." + String(e.className).split(" ").slice(0, 2).join(".") : "";
            const txt = (e.textContent || "").trim().slice(0, 40);
            logTech("    " + i + ": " + tag + id + cls + " · " + txt, "info");
          });
        }
      }
      return;
    }
    logTech("🌳 tree ouvert";`;

  src = src.replace(oldBlockRe, newBlock);
  log('  ✓ flow remplacé (position réelle + pas de UP)');

  // 4. Supprimer la fonction pushArrowUp si elle n'est plus utilisée
  if (!/pushArrowUp\s*\(/.test(src.replace(/async function pushArrowUp[\s\S]*?\n\}/, ''))) {
    src = src.replace(/async function pushArrowUp[\s\S]*?\n\}\n\n/, '');
    log('  ✓ pushArrowUp supprimé (plus utilisé)');
  }

  write(FILE, src);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
function verify() {
  log('── Vérification ──');
  const src = readOrNull(FILE);
  if (src === null) { err(FILE + ' introuvable'); return false; }
  const problems = [];
  if (!src.includes(MARKER))                        problems.push('marker absent');
  if (!src.includes('TOWN_RESEARCH_POSITION'))      problems.push('TOWN_RESEARCH_POSITION absent');
  if (/TOWN_POSITION\b/.test(src.replace(/TOWN_RESEARCH_POSITION/g, '')))
                                                    problems.push('TOWN_POSITION encore présent');
  if (/await pushArrowUp\(/.test(src))              problems.push('pushArrowUp encore appelé');
  if (!src.includes('dump DOM pour diag'))          problems.push('fallback dump DOM absent');
  if (problems.length) { for (const p of problems) err(p); return false; }
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
  const msg = 'fix(auto-tech-tree): use TOWN_RESEARCH_POSITION, drop UP push, detect real teleport';
  const out = run('git commit -m "' + msg + '"', { capture: true });
  if (/nothing to commit/i.test(out)) warn('rien à commit');
  else if (/error/i.test(out)) { err('commit échoué'); return false; }
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
  log('Après déploiement :');
  log('  - Au prochain Research Ready, le mod log la vraie position cible');
  log('  - Si téléport détecté → tree doit s\'ouvrir automatiquement');
  log('  - Si tree pas ouvert → dump DOM dans le log (colle-moi pour ajuster le sélecteur)');
}

main();