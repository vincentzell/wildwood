// mods/farm-auto-wood.ts
// Auto Wood — active le chop-body natif du jeu à Timberwood (Town grove).
// Navigation par waypoints (pont ouest → Oak stand), fallback unlock pour les arbres verrouillés.

import { REGISTERED_MODS } from "./registry";
import { getPlayerCoords } from "./lib/player-coords";

const STORAGE_KEY = "wildwood-mod-auto-wood-enabled";
const LIST_KEY = "wildwood-mod-auto-wood-list";
const LOG_LIMIT = 80;

const TREE_ORDER = ["pine", "oak", "yew", "elder"] as const;
type TreeKind = (typeof TREE_ORDER)[number];

const TREE_LABELS: Record<TreeKind, string> = {
  pine: "Pine Tree",
  oak: "Oak Tree",
  yew: "Yew Tree",
  elder: "Elder Tree",
};

// shared/woodcutting.ts → WOOD_STANDS[].woodcutting
const TREE_THRESHOLD: Record<TreeKind, number> = {
  pine: 0,
  oak: 50,
  yew: 250,
  elder: 900,
};

type CoopLike = {
  woodcutting?: () => number | null;
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
  if (!value) stopAutoWood();
}

let autoWoodList: TreeKind[] = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(LIST_KEY) || "[]");
    if (Array.isArray(saved)) return saved.filter((v): v is TreeKind => TREE_ORDER.includes(v));
  } catch { /* idem */ }
  return ["pine"];
})();

function saveList(): void {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(autoWoodList)); }
  catch { /* idem */ }
}

let autoWoodRunning = false;
let autoWoodAbort = false;
let autoWoodLogs: LogEntry[] = [];

function logAutoWood(msg: string, cls: LogEntry["cls"] = "info"): void {
  const ts = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  autoWoodLogs.push({ ts, msg, cls });
  if (autoWoodLogs.length > LOG_LIMIT) autoWoodLogs.shift();
  const p = "[mod-auto-wood]";
  if (cls === "bad") console.error(p, msg);
  else if (cls === "warn") console.warn(p, msg);
  else console.info(p, msg);
}

function getWoodcuttingLevel(): number | null {
  try {
    const lvl = getCoop()?.woodcutting?.();
    return typeof lvl === "number" ? lvl : null;
  } catch { return null; }
}

function isInGrove(): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  const chopBody = sheet?.querySelector<HTMLElement>(".farm-chop-body");
  return !!(chopBody && !chopBody.hidden);
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

