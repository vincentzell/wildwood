// mods/card-auto-farm.ts
import { REGISTERED_MODS } from "./registry";
import {
  createRunner,
  getCoop,
  installStorageHook,
  loadCopies,
  missingCards,
  pityPct,
  saveCopies,
  targetMapFor,
  uninstallStorageHook,
  type CardDef,
} from "./card-farming-core";

const STORAGE_KEY = "wildwood-mod-auto-all-enabled";
const COPIES_KEY = "wildwood-mod-auto-all-copies";
const PITY_KEY = "wildwood-mod-auto-all-pity";
const BOSS_FLAG = "wildwood-mod-auto-card-all-boss-mode";
const TARGET_KEY = "wildwood-mod-auto-target-enabled";

export function isAutoAllEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

function groupByMap(coop: NonNullable<ReturnType<typeof getCoop>>, copies: number): Map<string, CardDef[]> {
  const missing = missingCards(coop, copies);
  const grouped = new Map<string, CardDef[]>();
  for (const card of missing) {
    const mapId = targetMapFor(coop, card);
    if (!mapId) continue;
    const cards = grouped.get(mapId) ?? [];
    cards.push(card);
    grouped.set(mapId, cards);
  }
  const entries = [...grouped.entries()];
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return new Map(entries);
}

const runner = createRunner({
  getId: () => "card-auto-farm",
  getCopies: () => loadCopies(COPIES_KEY),
  getPityKey: () => PITY_KEY,
  getBossFlagKey: () => BOSS_FLAG,
  selectMaps: coop => groupByMap(coop, loadCopies(COPIES_KEY)),
});

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  const enabled = isAutoAllEnabled();
  const coop = getCoop();
  const copies = loadCopies(COPIES_KEY);
  const maps = coop ? groupByMap(coop, copies) : new Map<string, CardDef[]>();
  const missing = [...maps.values()].reduce((sum, cards) => sum + cards.length, 0);

  const line = document.createElement("div");
  line.style.cssText = "display:flex;justify-content:space-between;gap:6px;margin-bottom:2px;";
  const phase = document.createElement("span");
  phase.style.fontWeight = "600";
  const phaseLabels: Record<string, string> = {
    idle: "Off",
    traveling: "Voyage…",
    mobs: "Farm",
    done: "✓ Complet",
  };
  phase.textContent = enabled ? (phaseLabels[runner.getPhase()] ?? "—") : "Désactivé";
  const count = document.createElement("span");
  count.style.opacity = ".75";
  count.textContent = `${missing} restante(s) · ${maps.size} map(s)`;
  line.append(phase, count);
  wrap.append(line);

  if (enabled && runner.getLastError()) {
    const error = document.createElement("div");
    error.style.cssText = "font-size:9px;color:#ffd85b;margin-top:2px;";
    error.textContent = runner.getLastError();
    wrap.append(error);
  }

  if (!enabled) return wrap;

  const copiesRow = document.createElement("div");
  copiesRow.style.cssText = "display:flex;align-items:center;gap:4px;margin:4px 0;font-size:9px;";
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
  });
  copiesRow.append(copiesLabel, copiesInput);
  wrap.append(copiesRow);

  const currentCard = runner.getCurrentCards()[0];
  if (currentCard) {
    const pct = pityPct(PITY_KEY, currentCard.id, currentCard.rarity);
    const current = document.createElement("div");
    current.style.cssText = "font-size:10px;color:#69e56f;margin-top:2px;";
    const pctText = pct !== null ? ` · pity ${pct.toFixed(0)}%` : "";
    current.textContent = `▶ ${currentCard.id}${pctText} · ${runner.getCurrentMap()}`;
    wrap.append(current);
  }

  if (maps.size > 0) {
    const list = document.createElement("div");
    list.style.cssText = "font-size:9px;max-height:100px;overflow-y:auto;margin-top:3px;border-top:1px solid rgba(255,255,255,.1);padding-top:3px;";
    for (const [mapId, cards] of maps) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;opacity:.65;";
      const mapLabel = document.createElement("span");
      mapLabel.textContent = mapId;
      const cardCount = document.createElement("span");
      cardCount.textContent = `${cards.length}`;
      row.append(mapLabel, cardCount);
      list.append(row);
    }
    wrap.append(list);
  }
  return wrap;
}

export function registerAutoFarmAllCardsMod(): void {
  REGISTERED_MODS.push({
    id: "card-auto-farm",
    name: "Auto Farm All Cards",
    category: "CARD",
    switch: {
      label: "On",
      get: isAutoAllEnabled,
      set: value => {
        try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* Storage may be unavailable. */ }
        if (value) {
          try { localStorage.setItem(TARGET_KEY, "false"); } catch { /* Storage may be unavailable. */ }
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
      if (!isAutoAllEnabled()) return;
      try { localStorage.setItem(TARGET_KEY, "false"); } catch { /* Storage may be unavailable. */ }
      installStorageHook(PITY_KEY, () => getCoop()?.activeCardStats?.()?.cardHunter ?? 0);
      runner.start();
    },
  });
}
