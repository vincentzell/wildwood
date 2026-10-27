// mods/quest-auto-quest.ts
import { ENEMY_TYPES } from "../src/game/enemies";
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-quest-enabled";
const COLLECT_GUILD_KEY = "wildwood-mod-auto-quest-collect-guild-enabled";
const POLL_INTERVAL_MS = 10_000;
const GUILD_RETRY_COOLDOWN_MS = 60_000;
const POOL_EMPTY_RECHECK_MS = 5 * 60_000;
const QUEST_WAIT_MS = 60_000;
const TRAVEL_WAIT_MS = 15_000;
const TICK_MS = 2_000;
const LOG_LIMIT = 100;
const LOG_DISPLAY = 20;

type QuestPhase = "idle" | "scanning" | "traveling" | "farming" | "waiting";

let currentPhase: QuestPhase = "idle";
let currentQuestEnemy = "";
let currentQuestMap = "";

type LogEntry = { ts: string; msg: string; cls: "info" | "ok" | "warn" | "bad" };
let questLogs: LogEntry[] = [];

function logQuest(msg: string, cls: LogEntry["cls"] = "info"): void {
  const ts = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  questLogs.push({ ts, msg, cls });
  if (questLogs.length > LOG_LIMIT) questLogs.shift();
  const p = "[mod-auto-quest]";
  if (cls === "bad") console.error(p, msg);
  else if (cls === "warn") console.warn(p, msg);
  else console.info(p, msg);
}

type CoopQuest = {
  mapId: string;
  enemy?: string;
  stat?: string;
  target: number;
  progress: number;
  takenBy?: string;
  from?: string;
};

type WeeklyQuestState = {
  day: number;
  quests: CoopQuest[];
  bonus: number;
  guildPoints: number;
  guildName: string;
};

type GuildQuestCollect = {
  ready: boolean;
  left: number;
  pool: number;
  poolSize: number;
};

type LoadGuildResult = {
  guild?: {
    id: string;
    name: string;
    questCollect?: GuildQuestCollect;
  };
};

type CoopLike = {
  weeklyQuests?: () => WeeklyQuestState | null;
  localIdentity?: () => string;
  guild?: {
    guildAction?: (
      action: { kind: string; identity: string },
    ) => Promise<{ ok?: boolean; error?: string }>;
    loadGuild?: () => Promise<LoadGuildResult | null>;
  };
  travelToMap?: (mapId: string) => Promise<boolean>;
  localState?: () => { mapId?: string; hp?: number } | null;
};

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

let lastGuildAttemptTs = 0;
let lastSeenDay = -1;
let poolEmptyUntil = 0;
let lastKnownCollectState: GuildQuestCollect | null = null;

function isCollectGuildEnabled(): boolean {
  try {
    return localStorage.getItem(COLLECT_GUILD_KEY) === "true";
  } catch {
    return false;
  }
}

function setCollectGuildEnabled(value: boolean): void {
  try {
    localStorage.setItem(COLLECT_GUILD_KEY, String(value));
  } catch {
    // Ignore unavailable local storage.
  }
  if (value) poolEmptyUntil = 0;
}

export function isAutoQuestEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch (error) {
    logQuest("⚠ lecture du réglage impossible: " + (error as Error).message, "warn");
    return false;
  }
}

function activeQuests(coop: CoopLike): CoopQuest[] {
  const data = coop.weeklyQuests?.();
  if (!data?.quests) return [];
  return data.quests.filter(q =>
    q.progress < q.target &&
    !q.takenBy &&
    (q.enemy || q.stat)
  );
}

