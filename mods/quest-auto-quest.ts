// mods/quest-auto-quest.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-quest-enabled";
const POLL_INTERVAL_MS = 10_000;
const QUEST_WAIT_MS = 60_000;
const TRAVEL_WAIT_MS = 15_000;
const TICK_MS = 2_000;

type QuestPhase = "idle" | "scanning" | "traveling" | "farming" | "waiting";

let currentPhase: QuestPhase = "idle";
let currentQuestEnemy = "";
let currentQuestMap = "";

type CoopQuest = {
  mapId: string;
  enemy: string;
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

type CoopLike = {
  weeklyQuests?: () => WeeklyQuestState | null;
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

export function isAutoQuestEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch (error) {
    console.warn("[mod-auto-quest] lecture du réglage impossible", error);
    return false;
  }
}

const STAT_COLORS: Record<string, string> = {
  "rgb(255, 101, 90)": "damage",
  "rgb(102, 237, 121)": "health",
  "rgb(255, 224, 93)": "speed",
  "rgb(116, 216, 255)": "armor",
  "rgb(255, 124, 203)": "regen",
  "rgb(255, 154, 77)": "crit",
};

function statFromTracker(enemy: string): string | null {
  const items = document.querySelectorAll<HTMLLIElement>(".quest-tracker-item");
  for (const item of items) {
    const name = item.querySelector(".quest-tracker-enemy")?.textContent?.trim();
    if (name !== enemy) continue;
    const statEl = item.querySelector<HTMLElement>(".quest-tracker-stat");
    if (!statEl) return null;
    const color = statEl.style.color;
    if (color && STAT_COLORS[color]) return STAT_COLORS[color];
    const label = (statEl.textContent ?? "").toLowerCase();
    if (label.includes("damage")) return "damage";
    if (label.includes("max health") || label.includes("health")) return "health";
    if (label.includes("attack speed") || label.includes("speed")) return "speed";
    if (label.includes("armor")) return "armor";
    if (label.includes("regen") || label.includes("hp/sec")) return "regen";
    if (label.includes("crit")) return "crit";
    return null;
  }
  return null;
}

function activeQuests(coop: CoopLike): CoopQuest[] {
  const data = coop.weeklyQuests?.();
  if (!data?.quests) return [];
  return data.quests.filter(q => q.progress < q.target && !q.takenBy && !q.from);
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

async function waitForStat(enemy: string): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < 2_000 && !abort) {
    const stat = statFromTracker(enemy);
    if (stat) return stat;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

async function travelTo(coop: CoopLike, mapId: string): Promise<boolean> {
  if (!coop.travelToMap) return false;
  if (coop.localState?.()?.mapId === mapId) return true;
  try {
    const ok = await coop.travelToMap(mapId);
    if (!ok) return false;
  } catch (error) {
    console.warn(`[mod-auto-quest] voyage vers ${mapId} impossible`, error);
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
  currentQuestEnemy = quest.enemy;
  currentQuestMap = quest.mapId;
  if (!(await travelTo(coop, quest.mapId))) {
    console.warn(`[mod-auto-quest] voyage vers ${quest.mapId} échoué`);
    return false;
  }
  await new Promise(resolve => setTimeout(resolve, 800));

  const stat = await waitForStat(quest.enemy);
  if (!stat) {
    if (!abort) console.warn(`[mod-auto-quest] stat introuvable pour ${quest.enemy}`);
    return false;
  }
  if (!ensureFarmPanelOpen()) return false;
  const group = `stat:${stat}`;
  if (!setAggroGroup(group)) {
    console.warn(`[mod-auto-quest] groupe ${group} introuvable`);
    return false;
  }
  disableMoveOn();
  if (!startFarm()) {
    console.warn("[mod-auto-quest] démarrage du farm refusé");
    return false;
  }
  currentPhase = "farming";

  const deadline = Date.now() + QUEST_WAIT_MS;
  while (Date.now() < deadline && !abort) {
    await new Promise(resolve => setTimeout(resolve, TICK_MS));
    if (coop.localState?.()?.hp === 0) break;
    const current = coop.weeklyQuests?.()?.quests.find(q =>
      q.mapId === quest.mapId && q.enemy === quest.enemy && q.target === quest.target,
    );
    if (current?.progress !== undefined && current.progress >= current.target) {
      currentPhase = "waiting";
      return true;
    }
  }
  return false;
}

async function runLoop(coop: CoopLike): Promise<void> {
  running = true;
  abort = false;
  try {
    while (!abort && isAutoQuestEnabled()) {
      currentPhase = "scanning";
      const quests = activeQuests(coop);
      if (quests.length === 0) {
        currentPhase = "waiting";
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        continue;
      }
      const ok = await tryOneQuest(coop, quests[0]);
      if (ok) currentPhase = "waiting";
      if (!ok && !abort) await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    stopFarm();
    restoreMoveOn();
    currentPhase = "idle";
    running = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  const tick = () => {
    if (!isAutoQuestEnabled() || running) return;
    const coop = getCoop();
    if (!coop) return;
    void runLoop(coop).catch(error => console.error("[mod-auto-quest] boucle interrompue", error));
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
  stateLine.textContent = isAutoQuestEnabled() ? stateMap[currentPhase] : "Désactivé";
  wrap.append(stateLine);

  const coop = getCoop();
  const quests = coop ? activeQuests(coop) : [];
  if (quests.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "opacity:.55;font-size:10px;";
    empty.textContent = "Aucune quête active";
    wrap.append(empty);
    return wrap;
  }

  for (const quest of quests) {
    const isCurrent = currentPhase === "farming"
      && quest.enemy === currentQuestEnemy
      && quest.mapId === currentQuestMap;
    const row = document.createElement("div");
    row.style.cssText =
      "padding:2px 0;font-size:10px;line-height:1.3;" +
      (isCurrent ? "color:#69e56f;" : "");
    const line1 = document.createElement("div");
    line1.style.cssText = "display:flex;justify-content:space-between;gap:6px;";
    const name = document.createElement("span");
    name.textContent = (isCurrent ? "▶ " : "") + quest.enemy;
    name.style.fontWeight = isCurrent ? "700" : "500";
    const progress = document.createElement("span");
    progress.style.opacity = ".85";
    progress.textContent = `${quest.progress}/${quest.target}`;
    line1.append(name, progress);
    const line2 = document.createElement("div");
    line2.style.cssText = `opacity:.6;font-size:9px;padding-left:${isCurrent ? "12px" : "0"}`;
    line2.textContent = `${quest.mapId} · ${statFromTracker(quest.enemy) ?? "?"}`;
    row.append(line1, line2);
    wrap.append(row);
  }
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
          console.warn("[mod-auto-quest] enregistrement du réglage impossible", error);
        }
        if (value) startPolling();
        else stopPolling();
      },
    },
    status: { render: renderStatus, intervalMs: 1_500 },
    install: () => {
      if (isAutoQuestEnabled()) startPolling();
    },
  });
}
