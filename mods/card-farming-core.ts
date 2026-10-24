// mods/card-farming-core.ts
import { CARDS } from "../shared/cards";
import { ENEMY_TYPES } from "../src/game/enemies";

export type CardDef = {
  id: string;
  enemy: string;
  mapId: string;
  rarity: string;
  slot?: string;
  endless?: { from: number; to?: number };
};

export type CoopLike = {
  cards?: () => Readonly<Record<string, number>>;
  travelToMap?: (mapId: string) => Promise<boolean>;
  localState?: () => { mapId?: string } | null;
  proceduralCompleted?: () => number;
  activeCardStats?: () => { cardHunter?: number };
};

const KILL_STORAGE_PREFIX = "wildstat-enemy-defeats-v2:";
const CARD_DROP_OUTCOMES: Record<string, number> = { regular: 1000, elite: 2000, boss: 100 };
const CARD_METER_MULTIPLE = 2;

export function getCoop(): CoopLike | null {
  const w = window as unknown as { wildstatCoop?: CoopLike; wildwoodCoop?: CoopLike };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function loadTargetList(key: string): string[] {
  try { return (localStorage.getItem(key) ?? "").split(",").map(s => s.trim()).filter(Boolean); }
  catch { return []; }
}

export function saveTargetList(key: string, ids: string[]): void {
  try { localStorage.setItem(key, ids.join(",")); } catch { /* Storage may be unavailable. */ }
}

export function loadCopies(key: string): number {
  try {
    const value = Number.parseInt(localStorage.getItem(key) ?? "1", 10);
    return value > 0 ? value : 1;
  } catch { return 1; }
}

export function saveCopies(key: string, copies: number): void {
  try { localStorage.setItem(key, String(copies)); } catch { /* Storage may be unavailable. */ }
}

export function setFlag(key: string, on: boolean): void {
  try { localStorage.setItem(key, String(on)); } catch { /* Storage may be unavailable. */ }
}

export function ownedOf(coop: CoopLike, cardId: string): number {
  return coop.cards?.()?.[cardId] ?? 0;
}

export function statOf(enemy: string): string | null {
  const def = (ENEMY_TYPES as Record<string, { reward?: { type?: string } }>)[enemy];
  return def?.reward?.type ?? null;
}

export function missingCards(coop: CoopLike, copies: number): CardDef[] {
  return (CARDS as readonly CardDef[]).filter(card =>
    card.mapId !== "timberwood" && ownedOf(coop, card.id) < copies
  );
}

export function targetMapFor(coop: CoopLike, card: CardDef): string | null {
  if (card.mapId === "timberwood") return null;
  if (card.mapId !== "endless") return card.mapId;
  if (!card.endless) return null;
  const completed = coop.proceduralCompleted?.() ?? 0;
  if (card.endless.from > completed + 1) return null;
  return `endless_${card.endless.from}`;
}

export function bossCardIdForMap(mapId: string): string | null {
  for (const card of CARDS as readonly CardDef[]) {
    if (card.rarity === "boss" && card.mapId === mapId) return card.id;
  }
  return null;
}

export function cardIdForEnemy(enemy: string): string | null {
  for (const card of CARDS as readonly CardDef[]) {
    if (card.enemy === enemy && card.rarity !== "boss") return card.id;
  }
  return null;
}

type PityMap = Record<string, number>;

function loadPity(key: string): PityMap {
  try { return JSON.parse(localStorage.getItem(key) ?? "{}") as PityMap; }
  catch { return {}; }
}

function savePity(key: string, pity: PityMap): void {
  try { localStorage.setItem(key, JSON.stringify(pity)); } catch { /* Storage may be unavailable. */ }
}

export function pityPct(key: string, cardId: string, rarity: string): number | null {
  const outcomes = CARD_DROP_OUTCOMES[rarity];
  if (!outcomes) return null;
  const pity = loadPity(key);
  return Math.min(100, ((pity[cardId] ?? 0) / (outcomes * CARD_METER_MULTIPLE)) * 100);
}

let hookInstalled = false;
let originalSetItem: Storage["setItem"] | null = null;
const seenBatches = new Map<string, Record<string, number>>();
let pityKeyRef = "";
let hunterRef: (() => number) | null = null;

export function installStorageHook(pityKey: string, cardHunter: () => number): void {
  if (hookInstalled) {
    pityKeyRef = pityKey;
    hunterRef = cardHunter;
    return;
  }
  hookInstalled = true;
  pityKeyRef = pityKey;
  hunterRef = cardHunter;
  originalSetItem = Storage.prototype.setItem;
  const original = originalSetItem;
  Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
    try {
      if (typeof key === "string" && key.startsWith(KILL_STORAGE_PREFIX) && typeof value === "string") {
        const state = JSON.parse(value) as {
          streamId?: string;
          batches?: Array<{ mapId?: string; sequence?: number; enemies?: Array<{ enemy?: string; count?: number }> }>;
        };
        if (state?.streamId && Array.isArray(state.batches)) {
          const bonus = 1 + Math.max(0, hunterRef?.() ?? 0);
          const pity = loadPity(pityKeyRef);
          let dirty = false;
          for (const batch of state.batches) {
            if (!batch || !Array.isArray(batch.enemies)) continue;
            const signature = `${state.streamId}:${batch.sequence ?? 0}`;
            const previous = seenBatches.get(signature) ?? {};
            const next: Record<string, number> = {};
            for (const entry of batch.enemies) {
              if (!entry || typeof entry.enemy !== "string") continue;
              const count = entry.count ?? 0;
              next[entry.enemy] = count;
              const previousCount = previous[entry.enemy] ?? 0;
              if (count > previousCount) {
                const bossCard = entry.enemy === "boss" && batch.mapId
                  ? bossCardIdForMap(batch.mapId) : null;
                const cardId = bossCard ?? cardIdForEnemy(entry.enemy);
                if (cardId) {
                  pity[cardId] = (pity[cardId] ?? 0) + (count - previousCount) * bonus;
                  dirty = true;
                }
              }
            }
            seenBatches.set(signature, next);
          }
          if (dirty) savePity(pityKeyRef, pity);
          if (seenBatches.size > 500) {
            const recent = Array.from(seenBatches.entries()).slice(-200);
            seenBatches.clear();
            for (const [signature, counts] of recent) seenBatches.set(signature, counts);
          }
        }
      }
    } catch { /* Ignore malformed persisted kill data; preserve the storage write. */ }
    original!.call(this, key, value);
  };
}