async function tryCollectGuild(coop: CoopLike): Promise<void> {
  if (!isCollectGuildEnabled()) return;
  if (Date.now() < poolEmptyUntil) return;
  if (Date.now() - lastGuildAttemptTs < GUILD_RETRY_COOLDOWN_MS) return;

  const data = coop.weeklyQuests?.();
  if (!data?.quests || !data.guildName) return;

  if (data.day !== lastSeenDay) {
    lastSeenDay = data.day;
    poolEmptyUntil = 0;
    logQuest("📅 nouvelle semaine de quêtes (day=" + data.day + ")", "info");
  }

  const perso = data.quests.filter(quest => !quest.from);
  if (perso.length === 0) return;
  const allDone = perso.every(quest => quest.progress >= quest.target);
  if (!allDone) return;

  const identity = coop.localIdentity?.();
  if (!identity || !coop.guild?.guildAction) return;

  lastGuildAttemptTs = Date.now();

  let collectState: GuildQuestCollect | undefined;
  try {
    const info = await coop.guild.loadGuild?.();
    collectState = info?.guild?.questCollect;
    lastKnownCollectState = collectState ?? null;
  } catch (error) {
    logQuest("❌ loadGuild exception: " + (error as Error).message, "bad");
  }

  if (collectState) {
    if (!collectState.ready || collectState.pool === 0) {
      const min = Math.round(POOL_EMPTY_RECHECK_MS / 60_000);
      logQuest(
        `📦 pool ${collectState.pool}/${collectState.poolSize} · ready=${collectState.ready} — backoff ${min}min`,
        "info"
      );
      poolEmptyUntil = Date.now() + POOL_EMPTY_RECHECK_MS;
      return;
    }
  }

  try {
    const result = await coop.guild.guildAction({ kind: "collectQuests", identity });
    if (result?.ok) {
      const fresh = coop.weeklyQuests?.();
      const freshCollected = fresh?.quests.filter(q => q.from) ?? [];
      const freshActive = fresh?.quests.filter(q =>
        q.progress < q.target && !q.takenBy && (q.enemy || q.stat)
      ) ?? [];
      const poolInfo = collectState
        ? `pool ${collectState.pool}/${collectState.poolSize}`
        : "pool ?";
      logQuest(
        `📦 +${freshActive.length} guild quests · total ${freshCollected.length} · ${poolInfo}`,
        "ok"
      );
    } else {
      logQuest(
        `⚠ collecte refusée : ${result?.error ?? "sans message"}`,
        "warn"
      );
    }
  } catch (error) {
    logQuest("❌ collecte exception: " + (error as Error).message, "bad");
  }
}

function ensureFarmPanelOpen(): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  const content = sheet?.querySelector<HTMLElement>("#autoFarmContent");
  if (!sheet || !content) return false;
  if (content.hidden) sheet.querySelector<HTMLButtonElement>(".farm-toggle")?.click();
  return !content.hidden;
}

function setAggroGroup(group: string): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return false;
  for (const row of sheet.querySelectorAll<HTMLElement>("[data-group]")) {
    const target = row.dataset.group === group ? "aggro" : "off";
    const btn = row.querySelector<HTMLButtonElement>(`[data-mode="${target}"]`);
    if (btn && btn.getAttribute("aria-checked") !== "true") btn.click();
  }
  const activeBtn = sheet.querySelector<HTMLButtonElement>(
    `[data-group="${group}"] [data-mode="aggro"]`,
  );
  return activeBtn?.getAttribute("aria-checked") === "true";
}

function startFarm(): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  const btn = sheet?.querySelector<HTMLButtonElement>(".farm-start");
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}

function stopFarm(): void {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet?.classList.contains("is-farming")) return;
  if (!ensureFarmPanelOpen()) return;
  const btn = sheet.querySelector<HTMLButtonElement>(".farm-close");
  if (btn?.textContent?.trim() === "Stop" && !btn.disabled) btn.click();
}

let savedAdvance: boolean | null = null;

function disableMoveOn(): void {
  const sheet = document.getElementById("autoFarmSheet");
  const sw = sheet?.querySelector<HTMLElement>('[data-switch="advance"]');
  if (!sw) return;
  const wasOn = sw.getAttribute("aria-checked") === "true";
  if (savedAdvance === null) savedAdvance = wasOn;
  if (wasOn) sw.click();
}

