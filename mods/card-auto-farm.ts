// mods/card-auto-farm.ts
import { REGISTERED_MODS } from "./registry";
import { CARDS } from "../shared/cards";
import { ENEMY_TYPES } from "../src/game/enemies";

const STORAGE_KEY = "wildwood-mod-auto-card-enabled";
const REPEAT_FLAG = "wildwood-mod-auto-card-boss-mode";
const PITY_KEY = "wildwood-mod-auto-card-pity";
const KILL_STORAGE_PREFIX = "wildstat-enemy-defeats-v2:";
const CARD_DROP_OUTCOMES: Record<string, number> = { regular: 1000, elite: 2000, boss: 100 };
const CARD_METER_MULTIPLE = 2;
const POLL_MS = 5_000;
const TICK_MS = 2_500;
const TRAVEL_WAIT_MS = 15_000;
const ERROR_COOLDOWN_MS = 30_000;

type CardDef = {
  id: string;
  enemy: string;
  mapId: string;
  rarity: string;
  slot?: string;
  endless?: { from: number; to?: number };
};

type CoopLike = {
  cards?: () => Readonly<Record<string, number>>;
  travelToMap?: (mapId: string) => Promise<boolean>;
  localState?: () => { mapId?: string } | null;
  proceduralCompleted?: () => number;
  activeCardStats?: () => { cardHunter?: number };
};

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function isAutoCardEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

function setRepeatBoss(on: boolean): void {
  try { localStorage.setItem(REPEAT_FLAG, String(on)); }
  catch { /* idem */ }
}

// ─── Pity tracker ────────────────────────────────────────────

type PityMap = Record<string, number>;

function loadPity(): PityMap {
  try { return JSON.parse(localStorage.getItem(PITY_KEY) ?? "{}") as PityMap; }
  catch { return {}; }
}

function savePity(m: PityMap): void {
  try { localStorage.setItem(PITY_KEY, JSON.stringify(m)); } catch { /* idem */ }
}

function cardHunterBonus(): number {
  try {
    return Math.max(0, getCoop()?.activeCardStats?.()?.cardHunter ?? 0);
  } catch { return 0; }
}

function bumpPity(cardId: string, killed: number): void {
  if (killed <= 0) return;
  const m = loadPity();
  m[cardId] = (m[cardId] ?? 0) + killed * (1 + cardHunterBonus());
  savePity(m);
}

function resetPity(cardId: string): void {
  const m = loadPity();
  if (m[cardId]) { m[cardId] = 0; savePity(m); }
}

function pityPct(cardId: string, rarity: string): number | null {
  const outcomes = CARD_DROP_OUTCOMES[rarity];
  if (!outcomes) return null;
  const m = loadPity();
  return Math.min(100, ((m[cardId] ?? 0) / (outcomes * CARD_METER_MULTIPLE)) * 100);
}

function cardIdForEnemy(enemy: string): string | null {
  for (const c of CARDS as readonly CardDef[]) {
    if (c.enemy === enemy && c.rarity !== "boss") return c.id;
  }
  return null;
}

function bossCardIdForMap(mapId: string): string | null {
  for (const c of CARDS as readonly CardDef[]) {
    if (c.rarity === "boss" && c.mapId === mapId) return c.id;
  }
  return null;
}

// ─── Hook Storage.setItem pour compter les kills ─────────────

let storageHookInstalled = false;
let originalSetItem: Storage["setItem"] | null = null;
const seenBatches = new Map<string, Record<string, number>>();