// ─── Navigation ───
async function marcherVers(
  targetX: number,
  targetY: number,
  timeoutMs: number,
  mapIdDepart: string
): Promise<boolean> {
  const debut = Date.now();
  let lastLog = 0;
  logAutoWood("🚶 → (" + Math.round(targetX) + ", " + Math.round(targetY) + ")");
  releaseAllKeys();

  while (Date.now() - debut < timeoutMs && !autoWoodAbort) {
    const st = getPlayerCoords();
    if (!st) { await new Promise(r => setTimeout(r, 50)); continue; }

    if (st.mapId !== mapIdDepart) {
      releaseAllKeys();
      logAutoWood("✅ Map changée → " + st.mapId);
      return true;
    }

    const dx = targetX - st.x;
    const dy = targetY - st.y;
    const dist = Math.hypot(dx, dy);

    if (Date.now() - lastLog > 1000) {
      logAutoWood(`   [nav] pos=(${Math.round(st.x)}, ${Math.round(st.y)}) dist=${Math.round(dist)}px`, "info");
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
  logAutoWood("⏱️ Segment non atteint (timeout)", "warn");
  return false;
}

// Waypoints validés manuellement (captures 1 à 5)
const GROVE_WAYPOINTS: ReadonlyArray<{ x: number; y: number; name: string }> = [
  { x: 4382, y: 5110, name: "east wall end" },
  { x: 4264, y: 5207, name: "drop before bridge" },
  { x: 3792, y: 5207, name: "cross bridge" },
  { x: 2930, y: 5207, name: "grove interior" },
];

async function walkToGrove(): Promise<boolean> {
  if (isInGrove()) return true;
  logAutoWood("🌳 Waypoints → Grove");

  for (let i = 0; i < GROVE_WAYPOINTS.length; i++) {
    if (autoWoodAbort) return false;
    if (isInGrove()) { logAutoWood("✅ Grove atteint (wp " + i + ")", "ok"); return true; }
    
    const wp = GROVE_WAYPOINTS[i];
    logAutoWood("🚶 [" + (i + 1) + "/" + GROVE_WAYPOINTS.length + "] → " + wp.name);
    await marcherVers(wp.x, wp.y, 15000, "town");
  }

  if (isInGrove()) { logAutoWood("✅ Grove atteint (tous wp)", "ok"); return true; }
  logAutoWood("⚠️ Waypoints terminés sans grove", "warn");
  return isInGrove();
}

async function ensureTown(): Promise<boolean> {
  const c = getCoop();
  if (!c) return false;
  if (c.localState?.()?.mapId === "town") return true;
  if (!c.changeMap) { logAutoWood("❌ changeMap indisponible", "bad"); return false; }
  logAutoWood("🏘️ Téléport vers Town");
  try {
    const ok = await c.changeMap("town", 2400, 2400);
    if (!ok) { logAutoWood("❌ changeMap a retourné false", "bad"); return false; }
    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (c.localState?.()?.mapId === "town") return true;
      await new Promise(r => setTimeout(r, 150));
    }
    return c.localState?.()?.mapId === "town";
  } catch (e) {
    logAutoWood("❌ changeMap exception: " + (e as Error).message, "bad");
    return false;
  }
}

// ─── Activation chop ───
async function activateChop(kindsNeeded: TreeKind[]): Promise<{
  ok: boolean; reason: string; activeKinds: TreeKind[];
  fallbackFor: Map<TreeKind, { reason: string; farming: TreeKind[] }>;
}> {
  const empty = { ok: false, reason: "", activeKinds: [] as TreeKind[], fallbackFor: new Map() };
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return { ...empty, reason: "autoFarmSheet missing" };

  const toggle = sheet.querySelector<HTMLElement>(".farm-toggle");
  if (toggle && toggle.getAttribute("aria-expanded") === "false") {
    toggle.click();
    await new Promise(r => setTimeout(r, 400));
  }

  const buttons = Array.from(sheet.querySelectorAll<HTMLButtonElement>(".farm-chop-body [data-tree]"));
  if (buttons.length === 0) return { ...empty, reason: "chop-body invisible (pas dans le grove ?)" };

  const state = new Map<TreeKind, { disabled: boolean; checked: boolean; reason: string; el: HTMLButtonElement }>();
  for (const btn of buttons) {
    const kind = btn.dataset.tree as TreeKind;
    if (!TREE_ORDER.includes(kind)) continue;
    state.set(kind, {
      disabled: btn.disabled,
      checked: btn.getAttribute("aria-checked") === "true",
      reason: btn.querySelector(".farm-boss-status")?.textContent?.trim() || "",
      el: btn,
    });
  }

  const toActivate = new Set<TreeKind>();
  const fallbackFor = new Map<TreeKind, { reason: string; farming: TreeKind[] }>();

  for (const kind of kindsNeeded) {
    const st = state.get(kind);
    if (!st) continue;
    if (st.disabled) {
      fallbackFor.set(kind, { reason: st.reason || "locked", farming: [] });
      continue;
    }
    toActivate.add(kind);
  }

  for (const [lockedKind, info] of fallbackFor.entries()) {
    const idx = TREE_ORDER.indexOf(lockedKind);
    for (let i = idx - 1; i >= 0; i--) {
      const cand = TREE_ORDER[i];
      const st = state.get(cand);
      if (st && !st.disabled) {
        toActivate.add(cand);
        info.farming.push(cand);
        logAutoWood("🪓 " + lockedKind + " verrouillé (" + info.reason + ") — farm " + cand, "warn");
        break;
      }
    }
  }

  if (toActivate.size === 0) return { ...empty, reason: "aucun kind farmable", fallbackFor };

  for (const [kind, st] of state.entries()) {
    const shouldCheck = toActivate.has(kind);
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

  logAutoWood("✅ Auto Chop démarré (" + Array.from(toActivate).join(", ") + ")", "ok");
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

// ─── Routine ───
async function autoWoodRoutine(): Promise<void> {
  if (autoWoodRunning) return;
  if (autoWoodList.length === 0) { logAutoWood("⚠️ Aucun arbre coché", "warn"); return; }
  if (!isEnabled()) { logAutoWood("⚠️ Switch OFF", "warn"); return; }

  autoWoodRunning = true;
  autoWoodAbort = false;
  autoWoodLogs = [];
  logAutoWood("🌳 Démarrage (" + autoWoodList.map(k => TREE_LABELS[k]).join(", ") + ")");

  const STALL_MS = 20 * 60 * 1000;
  const HARD_CAP_MS = 12 * 60 * 60 * 1000;

  try {
    if (!(await ensureTown())) return;
    await new Promise(r => setTimeout(r, 800));

    if (!isInGrove()) {
      await walkToGrove();
      await new Promise(r => setTimeout(r, 1200));
    }
    if (!isInGrove()) { logAutoWood("❌ Grove non atteint, abandon", "bad"); return; }

    let result = await activateChop([...autoWoodList]);
    if (!result.ok) { logAutoWood("❌ Activation échouée : " + result.reason, "bad"); return; }

    const start = Date.now();
    let lastProgressTs = Date.now();
    let lastProgressReason = "start";
    let lastWc = getWoodcuttingLevel();
    const nextLockedThreshold = (): number | null => {
      let min = Infinity;
      for (const k of result.fallbackFor.keys()) {
        const t = TREE_THRESHOLD[k];
        if (typeof t === "number" && t < min) min = t;
      }
      return Number.isFinite(min) ? min : null;
    };
    if (lastWc !== null) {
      const need = nextLockedThreshold();
      logAutoWood("🪓 Woodcutting " + (need !== null ? lastWc + "/" + need : String(lastWc)), "info");
    }

    while (!autoWoodAbort && autoWoodRunning) {
      if (Date.now() - start > HARD_CAP_MS) { logAutoWood("⏹️ Hard cap 12h", "warn"); break; }
      if (Date.now() - lastProgressTs > STALL_MS) {
        logAutoWood("⏹️ Stall 20min (dernier : " + lastProgressReason + ")", "warn"); break;
      }
      await new Promise(r => setTimeout(r, 3000));

      const lvl = getWoodcuttingLevel();
      if (lvl !== null && lvl !== lastWc) {
        lastWc = lvl; lastProgressTs = Date.now(); lastProgressReason = "Woodcutting " + lvl;
        const need = nextLockedThreshold();
        logAutoWood("🪓 Woodcutting " + (need !== null ? lvl + "/" + need : String(lvl)), "info");
      }

      let unlocked = false;
      for (const kind of result.fallbackFor.keys()) {
        if (isKindUnlocked(kind)) { unlocked = true; logAutoWood("🎉 " + TREE_LABELS[kind] + " débloqué", "ok"); break; }
      }
      if (unlocked) {
        await stopNativeAutoFarm();
        await new Promise(r => setTimeout(r, 500));
        const re = await activateChop([...autoWoodList]);
        if (re.ok) { result = re; lastProgressTs = Date.now(); lastProgressReason = "unlock"; }
        else logAutoWood("⚠️ Réactivation échouée : " + re.reason, "warn");
      }

      const sheet = document.getElementById("autoFarmSheet");
      const status = sheet?.querySelector(".farm-chop-body .farm-mine-status")?.textContent || "";
      if (/Bag Full/i.test(status)) { logAutoWood("⚠️ " + status + " — arrêt", "warn"); break; }
      if (!sheet?.classList.contains("is-farming")) {
        logAutoWood("⚠️ Auto Chop arrêté (status: " + status + ")", "warn"); break;
      }
    }
  } catch (e) {
    logAutoWood("❌ Erreur : " + (e as Error).message, "bad");
  } finally {
    await stopNativeAutoFarm().catch(() => {});
    releaseAllKeys();
    autoWoodRunning = false;
    logAutoWood("🏁 Routine terminée", "info");
  }
}

function isKindUnlocked(kind: TreeKind): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  const chopBody = sheet?.querySelector(".farm-chop-body");
  if (!chopBody) return false;
  const btn = chopBody.querySelector<HTMLButtonElement>('[data-tree="' + kind + '"]');
  return !!(btn && !btn.disabled);
}

function startAutoWood(): void {
  autoWoodRoutine().catch(e => logAutoWood("❌ " + (e as Error).message, "bad"));
}

function stopAutoWood(): void {
  if (!autoWoodRunning) return;
  autoWoodAbort = true;
  releaseAllKeys();
  logAutoWood("🛑 Arrêt demandé", "warn");
}

// ─── UI ───
function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "font-size:10px;display:flex;flex-direction:column;gap:4px;";

  const status = document.createElement("div");
  const lvl = getWoodcuttingLevel();
  const inGrove = isInGrove();
  const stateLabel = autoWoodRunning ? (inGrove ? "▶ Farming" : "▶ Nav") : (isEnabled() ? "Idle" : "OFF");
  status.style.cssText = "color:" + (autoWoodRunning ? "#69e56f" : "#888") + ";font-weight:900;";
  status.textContent = stateLabel + " · Woodcutting " + (lvl ?? "?") + " · " + (inGrove ? "grove" : "hors grove");
  wrap.append(status);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:2px;margin:4px 0;";
  const wc = lvl ?? 0;
  for (const kind of TREE_ORDER) {
    const thr = TREE_THRESHOLD[kind];
    const locked = wc < thr;
    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 4px;border-radius:3px;";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = autoWoodList.includes(kind);
    cb.disabled = autoWoodRunning;
    cb.addEventListener("change", () => {
      if (cb.checked) { if (!autoWoodList.includes(kind)) autoWoodList.push(kind); }
      else autoWoodList = autoWoodList.filter(k => k !== kind);
      saveList();
    });
    const name = document.createElement("span");
    name.textContent = TREE_LABELS[kind];
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
  btnStart.disabled = autoWoodRunning || autoWoodList.length === 0 || !isEnabled();
  btnStart.addEventListener("click", () => startAutoWood());
  const btnStop = document.createElement("button");
  btnStop.textContent = "🛑 STOP";
  btnStop.style.cssText = "flex:1;padding:4px;background:rgba(255,103,103,.22);color:inherit;border:0;border-radius:3px;cursor:pointer;font-size:10px;font-weight:900;";
  btnStop.disabled = !autoWoodRunning;
  btnStop.addEventListener("click", () => stopAutoWood());
  actions.append(btnStart, btnStop);
  wrap.append(actions);

  // 📋 Copier log
  const btnCopy = document.createElement("button");
  btnCopy.textContent = "📋 Copier log";
  btnCopy.style.cssText = "margin-top:4px;padding:3px 6px;font:inherit;cursor:pointer;background:rgba(116,216,255,.22);color:inherit;border:0;border-radius:3px;font-size:10px;width:100%;";
  btnCopy.addEventListener("click", async () => {
    if (autoWoodLogs.length === 0) return;
    const header = "=== DIAG AUTO WOOD ===\nTimestamp: " + new Date().toISOString()
      + "\nList: " + autoWoodList.join(", ")
      + "\nRunning: " + autoWoodRunning
      + "\n--- LOGS ---\n";
    const body = autoWoodLogs.map(l => "[" + l.ts + "] (" + l.cls + ") " + l.msg).join("\n");
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

  if (autoWoodLogs.length > 0) {
    const logs = document.createElement("div");
    logs.style.cssText = "max-height:100px;overflow-y:auto;background:rgba(0,0,0,.3);padding:3px;border-radius:3px;font-size:9px;line-height:1.3;";
    for (const l of autoWoodLogs.slice(-20)) {
      const line = document.createElement("div");
      line.textContent = "[" + l.ts + "] " + l.msg;
      line.style.color = l.cls === "ok" ? "#69e56f" : l.cls === "warn" ? "#ffd85b" : l.cls === "bad" ? "#ff6767" : "#8aa8c8";
      logs.append(line);
    }
    wrap.append(logs);
  }
  return wrap;
}

export function registerAutoWoodMod(): void {
  REGISTERED_MODS.push({
    id: "farm-auto-wood",
    name: "Auto Wood",
    category: "FARM",
    description: "Farme les arbres à Timberwood (Town grove) via l'Auto Chop natif, avec fallback unlock.",
    switch: { label: "On", get: isEnabled, set: setEnabled },
    status: { render: renderStatus, intervalMs: 2000 },
    install: () => { if (isEnabled()) startAutoWood(); },
  });
}