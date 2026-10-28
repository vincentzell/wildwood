#!/usr/bin/env node
// patch.cjs — installe le mutex inter-mods + remplace misc-auto-tech-tree.ts
// + auto-patche les mods qui bougent le joueur. Idempotent.
//
// Usage : node patch.cjs [--no-build] [--commit] [--push]

'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FLAGS = new Set(process.argv.slice(2));
const DO_BUILD  = !FLAGS.has('--no-build');
const DO_COMMIT = FLAGS.has('--commit') || FLAGS.has('--push');
const DO_PUSH   = FLAGS.has('--push');

const MUTEX_FILE = 'mods/lib/mod-mutex.ts';
const TECH_FILE  = 'mods/misc-auto-tech-tree.ts';
const MARKER     = '[patched:mutex]';

const SAFE_IDS = new Set([
  'misc-auto-tech-tree',
  'misc-login-inject',
  'misc-player-coords',
  'misc-auto-upgrade',
  'misc-daily-gems',
  'farm-auto-prestige',
  'trade-bid-volume',
  'trade-market',
]);

const HELPER_FILES = new Set(['card-farming-core.ts']);

const KNOWN_LOOPS = {
  'farm-auto-mining': {
    loopPattern: /while\s*\(\s*!autoMiningAbort\s*&&\s*autoMiningRunning\s*\)\s*\{/,
    pauseSnippet: '\n      if (isPausedFor(MODULE_ID)) {\n        releaseAllKeys();\n        await new Promise(r => setTimeout(r, 1000));\n        continue;\n      }\n',
  },
  'quest-auto-quest': {
    loopPattern: /while\s*\(\s*!abort\s*&&\s*isAutoQuestEnabled\s*\(\s*\)\s*\)\s*\{/,
    pauseSnippet: '\n      if (isPausedFor(MODULE_ID)) {\n        await new Promise(r => setTimeout(r, 2000));\n        continue;\n      }\n',
  },
};

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

// ─────────────────────────────────────────────────────────────────────────
// mod-mutex.ts
// ─────────────────────────────────────────────────────────────────────────
const MUTEX_SRC = `// mods/lib/mod-mutex.ts
const MUTEX_KEY = "wildwood-mod-mutex";
const MUTEX_EVENT = "wildwood-mod-mutex-change";

export type MutexState = {
  holder: string;
  reason: string;
  until: number;
} | null;

export function readMutex(): MutexState {
  try {
    const raw = localStorage.getItem(MUTEX_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MutexState;
    if (!parsed || typeof parsed.until !== "number") return null;
    if (Date.now() >= parsed.until) {
      try { localStorage.removeItem(MUTEX_KEY); } catch { /* idem */ }
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function acquireMutex(holder: string, reason: string, ttlMs: number): () => void {
  const current = readMutex();
  if (current && current.holder !== holder) {
    return () => {};
  }
  const state: MutexState = { holder, reason, until: Date.now() + ttlMs };
  try {
    localStorage.setItem(MUTEX_KEY, JSON.stringify(state));
    window.dispatchEvent(new CustomEvent(MUTEX_EVENT, { detail: state }));
  } catch { /* idem */ }
  return () => {
    const still = readMutex();
    if (still?.holder === holder) {
      try {
        localStorage.removeItem(MUTEX_KEY);
        window.dispatchEvent(new CustomEvent(MUTEX_EVENT, { detail: null }));
      } catch { /* idem */ }
    }
  };
}

export function isPausedFor(moduleId: string): boolean {
  const m = readMutex();
  if (!m) return false;
  return m.holder !== moduleId;
}

export function mutexHolder(): string | null {
  return readMutex()?.holder ?? null;
}

export function onMutexChange(cb: (state: MutexState) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<MutexState>).detail);
  const storageHandler = (e: StorageEvent) => {
    if (e.key === MUTEX_KEY) cb(readMutex());
  };
  window.addEventListener(MUTEX_EVENT, handler);
  window.addEventListener("storage", storageHandler);
  return () => {
    window.removeEventListener(MUTEX_EVENT, handler);
    window.removeEventListener("storage", storageHandler);
  };
}
`;

// ─────────────────────────────────────────────────────────────────────────
// misc-auto-tech-tree.ts — version complète
// ─────────────────────────────────────────────────────────────────────────
const TECH_SRC = `// mods/misc-auto-tech-tree.ts
import { RESEARCH_IDS, researchIsAvailable, type ResearchId, type ResearchRanks } from "../shared/research";
import { REGISTERED_MODS } from "./registry";
import { acquireMutex, isPausedFor, readMutex } from "./lib/mod-mutex";

const STORAGE_KEY = "wildwood-mod-auto-tech-tree-enabled";
const POLL_MS = 10_000;
const LOG_LIMIT = 100;
const LOG_DISPLAY = 20;

const READY_HINT_ID = "researchReadyHint";
const TOWN_MAP_ID = "town";
const TOWN_POSITION = { x: 5780, y: 5305 };
const UP_DURATION_MS = 1_000;
const ARRIVAL_RADIUS_PX = 100;
const TRAVEL_TIMEOUT_MS = 10_000;
const TREE_OPEN_TIMEOUT_MS = 5_000;
const POST_ACTION_WAIT_MS = 1_500;
const MUTEX_TTL_MS = 60_000;

const MODULE_ID = "misc-auto-tech-tree";

type CoopLike = {
  activeResearch?: () => unknown;
  research?: () => ResearchRanks;
  startResearch?: (id: ResearchId) => Promise<{ ok: boolean; error?: string }>;
  localState?: () => { x?: number; y?: number; mapId?: string; hp?: number } | null;
  travelToMap?: (mapId: string) => Promise<boolean>;
};

type LogEntry = { ts: string; msg: string; cls: "info" | "ok" | "warn" | "bad" };

let techLogs: LogEntry[] = [];

function logTech(msg: string, cls: LogEntry["cls"] = "info"): void {
  const ts = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  techLogs.push({ ts, msg, cls });
  if (techLogs.length > LOG_LIMIT) techLogs.shift();
  const p = "[mod-auto-tech-tree]";
  if (cls === "bad") console.error(p, msg);
  else if (cls === "warn") console.warn(p, msg);
  else console.info(p, msg);
}

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function isAutoTechTreeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let running = false;
let lastAttemptTs = 0;
let lastAction = "";
let lastError = "";
let intervalId: number | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return true;
    await sleep(200);
  }
  return false;
}

function isVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.hasAttribute("hidden")) return false;
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  return el.getClientRects().length > 0;
}

async function pushArrowUp(durationMs: number): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>("#gameGpu")
    || document.querySelector<HTMLCanvasElement>("canvas");
  try { canvas?.focus({ preventScroll: true }); } catch { /* idem */ }

  const kd = new KeyboardEvent("keydown", {
    key: "ArrowUp", code: "ArrowUp", keyCode: 38, which: 38,
    bubbles: true, cancelable: true, composed: true,
  });
  window.dispatchEvent(kd);
  try { canvas?.dispatchEvent(kd); } catch { /* idem */ }
  await sleep(durationMs);
  const ku = new KeyboardEvent("keyup", {
    key: "ArrowUp", code: "ArrowUp", keyCode: 38, which: 38,
    bubbles: true, cancelable: true, composed: true,
  });
  window.dispatchEvent(ku);
  try { canvas?.dispatchEvent(ku); } catch { /* idem */ }
}

function findResearchTreeButton(): HTMLElement | null {
  const selectors = [
    "button[data-research-id]:not([disabled])",
    ".research-tree [data-research-id]",
    "#researchTree [data-research-id]",
    "[class*='research-tree'] button:not([disabled])",
    "[id*='research-tree'] button:not([disabled])",
    "dialog[open] button[data-research-id]",
  ];
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && isVisible(el)) return el;
  }
  return null;
}

function findAvailableUpgrade(): HTMLButtonElement | null {
  const candidates = document.querySelectorAll<HTMLButtonElement>(
    "button[data-research-id]:not([disabled])"
  );
  for (const btn of candidates) {
    if (!isVisible(btn)) continue;
    if (btn.getAttribute("aria-pressed") === "true") continue;
    if (btn.getAttribute("aria-disabled") === "true") continue;
    if (btn.classList.contains("is-owned")
        || btn.classList.contains("is-maxed")
        || btn.classList.contains("is-locked")) continue;
    return btn;
  }
  return null;
}

function describeActiveResearch(active: unknown): string | null {
  if (!active || typeof active !== "object") return null;
  const a = active as Record<string, unknown>;
  const id = (a.id ?? a.researchId ?? a.name) as string | undefined;
  const endsAt = a.endsAtMs ?? a.endsAt ?? a.completeAt;
  if (typeof endsAt === "number") {
    const remaining = endsAt - Date.now();
    if (remaining > 0) {
      const s = Math.ceil(remaining / 1000);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      const time = h > 0 ? h + "h" + m + "m" : m > 0 ? m + "m" + sec + "s" : sec + "s";
      return "⏳ " + (id ?? "?") + " · " + time + " restant";
    }
    return "✅ " + (id ?? "?") + " terminée";
  }
  return id ? "▶ " + id : null;
}

async function handleReadyHint(coop: CoopLike): Promise<void> {
  const current = readMutex();
  if (current && current.holder !== MODULE_ID) {
    logTech("⏸ verrou tenu par " + current.holder + " (" + current.reason + ")", "warn");
    return;
  }

  const release = acquireMutex(MODULE_ID, "Research Ready cycle", MUTEX_TTL_MS);
  try {
    logTech("🔔 Research Ready — verrou pris");

    const hint = document.getElementById(READY_HINT_ID) as HTMLButtonElement | null;
    if (!hint || !isVisible(hint)) return;

    const prevMapId = coop.localState?.()?.mapId ?? null;
    logTech("📍 position avant : " + (prevMapId ?? "?"));

    hint.click();
    logTech("👆 clic sur Research Ready");

    const arrived = await waitFor(() => coop.localState?.()?.mapId === TOWN_MAP_ID, TRAVEL_TIMEOUT_MS);
    if (!arrived) { logTech("❌ téléportation town timeout", "bad"); return; }
    logTech("✅ téléporté à town");

    const atPos = await waitFor(() => {
      const st = coop.localState?.();
      if (!st) return false;
      const d = Math.hypot((st.x ?? 0) - TOWN_POSITION.x, (st.y ?? 0) - TOWN_POSITION.y);
      return d < ARRIVAL_RADIUS_PX;
    }, TRAVEL_TIMEOUT_MS);
    if (!atPos) logTech("⚠ position town pas exacte, continue", "warn");
    await sleep(500);

    logTech("⬆️ déplacement UP " + UP_DURATION_MS + "ms");
    await pushArrowUp(UP_DURATION_MS);
    await sleep(800);

    const treeOpen = await waitFor(() => findResearchTreeButton() !== null, TREE_OPEN_TIMEOUT_MS);
    if (!treeOpen) { logTech("❌ tree pas ouvert", "bad"); return; }
    logTech("🌳 tree ouvert");

    const upgradeBtn = findAvailableUpgrade();
    if (!upgradeBtn) { logTech("⚠ aucun upgrade cliquable", "warn"); return; }
    const upgradeId = upgradeBtn.dataset.researchId ?? upgradeBtn.textContent?.trim() ?? "?";
    logTech("🎯 upgrade ciblé : " + upgradeId);
    upgradeBtn.click();
    await sleep(POST_ACTION_WAIT_MS);

    const newActive = coop.activeResearch?.();
    if (newActive) {
      const desc = describeActiveResearch(newActive);
      logTech("✅ recherche active : " + (desc ?? "?"), "ok");
      lastAction = desc ?? "Recherche en cours";
    } else {
      logTech("⚠ pas de recherche active après upgrade", "warn");
    }

    if (prevMapId && prevMapId !== TOWN_MAP_ID && coop.travelToMap) {
      logTech("🔙 retour " + prevMapId);
      try {
        await coop.travelToMap(prevMapId);
        logTech("✅ retour " + prevMapId, "ok");
      } catch (e) {
        logTech("⚠ retour échoué : " + (e as Error).message, "warn");
      }
    }
  } finally {
    release();
    logTech("🔓 verrou libéré", "info");
  }
}

function pickResearchToStart(ranks: ResearchRanks): ResearchId | null {
  return RESEARCH_IDS.find(id => researchIsAvailable(id, ranks)) ?? null;
}

async function tick(): Promise<void> {
  if (running || !isAutoTechTreeEnabled() || Date.now() - lastAttemptTs < POLL_MS) return;
  const coop = getCoop();
  if (!coop) return;

  if (isPausedFor(MODULE_ID)) return;

  running = true;
  lastAttemptTs = Date.now();
  try {
    const hint = document.getElementById(READY_HINT_ID) as HTMLButtonElement | null;
    if (hint && isVisible(hint)) {
      await handleReadyHint(coop);
      return;
    }

    if (coop.activeResearch?.()) {
      const desc = describeActiveResearch(coop.activeResearch());
      if (desc && desc !== lastAction) {
        lastAction = desc;
        if (!desc.startsWith("⏳")) logTech(desc, "info");
      }
      return;
    }

    if (!coop.startResearch || !coop.research) {
      if (lastError !== "API indisponible") {
        lastError = "API indisponible";
        logTech("⚠ API startResearch/research indisponible", "warn");
      }
      return;
    }

    const ranks = coop.research();
    const target = pickResearchToStart(ranks);
    if (!target) {
      if (lastAction !== "Aucune recherche disponible") {
        lastAction = "Aucune recherche disponible";
        logTech("⚠ aucune recherche disponible via API", "warn");
      }
      lastError = "";
      return;
    }

    logTech("▶ tentative API démarrage " + target);
    const result = await coop.startResearch(target);
    if (result.ok) {
      lastError = "";
      lastAction = "▶ " + target;
      logTech("✅ " + target + " démarrée (API)", "ok");
    } else {
      lastError = result.error ?? "Refus serveur";
      logTech("❌ API refusée : " + lastError, "bad");
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    logTech("❌ exception : " + lastError, "bad");
  } finally {
    running = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => { void tick(); }, POLL_MS);
  void tick();
}

function stopPolling(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  if (!isAutoTechTreeEnabled()) {
    wrap.style.cssText = "font-size:10px;opacity:.6;";
    wrap.textContent = "Désactivé";
    return wrap;
  }

  const activeLine = document.createElement("div");
  activeLine.style.cssText = "font-size:10px;margin-bottom:3px;padding:2px 4px;border-radius:3px;background:rgba(0,0,0,.25);";
  const coop = getCoop();
  const active = coop?.activeResearch?.();
  if (active) {
    const desc = describeActiveResearch(active);
    activeLine.textContent = desc ?? "▶ Recherche active";
    activeLine.style.color = "#69e56f";
  } else if (running) {
    activeLine.textContent = "🔄 cycle en cours…";
    activeLine.style.color = "#74d8ff";
  } else {
    activeLine.textContent = "⏸ aucune recherche active";
    activeLine.style.color = "#ffd85b";
  }
  wrap.append(activeLine);

  const hint = document.getElementById(READY_HINT_ID);
  if (hint && isVisible(hint as HTMLElement)) {
    const readyLine = document.createElement("div");
    readyLine.style.cssText = "font-size:10px;color:#69e56f;font-weight:900;margin-bottom:3px;";
    readyLine.textContent = "🔔 Research Ready — clic imminent";
    wrap.append(readyLine);
  }

  const line = document.createElement("div");
  line.style.cssText = "font-size:10px;opacity:.85;margin-bottom:3px;";
  if (lastError) {
    line.textContent = "⚠ " + lastError;
    line.style.color = "#ff6767";
  } else {
    line.textContent = lastAction || "En attente";
    line.style.color = "#888";
  }
  wrap.append(line);

  if (techLogs.length > 0) {
    const logs = document.createElement("div");
    logs.style.cssText =
      "max-height:130px;overflow-y:auto;background:rgba(0,0,0,.3);" +
      "padding:3px;border-radius:3px;font-size:9px;line-height:1.3;" +
      "font-family:monospace;";
    for (const l of techLogs.slice(-LOG_DISPLAY)) {
      const row = document.createElement("div");
      row.textContent = "[" + l.ts + "] " + l.msg;
      row.style.color =
        l.cls === "ok" ? "#69e56f"
        : l.cls === "warn" ? "#ffd85b"
        : l.cls === "bad" ? "#ff6767"
        : "#8aa8c8";
      logs.append(row);
    }
    wrap.append(logs);
  }

  const btnCopy = document.createElement("button");
  btnCopy.textContent = "📋 Copier log";
  btnCopy.style.cssText =
    "margin-top:4px;padding:3px 6px;font:inherit;cursor:pointer;" +
    "background:rgba(116,216,255,.22);color:inherit;border:0;" +
    "border-radius:3px;font-size:10px;width:100%;";
  btnCopy.addEventListener("click", async () => {
    if (techLogs.length === 0) return;
    const header =
      "=== DIAG AUTO TECH TREE ===\\n" +
      "Timestamp: " + new Date().toISOString() + "\\n" +
      "Running: " + running + " | Last action: " + lastAction + " | Error: " + (lastError || "-") + "\\n" +
      "--- LOGS ---\\n";
    const body = techLogs.map(l => "[" + l.ts + "] (" + l.cls + ") " + l.msg).join("\\n");
    try {
      await navigator.clipboard.writeText(header + body);
      btnCopy.textContent = "✅ Copié";
      setTimeout(() => { btnCopy.textContent = "📋 Copier log"; }, 2000);
    } catch {
      btnCopy.textContent = "❌ Voir console";
      setTimeout(() => { btnCopy.textContent = "📋 Copier log"; }, 2000);
    }
  });
  wrap.append(btnCopy);

  return wrap;
}

export function registerAutoTechTreeMod(): void {
  REGISTERED_MODS.push({
    id: MODULE_ID,
    name: "Auto Tech Tree",
    category: "MISC",
    switch: {
      label: "On",
      get: isAutoTechTreeEnabled,
      set: value => {
        try {
          localStorage.setItem(STORAGE_KEY, String(value));
        } catch { /* idem */ }
        if (value) {
          techLogs = [];
          startPolling();
        } else {
          stopPolling();
        }
      },
    },
    status: { render: renderStatus, intervalMs: 2000 },
    install: () => { if (isAutoTechTreeEnabled()) startPolling(); },
  });
}
`;

// ─────────────────────────────────────────────────────────────────────────
// Patchers
// ─────────────────────────────────────────────────────────────────────────
function patchKnownLoop(content, id) {
  const known = KNOWN_LOOPS[id];
  if (!known) return null;
  const m = content.match(known.loopPattern);
  if (!m) return null;
  const idx = m.index + m[0].length;
  return content.slice(0, idx) + known.pauseSnippet + content.slice(idx);
}

function patchGenericLoop(content) {
  const fnRe = /(async\s+function\s+\w*(?:Routine|Run|Loop)\w*\s*\([^)]*\)\s*(?::\s*[^{]+)?\{)/;
  const fnMatch = content.match(fnRe);
  if (!fnMatch) return null;
  const fnBodyStart = fnMatch.index + fnMatch[0].length;
  const rest = content.slice(fnBodyStart);
  const whileMatch = rest.match(/while\s*\([^)]+\)\s*\{/);
  if (!whileMatch) return null;
  const injectIdx = fnBodyStart + whileMatch.index + whileMatch[0].length;
  const snippet = '\n      if (isPausedFor(MODULE_ID)) {\n        await new Promise(r => setTimeout(r, 2000));\n        continue;\n      }\n';
  return content.slice(0, injectIdx) + snippet + content.slice(injectIdx);
}

function patchIntervalFn(content, fnName) {
  const re = new RegExp('(function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\{)');
  const m = content.match(re);
  if (!m) return null;
  const idx = m.index + m[0].length;
  const snippet = '\n    if (isPausedFor(MODULE_ID)) return;';
  return content.slice(0, idx) + snippet + content.slice(idx);
}

function addImportsAndModuleId(content, id) {
  let patched = content;

  if (!patched.includes('isPausedFor')) {
    const imports = [...patched.matchAll(/^import .*;$/gm)];
    if (imports.length > 0) {
      const last = imports[imports.length - 1];
      const idx = last.index + last[0].length;
      patched = patched.slice(0, idx)
        + '\nimport { isPausedFor } from "./lib/mod-mutex";'
        + patched.slice(idx);
    }
  }

  if (!patched.includes('const MODULE_ID')) {
    const regMatch = patched.match(/(REGISTERED_MODS\.push\()/);
    if (regMatch) {
      patched = patched.slice(0, regMatch.index)
        + 'const MODULE_ID = "' + id + '";\n// ' + MARKER + '\n\n'
        + patched.slice(regMatch.index);
    }
  }

  return patched;
}

function patchHelperFile(filePath, content) {
  if (content.includes(MARKER)) return { ok: true, reason: 'already' };

  let patched = content;
  const fnRe = /(async\s+function\s+\w*(?:Routine|Run|Loop)\w*\s*\([^)]*\)\s*(?::\s*[^{]+)?\{)/;
  const fnMatch = patched.match(fnRe);
  if (!fnMatch) return { ok: false, reason: 'no routine fn' };

  const fnBodyStart = fnMatch.index + fnMatch[0].length;
  const rest = patched.slice(fnBodyStart);
  const whileMatch = rest.match(/while\s*\([^)]+\)\s*\{/);
  if (!whileMatch) return { ok: false, reason: 'no while in routine' };

  const injectIdx = fnBodyStart + whileMatch.index + whileMatch[0].length;
  const snippet = '\n      if (readMutex()) {\n        await new Promise(r => setTimeout(r, 2000));\n        continue;\n      }\n';
  patched = patched.slice(0, injectIdx) + snippet + patched.slice(injectIdx);

  // Import readMutex
  if (!patched.includes('readMutex')) {
    const imports = [...patched.matchAll(/^import .*;$/gm)];
    if (imports.length > 0) {
      const last = imports[imports.length - 1];
      const idx = last.index + last[0].length;
      patched = patched.slice(0, idx)
        + '\nimport { readMutex } from "./lib/mod-mutex";'
        + patched.slice(idx);
    }
  }

  // Marker en haut
  if (!patched.includes(MARKER)) {
    patched = '// ' + MARKER + ' — auto-patched\n\n' + patched;
  }

  write(filePath, patched);
  return { ok: true, reason: 'patched (helper)' };
}

function patchModFile(filePath, content) {
  const idMatch = content.match(/id:\s*["']([^"']+)["']/);
  if (!idMatch) return { ok: false, reason: 'no id' };
  const id = idMatch[1];

  if (SAFE_IDS.has(id)) return { ok: false, reason: 'safe' };
  if (content.includes(MARKER)) return { ok: true, reason: 'already' };

  let patched = null;

  if (KNOWN_LOOPS[id]) {
    patched = patchKnownLoop(content, id);
  }
  if (!patched) {
    patched = patchGenericLoop(content);
  }
  if (!patched) {
    if (id === 'farm-auto-kiting') {
      patched = patchIntervalFn(content, 'boucleKiting')
             || patchIntervalFn(content, 'kitingLoop')
             || patchIntervalFn(content, 'loop');
    } else if (id === 'misc-auto-ad') {
      patched = patchIntervalFn(content, 'tryClaimAd')
             || patchIntervalFn(content, 'runOneAd')
             || patchIntervalFn(content, 'tick');
    }
  }

  if (!patched) {
    return { ok: false, reason: 'pattern non détecté — patch manuel requis' };
  }

  patched = addImportsAndModuleId(patched, id);
  write(filePath, patched);
  return { ok: true, reason: 'patched' };
}

function patchAllMods() {
  log('── Patch des mods ──');
  const files = fs.readdirSync('mods').filter(f => f.endsWith('.ts'));
  const results = { patched: [], safe: [], already: [], failed: [], helper: [] };

  for (const f of files) {
    if (['index.ts', 'registry.ts', 'modmenu.ts', 'misc-auto-tech-tree.ts'].includes(f)) continue;
    const fullPath = path.join('mods', f);
    const content = read(fullPath);
    if (!content) continue;

    if (HELPER_FILES.has(f)) {
      const r = patchHelperFile(fullPath, content);
      if (r.ok && r.reason === 'already') results.already.push(f);
      else if (r.ok) { log('  ✓ ' + f + ' (helper) patché'); results.helper.push(f); }
      else { warn(f + ' : ' + r.reason); results.failed.push({ file: f, reason: r.reason }); }
      continue;
    }

    if (!content.includes('REGISTERED_MODS.push')) continue;

    const r = patchModFile(fullPath, content);
    if (r.ok && r.reason === 'already') results.already.push(f);
    else if (r.ok) { log('  ✓ ' + f + ' patché'); results.patched.push(f); }
    else if (r.reason === 'safe') results.safe.push(f);
    else { warn(f + ' : ' + r.reason); results.failed.push({ file: f, reason: r.reason }); }
  }

  log('');
  log('  ' + results.patched.length + ' mods + ' + results.helper.length + ' helper patchés · '
      + results.already.length + ' déjà · '
      + results.safe.length + ' safe · '
      + results.failed.length + ' en échec');
  if (results.failed.length > 0) {
    log('  ⚠ Mods à patcher à la main :');
    for (const f of results.failed) log('    - ' + f.file + ' : ' + f.reason);
  }
  return results;
}

function verify() {
  log('── Vérification ──');
  const problems = [];

  if (!fs.existsSync(MUTEX_FILE)) problems.push(MUTEX_FILE + ' manquant');
  else {
    const c = read(MUTEX_FILE);
    if (!c?.includes('acquireMutex') || !c?.includes('isPausedFor')) {
      problems.push(MUTEX_FILE + ' : exports manquants');
    }
  }

  if (!fs.existsSync(TECH_FILE)) problems.push(TECH_FILE + ' manquant');
  else {
    const c = read(TECH_FILE);
    if (!c?.includes('acquireMutex')) problems.push(TECH_FILE + ' : acquireMutex absent');
    if (!c?.includes('researchReadyHint')) problems.push(TECH_FILE + ' : READY_HINT_ID absent');
  }

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
  const msg = 'feat(mods): add inter-mod mutex for auto-tech-tree critical cycles';
  const out = run('git commit -m "' + msg + '"', { capture: true });
  if (/nothing to commit/i.test(out)) warn('rien à commit');
  else if (/error/i.test(out)) { err('commit échoué : ' + out.trim()); return false; }
  else log('  ✓ commit fait');
  if (!DO_PUSH) return true;
  log('── git push origin main ──');
  if (!run('git push origin main')) { err('push échoué'); return false; }
  log('  ✓ push fait');
  return true;
}

function main() {
  if (!fs.existsSync('mods')) { err('Lance depuis la racine.'); process.exit(1); }

  try { fs.mkdirSync('mods/lib', { recursive: true }); } catch { /* idem */ }

  if (fs.existsSync(MUTEX_FILE) && read(MUTEX_FILE)?.includes('acquireMutex')) {
    log('✓ ' + MUTEX_FILE + ' déjà présent');
  } else {
    write(MUTEX_FILE, MUTEX_SRC);
    log('✅ ' + MUTEX_FILE + ' créé');
  }

  if (fs.existsSync(TECH_FILE)) {
    const cur = read(TECH_FILE);
    if (cur && cur.includes('acquireMutex')) {
      log('✓ ' + TECH_FILE + ' déjà patché');
    } else {
      if (cur) write(TECH_FILE + '.bak', cur);
      write(TECH_FILE, TECH_SRC);
      log('✅ ' + TECH_FILE + ' remplacé (backup .bak)');
    }
  } else {
    write(TECH_FILE, TECH_SRC);
    log('✅ ' + TECH_FILE + ' créé');
  }

  patchAllMods();

  if (!verify()) process.exit(3);
  if (!build()) process.exit(4);
  if (!commitPush()) process.exit(5);

  log('');
  log('✅ Terminé.');
  log('');
  log('Comportement :');
  log('  • misc-auto-tech-tree prend le verrou (~60s TTL) quand Research Ready apparaît');
  log('  • Pendant le cycle : Auto Mining / Auto Quest / Card farms → pause');
  log('  • Verrou libéré à la fin → les autres reprennent');
  log('  • Log window dans la carte du modmenu');
  log('  • Si un mod na pas pu être patché, voir warnings ci-dessus');
}

main();