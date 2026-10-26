// mods/trade-bid-volume.ts
// Bid Volume — affiche le volume total d'offres d'achat (server-wide) pour
// les items choisis (max 8, limite serveur).

import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-trade-bid-volume-enabled";
const LIST_KEY = "wildwood-mod-trade-bid-volume-list";
const LOG_LIMIT = 40;

// Tous les items échangeables sur l'Exchange (10 au total).
// Limite serveur : 8 subscriptions simultanées.
const MAX_WATCH = 8;

const ALL_ITEMS = [
  "pine_log", "oak_log", "yew_log", "elder_log",
  "copper_ore", "iron_ore", "mithril_ore", "adamant_ore",
  "arcane_crystal", "starshard",
] as const;
type ItemId = (typeof ALL_ITEMS)[number];

const ITEM_LABELS: Record<ItemId, string> = {
  pine_log: "Pine Log",
  oak_log: "Oak Log",
  yew_log: "Yew Log",
  elder_log: "Elder Log",
  copper_ore: "Copper Ore",
  iron_ore: "Iron Ore",
  mithril_ore: "Mithril Ore",
  adamant_ore: "Adamant Ore",
  arcane_crystal: "Arcane Crystal",
  starshard: "Starshard",
};

const WOOD_SET = new Set<ItemId>(["pine_log", "oak_log", "yew_log", "elder_log"]);

type LogEntry = { ts: string; msg: string; cls: "info" | "ok" | "warn" | "bad" };
type BidRow = {
  itemId: ItemId;
  bestBid: number;
  totalVolume: number;
  offerCount: number;
};

type CoopLike = {
  exchangeOffers?: () => any[];
  watchExchangeItems?: (itemIds: readonly string[]) => void;
};

function getCoop(): CoopLike | null {
  const w = window as unknown as { wildstatCoop?: CoopLike; wildwoodCoop?: CoopLike };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

function isEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
}

function setEnabled(value: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, String(value)); } catch {}
  if (value) startHeartbeat();
  else stopHeartbeat();
}

// Liste de surveillance, persistée. Par défaut, les 8 items de base.
let watchList: ItemId[] = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(LIST_KEY) || "[]");
    const valid = ALL_ITEMS as readonly string[];
    if (Array.isArray(saved)) {
      const filtered = saved.filter((v): v is ItemId => valid.includes(v)).slice(0, MAX_WATCH);
      if (filtered.length > 0) return filtered;
    }
  } catch {}
  return ["pine_log", "oak_log", "yew_log", "elder_log",
          "copper_ore", "iron_ore", "mithril_ore", "adamant_ore"];
})();

function saveWatchList(): void {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(watchList)); } catch {}
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastWatchTs = 0;
let logs: LogEntry[] = [];
const bidCache = new Map<ItemId, BidRow>();

function log(msg: string, cls: LogEntry["cls"] = "info"): void {
  const ts = new Date().toLocaleTimeString("fr-FR", { hour12: false });
  logs.push({ ts, msg, cls });
  if (logs.length > LOG_LIMIT) logs.shift();
  const p = "[mod-bid-volume]";
  if (cls === "bad") console.error(p, msg);
  else if (cls === "warn") console.warn(p, msg);
  else console.info(p, msg);
}

function isExchangeDialogOpen(): boolean {
  const dialog = document.querySelector("dialog.exchange-sheet") as HTMLDialogElement | null;
  return !!(dialog && dialog.open);
}

function ensureWatch(): void {
  const c = getCoop();
  if (!c?.watchExchangeItems) return;
  if (isExchangeDialogOpen()) return; // laisser le jeu contrôler
  if (watchList.length === 0) return;
  const now = Date.now();
  if (now - lastWatchTs < 5000) return;
  lastWatchTs = now;
  try { c.watchExchangeItems(watchList); } catch {}
}

