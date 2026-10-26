#!/usr/bin/env node
// patch.cjs — ajoute l'email du compte + le temps restant de validité du
// token dans la carte du modmenu de misc-login-inject.
//
// État attendu : bouton "📤 Exporter" déjà retiré (patch précédent).
// Ce patch ajoute :
//   - decodeJwt() + checkToken() avant renderStatus()
//   - une ligne "✓ email · valide Nmin" / "⏸ Token expiré" dans renderStatus()
//
// Usage : node patch.cjs [--no-build] [--commit] [--push]
// Idempotent.

'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

const FLAGS = new Set(process.argv.slice(2));
const DO_BUILD  = !FLAGS.has('--no-build');
const DO_COMMIT = FLAGS.has('--commit') || FLAGS.has('--push');
const DO_PUSH   = FLAGS.has('--push');

const LOGIN_FILE = 'mods/misc-login-inject.ts';
const MARKER_HELPERS = '// [patched:token-status-helpers]';
const MARKER_INFO    = '// [patched:token-status-info]';

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
// 1. Ajoute decodeJwt() + checkToken() avant renderStatus()
// ─────────────────────────────────────────────────────────────────────────
function addHelpers() {
  log('── Ajout helpers decodeJwt/checkToken ──');
  const src0 = readOrNull(LOGIN_FILE);
  if (src0 === null) { err(`${LOGIN_FILE} introuvable`); return false; }

  if (/function\s+decodeJwt\s*\(/.test(src0) && /function\s+checkToken\s*\(/.test(src0)) {
    log('  ✓ helpers déjà présents');
    return true;
  }

  const anchor = 'function renderStatus(): HTMLElement {';
  if (!src0.includes(anchor)) {
    err('renderStatus() introuvable — colle le fichier, je ferai un patch exact');
    return false;
  }

  const block = `${MARKER_HELPERS}
// ─── Décodage JWT (email + expiration) ───────────────────────────────────
function decodeJwt(token: string): { exp?: number; email?: string; sub?: string; user_email?: string; preferred_username?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch { return null; }
}

type TokenCheck = { valid: boolean; email: string; remainingMin: number; reason?: string };

function checkToken(): TokenCheck {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ID_TOKEN_KEY); } catch { /* idem */ }
  if (!raw) return { valid: false, email: "", remainingMin: 0, reason: "Aucun token (pas connecté)" };
  const payload = decodeJwt(raw);
  if (!payload || !payload.exp) return { valid: false, email: "", remainingMin: 0, reason: "Token invalide" };
  const remainingMs = payload.exp * 1000 - Date.now();
  const email = payload.email
    ?? payload.user_email
    ?? payload.preferred_username
    ?? payload.sub
    ?? "";
  return {
    valid: remainingMs > 0,
    email,
    remainingMin: Math.round(remainingMs / 60000),
    reason: remainingMs > 0 ? undefined : "Token expiré",
  };
}

`;

  const src = src0.replace(anchor, block + anchor);
  fs.writeFileSync(LOGIN_FILE, src, 'utf8');
  log('  ✓ decodeJwt() + checkToken() insérés');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Injecte la ligne de statut dans renderStatus()
// ─────────────────────────────────────────────────────────────────────────
function addStatusLine() {
  log('── Ajout ligne de statut ──');
  const src0 = readOrNull(LOGIN_FILE);
  if (src0 === null) { err(`${LOGIN_FILE} introuvable`); return false; }

  if (src0.includes(MARKER_INFO)) {
    log('  ✓ ligne de statut déjà présente');
    return true;
  }

  // Ancre : `wrap.append(warnEl);` (unique dans le fichier)
  const anchor = /(wrap\.append\(warnEl\);\r?\n)/;
  if (!anchor.test(src0)) {
    err('ancre `wrap.append(warnEl);` introuvable — patch exact requis');
    return false;
  }

  const line = `
  ${MARKER_INFO}
  const check = checkToken();
  const info = document.createElement("div");
  info.style.cssText =
    "font-size:10px;margin-bottom:4px;padding:4px 6px;border-radius:3px;" +
    "background:rgba(0,0,0,.25);line-height:1.3;";
  if (check.valid) {
    info.style.color = "#69e56f";
    info.textContent = \`✓ \${check.email || "(email inconnu)"} · valide \${check.remainingMin}min\`;
  } else {
    info.style.color = "#ffd85b";
    info.textContent = \`⏸ \${check.reason ?? "Non connecté"}\`;
  }
  wrap.append(info);
`;

  const src = src0.replace(anchor, (m) => m + line);
  fs.writeFileSync(LOGIN_FILE, src, 'utf8');
  log('  ✓ ligne de statut ajoutée dans renderStatus()');
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
  if (!/function\s+decodeJwt/.test(src))  problems.push('decodeJwt absent');
  if (!/function\s+checkToken/.test(src)) problems.push('checkToken absent');
  if (!src.includes(MARKER_INFO))         problems.push('ligne de statut absente');
  if (!/const check = checkToken\(\)/.test(src))
    problems.push('appel checkToken() dans renderStatus absent');
  if (!/info\.textContent = `✓ \$\{check\.email/.test(src))
    problems.push('texte du statut absent');
  if (!src.includes('📥 Injecter'))
    problems.push('bouton "📥 Injecter" disparu (régression)');

  if (problems.length) {
    for (const p of problems) err(p);
    return false;
  }
  log(`  ✓ ${LOGIN_FILE} : OK (email + validité présents, inject intact)`);
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
  const msg = 'feat(login-inject): show account email + token validity in mod card';
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
    ['Helpers',     addHelpers],
    ['Status line', addStatusLine],
    ['Verify',      verify],
    ['Build',       buildAndTypecheck],
    ['Commit/push', commitAndPush],
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
    log('  git commit -m "feat(login-inject): show account email + token validity in mod card"');
    log('  git push origin main');
  }
  log('');
  log('Après hard-reload, la carte Login Inject affiche :');
  log('  ⚠️ Secret. Ne partage jamais. À usage personnel.');
  log('  ✓ user@example.com · valide 42min      (ou ⏸ Token expiré / ⏸ Aucun token)');
  log('  [textarea]');
  log('  [📥 Injecter + reload]');
}

main();