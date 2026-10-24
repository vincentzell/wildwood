// mods/card-auto-target.ts
import { CARDS } from "../shared/cards";
import { REGISTERED_MODS } from "./registry";
import {
  createRunner,
  getCoop,
  installStorageHook,
  loadCopies,
  loadTargetList,
  missingCards,
  pityPct,
  saveCopies,
  saveTargetList,
  targetMapFor,
  uninstallStorageHook,
  type CardDef,
} from "./card-farming-core";

const STORAGE_KEY = "wildwood-mod-auto-target-enabled";
const COPIES_KEY = "wildwood-mod-auto-target-copies";
const TARGET_KEY = "wildwood-mod-auto-target-list";
const PITY_KEY = "wildwood-mod-auto-target-pity";
const BOSS_FLAG = "wildwood-mod-auto-card-target-boss-mode";
const ALL_ENABLED_KEY = "wildwood-mod-auto-all-enabled";

export function isAutoTargetEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

function groupByMap(coop: NonNullable<ReturnType<typeof getCoop>>): Map<string, CardDef[]> {
  const copies = loadCopies(COPIES_KEY);
  const targets = new Set(loadTargetList(TARGET_KEY));
  if (targets.size === 0) return new Map();
  const grouped = new Map<string, CardDef[]>();
  for (const card of missingCards(coop, copies)) {
    if (!targets.has(card.id)) continue;
    const mapId = targetMapFor(coop, card);
    if (!mapId) continue;
    const cards = grouped.get(mapId) ?? [];
    cards.push(card);
    grouped.set(mapId, cards);
  }
  const entries = [...grouped.entries()];
  entries.sort(([mapA, cardsA], [mapB, cardsB]) => {
    const bossA = cardsA.some(card => card.rarity === "boss") ? 0 : 1;
    const bossB = cardsB.some(card => card.rarity === "boss") ? 0 : 1;
    return bossA - bossB || mapA.localeCompare(mapB);
  });
  return new Map(entries);
}

const runner = createRunner({
  getId: () => "card-auto-target",
  getCopies: () => loadCopies(COPIES_KEY),
  getPityKey: () => PITY_KEY,
  getBossFlagKey: () => BOSS_FLAG,
  selectMaps: groupByMap,
});