function restoreMoveOn(): void {
  if (savedAdvance === null) return;
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return;
  const sw = sheet.querySelector<HTMLElement>('[data-switch="advance"]');
  if (!sw) {
    savedAdvance = null;
    return;
  }
  const isOn = sw.getAttribute("aria-checked") === "true";
  if (savedAdvance && !isOn) sw.click();
  savedAdvance = null;
}

async function travelTo(coop: CoopLike, mapId: string): Promise<boolean> {
  if (!coop.travelToMap) return false;
  if (coop.localState?.()?.mapId === mapId) return true;
  try {
    const ok = await coop.travelToMap(mapId);
    if (!ok) return false;
  } catch (error) {
    logQuest("⚠ voyage " + mapId + " impossible: " + (error as Error).message, "warn");
    return false;
  }
  const start = Date.now();
  while (Date.now() - start < TRAVEL_WAIT_MS && !abort) {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (coop.localState?.()?.mapId === mapId) return true;
  }
  return false;
}

let running = false;
let abort = false;
let intervalId: number | null = null;

async function tryOneQuest(coop: CoopLike, quest: CoopQuest): Promise<boolean> {
  currentPhase = "traveling";
  currentQuestEnemy = quest.enemy ?? (quest.stat ? `guild:${quest.stat}` : "?");
  currentQuestMap = quest.mapId;

  const label = quest.enemy ?? `guild:${quest.stat}`;
  logQuest(`🚶 → ${quest.mapId} · ${label}`, "info");

  if (!(await travelTo(coop, quest.mapId))) {
    logQuest(`⚠ voyage ${quest.mapId} échoué`, "warn");
    return false;
  }
  await new Promise(resolve => setTimeout(resolve, 800));

  let stat: string | null = null;
  if (quest.stat) {
    stat = quest.stat;
  } else if (quest.enemy) {
    const def = ENEMY_TYPES[quest.enemy as keyof typeof ENEMY_TYPES];
    stat = def?.reward.type ?? null;
  }
  if (!stat) {
    logQuest(`⚠ stat introuvable pour ${label}`, "warn");
    return false;
  }
  if (!ensureFarmPanelOpen()) return false;
  const group = `stat:${stat}`;
  if (!setAggroGroup(group)) {
    logQuest(`⚠ groupe ${group} introuvable`, "warn");
    return false;
  }
  disableMoveOn();
  if (!startFarm()) {
    logQuest(`⚠ start farm refusé (${label})`, "warn");
    return false;
  }
  logQuest(`⛏ farm ${label} · ${group}`, "info");
  currentPhase = "farming";

  const deadline = Date.now() + QUEST_WAIT_MS;
  while (Date.now() < deadline && !abort) {
    await new Promise(resolve => setTimeout(resolve, TICK_MS));
    if (coop.localState?.()?.hp === 0) {
      logQuest("💀 mort pendant le farm", "warn");
      break;
    }
    const current = coop.weeklyQuests?.()?.quests.find(q => {
      if (q.mapId !== quest.mapId || q.target !== quest.target) return false;
      if (quest.enemy && q.enemy === quest.enemy) return true;
      if (quest.stat && q.stat === quest.stat) return true;
      return false;
    });
    if (current?.progress !== undefined && current.progress >= current.target) {
      currentPhase = "waiting";
      logQuest(`✅ ${label} terminée (${current.progress}/${current.target})`, "ok");
      return true;
    }
  }
  logQuest(`⏱ ${label} non finie en ${QUEST_WAIT_MS / 1000}s`, "warn");
  return false;
}