export function uninstallStorageHook(): void {
  if (!hookInstalled || !originalSetItem) return;
  Storage.prototype.setItem = originalSetItem;
  hookInstalled = false;
  originalSetItem = null;
  pityKeyRef = "";
  hunterRef = null;
  seenBatches.clear();
}

export function resetPity(key: string, cardId: string): void {
  const pity = loadPity(key);
  if (pity[cardId]) { pity[cardId] = 0; savePity(key, pity); }
}

function sheet(): HTMLElement | null {
  return document.getElementById("autoFarmSheet");
}

export function ensurePanelOpen(): boolean {
  const panel = sheet();
  if (!panel) return false;
  const content = panel.querySelector<HTMLElement>("#autoFarmContent");
  if (!content || content.hidden) panel.querySelector<HTMLButtonElement>(".farm-toggle")?.click();
  return true;
}

export function setAggroGroups(groups: Set<string>): void {
  const s = sheet();
  if (!s) return;

  for (const row of s.querySelectorAll<HTMLElement>("[data-group]")) {
    const offBtn = row.querySelector<HTMLButtonElement>('[data-mode="off"]');
    if (offBtn && offBtn.getAttribute("aria-checked") !== "true") offBtn.click();
  }

  let maxAggro = 99;
  const aggText = s.textContent?.match(/Aggro \d+\/(\d+)/);
  if (aggText) maxAggro = parseInt(aggText[1], 10);

  let count = 0;
  for (const row of s.querySelectorAll<HTMLElement>("[data-group]")) {
    if (count >= maxAggro) break;
    const group = row.dataset.group;
    if (group && groups.has(group)) {
      const aggroBtn = row.querySelector<HTMLButtonElement>('[data-mode="aggro"]');
      if (aggroBtn && !aggroBtn.disabled && aggroBtn.getAttribute("aria-checked") !== "true") {
        aggroBtn.click();
        count++;
      }
    }
  }
}