function installStorageHook(): void {
  if (storageHookInstalled) return;
  storageHookInstalled = true;
  originalSetItem = Storage.prototype.setItem;
  const orig = originalSetItem;
  Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
    try {
      if (typeof key === "string" && key.startsWith(KILL_STORAGE_PREFIX) && typeof value === "string") {
        const state = JSON.parse(value) as {
          streamId?: string;
          batches?: Array<{
            mapId?: string;
            sequence?: number;
            enemies?: Array<{ enemy?: string; count?: number }>;
          }>;
        };
        if (state && state.streamId && Array.isArray(state.batches)) {
          for (const batch of state.batches) {
            if (!batch || !Array.isArray(batch.enemies)) continue;
            const sig = `${state.streamId}:${batch.sequence ?? 0}`;
            const prev = seenBatches.get(sig) ?? {};
            const next: Record<string, number> = {};
            for (const e of batch.enemies) {
              if (!e || typeof e.enemy !== "string") continue;
              const count = e.count ?? 0;
              next[e.enemy] = count;
              const prevCount = prev[e.enemy] ?? 0;
              if (count > prevCount) {
                const diff = count - prevCount;
                const bossCard = e.enemy === "boss" && batch.mapId
                  ? bossCardIdForMap(batch.mapId) : null;
                const card = bossCard ?? cardIdForEnemy(e.enemy);
                if (card) bumpPity(card, diff);
              }
            }
            seenBatches.set(sig, next);
          }
          if (seenBatches.size > 500) {
            const keep = Array.from(seenBatches.entries()).slice(-200);
            seenBatches.clear();
            for (const [k, v] of keep) seenBatches.set(k, v);
          }
        }
      }
    } catch { /* silencieux */ }
    orig!.call(this, key, value);
  };
}

function uninstallStorageHook(): void {
  if (!storageHookInstalled || !originalSetItem) return;
  Storage.prototype.setItem = originalSetItem;
  storageHookInstalled = false;
  originalSetItem = null;
  seenBatches.clear();
}

// ─── État ────────────────────────────────────────────────────

let farmCardId = "";
let farmMode: "aggro" | "boss" | null = null;
let farmStartTs = 0;
let lastErrorTs = 0;
let lastErrorMessage = "";
let currentPhase = "idle";
let tickInProgress = false;
let intervalId: number | null = null;
const lastOwnedSnapshot: Record<string, number> = {};

function ownedOf(coop: CoopLike, cardId: string): number {
  return coop.cards?.()?.[cardId] ?? 0;
}

function statOf(enemy: string): string | null {
  const def = (ENEMY_TYPES as Record<string, { reward?: { type?: string } }>)[enemy];
  return def?.reward?.type ?? null;
}

function missingCards(coop: CoopLike): CardDef[] {
  return (CARDS as readonly CardDef[]).filter(c =>
    c.mapId !== "timberwood" &&
    ownedOf(coop, c.id) < 1
  );
}

/**
 * Map cible pour une carte. null si pas encore accessible (Warden
 * non débloquée) — ce n'est PAS un skip définitif, la carte sera
 * retentée au prochain tick quand la progression aura avancé.
 */
function targetMapFor(coop: CoopLike, card: CardDef): string | null {
  if (card.mapId === "timberwood") return null;
  if (card.mapId !== "endless") return card.mapId;
  if (!card.endless) return null;
  const completed = coop.proceduralCompleted?.() ?? 0;
  if (card.endless.from > completed + 1) return null;
  return `endless_${card.endless.from}`;
}

function nextCard(
  coop: CoopLike,
): { card: CardDef; mode: "aggro" | "boss" } | null {
  const missing = missingCards(coop);
  if (missing.length === 0) return null;
  // Priorité : régulières d'abord, puis boss
  for (const card of missing) {
    if (card.rarity !== "boss") {
      const map = targetMapFor(coop, card);
      if (map) return { card, mode: "aggro" };
    }
  }
  for (const card of missing) {
    if (card.rarity === "boss") {
      const map = targetMapFor(coop, card);
      if (map) return { card, mode: "boss" };
    }
  }
  return null;
}

// ─── Panneau auto-farm ──────────────────────────────────────

function ensurePanelOpen(): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return false;
  const content = sheet.querySelector<HTMLElement>("#autoFarmContent");
  if (!content || content.hidden) {
    sheet.querySelector<HTMLButtonElement>(".farm-toggle")?.click();
  }
  return true;
}

function setAggroGroup(group: string | null): void {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return;
  for (const row of sheet.querySelectorAll<HTMLElement>("[data-group]")) {
    const target = row.dataset.group === group ? "aggro" : "off";
    const btn = row.querySelector<HTMLButtonElement>(`[data-mode="${target}"]`);
    if (btn && btn.getAttribute("aria-checked") !== "true") btn.click();
  }
  if (group === null) {
    const first = sheet.querySelector<HTMLElement>("[data-group]");
    if (first) {
      const btn = first.querySelector<HTMLButtonElement>('[data-mode="aggro"]');
      if (btn && btn.getAttribute("aria-checked") !== "true") btn.click();
    }
  }
}

