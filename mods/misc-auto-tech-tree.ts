// mods/misc-auto-tech-tree.ts
import { RESEARCH_IDS, researchIsAvailable, type ResearchId, type ResearchRanks } from "../shared/research";
import { REGISTERED_MODS } from "./registry";
import { acquireMutex, isPausedFor, readMutex } from "./lib/mod-mutex";
import { TOWN_RESEARCH_POSITION } from "../shared/town";

const STORAGE_KEY = "wildwood-mod-auto-tech-tree-enabled";
const POLL_MS = 10_000;
const LOG_LIMIT = 100;
const LOG_DISPLAY = 20;

const READY_HINT_ID = "researchReadyHint";
const TOWN_MAP_ID = "town";
const TRAVEL_TIMEOUT_MS = 10_000;
const TREE_OPEN_TIMEOUT_MS = 5_000;
const WALK_TIMEOUT_MS = 8_000;
const STATION_REACH = 45;
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
let apiStale = false;

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
    await sleep(150);
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

// ─── Touches clavier ────────────────────────────────────────────────────
const KEYCODES: Record<string, number> = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
const activeKeys = new Set<string>();

function dispatchKey(type: "keydown" | "keyup", key: string): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#gameGpu")
    || document.querySelector<HTMLCanvasElement>("canvas");
  const evt = new KeyboardEvent(type, {
    key, code: key, keyCode: KEYCODES[key] || 0, which: KEYCODES[key] || 0,
    bubbles: true, cancelable: true, composed: true,
  });
  window.dispatchEvent(evt);
  if (canvas) try { canvas.dispatchEvent(evt); } catch { /* idem */ }
}

function setKeys(wanted: string[]): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#gameGpu")
    || document.querySelector<HTMLCanvasElement>("canvas");
  try { canvas?.focus({ preventScroll: true }); } catch { /* idem */ }
  for (const k of Array.from(activeKeys)) {
    if (!wanted.includes(k)) { dispatchKey("keyup", k); activeKeys.delete(k); }
  }
  for (const k of wanted) {
    if (!activeKeys.has(k)) { dispatchKey("keydown", k); activeKeys.add(k); }
  }
}

function releaseAllKeys(): void {
  for (const k of Array.from(activeKeys)) { dispatchKey("keyup", k); activeKeys.delete(k); }
}

function directionToKeys(angleRad: number): string[] {
  const deg = (angleRad * 180 / Math.PI + 360) % 360;
  if (deg >= 337.5 || deg < 22.5) return ["ArrowRight"];
  if (deg >= 22.5 && deg < 67.5) return ["ArrowDown", "ArrowRight"];
  if (deg >= 67.5 && deg < 112.5) return ["ArrowDown"];
  if (deg >= 112.5 && deg < 157.5) return ["ArrowDown", "ArrowLeft"];
  if (deg >= 157.5 && deg < 202.5) return ["ArrowLeft"];
  if (deg >= 202.5 && deg < 247.5) return ["ArrowUp", "ArrowLeft"];
  if (deg >= 247.5 && deg < 292.5) return ["ArrowUp"];
  return ["ArrowUp", "ArrowRight"];
}

async function walkTo(
  coop: CoopLike,
  targetX: number,
  targetY: number,
  timeoutMs: number,
  reach = STATION_REACH,
): Promise<boolean> {
  const start = Date.now();
  releaseAllKeys();
  while (Date.now() - start < timeoutMs) {
    const st = coop.localState?.();
    if (!st) { await sleep(100); continue; }
    const dx = targetX - (st.x ?? 0);
    const dy = targetY - (st.y ?? 0);
    const dist = Math.hypot(dx, dy);
    if (dist < reach) {
      releaseAllKeys();
      logTech("✅ arrivé station (dist=" + Math.round(dist) + "px)", "ok");
      return true;
    }
    const keys = directionToKeys(Math.atan2(dy, dx));
    setKeys(keys);
    await sleep(100);
  }
  releaseAllKeys();
  const st = coop.localState?.();
  const dist = Math.hypot(targetX - (st?.x ?? 0), targetY - (st?.y ?? 0));
  logTech("⚠ timeout marche (dist restant=" + Math.round(dist) + "px)", "warn");
  return false;
}

// ─── Détection tree ─────────────────────────────────────────────────────
function findResearchTreeButton(): HTMLElement | null {
  // Le tree est une <section class="tech-tree-window">, pas des <button data-research-id>
  const tree = document.querySelector<HTMLElement>(".tech-tree-window");
  if (tree && isVisible(tree)) return tree;
  return null;
}

