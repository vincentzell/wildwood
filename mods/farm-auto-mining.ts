// mods/farm-auto-mining.ts
// Auto Mining — active le mine-body natif du jeu à Copper Hills.
// Navigation par waypoints (userscript WildPote v20.7.0), fallback unlock.

import { REGISTERED_MODS } from "./registry";
import { getPlayerCoords } from "./lib/player-coords";

const STORAGE_KEY = "wildwood-mod-auto-mining-enabled";
const LIST_KEY = "wildwood-mod-auto-mining-list";
const LOG_LIMIT = 80;

const ORE_ORDER = ["copper_ore", "iron_ore", "mithril_ore", "adamant_ore"] as const;
type OreKind = (typeof ORE_ORDER)[number];

const ORE_EXTRA = ["arcane_crystal", "starshard"] as const;
type OreExtra = (typeof ORE_EXTRA)[number];
type AllOre = OreKind | OreExtra;

const ORE_LABELS: Record<AllOre, string> = {
  copper_ore: "Copper Ore",
  iron_ore: "Iron Ore",
  mithril_ore: "Mithril Ore",
  adamant_ore: "Adamant Ore",
  arcane_crystal: "Arcane Crystal",
  starshard: "Starshard",
};

const ORE_THRESHOLD: Record<AllOre, number> = {
  copper_ore: 0,
  iron_ore: 50,
  mithril_ore: 250,
  adamant_ore: 900,
  arcane_crystal: 25,
  starshard: 0,
};

// Waypoints vers Copper Hills (userscript v20.7.0 navigateToHills).
const HILLS_WAYPOINTS: ReadonlyArray<{ x: number; y: number; name: string }> = [
  { x: 6506, y: 5110, name: "east corridor" },
  { x: 6506, y: 5210, name: "drop south" },
  { x: 7000, y: 5210, name: "east approach" },
  { x: 7000, y: 4742, name: "bridge crossing (north)" },
  { x: 7624, y: 4742, name: "bridge exit" },
  { x: 9036, y: 4742, name: "hills interior" },
];

type CoopLike = {
  mining?: () => number | null;
  localState?: () => { x?: number; y?: number; mapId?: string } | null;
  changeMap?: (mapId: string, x: number, y: number) => Promise<boolean>;
};

type LogEntry = { ts: string; msg: string; cls: "info" | "ok" | "warn" | "bad" };

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

function isEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

function setEnabled(value: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, String(value)); }
  catch { /* idem */ }
  if (!value) stopAutoMining();
}

let autoMiningList: AllOre[] = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(LIST_KEY) || "[]");
    const valid = [...ORE_ORDER, ...ORE_EXTRA] as AllOre[];
    if (Array.isArray(saved)) return saved.filter((v): v is AllOre => valid.includes(v as AllOre));
  } catch { /* idem */ }
  return ["copper_ore"];
})();

function saveList(): void {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(autoMiningList)); }
  catch { /* idem */ }
}

let autoMiningRunning = false;
let autoMiningAbort = false;
let autoMiningLogs: LogEntry[] = [];

function logAutoMining(msg: string, cls: LogEntry["cls"] = "info"): void {
  const ts = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  autoMiningLogs.push({ ts, msg, cls });
  if (autoMiningLogs.length > LOG_LIMIT) autoMiningLogs.shift();
  const p = "[mod-auto-mining]";
  if (cls === "bad") console.error(p, msg);
  else if (cls === "warn") console.warn(p, msg);
  else console.info(p, msg);
}

function getMiningLevel(): number | null {
  try {
    const lvl = getCoop()?.mining?.();
    return typeof lvl === "number" ? lvl : null;
  } catch { return null; }
}

function isInHills(): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  const mineBody = sheet?.querySelector<HTMLElement>(".farm-mine-body:not(.farm-chop-body)");
  return !!(mineBody && !mineBody.hidden);
}

// ─── Touches clavier ───
const KEYCODES: Record<string, number> = {
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
};
const activeKeys = new Set<string>();