async function runLoop(coop: CoopLike): Promise<void> {
  running = true;
  abort = false;
  logQuest("▶ boucle démarrée", "ok");
  try {
    while (!abort && isAutoQuestEnabled()) {
      currentPhase = "scanning";
      const quests = activeQuests(coop);
      if (quests.length === 0) {
        currentPhase = "waiting";
        await tryCollectGuild(coop);
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      logQuest(`🔍 ${quests.length} quête(s) à farmer · cible: ${quests[0].enemy ?? `guild:${quests[0].stat}`}`, "info");
      const ok = await tryOneQuest(coop, quests[0]);
      if (ok) currentPhase = "waiting";
      if (!ok && !abort) await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    stopFarm();
    restoreMoveOn();
    currentPhase = "idle";
    running = false;
    logQuest("⏹ boucle terminée", "info");
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  const tick = () => {
    if (!isAutoQuestEnabled() || running) return;
    const coop = getCoop();
    if (!coop) {
      logQuest("⚠ coop indisponible", "warn");
      return;
    }
    void runLoop(coop).catch(error =>
      logQuest("❌ boucle interrompue: " + (error as Error).message, "bad")
    );
  };
  intervalId = window.setInterval(tick, POLL_INTERVAL_MS);
  tick();
}

function stopPolling(): void {
  abort = true;
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  const stateMap: Record<QuestPhase, string> = {
    idle: "Off",
    scanning: "Recherche de quêtes…",
    traveling: `Voyage vers ${currentQuestMap}`,
    farming: `Farm ${currentQuestEnemy}`,
    waiting: "En attente",
  };
  const stateLine = document.createElement("div");
  stateLine.style.cssText = "margin-bottom:4px;font-weight:600;color:#b7c5b7;";
  const sheet = document.getElementById("autoFarmSheet");
  const sw = sheet?.querySelector<HTMLElement>('[data-switch="advance"]');
  const advanceState = sw
    ? `advance=${sw.getAttribute("aria-checked") ?? "?"}`
    : "advance=ABSENT";
  stateLine.textContent = (isAutoQuestEnabled() ? stateMap[currentPhase] : "Désactivé") + " · " + advanceState;
  wrap.append(stateLine);

  // Pool status (lu depuis le cache du dernier loadGuild)
  if (lastKnownCollectState) {
    const poolLine = document.createElement("div");
    poolLine.style.cssText =
      "font-size:9px;margin:2px 0;padding:2px 4px;border-radius:3px;" +
      "background:rgba(0,0,0,.25);" +
      "color:" + (lastKnownCollectState.ready ? "#69e56f" : "#ffd85b") + ";";
    poolLine.textContent =
      `📦 pool ${lastKnownCollectState.pool}/${lastKnownCollectState.poolSize} · ` +
      `ready=${lastKnownCollectState.ready}`;
    wrap.append(poolLine);
  }

  const guildRow = document.createElement("label");
  guildRow.style.cssText =
    "display:flex;align-items:center;gap:4px;margin:4px 0;font-size:10px;cursor:pointer;";
  const guildCheckbox = document.createElement("input");
  guildCheckbox.type = "checkbox";
  guildCheckbox.checked = isCollectGuildEnabled();
  guildCheckbox.addEventListener("change", () => setCollectGuildEnabled(guildCheckbox.checked));
  guildRow.append(guildCheckbox, document.createTextNode("Collect guild quests"));
  wrap.append(guildRow);

  const coop = getCoop();
  const quests = coop ? activeQuests(coop) : [];
  if (quests.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "opacity:.75;font-size:10px;line-height:1.4;";
    const data = coop?.weeklyQuests?.();
    const perso = data?.quests.filter(q => !q.from) ?? [];
    const guild = data?.quests.filter(q => q.from) ?? [];
    const persoDone = perso.filter(q => q.progress >= q.target).length;
    const guildDone = guild.filter(q => q.progress >= q.target).length;
    if (perso.length > 0 && persoDone === perso.length) {
      empty.textContent =
        `✓ ${persoDone}/${perso.length} perso terminées · ` +
        `${guildDone}/${guild.length} guild finies · ` +
        `collecte ${isCollectGuildEnabled() ? "active" : "désactivée"}`;
    } else {
      empty.textContent = "Aucune quête active";
    }
    wrap.append(empty);
  } else {
    for (const quest of quests) {
      const isCurrent = currentPhase === "farming"
        && (quest.enemy ? quest.enemy === currentQuestEnemy : `guild:${quest.stat}` === currentQuestEnemy)
        && quest.mapId === currentQuestMap;
      const row = document.createElement("div");
      row.style.cssText =
        "padding:2px 0;font-size:10px;line-height:1.3;" +
        (isCurrent ? "color:#69e56f;" : "");
      const line1 = document.createElement("div");
      line1.style.cssText = "display:flex;justify-content:space-between;gap:6px;";
      const name = document.createElement("span");
      const label = quest.enemy ?? (quest.stat ? `guild ${quest.stat}` : "?");
      name.textContent = (isCurrent ? "▶ " : "") + label;
      name.style.fontWeight = isCurrent ? "700" : "500";
      const progress = document.createElement("span");
      progress.style.opacity = ".85";
      progress.textContent = `${quest.progress}/${quest.target}`;
      line1.append(name, progress);
      const line2 = document.createElement("div");
      line2.style.cssText = `opacity:.6;font-size:9px;padding-left:${isCurrent ? "12px" : "0"}`;
      const stat = quest.enemy
        ? (ENEMY_TYPES[quest.enemy as keyof typeof ENEMY_TYPES]?.reward.type ?? "?")
        : (quest.stat ?? "?");
      line2.textContent = `${quest.mapId} · ${stat}`;
      row.append(line1, line2);
      wrap.append(row);
    }
  }

  // ─── Fenêtre de log ───────────────────────────────────────────────────
  if (questLogs.length > 0) {
    const logs = document.createElement("div");
    logs.style.cssText =
      "margin-top:6px;max-height:130px;overflow-y:auto;" +
      "background:rgba(0,0,0,.3);padding:3px;border-radius:3px;" +
      "font-size:9px;line-height:1.35;font-family:monospace;";
    for (const l of questLogs.slice(-LOG_DISPLAY)) {
      const line = document.createElement("div");
      line.textContent = `[${l.ts}] ${l.msg}`;
      line.style.color =
        l.cls === "ok" ? "#69e56f"
        : l.cls === "warn" ? "#ffd85b"
        : l.cls === "bad" ? "#ff6767"
        : "#8aa8c8";
      logs.append(line);
    }
    wrap.append(logs);
  }

  // Bouton "Copier log"
  const btnCopy = document.createElement("button");
  btnCopy.textContent = "📋 Copier log";
  btnCopy.style.cssText =
    "margin-top:4px;padding:3px 6px;font:inherit;cursor:pointer;" +
    "background:rgba(116,216,255,.22);color:inherit;border:0;" +
    "border-radius:3px;font-size:10px;width:100%;";
  btnCopy.addEventListener("click", async () => {
    if (questLogs.length === 0) return;
    const header =
      "=== DIAG AUTO-QUEST ===\n" +
      "Timestamp: " + new Date().toISOString() + "\n" +
      "Phase: " + currentPhase + "\n" +
      "Current: " + (currentQuestEnemy || "-") + " @ " + (currentQuestMap || "-") + "\n" +
      "Pool: " + (lastKnownCollectState ? `${lastKnownCollectState.pool}/${lastKnownCollectState.poolSize} ready=${lastKnownCollectState.ready}` : "?") + "\n" +
      "--- LOGS ---\n";
    const body = questLogs.map(l => `[${l.ts}] (${l.cls}) ${l.msg}`).join("\n");
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

export function registerAutoQuestMod(): void {
  REGISTERED_MODS.push({
    id: "quest-auto-quest",
    name: "Auto Quest",
    category: "QUEST",
    switch: {
      label: "On",
      get: isAutoQuestEnabled,
      set: value => {
        try {
          localStorage.setItem(STORAGE_KEY, String(value));
        } catch (error) {
          logQuest("⚠ enregistrement du réglage impossible: " + (error as Error).message, "warn");
        }
        if (value) {
          questLogs = [];  // session fraîche
          startPolling();
        } else {
          stopPolling();
        }
      },
    },
    status: { render: renderStatus, intervalMs: 1_500 },
    install: () => {
      if (isAutoQuestEnabled()) startPolling();
    },
  });
}