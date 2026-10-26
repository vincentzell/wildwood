#!/usr/bin/env node
// patch.cjs — fix le mod Auto Quest pour ignorer les guild stat quests
// (format serveur { mapId, stat, target, progress, from }) que le mod ne sait
// pas farmer, et ajoute un probe console qui liste les groupes `stat:*`
// disponibles dans #autoFarmSheet — utile pour préparer une extension
// éventuelle qui les gérerait.
//
// Usage :
//   node patch.cjs              # patch + typecheck + build
//   node patch.cjs --no-build   # patch seulement
//   node patch.cjs --commit     # patch + build + commit (sans push)
//   node patch.cjs --push       # patch + build + commit + push
//
// Idempotent : relance sans risque.

'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

const FLAGS = new Set(process.argv.slice(2));
const DO_BUILD  = !FLAGS.has('--no-build');
const DO_COMMIT = FLAGS.has('--commit') || FLAGS.has('--push');
const DO_PUSH   = FLAGS.has('--push');

const QUEST_FILE = 'mods/quest-auto-quest.ts';
const MARKER_FILTER = '// [patched:skip-guild-stat-quests]';
const MARKER_PROBE  = '// [patched:stat-groups-probe]';

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
// 1. Patch activeQuests() — skip les quêtes sans enemy valide
// ─────────────────────────────────────────────────────────────────────────
function patchActiveQuests() {
  log('── Patch activeQuests() ──');
  const src0 = readOrNull(QUEST_FILE);
  if (src0 === null) { err(`${QUEST_FILE} introuvable`); return false; }

  if (src0.includes(MARKER_FILTER)) {
    log('  ✓ déjà patché (marker présent)');
    return true;
  }

  // Trouve la fonction activeQuests() et son corps
  const fnRe = /function\s+activeQuests\s*\([^)]*\)\s*:\s*CoopQuest\[\]\s*\{[\s\S]*?\n\}/;
  const m = src0.match(fnRe);
  if (!m) {
    err('activeQuests() introuvable — colle le fichier, je ferai un patch exact');
    return false;
  }

  const replacement =
`function activeQuests(coop: CoopLike): CoopQuest[] {
  const data = coop.weeklyQuests?.();
  if (!data?.quests) return [];
  // ${MARKER_FILTER}
  // Le serveur renvoie aussi des "guild stat quests" au format
  // { mapId, stat: "speed"|"armor"|..., target, progress, from: "your guild" }
  // sans champ \`enemy\`. Le mod ne sait pas les farmer (il faudrait équiper
  // la bonne stat et farmer la bonne map). On les ignore pour ne pas boucler
  // sur \`stat introuvable pour undefined\` dans tryOneQuest().
  return data.quests.filter(q =>
    q.progress < q.target &&
    !q.takenBy &&
    typeof q.enemy === "string" &&
    q.enemy.length > 0 &&
    ENEMY_TYPES[q.enemy as keyof typeof ENEMY_TYPES] !== undefined
  );
}`;

  const src = src0.replace(m[0], replacement);
  fs.writeFileSync(QUEST_FILE, src, 'utf8');
  log('  ✓ activeQuests() : filtre les guild stat quests');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Ajoute un probe console dans startPolling() — dump les groupes stat:*
//    une seule fois par page (window flag)
// ─────────────────────────────────────────────────────────────────────────
function patchStatProbe() {
  log('── Ajout probe stat:* ──');
  const src0 = readOrNull(QUEST_FILE);
  if (src0 === null) { err(`${QUEST_FILE} introuvable`); return false; }

  if (src0.includes(MARKER_PROBE)) {
    log('  ✓ déjà patché (marker présent)');
    return true;
  }

  // Ancre : la première ligne de startPolling(), juste après l'accolade
  const anchor = 'function startPolling(): void {\n  if (intervalId !== null) return;';
  if (!src0.includes(anchor)) {
    warn('startPolling() introuvable — probe non ajouté (non bloquant)');
    return true; // pas critique, on continue
  }

  const probe =
`function startPolling(): void {
  if (intervalId !== null) return;
  // ${MARKER_PROBE}
  // Dump une seule fois des groupes d'aggro disponibles dans #autoFarmSheet.
  // Utile pour vérifier si les guild stat quests ("stat:speed", "stat:armor", …)
  // ont un groupe natif — si oui, une future extension pourrait les farmer.
  try {
    const w = window as unknown as { __wildwoodQuestProbeDone?: boolean };
    if (!w.__wildwoodQuestProbeDone) {
      w.__wildwoodQuestProbeDone = true;
      setTimeout(() => {
        const sheet = document.getElementById("autoFarmSheet");
        const groups = sheet
          ? [...sheet.querySelectorAll<HTMLElement>("[data-group]")].map(el => el.dataset.group ?? "")
          : [];
        console.info("[mod-auto-quest] groupes aggro disponibles :", groups);
        const coop = getCoop();
        const statQuests = coop?.weeklyQuests?.()?.quests.filter(q => (q as { stat?: string }).stat) ?? [];
        if (statQuests.length > 0) {
          console.info("[mod-auto-quest] guild stat quests détectées :", statQuests.length);
          console.info("[mod-auto-quest] stats demandées :", [...new Set(statQuests.map(q => (q as { stat?: string }).stat))]);
        }
      }, 2000);
    }
  } catch { /* probe best-effort */ }`;

  const src = src0.replace(anchor, probe);
  fs.writeFileSync(QUEST_FILE, src, 'utf8');
  log('  ✓ probe ajouté dans startPolling()');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Vérification finale
// ─────────────────────────────────────────────────────────────────────────
function verify() {
  log('── Vérification ──');
  const src = readOrNull(QUEST_FILE);
  if (src === null) { err(`${QUEST_FILE} introuvable`); return false; }

  const problems = [];
  if (!src.includes(MARKER_FILTER)) problems.push('patch activeQuests absent');
  if (!src.includes(MARKER_PROBE))  problems.push('probe stat:* absent');
  if (!/typeof q\.enemy === ["']string["']/.test(src))
    problems.push('garde typeof q.enemy manquante');

  if (problems.length) {
    for (const p of problems) err(p);
    return false;
  }
  log(`  ✓ ${QUEST_FILE} : OK`);
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
  const msg = 'fix(auto-quest): skip guild stat quests, add stat-groups probe';
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
  if (!fs.existsSync('mods') || !fs.existsSync(QUEST_FILE)) {
    err('Lance depuis la racine du repo (mods/quest-auto-quest.ts requis).');
    process.exit(1);
  }

  const steps = [
    ['Patch activeQuests', patchActiveQuests],
    ['Probe stat:*',       patchStatProbe],
    ['Verify',             verify],
    ['Build',              buildAndTypecheck],
    ['Commit/push',        commitAndPush],
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
    log('  git commit -m "fix(auto-quest): skip guild stat quests, add stat-groups probe"');
    log('  git push origin main');
  }
  log('');
  log('Après déploiement (hard-reload), dans la console du jeu :');
  log('  → plus de "[mod-auto-quest] stat introuvable pour undefined" en boucle');
  log('  → nouveau log au démarrage : "[mod-auto-quest] groupes aggro disponibles : [...]"');
  log('  → nouveau log si guild stat quests présentes : "[mod-auto-quest] stats demandées : [...]"');
  log('');
  log('Compare les deux listes :');
  log('  - si "stat:speed" (etc.) est dans "groupes aggro" → extension possible');
  log('  - sinon → les guild stat quests restent manuelles');
}

main();