function restartIfEnabled(): void {
  if (!isAutoTargetEnabled()) return;
  runner.stop();
  runner.start();
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  const enabled = isAutoTargetEnabled();
  const coop = getCoop();
  const copies = loadCopies(COPIES_KEY);
  const targetIds = loadTargetList(TARGET_KEY);
  const maps = coop ? groupByMap(coop) : new Map<string, CardDef[]>();
  const missingCount = [...maps.values()].reduce((sum, cards) => sum + cards.length, 0);

  const line = document.createElement("div");
  line.style.cssText = "display:flex;justify-content:space-between;gap:6px;margin-bottom:2px;";
  const phase = document.createElement("span");
  phase.style.fontWeight = "600";
  const phaseLabels: Record<string, string> = {
    idle: "Off",
    traveling: "Voyage…",
    boss: "Boss",
    mobs: "Farm mobs",
    done: "✓ Complet",
  };
  phase.textContent = enabled ? (phaseLabels[runner.getPhase()] ?? "—") : "Désactivé";
  const count = document.createElement("span");
  count.style.opacity = ".75";
  count.textContent = `${missingCount}/${targetIds.length}`;
  line.append(phase, count);
  wrap.append(line);

  if (enabled && runner.getLastError()) {
    const error = document.createElement("div");
    error.style.cssText = "font-size:9px;color:#ffd85b;margin-top:2px;";
    error.textContent = runner.getLastError();
    wrap.append(error);
  }

  const addRow = document.createElement("div");
  addRow.style.cssText = "display:flex;gap:4px;margin:4px 0;font-size:9px;";
  const select = document.createElement("select");
  select.style.cssText = "flex:1;background:rgba(0,0,0,.3);color:inherit;border:1px solid rgba(255,255,255,.15);border-radius:3px;padding:1px 4px;font:inherit;font-size:9px;";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "— Carte —";
  select.append(emptyOption);
  const cardsByMap = new Map<string, CardDef[]>();
  for (const card of CARDS as readonly CardDef[]) {
    if (card.mapId === "timberwood") continue;
    const cards = cardsByMap.get(card.mapId) ?? [];
    cards.push(card);
    cardsByMap.set(card.mapId, cards);
  }
  for (const [mapId, cards] of cardsByMap) {
    const group = document.createElement("optgroup");
    group.label = mapId;
    for (const card of cards) {
      const option = document.createElement("option");
      option.value = card.id;
      option.textContent = `${card.enemy} (${card.rarity})${targetIds.includes(card.id) ? " ✓" : ""}`;
      group.append(option);
    }
    select.append(group);
  }
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.textContent = "Ajouter";
  addButton.style.cssText = "font-size:9px;padding:1px 6px;";
  addButton.addEventListener("click", () => {
    const id = select.value;
    const currentTargets = loadTargetList(TARGET_KEY);
    if (!id || currentTargets.includes(id)) return;
    saveTargetList(TARGET_KEY, [...currentTargets, id]);
    restartIfEnabled();
  });
  addRow.append(select, addButton);
  wrap.append(addRow);

  const copiesRow = document.createElement("div");
  copiesRow.style.cssText = "display:flex;align-items:center;gap:4px;margin:2px 0;font-size:9px;";
  const copiesLabel = document.createElement("span");
  copiesLabel.textContent = "Copies :";
  copiesLabel.style.opacity = ".7";
  const copiesInput = document.createElement("input");
  copiesInput.type = "number";
  copiesInput.min = "1";
  copiesInput.max = "99";
  copiesInput.value = String(copies);
  copiesInput.style.cssText = "width:50px;background:rgba(0,0,0,.3);color:inherit;border:1px solid rgba(255,255,255,.15);border-radius:3px;padding:1px 4px;font:inherit;font-size:9px;";
  copiesInput.addEventListener("change", () => {
    const value = Number.parseInt(copiesInput.value, 10);
    saveCopies(COPIES_KEY, value > 0 ? Math.min(99, value) : 1);
    restartIfEnabled();
  });
  copiesRow.append(copiesLabel, copiesInput);
  wrap.append(copiesRow);

  const currentCard = runner.getCurrentCards()[0];
  if (enabled && currentCard) {
    const pct = pityPct(PITY_KEY, currentCard.id, currentCard.rarity);
    const current = document.createElement("div");
    current.style.cssText = "font-size:10px;color:#69e56f;margin-top:2px;";
    const pctText = pct !== null ? ` · pity ${pct.toFixed(0)}%` : "";
    current.textContent = `▶ ${currentCard.id}${pctText}`;
    wrap.append(current);
  }

  if (targetIds.length > 0) {
    const clearRow = document.createElement("div");
    clearRow.style.cssText = "display:flex;justify-content:flex-end;margin-top:2px;";
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "🗑 Clear";
    clearButton.style.cssText = "font-size:9px;padding:1px 6px;background:rgba(255,103,103,.22);color:inherit;border:0;border-radius:3px;cursor:pointer;";
    clearButton.addEventListener("click", () => {
      saveTargetList(TARGET_KEY, []);
      restartIfEnabled();
    });
    clearRow.append(clearButton);
    wrap.append(clearRow);

    const list = document.createElement("div");
    list.style.cssText = "font-size:9px;max-height:100px;overflow-y:auto;margin-top:3px;border-top:1px solid rgba(255,255,255,.1);padding-top:3px;";
    for (const id of targetIds) {
      const card = (CARDS as readonly CardDef[]).find(item => item.id === id);
      const owned = coop?.cards?.()?.[id] ?? 0;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;opacity:.75;";
      const name = document.createElement("span");
      name.textContent = card?.enemy ?? id;
      const total = document.createElement("span");
      total.textContent = `${owned}/${copies}${card?.rarity === "boss" ? " 👹" : ""}`;
      row.append(name, total);
      list.append(row);
    }
    wrap.append(list);
  }

  return wrap;
}

export function registerAutoFarmTargetCardsMod(): void {
  REGISTERED_MODS.push({
    id: "card-auto-target",
    name: "Auto Farm Target Cards",
    category: "CARD",
    switch: {
      label: "On",
      get: isAutoTargetEnabled,
      set: value => {
        try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* Storage may be unavailable. */ }
        if (value) {
          try { localStorage.setItem(ALL_ENABLED_KEY, "false"); } catch { /* Storage may be unavailable. */ }
          installStorageHook(PITY_KEY, () => getCoop()?.activeCardStats?.()?.cardHunter ?? 0);
          runner.start();
        } else {
          runner.stop();
          uninstallStorageHook();
        }
      },
    },
    status: { render: renderStatus, intervalMs: 1_500 },
    install: () => {
      if (!isAutoTargetEnabled()) return;
      try { localStorage.setItem(ALL_ENABLED_KEY, "false"); } catch { /* Storage may be unavailable. */ }
      installStorageHook(PITY_KEY, () => getCoop()?.activeCardStats?.()?.cardHunter ?? 0);
      runner.start();
    },
  });
}