function dispatchKey(type: "keydown" | "keyup", key: string): void {
  const canvas = document.querySelector<HTMLCanvasElement>("#gameGpu")
    || document.querySelector<HTMLCanvasElement>("canvas");
  const evt = new KeyboardEvent(type, {
    key, code: key, keyCode: KEYCODES[key] || 0,
    which: KEYCODES[key] || 0,
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

async function marcherVers(
  targetX: number,
  targetY: number,
  timeoutMs: number,
  mapIdDepart: string
): Promise<boolean> {
  const debut = Date.now();
  let lastLog = 0;
  logAutoMining("🚶 → (" + Math.round(targetX) + ", " + Math.round(targetY) + ")");
  releaseAllKeys();

  while (Date.now() - debut < timeoutMs && !autoMiningAbort) {
    const st = getPlayerCoords();
    if (!st) { await new Promise(r => setTimeout(r, 50)); continue; }

    if (st.mapId !== mapIdDepart) {
      releaseAllKeys();
      logAutoMining("✅ Map changée → " + st.mapId);
      return true;
    }

    const dx = targetX - st.x;
    const dy = targetY - st.y;
    const dist = Math.hypot(dx, dy);

    if (Date.now() - lastLog > 1000) {
      logAutoMining(`   [nav] pos=(${Math.round(st.x)}, ${Math.round(st.y)}) dist=${Math.round(dist)}px`, "info");
      lastLog = Date.now();
    }

    if (dist < 25) {
      releaseAllKeys();
      return true;
    }

    const keys = directionToKeys(Math.atan2(dy, dx));
    setKeys(keys);
    await new Promise(r => setTimeout(r, 50));
  }
  releaseAllKeys();
  logAutoMining("⏱️ Segment non atteint (timeout)", "warn");
  return false;
}

async function ensureTown(): Promise<boolean> {
  const c = getCoop();
  if (!c) return false;
  if (getPlayerCoords()?.mapId === "town") return true;
  if (!c.changeMap) { logAutoMining("❌ changeMap indisponible", "bad"); return false; }
  logAutoMining("🏘️ Téléport vers Town");
  try {
    const ok = await c.changeMap("town", 2400, 2400);
    if (!ok) { logAutoMining("❌ changeMap a retourné false", "bad"); return false; }
    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (getPlayerCoords()?.mapId === "town") return true;
      await new Promise(r => setTimeout(r, 150));
    }
    return getPlayerCoords()?.mapId === "town";
  } catch (e) {
    logAutoMining("❌ changeMap exception: " + (e as Error).message, "bad");
    return false;
  }
}

async function walkToHills(): Promise<boolean> {
  if (isInHills()) return true;
  logAutoMining("⛏️ Waypoints → Copper Hills");

  for (let i = 0; i < HILLS_WAYPOINTS.length; i++) {
    if (autoMiningAbort) return false;
    if (isInHills()) { logAutoMining("✅ Hills atteint (wp " + i + ")", "ok"); return true; }
    const wp = HILLS_WAYPOINTS[i];
    logAutoMining("🚶 [" + (i + 1) + "/" + HILLS_WAYPOINTS.length + "] → " + wp.name);
    await marcherVers(wp.x, wp.y, 12000, "town");
  }

  if (isInHills()) { logAutoMining("✅ Hills atteint (tous wp)", "ok"); return true; }

  logAutoMining("⚠️ Dernier waypoint atteint, push final vers l'est", "warn");
  await marcherVers(9500, 4742, 5000, "town");
  if (isInHills()) { logAutoMining("✅ Hills atteint (push final)", "ok"); return true; }
  logAutoMining("⚠️ Waypoints terminés sans hills", "warn");
  return isInHills();
}

async function activateMining(kindsNeeded: AllOre[]): Promise<{
  ok: boolean; reason: string; activeKinds: AllOre[];
  fallbackFor: Map<OreKind, { reason: string; farming: OreKind[] }>;
}> {
  const empty = { ok: false, reason: "", activeKinds: [] as AllOre[], fallbackFor: new Map<OreKind, { reason: string; farming: OreKind[] }>() };
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return { ...empty, reason: "autoFarmSheet missing" };

  const toggle = sheet.querySelector<HTMLElement>(".farm-toggle");
  if (toggle && toggle.getAttribute("aria-expanded") === "false") {
    toggle.click();
    await new Promise(r => setTimeout(r, 400));
  }

  const mineBody = sheet.querySelector<HTMLElement>(".farm-mine-body:not(.farm-chop-body)");
  if (!mineBody || mineBody.hidden) {
    return { ...empty, reason: "mine-body invisible (pas dans les hills ?)" };
  }

  const buttons = Array.from(mineBody.querySelectorAll<HTMLButtonElement>("[data-ore]"));
  if (buttons.length === 0) return { ...empty, reason: "aucun bouton [data-ore]" };

  const valid = [...ORE_ORDER, ...ORE_EXTRA] as AllOre[];
  const state = new Map<AllOre, { disabled: boolean; checked: boolean; reason: string; el: HTMLButtonElement }>();
  for (const btn of buttons) {
    const ore = btn.dataset.ore as AllOre;
    if (!valid.includes(ore)) continue;
    state.set(ore, {
      disabled: btn.disabled,
      checked: btn.getAttribute("aria-checked") === "true",
      reason: btn.querySelector(".farm-boss-status")?.textContent?.trim() || "",
      el: btn,
    });
  }

  const toActivate = new Set<AllOre>();
  const fallbackFor = new Map<OreKind, { reason: string; farming: OreKind[] }>();

  for (const ore of kindsNeeded) {
    const st = state.get(ore);
    if (!st) continue;
    if (st.disabled) {
      if ((ORE_ORDER as readonly string[]).includes(ore)) {
        fallbackFor.set(ore as OreKind, { reason: st.reason || "locked", farming: [] });
      }
      continue;
    }
    toActivate.add(ore);
  }

  for (const [lockedOre, info] of fallbackFor.entries()) {
    const idx = ORE_ORDER.indexOf(lockedOre);
    for (let i = idx - 1; i >= 0; i--) {
      const cand = ORE_ORDER[i];
      const st = state.get(cand);
      if (st && !st.disabled) {
        toActivate.add(cand);
        info.farming.push(cand);
        logAutoMining("⛏️ " + lockedOre + " verrouillé (" + info.reason + ") — mine " + cand, "warn");
        break;
      }
    }
  }

  if (toActivate.size === 0) return { ...empty, reason: "aucun ore farmable", fallbackFor };

  for (const [ore, st] of state.entries()) {
    const shouldCheck = toActivate.has(ore);
    if (shouldCheck && !st.checked && !st.disabled) {
      st.el.click();
      await new Promise(r => setTimeout(r, 100));
    } else if (!shouldCheck && st.checked) {
      st.el.click();
      await new Promise(r => setTimeout(r, 100));
    }
  }

  await new Promise(r => setTimeout(r, 600));

  const startBtn = sheet.querySelector<HTMLButtonElement>(".farm-start");
  if (!startBtn || startBtn.disabled) {
    const reason = sheet.querySelector(".farm-selection")?.textContent?.trim() || "Start disabled";
    return { ...empty, reason, activeKinds: Array.from(toActivate), fallbackFor };
  }
  startBtn.click();
  await new Promise(r => setTimeout(r, 1000));

  if (!sheet.classList.contains("is-farming")) {
    return { ...empty, reason: "démarré mais pas en farming", activeKinds: Array.from(toActivate), fallbackFor };
  }

  logAutoMining("✅ Auto Mine démarré (" + Array.from(toActivate).join(", ") + ")", "ok");
  return { ok: true, reason: "", activeKinds: Array.from(toActivate), fallbackFor };
}

async function stopNativeAutoFarm(): Promise<void> {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return;
  const content = sheet.querySelector<HTMLElement>(".farm-card-content");
  const wasHidden = content?.hidden;
  if (wasHidden) {
    sheet.querySelector<HTMLElement>(".farm-toggle")?.click();
    await new Promise(r => setTimeout(r, 300));
  }
  const closeBtn = sheet.querySelector<HTMLButtonElement>(".farm-close");
  if (closeBtn && /stop/i.test(closeBtn.textContent || "")) {
    closeBtn.click();
    await new Promise(r => setTimeout(r, 500));
  }
  for (const row of sheet.querySelectorAll<HTMLElement>("[data-group]")) {
    const off = row.querySelector<HTMLElement>('[data-mode="off"]');
    if (off && off.getAttribute("aria-checked") !== "true") {
      off.click();
      await new Promise(r => setTimeout(r, 20));
    }
  }
  if (wasHidden && content && !content.hidden) {
    sheet.querySelector<HTMLElement>(".farm-toggle")?.click();
    await new Promise(r => setTimeout(r, 100));
  }
}

async function autoMiningRoutine(): Promise<void> {
  if (autoMiningRunning) return;
  if (autoMiningList.length === 0) { logAutoMining("⚠️ Aucun minerai coché", "warn"); return; }
  if (!isEnabled()) { logAutoMining("⚠️ Switch OFF", "warn"); return; }

  autoMiningRunning = true;
  autoMiningAbort = false;
  autoMiningLogs = [];
  logAutoMining("⛏️ Démarrage (" + autoMiningList.map(k => ORE_LABELS[k]).join(", ") + ")");

  const STALL_MS = 20 * 60 * 1000;
  const HARD_CAP_MS = 12 * 60 * 60 * 1000;

  try {
    if (!(await ensureTown())) return;
    await new Promise(r => setTimeout(r, 800));

    if (!isInHills()) {
      await walkToHills();
      await new Promise(r => setTimeout(r, 1200));
    }
    if (!isInHills()) { logAutoMining("❌ Hills non atteint, abandon", "bad"); return; }

    let result = await activateMining([...autoMiningList]);
    if (!result.ok) { logAutoMining("❌ Activation échouée : " + result.reason, "bad"); return; }

    const start = Date.now();
    let lastProgressTs = Date.now();
    let lastProgressReason = "start";
    let lastMining = getMiningLevel();
    const nextLockedThreshold = (): number | null => {
      let min = Infinity;
      for (const k of result.fallbackFor.keys()) {
        const t = ORE_THRESHOLD[k];
        if (typeof t === "number" && t < min) min = t;
      }
      return Number.isFinite(min) ? min : null;
    };
    if (lastMining !== null) {
      const need = nextLockedThreshold();
      logAutoMining("⛏️ Mining " + (need !== null ? lastMining + "/" + need : String(lastMining)), "info");
    }

    while (!autoMiningAbort && autoMiningRunning) {
      if (Date.now() - start > HARD_CAP_MS) { logAutoMining("⏹️ Hard cap 12h", "warn"); break; }
      if (Date.now() - lastProgressTs > STALL_MS) {
        logAutoMining("⏹️ Stall 20min (dernier : " + lastProgressReason + ")", "warn"); break;
      }
      await new Promise(r => setTimeout(r, 3000));

      const lvl = getMiningLevel();
      if (lvl !== null && lvl !== lastMining) {
        lastMining = lvl; lastProgressTs = Date.now(); lastProgressReason = "Mining " + lvl;
        const need = nextLockedThreshold();
        logAutoMining("⛏️ Mining " + (need !== null ? lvl + "/" + need : String(lvl)), "info");
      }

      let unlocked = false;
      for (const ore of result.fallbackFor.keys()) {
        if (isOreUnlocked(ore)) { unlocked = true; logAutoMining("🎉 " + ORE_LABELS[ore] + " débloqué", "ok"); break; }
      }
      if (unlocked) {
        await stopNativeAutoFarm();
        await new Promise(r => setTimeout(r, 500));
        const re = await activateMining([...autoMiningList]);
        if (re.ok) { result = re; lastProgressTs = Date.now(); lastProgressReason = "unlock"; }
        else logAutoMining("⚠️ Réactivation échouée : " + re.reason, "warn");
      }

      const sheet = document.getElementById("autoFarmSheet");
      const status = sheet?.querySelector(".farm-mine-body:not(.farm-chop-body) .farm-mine-status")?.textContent || "";
      if (/Bag Full/i.test(status)) { logAutoMining("⚠️ " + status + " — arrêt", "warn"); break; }
      if (!sheet?.classList.contains("is-farming")) {
        logAutoMining("⚠️ Auto Mine arrêté (status: " + status + ")", "warn"); break;
      }
    }
  } catch (e) {
    logAutoMining("❌ Erreur : " + (e as Error).message, "bad");
  } finally {
    await stopNativeAutoFarm().catch(() => {});
    releaseAllKeys();
    autoMiningRunning = false;
    logAutoMining("🏁 Routine terminée", "info");
  }
}

function isOreUnlocked(ore: AllOre): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  const mineBody = sheet?.querySelector<HTMLElement>(".farm-mine-body:not(.farm-chop-body)");
  if (!mineBody || mineBody.hidden) return false;
  const btn = mineBody.querySelector<HTMLButtonElement>('[data-ore="' + ore + '"]');
  return !!(btn && !btn.disabled);
}

function startAutoMining(): void {
  autoMiningRoutine().catch(e => logAutoMining("❌ " + (e as Error).message, "bad"));
}

function stopAutoMining(): void {
  if (!autoMiningRunning) return;
  autoMiningAbort = true;
  releaseAllKeys();
  logAutoMining("🛑 Arrêt demandé", "warn");
}

// ─── UI ───
function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "font-size:10px;display:flex;flex-direction:column;gap:4px;";

  const status = document.createElement("div");
  const lvl = getMiningLevel();
  const inHills = isInHills();
  const stateLabel = autoMiningRunning ? (inHills ? "▶ Mining" : "▶ Nav") : (isEnabled() ? "Idle" : "OFF");
  status.style.cssText = "color:" + (autoMiningRunning ? "#69e56f" : "#888") + ";font-weight:900;";
  status.textContent = stateLabel + " · Mining " + (lvl ?? "?") + " · " + (inHills ? "hills" : "hors hills");
  wrap.append(status);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:2px;margin:4px 0;";
  const wc = lvl ?? 0;
  const allOres: AllOre[] = [...ORE_ORDER, ...ORE_EXTRA];
  for (const ore of allOres) {
    const thr = ORE_THRESHOLD[ore];
    const locked = wc < thr;
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 4px;border-radius:3px;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = autoMiningList.includes(ore);
    cb.disabled = autoMiningRunning;
    cb.addEventListener("change", () => {
      if (cb.checked) { if (!autoMiningList.includes(ore)) autoMiningList.push(ore); }
      else autoMiningList = autoMiningList.filter(k => k !== ore);
      saveList();
    });
    const name = document.createElement("span");
    name.textContent = ORE_LABELS[ore];
    name.style.flex = "1";
    const badge = document.createElement("span");
    badge.textContent = locked ? ("🔒 Lv " + thr) : (thr === 0 ? "Lv 0" : ("Lv " + thr));
    badge.style.cssText = "font-size:8px;font-weight:900;color:" + (locked ? "#888" : "#69e56f") + ";";
    row.append(cb, name, badge);
    list.append(row);
  }
  wrap.append(list);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:4px;";
  const btnStart = document.createElement("button");
  btnStart.textContent = "🚀 START";
  btnStart.style.cssText = "flex:1;padding:4px;background:rgba(105,229,111,.22);color:inherit;border:0;border-radius:3px;cursor:pointer;font-size:10px;font-weight:900;";
  btnStart.disabled = autoMiningRunning || autoMiningList.length === 0 || !isEnabled();
  btnStart.addEventListener("click", () => startAutoMining());
  const btnStop = document.createElement("button");
  btnStop.textContent = "🛑 STOP";
  btnStop.style.cssText = "flex:1;padding:4px;background:rgba(255,103,103,.22);color:inherit;border:0;border-radius:3px;cursor:pointer;font-size:10px;font-weight:900;";
  btnStop.disabled = !autoMiningRunning;
  btnStop.addEventListener("click", () => stopAutoMining());
  actions.append(btnStart, btnStop);
  wrap.append(actions);

  const btnCopy = document.createElement("button");
  btnCopy.textContent = "📋 Copier log";
  btnCopy.style.cssText = "margin-top:4px;padding:3px 6px;font:inherit;cursor:pointer;background:rgba(116,216,255,.22);color:inherit;border:0;border-radius:3px;font-size:10px;width:100%;";
  btnCopy.addEventListener("click", async () => {
    if (autoMiningLogs.length === 0) return;
    const header = "=== DIAG AUTO MINING ===\nTimestamp: " + new Date().toISOString()
      + "\nList: " + autoMiningList.join(", ")
      + "\nRunning: " + autoMiningRunning
      + "\n--- LOGS ---\n";
    const body = autoMiningLogs.map(l => "[" + l.ts + "] (" + l.cls + ") " + l.msg).join("\n");
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

  if (autoMiningLogs.length > 0) {
    const logs = document.createElement("div");
    logs.style.cssText = "max-height:100px;overflow-y:auto;background:rgba(0,0,0,.3);padding:3px;border-radius:3px;font-size:9px;line-height:1.3;";
    for (const l of autoMiningLogs.slice(-20)) {
      const line = document.createElement("div");
      line.textContent = "[" + l.ts + "] " + l.msg;
      line.style.color = l.cls === "ok" ? "#69e56f" : l.cls === "warn" ? "#ffd85b" : l.cls === "bad" ? "#ff6767" : "#8aa8c8";
      logs.append(line);
    }
    wrap.append(logs);
  }
  return wrap;
}

export function registerAutoMiningMod(): void {
  REGISTERED_MODS.push({
    id: "farm-auto-mining",
    name: "Auto Mining",
    category: "FARM",
    description: "Farme les minerais à Copper Hills via l'Auto Mine natif, avec fallback unlock.",
    switch: { label: "On", get: isEnabled, set: setEnabled },
    status: { render: renderStatus, intervalMs: 2000 },
    install: () => { if (isEnabled()) startAutoMining(); },
  });
}