function enableMoveOn(): void {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return;
  const sw = sheet.querySelector<HTMLElement>('[data-switch="advance"]');
  if (sw && sw.getAttribute("aria-checked") !== "true") sw.click();
}

function disableMoveOn(): void {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return;
  const sw = sheet.querySelector<HTMLElement>('[data-switch="advance"]');
  if (sw && sw.getAttribute("aria-checked") === "true") sw.click();
}

function startFarm(): boolean {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return false;
  if (sheet.classList.contains("is-farming")) return true;
  const btn = sheet.querySelector<HTMLButtonElement>(".farm-start");
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}

function stopFarm(): void {
  const sheet = document.getElementById("autoFarmSheet");
  if (!sheet) return;
  const btn = sheet.querySelector<HTMLButtonElement>(".farm-close");
  if (btn && !btn.disabled && /stop/i.test(btn.textContent ?? "")) btn.click();
}

// ─── Navigation ─────────────────────────────────────────────

async function travelTo(coop: CoopLike, mapId: string): Promise<boolean> {
  if (coop.localState?.()?.mapId === mapId) return true;
  if (!coop.travelToMap) return false;
  try {
    const ok = await coop.travelToMap(mapId);
    if (!ok) return false;
  } catch { return false; }
  const start = Date.now();
  while (Date.now() - start < TRAVEL_WAIT_MS) {
    await new Promise(resolve => window.setTimeout(resolve, 300));
    if (coop.localState?.()?.mapId === mapId) return true;
  }
  return false;
}

// ─── Boucle ─────────────────────────────────────────────────