function setTarget(mode: "closest" | "strongest" | "lowest"): void {
  const s = sheet();
  if (!s) return;
  const label = mode === "strongest" ? "Strongest" : mode === "lowest" ? "Lowest HP" : "Closest";
  const btns = Array.from(s.querySelectorAll("button"));
  const targetBtn = btns.find(button => button.textContent?.trim() === label);
  if (targetBtn) targetBtn.click();
}

function moveOnSwitch(): HTMLElement | null {
  return sheet()?.querySelector<HTMLElement>('[data-switch="advance"]') ?? null;
}

export function getMoveOnState(): boolean | null {
  const switchElement = moveOnSwitch();
  return switchElement ? switchElement.getAttribute("aria-checked") === "true" : null;
}

export function setMoveOn(on: boolean): void {
  const switchElement = moveOnSwitch();
  if (!switchElement) return;
  const isOn = switchElement.getAttribute("aria-checked") === "true";
  if (on !== isOn) switchElement.click();
}

export function startFarm(): boolean {
  const panel = sheet();
  if (!panel) return false;
  if (panel.classList.contains("is-farming")) return true;
  const button = panel.querySelector<HTMLButtonElement>(".farm-start");
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

export function stopFarm(): void {
  const panel = sheet();
  if (!panel) return;
  const button = panel.querySelector<HTMLButtonElement>(".farm-close");
  if (button && !button.disabled && /stop/i.test(button.textContent ?? "")) button.click();
}

export async function travelTo(coop: CoopLike, mapId: string, waitMs = 15_000): Promise<boolean> {
  if (coop.localState?.()?.mapId === mapId) return true;
  if (!coop.travelToMap) return false;
  try {
    if (!(await coop.travelToMap(mapId))) return false;
  } catch {
    return false;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitMs) {
    await new Promise(resolve => window.setTimeout(resolve, 300));
    if (coop.localState?.()?.mapId === mapId) return true;
  }
  return false;
}

export type RunnerOptions = {
  getId: () => string;
  getCopies: () => number;
  getPityKey: () => string;
  getBossFlagKey: () => string;
  selectMaps: (coop: CoopLike) => Map<string, CardDef[]>;
};

export type RunnerPhase = "idle" | "traveling" | "mobs" | "done";

export type Runner = {
  start: () => void;
  stop: () => void;
  getPhase: () => RunnerPhase;
  getCurrentMap: () => string;
  getCurrentCards: () => CardDef[];
  getMoveOnSaved: () => boolean | null;
  getLastError: () => string;
};

const POLL_MS = 5_000;
const ERROR_COOLDOWN_MS = 30_000;
let activeRunner: { id: string; stop: () => void } | null = null;

export function createRunner(options: RunnerOptions): Runner {
  let phase: RunnerPhase = "idle";
  let currentMap = "";
  let currentCards: CardDef[] = [];
  let intervalId: number | null = null;
  let tickInProgress = false;
  let lastErrorTs = 0;
  let lastErrorMessage = "";
  let savedMoveOn: boolean | null = null;
  let generation = 0;
  const lastOwned: Record<string, number> = {};
  const runnerId = options.getId();

  function saveMoveOn(): void {
    if (savedMoveOn !== null) return;
    const state = getMoveOnState();
    if (state !== null) savedMoveOn = state;
  }

  function restoreMoveOn(): void {
    if (savedMoveOn === null) return;
    setMoveOn(savedMoveOn);
    savedMoveOn = null;
  }

  function cleanupFarm(): void {
    setFlag(options.getBossFlagKey(), false);
    stopFarm();
  }

  async function startMobsPhase(coop: CoopLike, cards: CardDef[]): Promise<void> {
    phase = "mobs";
    // Move On must stay off so Auto Farm remains in its farm phase.
    setMoveOn(false);
    setFlag(options.getBossFlagKey(), false);
    const bossMissing = cards.some(card => card.rarity === "boss");
    setTarget(bossMissing ? "strongest" : "closest");
    const groups = new Set<string>();
    for (const card of cards) {
      if (card.rarity === "boss") continue;
      const stat = statOf(card.enemy);
      if (stat) groups.add(`stat:${stat}`);
    }
    setAggroGroups(groups);
    if (!startFarm()) {
      lastErrorTs = Date.now();
      lastErrorMessage = "démarrage du farm mobs refusé";
      return;
    }
    lastErrorTs = 0;
    lastErrorMessage = "";
    void coop;
  }

  async function tickMap(coop: CoopLike, mapId: string, cards: CardDef[], tickGeneration: number): Promise<void> {
    phase = "traveling";
    setFlag(options.getBossFlagKey(), false);
    if (!(await travelTo(coop, mapId))) {
      lastErrorTs = Date.now();
      lastErrorMessage = `voyage vers ${mapId} échoué`;
      return;
    }
    if (tickGeneration !== generation) return;
    await new Promise(resolve => window.setTimeout(resolve, 800));
    if (tickGeneration !== generation) return;
    if (!ensurePanelOpen()) {
      lastErrorTs = Date.now();
      lastErrorMessage = "panneau auto-farm indisponible";
      return;
    }
    currentMap = mapId;
    currentCards = cards;
    for (const card of cards) lastOwned[card.id] = ownedOf(coop, card.id);
    await startMobsPhase(coop, cards);
  }

  async function tick(): Promise<void> {
    if (tickInProgress || lastErrorTs > 0 && Date.now() - lastErrorTs < ERROR_COOLDOWN_MS) return;
    tickInProgress = true;
    const tickGeneration = generation;
    try {
      const coop = getCoop();
      if (!coop) return;
      const copies = options.getCopies();
      const maps = options.selectMaps(coop);

      if (currentCards.length > 0) {
        for (const card of currentCards) {
          const previous = lastOwned[card.id] ?? 0;
          const current = ownedOf(coop, card.id);
          lastOwned[card.id] = current;
          if (current > previous) resetPity(options.getPityKey(), card.id);
        }
        const stillMissing = currentCards.filter(card => ownedOf(coop, card.id) < copies);
        if (stillMissing.length === 0) {
          cleanupFarm();
          currentCards = [];
          currentMap = "";
        } else {
          currentCards = stillMissing;
          if (phase === "mobs") {
            const groups = new Set<string>();
            for (const card of stillMissing) {
              if (card.rarity === "boss") continue;
              const stat = statOf(card.enemy);
              if (stat) groups.add(`stat:${stat}`);
            }
            setAggroGroups(groups);
          }
          return;
        }
      }

      if (maps.size === 0) {
        phase = "done";
        cleanupFarm();
        currentCards = [];
        currentMap = "";
        return;
      }
      const next = maps.entries().next().value;
      if (!next) return;
      const [mapId, cards] = next;
      await tickMap(coop, mapId, cards, tickGeneration);
    } finally {
      tickInProgress = false;
    }
  }

  let runner!: Runner;
  runner = {
    start: () => {
      if (intervalId !== null) return;
      if (activeRunner && activeRunner.id !== runnerId) activeRunner.stop();
      activeRunner = { id: runnerId, stop: runner.stop };
      saveMoveOn();
      setMoveOn(false);
      intervalId = window.setInterval(() => {
        void tick().catch(error => console.error(`[mod-auto-card:${runnerId}] tick failed`, error));
      }, POLL_MS);
      void tick().catch(error => console.error(`[mod-auto-card:${runnerId}] tick failed`, error));
    },
    stop: () => {
      const ownsFarm = intervalId !== null || activeRunner?.id === runnerId;
      generation++;
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
      if (ownsFarm) cleanupFarm();
      if (ownsFarm) restoreMoveOn();
      phase = "idle";
      currentMap = "";
      currentCards = [];
      lastErrorTs = 0;
      lastErrorMessage = "";
      if (activeRunner?.id === runnerId) activeRunner = null;
    },
    getPhase: () => phase,
    getCurrentMap: () => currentMap,
    getCurrentCards: () => currentCards,
    getMoveOnSaved: () => savedMoveOn,
    getLastError: () => lastErrorMessage,
  };
  return runner;
}