function refreshBidCache(): void {
  const c = getCoop();
  if (!c?.exchangeOffers) return;

  try {
    const offers = c.exchangeOffers() as Array<{
      buy: boolean; itemId: string; price: bigint | number;
      quantity: number; filled: number;
    }>;
    const totals = new Map<string, { volume: number; bestBid: number; count: number }>();

    for (const o of offers) {
      if (!o.buy) continue;
      const left = o.quantity - o.filled;
      if (left <= 0) continue;
      const price = Number(o.price);
      const t = totals.get(o.itemId) ?? { volume: 0, bestBid: 0, count: 0 };
      t.volume += left;
      t.count += 1;
      if (price > t.bestBid) t.bestBid = price;
      totals.set(o.itemId, t);
    }

    bidCache.clear();
    for (const itemId of watchList) {
      const t = totals.get(itemId);
      bidCache.set(itemId, {
        itemId,
        bestBid: t?.bestBid ?? 0,
        totalVolume: t?.volume ?? 0,
        offerCount: t?.count ?? 0,
      });
    }
  } catch (e) {
    log("Erreur lecture exchangeOffers: " + (e as Error).message, "warn");
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) return;
  log("Démarrage heartbeat", "info");
  ensureWatch();
  refreshBidCache();
  heartbeatTimer = setInterval(() => {
    if (!isEnabled()) return;
    ensureWatch();
    refreshBidCache();
  }, 1000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  bidCache.clear();
  try { getCoop()?.watchExchangeItems?.([]); } catch {}
  log("Heartbeat arrêté", "info");
}

// ─── Rendu UI ───
function buildRow(itemId: ItemId): HTMLElement {
  const row = document.createElement("div");
  row.style.cssText = "display:grid;grid-template-columns:1fr auto auto auto;gap:6px;padding:3px 4px;font-size:10px;border-bottom:1px solid rgba(255,255,255,.05);";

  const data = bidCache.get(itemId);

  const name = document.createElement("span");
  name.textContent = ITEM_LABELS[itemId];
  name.style.cssText = "color:" + (WOOD_SET.has(itemId) ? "#6c6" : "#c96") + ";";

  const best = document.createElement("span");
  best.textContent = data && data.bestBid > 0 ? data.bestBid.toLocaleString("en-US") : "—";
  best.style.cssText = "color:" + (data && data.bestBid > 0 ? "#74d8ff" : "#444") + ";text-align:right;font-weight:bold;";
  best.title = "Meilleur prix d'achat (server-wide)";

  const vol = document.createElement("span");
  vol.textContent = data && data.totalVolume > 0 ? data.totalVolume.toLocaleString("en-US") : "—";
  vol.style.cssText = "color:" + (data && data.totalVolume > 0 ? "#69e56f" : "#444") + ";text-align:right;font-weight:bold;min-width:40px;";
  vol.title = "Volume total d'achat (server-wide)";

  const count = document.createElement("span");
  count.textContent = data && data.offerCount > 0 ? `×${data.offerCount}` : "—";
  count.style.cssText = "color:" + (data && data.offerCount > 0 ? "#b7c5b7" : "#444") + ";text-align:right;font-size:9px;min-width:24px;";
  count.title = "Nombre d'offres d'achat";

  row.append(name, best, vol, count);
  return row;
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "font-size:10px;display:flex;flex-direction:column;gap:6px;";

  if (!isEnabled()) {
    wrap.innerHTML = '<div style="color:#888;text-align:center;padding:10px;">Mod désactivé (Switch OFF)</div>';
    return wrap;
  }

  const c = getCoop();
  const withBids = [...bidCache.values()].filter(r => r.totalVolume > 0).length;

  // Status
  const status = document.createElement("div");
  status.style.cssText = "font-weight:900;text-align:center;padding:4px;border-radius:4px;";

  if (!c?.watchExchangeItems) {
    status.textContent = "❌ watchExchangeItems indisponible";
    status.style.color = "#ff6767";
    status.style.background = "rgba(255,103,103,.1)";
  } else if (isExchangeDialogOpen()) {
    status.textContent = "⏸️ Fenêtre Exchange ouverte — pause";
    status.style.color = "#ffd85b";
    status.style.background = "rgba(255,216,91,.1)";
  } else if (watchList.length === 0) {
    status.textContent = "⚠️ Aucun item coché";
    status.style.color = "#ffd85b";
    status.style.background = "rgba(255,216,91,.1)";
  } else {
    status.textContent = `✅ ${withBids}/${watchList.length} items avec offres`;
    status.style.color = "#69e56f";
    status.style.background = "rgba(105,229,111,.1)";
  }
  wrap.append(status);

  // Header
  const header = document.createElement("div");
  header.style.cssText = "display:grid;grid-template-columns:1fr auto auto auto;gap:6px;padding:2px 4px;font-size:9px;color:#666;border-bottom:1px solid rgba(255,255,255,.1);font-weight:900;text-transform:uppercase;";
  for (const [text, align] of [["Item", "left"], ["Prix", "right"], ["Vol.", "right"], ["N", "right"]] as [string, string][]) {
    const cell = document.createElement("span");
    cell.textContent = text;
    cell.style.textAlign = align;
    header.append(cell);
  }
  wrap.append(header);

  // Lignes (uniquement les items surveillés)
  if (watchList.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "Coche des items ci-dessous";
    empty.style.cssText = "color:#666;text-align:center;padding:8px;font-size:9px;";
    wrap.append(empty);
  } else {
    for (const itemId of watchList) {
      wrap.append(buildRow(itemId));
    }
  }

  // ─── Checkboxes de sélection ───
  const listTitle = document.createElement("div");
  listTitle.style.cssText = "margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.1);font-size:9px;color:#888;text-transform:uppercase;font-weight:900;";
  listTitle.textContent = `📋 Items surveillés (${watchList.length}/${MAX_WATCH})`;
  wrap.append(listTitle);

  const list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:2px;";

  for (const itemId of ALL_ITEMS) {
    const checked = watchList.includes(itemId);
    const atLimit = !checked && watchList.length >= MAX_WATCH;

    const row = document.createElement("label");
    row.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;padding:2px 4px;border-radius:3px;" + (atLimit ? "opacity:.4;" : "");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.disabled = atLimit;
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (watchList.length >= MAX_WATCH) {
          cb.checked = false;
          log(`Limite ${MAX_WATCH} items atteinte`, "warn");
          return;
        }
        if (!watchList.includes(itemId)) watchList.push(itemId);
      } else {
        watchList = watchList.filter(k => k !== itemId);
      }
      saveWatchList();
      // Force re-watch immédiat
      lastWatchTs = 0;
      ensureWatch();
      refreshBidCache();
    });

    const name = document.createElement("span");
    name.textContent = ITEM_LABELS[itemId];
    name.style.flex = "1";
    name.style.color = WOOD_SET.has(itemId) ? "#6c6" : "#c96";

    row.append(cb, name);
    list.append(row);
  }
  wrap.append(list);

  // Logs
  if (logs.length > 0) {
    const logsEl = document.createElement("div");
    logsEl.style.cssText = "max-height:80px;overflow-y:auto;background:rgba(0,0,0,.3);padding:3px;border-radius:3px;font-size:9px;line-height:1.3;margin-top:4px;";
    for (const l of logs.slice(-10)) {
      const line = document.createElement("div");
      line.textContent = "[" + l.ts + "] " + l.msg;
      line.style.color = l.cls === "ok" ? "#69e56f" : l.cls === "warn" ? "#ffd85b" : l.cls === "bad" ? "#ff6767" : "#8aa8c8";
      logsEl.append(line);
    }
    wrap.append(logsEl);
  }

  // Copy JSON
  const btnCopy = document.createElement("button");
  btnCopy.textContent = "📋 Copier JSON";
  btnCopy.style.cssText = "margin-top:4px;padding:3px 6px;font:inherit;cursor:pointer;background:rgba(116,216,255,.22);color:inherit;border:0;border-radius:3px;font-size:10px;width:100%;";
  btnCopy.addEventListener("click", async () => {
    const data = watchList.map(itemId => bidCache.get(itemId)).filter(Boolean);
    if (data.length === 0) return;
    const json = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      btnCopy.textContent = "✅ Copié";
      setTimeout(() => { btnCopy.textContent = "📋 Copier JSON"; }, 2000);
    } catch {
      console.log(json);
      btnCopy.textContent = "❌ Voir console";
      setTimeout(() => { btnCopy.textContent = "📋 Copier JSON"; }, 2000);
    }
  });
  wrap.append(btnCopy);

  return wrap;
}

export function registerTradeBidVolumeMod(): void {
  REGISTERED_MODS.push({
    id: "trade-bid-volume",
    name: "Bid Volume",
    category: "TRADE",
    description: "Affiche le volume total d'offres d'achat (server-wide) pour les items choisis (max 8).",
    switch: { label: "On", get: isEnabled, set: setEnabled },
    status: { render: renderStatus, intervalMs: 1000 },
    install: () => { if (isEnabled()) startHeartbeat(); },
  });
}