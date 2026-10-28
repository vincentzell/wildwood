// mods/misc-auto-tech-tree.ts
import { RESEARCH_IDS, researchIsAvailable, type ResearchId, type ResearchRanks } from "../shared/research";
import { REGISTERED_MODS } from "./registry";
import { acquireMutex, isPausedFor, readMutex } from "./lib/mod-mutex";

import { TOWN_RESEARCH_POSITION } from "../shared/town";
// [patched:research-position-v2]
const STORAGE_KEY = "wildwood-mod-auto-tech-tree-enabled";
const POLL_MS = 10_000;
const LOG_LIMIT = 100;
const LOG_DISPLAY = 20;

const READY_HINT_ID = "researchReadyHint";
const TOWN_MAP_ID = "town";
// TOWN_RESEARCH_POSITION remplacé par TOWN_RESEARCH_POSITION (import)
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
        const els = [...document.querySelectorAll(sel)].filter(e => (e as HTMLElement).offsetParent !== null);
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
      "=== DIAG AUTO TECH TREE ===\n" +
      "Timestamp: " + new Date().toISOString() + "\n" +
      "Running: " + running + " | Last action: " + lastAction + " | Error: " + (lastError || "-") + "\n" +
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