async function tick(): Promise<void> {
  if (tickInProgress) return;
  if (!isAutoCardEnabled()) return;
  // Cooldown sur erreur (retry auto après 30s)
  if (lastErrorTs > 0 && Date.now() - lastErrorTs < ERROR_COOLDOWN_MS) return;

  tickInProgress = true;
  try {
    const coop = getCoop();
    if (!coop) return;

    // Suivi du farm en cours
    if (farmMode && farmCardId) {
      const before = lastOwnedSnapshot[farmCardId] ?? 0;
      const now = ownedOf(coop, farmCardId);
      lastOwnedSnapshot[farmCardId] = now;
      if (now >= 1) {
        console.info(`[mod-auto-card] ✓ ${farmCardId} obtenue`);
        resetPity(farmCardId);
        farmMode = null;
        farmCardId = "";
        setRepeatBoss(false);
        stopFarm();
        return;
      }
      if (now > before) {
        resetPity(farmCardId);
      }
      currentPhase = "farming";
      return;
    }

    // Choisir la prochaine carte
    const next = nextCard(coop);
    if (!next) {
      console.info("[mod-auto-card] toutes les cartes accessibles obtenues");
      currentPhase = "done";
      setRepeatBoss(false);
      stopFarm();
      return;
    }

    const targetMap = targetMapFor(coop, next.card);
    if (!targetMap) {
      lastErrorTs = Date.now();
      lastErrorMessage = `map ${next.card.mapId} inaccessible`;
      return;
    }

    // Voyage
    currentPhase = "traveling";
    setRepeatBoss(false);
    if (!(await travelTo(coop, targetMap))) {
      lastErrorTs = Date.now();
      lastErrorMessage = `voyage vers ${targetMap} échoué`;
      console.warn(`[mod-auto-card] ${lastErrorMessage}`);
      return;
    }

    // Config panneau
    if (!ensurePanelOpen()) {
      lastErrorTs = Date.now();
      lastErrorMessage = "panneau auto-farm indisponible";
      return;
    }

    if (next.mode === "boss") {
      enableMoveOn();
      setRepeatBoss(true);
      setAggroGroup(null);
    } else {
      disableMoveOn();
      setRepeatBoss(false);
      const stat = statOf(next.card.enemy);
      if (!stat) {
        lastErrorTs = Date.now();
        lastErrorMessage = `stat introuvable pour ${next.card.enemy}`;
        return;
      }
      setAggroGroup(`stat:${stat}`);
    }

    if (!startFarm()) {
      lastErrorTs = Date.now();
      lastErrorMessage = `start refusé sur ${targetMap}`;
      return;
    }

    farmCardId = next.card.id;
    farmMode = next.mode;
    farmStartTs = Date.now();
    lastOwnedSnapshot[farmCardId] = ownedOf(coop, farmCardId);
    lastErrorTs = 0;
    lastErrorMessage = "";
    currentPhase = "farming";
  } finally {
    tickInProgress = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  installStorageHook();
  intervalId = window.setInterval(() => { void tick().catch(error => console.error("[mod-auto-card] tick failed", error)); }, POLL_MS);
  void tick().catch(error => console.error("[mod-auto-card] tick failed", error));
}

function stopPolling(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
  farmMode = null;
  farmCardId = "";
  lastErrorTs = 0;
  lastErrorMessage = "";
  currentPhase = "idle";
  setRepeatBoss(false);
  stopFarm();
  uninstallStorageHook();
}

// ─── Status ─────────────────────────────────────────────────

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  const enabled = isAutoCardEnabled();
  const coop = getCoop();
  const missing = coop ? missingCards(coop) : [];
  const byMap = new Map<string, number>();
  for (const card of missing) {
    const map = card.mapId === "endless" ? "endless" : card.mapId;
    byMap.set(map, (byMap.get(map) ?? 0) + 1);
  }

  const phaseText: Record<string, string> = {
    idle: "Off",
    traveling: "Voyage…",
    farming: farmMode === "boss" ? "Farm boss" : "Farm mobs",
    done: "✓ Toutes obtenues",
  };

  const line1 = document.createElement("div");
  line1.style.cssText = "display:flex;justify-content:space-between;gap:6px;margin-bottom:2px;";
  const label = document.createElement("span");
  label.style.fontWeight = "600";
  label.textContent = enabled ? (phaseText[currentPhase] ?? "—") : "Désactivé";
  const count = document.createElement("span");
  count.style.opacity = ".75";
  count.textContent = `${missing.length} restante(s) · ${byMap.size} map(s)`;
  line1.append(label, count);
  wrap.append(line1);

  if (!enabled) return wrap;

  if (farmCardId) {
    const card = (CARDS as readonly CardDef[]).find(item => item.id === farmCardId);
    const pct = card ? pityPct(farmCardId, card.rarity) : null;
    const current = document.createElement("div");
    current.style.cssText = "font-size:10px;color:#69e56f;margin-top:2px;";
    const elapsedSec = Math.floor((Date.now() - farmStartTs) / 1000);
    const minutes = Math.floor(elapsedSec / 60);
    const seconds = elapsedSec % 60;
    const time = minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
    const pctText = pct !== null ? ` · pity ${pct.toFixed(0)}%` : "";
    current.textContent = `▶ ${farmCardId} · ${time}${pctText}`;
    wrap.append(current);
  }

  if (lastErrorTs > 0 && lastErrorMessage) {
    const remaining = Math.max(0, Math.ceil((lastErrorTs + ERROR_COOLDOWN_MS - Date.now()) / 1000));
    const error = document.createElement("div");
    error.style.cssText = "font-size:9px;color:#ffd85b;margin-top:2px;";
    error.textContent = `⏸ ${lastErrorMessage} — retry dans ${remaining}s`;
    wrap.append(error);
  }

  if (byMap.size > 0) {
    const list = document.createElement("div");
    list.style.cssText = "font-size:9px;max-height:100px;overflow-y:auto;margin-top:3px;";
    for (const [map, count] of byMap) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;opacity:.65;";
      const mapLabel = document.createElement("span");
      mapLabel.textContent = map;
      const cardCount = document.createElement("span");
      cardCount.textContent = `${count}`;
      row.append(mapLabel, cardCount);
      list.append(row);
    }
    wrap.append(list);
  }

  return wrap;
}

export function registerAutoCardFarmMod(): void {
  REGISTERED_MODS.push({
    id: "card-auto-farm",
    name: "Auto Card Farming",
    category: "CARD",
    switch: {
      label: "On",
      get: isAutoCardEnabled,
      set: value => {
        try { localStorage.setItem(STORAGE_KEY, String(value)); }
        catch { /* idem */ }
        if (value) startPolling();
        else stopPolling();
      },
    },
    status: { render: renderStatus, intervalMs: TICK_MS },
    install: () => {
      if (isAutoCardEnabled()) startPolling();
    },
  });
}