function findAvailableUpgrade(): HTMLButtonElement | null {
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

// ─── Flow Research Ready ────────────────────────────────────────────────
async function handleReadyHint(coop: CoopLike): Promise<void> {
  const current = readMutex();
  if (current && current.holder !== MODULE_ID) {
    logTech("⏸ verrou tenu par " + current.holder, "warn");
    return;
  }

  const release = acquireMutex(MODULE_ID, "Research Ready cycle", MUTEX_TTL_MS);
  try {
    logTech("🔔 Research Ready — verrou pris");

    const hint = document.getElementById(READY_HINT_ID) as HTMLButtonElement | null;
    if (!hint || !isVisible(hint)) return;

    const prevMapId = coop.localState?.()?.mapId ?? null;
    const prevPos = coop.localState?.() ?? null;
    logTech("📍 avant : " + (prevMapId ?? "?") + " (" + Math.round(prevPos?.x ?? 0) + "," + Math.round(prevPos?.y ?? 0) + ")");
    logTech("🎯 cible : (" + Math.round(TOWN_RESEARCH_POSITION.x) + "," + Math.round(TOWN_RESEARCH_POSITION.y) + ")");

    hint.click();
    logTech("👆 clic hint");

    // Attend que le joueur soit à town (post-téléport)
    const arrived = await waitFor(() => coop.localState?.()?.mapId === TOWN_MAP_ID, TRAVEL_TIMEOUT_MS);
    if (!arrived) { logTech("❌ pas à town après téléport", "bad"); return; }
    await sleep(600);

    // Mesure distance à la station
    const st = coop.localState?.();
    const dist = Math.hypot((st?.x ?? 0) - TOWN_RESEARCH_POSITION.x, (st?.y ?? 0) - TOWN_RESEARCH_POSITION.y);
    logTech("📏 dist station : " + Math.round(dist) + "px");

    // Marche vers la station si trop loin
    if (dist > STATION_REACH) {
      logTech("🚶 marche vers station");
      const ok = await walkTo(coop, TOWN_RESEARCH_POSITION.x, TOWN_RESEARCH_POSITION.y, WALK_TIMEOUT_MS);
      if (!ok) { logTech("⚠ marche incomplète, on tente quand même le tree", "warn"); }
      await sleep(800);
    }

    // Attend tree
    const treeOpen = await waitFor(() => findResearchTreeButton() !== null, TREE_OPEN_TIMEOUT_MS);
    if (!treeOpen) {
      logTech("❌ tree pas ouvert — dump DOM", "bad");
      const dumpSelectors = [
        "button[data-research-id]",
        "[data-research-id]",
        "[class*='research']",
        "[id*='research']",
        "dialog[open]",
        "[class*='station']",
      ];
      for (const sel of dumpSelectors) {
        const els = [...document.querySelectorAll(sel)].filter(e => (e as HTMLElement).offsetParent !== null);
        if (els.length > 0) {
          logTech("  " + sel + " : " + els.length, "info");
          els.slice(0, 5).forEach((e, i) => {
            const txt = (e.textContent || "").trim().slice(0, 40);
            logTech("    " + i + ": " + e.tagName + (e.id ? "#" + e.id : "") + " · " + txt, "info");
          });
        }
      }
      return;
    }
    logTech("🌳 tree ouvert");

    const upgradeBtn = findAvailableUpgrade();
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
    }

    const newActive = coop.activeResearch?.();
    if (newActive) {
      const desc = describeActiveResearch(newActive);
      logTech("✅ actif : " + (desc ?? "?"), "ok");
      lastAction = desc ?? "Recherche en cours";
    } else {
      logTech("⚠ pas de recherche active après upgrade", "warn");
    }
  } finally {
    releaseAllKeys();
    release();
    logTech("🔓 verrou libéré", "info");
  }
}

function pickResearchToStart(ranks: ResearchRanks): ResearchId | null {
  return RESEARCH_IDS.find(id => researchIsAvailable(id, ranks)) ?? null;
}

// ─── Tick principal ─────────────────────────────────────────────────────
async function tick(): Promise<void> {
  if (running || !isAutoTechTreeEnabled() || Date.now() - lastAttemptTs < POLL_MS) return;
  const coop = getCoop();
  if (!coop) return;
  if (isPausedFor(MODULE_ID)) return;

  running = true;
  lastAttemptTs = Date.now();
  try {
    // 1. Priorité absolue : hint visible → flow UI
    const hint = document.getElementById(READY_HINT_ID) as HTMLButtonElement | null;
    if (hint && isVisible(hint)) {
      await handleReadyHint(coop);
      return;
    }

    // 2. Recherche active → juste logger
    if (coop.activeResearch?.()) {
      const desc = describeActiveResearch(coop.activeResearch());
      if (desc && desc !== lastAction) {
        lastAction = desc;
        if (!desc.startsWith("⏳")) logTech(desc, "info");
      }
      return;
    }

    // 3. API fallback (skip si stale)
    if (apiStale) return;
    if (!coop.startResearch || !coop.research) return;

    const ranks = coop.research();
    const target = pickResearchToStart(ranks);
    if (!target) {
      if (lastAction !== "Aucune recherche disponible") {
        lastAction = "Aucune recherche disponible";
        logTech("⚠ aucune recherche dispo via API", "warn");
      }
      return;
    }

    logTech("▶ tentative API " + target);
    const result = await coop.startResearch(target);
    if (result.ok) {
      lastError = "";
      lastAction = "▶ " + target;
      logTech("✅ " + target + " démarrée (API)", "ok");
    } else {
      const err = result.error ?? "Refus serveur";
      // Détecte "WildStat updated" → API stale, on arrête de spammer
      if (/wildstat updated|refresh to continue/i.test(err)) {
        apiStale = true;
        logTech("⚠ API stale ('WildStat updated') — mode UI only jusqu'au reload", "warn");
      } else {
        lastError = err;
        logTech("❌ API refusée : " + err, "bad");
      }
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

// ─── UI ─────────────────────────────────────────────────────────────────
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

  if (apiStale) {
    const staleLine = document.createElement("div");
    staleLine.style.cssText = "font-size:10px;color:#ffd85b;margin-bottom:3px;";
    staleLine.textContent = "⚠ API stale — reload pour réactiver";
    wrap.append(staleLine);
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
      "=== DIAG AUTO TECH TREE ===\n" +
      "Timestamp: " + new Date().toISOString() + "\n" +
      "Running: " + running + " | Last action: " + lastAction + " | Error: " + (lastError || "-") + "\n" +
      "API stale: " + apiStale + "\n" +
      "--- LOGS ---\n";
    const body = techLogs.map(l => "[" + l.ts + "] (" + l.cls + ") " + l.msg).join("\n");
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
          apiStale = false;
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
// [patched:tech-tree-canvas]
