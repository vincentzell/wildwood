// mods/quest-auto-quest.ts
import { ENEMY_TYPES } from "../src/game/enemies";
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-quest-enabled";
const COLLECT_GUILD_KEY = "wildwood-mod-auto-quest-collect-guild-enabled";
const POLL_INTERVAL_MS = 10_000;
const GUILD_RETRY_COOLDOWN_MS = 60_000;
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
  localIdentity?: () => string;
  guild?: {
    guildAction?: (
      action: { kind: string; identity: string },
    ) => Promise<{ ok?: boolean; error?: string }>;
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
}

export function isAutoQuestEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch (error) {
    console.warn("[mod-auto-quest] lecture du réglage impossible", error);
    return false;
  }
}

function activeQuests(coop: CoopLike): CoopQuest[] {
  const data = coop.weeklyQuests?.();
  if (!data?.quests) return [];
  // FIX: on farme les DEUX types de quêtes :
  //  - perso  (from undefined) : tes quêtes hebdo individuelles
  //  - guild  (from set)       : les quêtes collectées dans le pool de guilde
  //
  // Sans ça, après une collecte, les quêtes collectées restent non terminées
  // (le mod ne les voit pas), et le serveur refuse toute nouvelle collecte
  // avec "Finish some of your 15 collected quests first".
  //
  // On skip uniquement les quêtes déjà prises par un autre joueur.
  return data.quests.filter(q => q.progress < q.target && !q.takenBy);
}

async function tryCollectGuild(coop: CoopLike): Promise<void> {
  if (!isCollectGuildEnabled()) return;
  if (Date.now() - lastGuildAttemptTs < GUILD_RETRY_COOLDOWN_MS) return;
  const data = coop.weeklyQuests?.();
  if (!data?.quests || !data.guildName) return;
  const perso = data.quests.filter(quest => !quest.from);
  const collected = data.quests.filter(quest => quest.from);
  // FIX: ne pas tenter la collecte si on est déjà à 15/15.
  // Le serveur renverrait "Finish some of your 15 collected quests first".
  // Comme activeQuests farme maintenant les guild quests, elles vont
  // se terminer avec le temps et libéreront le slot naturellement.
  if (collected.length >= 15) return;
  if (perso.length === 0) return;
  const allDone = perso.every(quest => quest.progress >= quest.target);
  if (!allDone) return;
  const identity = coop.localIdentity?.();
  if (!identity || !coop.guild?.guildAction) return;

  lastGuildAttemptTs = Date.now();
  try {
    const result = await coop.guild.guildAction({ kind: "collectQuests", identity });
    if (result?.ok) {
      console.info(`[mod-auto-quest] guild quests collectées (${collected.length}/15)`);
    } else {
      console.warn(`[mod-auto-quest] collecte guild refusée : ${result?.error ?? "sans message"}`);
    }
  } catch (error) {
    console.warn("[mod-auto-quest] collecte guild exception", error);
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

  const def = ENEMY_TYPES[quest.enemy as keyof typeof ENEMY_TYPES];
  const stat = def?.reward.type;
  if (!stat) {
    console.warn(`[mod-auto-quest] stat introuvable pour ${quest.enemy}`);
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
        await tryCollectGuild(coop);
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
  const sheet = document.getElementById("autoFarmSheet");
  const sw = sheet?.querySelector<HTMLElement>('[data-switch="advance"]');
  const advanceState = sw
    ? `advance=${sw.getAttribute("aria-checked") ?? "?"}`
    : "advance=ABSENT";
  stateLine.textContent = (isAutoQuestEnabled() ? stateMap[currentPhase] : "Désactivé") + " · " + advanceState;
  wrap.append(stateLine);

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
    if (perso.length > 0 && persoDone === perso.length) {
      empty.textContent =
        `✓ ${persoDone}/${perso.length} perso terminées · ` +
        `${guild.length} guild quests · collecte ${isCollectGuildEnabled() ? "active" : "désactivée"}`;
    } else {
      empty.textContent = "Aucune quête active";
    }
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
    const stat = ENEMY_TYPES[quest.enemy as keyof typeof ENEMY_TYPES]?.reward.type ?? "?";
    line2.textContent = `${quest.mapId} · ${stat}`;
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
