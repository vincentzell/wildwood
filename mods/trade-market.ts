// mods/trade-market.ts
// Exchange Prices — surveille les prix du bois et des minerais.
// Force l'abonnement (followExchange) pour charger les prix à distance.

import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-exchange-enabled";
const FORCE_SUB_KEY = "wildwood-mod-exchange-force";
const SORT_KEY = "wildwood-mod-exchange-sort";
const ALERT_KEY = "wildwood-mod-exchange-alert";

const WOOD_IDS = new Set(["pine_log", "oak_log", "yew_log", "elder_log"]);
const ORE_IDS = new Set(["copper_ore", "iron_ore", "mithril_ore", "adamant_ore", "arcane_crystal", "starshard"]);

type Bucket = "wood" | "ore";
type ExchangeRow = {
  itemId: string;
  lowestAsk: number;
  highestBid: number;
  spread: number | null;
  spreadPct: number | null;
  forSale: number;
  lastPrice: number;
  owned: number;
};

type CoopLike = {
  exchangePrices?: () => any[];
  followExchange?: (follow: boolean) => void;
  ores?: () => Record<string, number>;
  localState?: () => { mapId?: string } | null;
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

// ─── Configuration & État ───
let forceSubscribe = localStorage.getItem(FORCE_SUB_KEY) !== "false"; // ON par défaut
let spreadAlertPct = parseFloat(localStorage.getItem(ALERT_KEY) || "25");
let sortState: Record<Bucket, { key: keyof ExchangeRow; dir: number }> = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_KEY) || "null");
    if (s && s.wood && s.ore) return s;
  } catch {}
  return { wood: { key: "lowestAsk", dir: 1 }, ore: { key: "lowestAsk", dir: 1 } };
})();

// ─── Heartbeat (Force Subscribe) ───
let heartbeatTimer: any = null;
let lastSubAttempt = 0;

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (!isEnabled() || !forceSubscribe) return;
    const c = getCoop();
    if (!c || typeof c.followExchange !== "function") return;

    let raw: any = [];
    try { raw = c.exchangePrices?.() || []; } catch {}
    if (!Array.isArray(raw)) raw = Object.values(raw);

    // Si les prix sont vides, on force l'abonnement (throttle 5s)
    if (raw.length === 0) {
      const now = Date.now();
      if (now - lastSubAttempt > 5000) {
        lastSubAttempt = now;
        try { c.followExchange(true); } catch {}
      }
    }
  }, 3000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (forceSubscribe) {
    try { getCoop()?.followExchange?.(false); } catch {}
  }
}

// ─── Lecture des données ───
function readInventory(): Record<string, number> {
  try { return getCoop()?.ores?.() || {}; } catch { return {}; }
}

function readPrices(): { wood: ExchangeRow[]; ore: ExchangeRow[]; inTown: boolean } {
  const c = getCoop();
  if (!c?.exchangePrices) return { wood: [], ore: [], inTown: false };

  let inTown = false;
  try { inTown = c.localState?.()?.mapId === "town"; } catch {}

  let raw: any = [];
  try { raw = c.exchangePrices() || []; } catch { return { wood: [], ore: [], inTown }; }
  if (!Array.isArray(raw)) raw = Object.values(raw);

  const inv = readInventory();
  const out: { wood: ExchangeRow[]; ore: ExchangeRow[]; inTown: boolean } = { wood: [], ore: [], inTown };

  for (const r of raw) {
    const id = r.itemId || r.item_id || r.id;
    let bucket: Bucket | null = null;
    if (WOOD_IDS.has(id)) bucket = "wood";
    else if (ORE_IDS.has(id)) bucket = "ore";
    if (!bucket) continue;

    const ask = Number(r.lowestAsk ?? r.lowest_ask ?? 0);
    const bid = Number(r.highestBid ?? r.highest_bid ?? 0);
    const last = Number(r.lastPrice ?? r.last_price ?? 0);
    const spread = (ask > 0 && bid > 0) ? ask - bid : null;
    const spreadPct = (spread !== null && ask > 0) ? (spread / ask) * 100 : null;

    out[bucket].push({
      itemId: id, lowestAsk: ask, highestBid: bid,
      forSale: Number(r.forSale ?? r.for_sale ?? 0),
      lastPrice: last, spread, spreadPct,
      owned: Number(inv[id] ?? 0),
    });
  }

  for (const b of ["wood", "ore"] as Bucket[]) {
    const s = sortState[b];
    out[b].sort((x, y) => {
      let vx = x[s.key], vy = y[s.key];
      if (vx === null || vx === undefined) vx = s.dir > 0 ? Infinity : -Infinity;
      if (vy === null || vy === undefined) vy = s.dir > 0 ? Infinity : -Infinity;
      if (typeof vx === "string" && typeof vy === "string") return vx.localeCompare(vy) * s.dir;
      return ((vx as number) - (vy as number)) * s.dir;
    });
  }
  return out;
}

function spreadColor(pct: number | null): string {
  if (pct === null) return "#666";
  if (pct < 5) return "#69e56f";
  if (pct < 15) return "#f5f5e9";
  if (pct < spreadAlertPct) return "#ffd85b";
  return "#ff655a";
}

// ─── Rendu UI ───
function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "font-size:10px;display:flex;flex-direction:column;gap:6px;";

  if (!isEnabled()) {
    wrap.innerHTML = '<div style="color:#888;text-align:center;padding:10px;">Mod désactivé (Switch OFF)</div>';
    return wrap;
  }

  const data = readPrices();
  const total = data.wood.length + data.ore.length;

  // Status
  const status = document.createElement("div");
  status.style.cssText = "font-weight:900;text-align:center;padding:4px;border-radius:4px;";
  if (total === 0) {
    if (data.inTown) {
      status.textContent = "⏳ En ville — abonnement en cours...";
      status.style.color = "#ffd85b";
      status.style.background = "rgba(255,216,91,.1)";
    } else if (forceSubscribe) {
      status.textContent = "⏳ Force-subscribe actif, attente serveur...";
      status.style.color = "#ffd85b";
      status.style.background = "rgba(255,216,91,.1)";
    } else {
      status.textContent = "📍 Entre en ville pour voir les prix";
      status.style.color = "#888";
      status.style.background = "rgba(255,255,255,.05)";
    }
  } else {
    status.textContent = `✅ ${data.wood.length} bois · ${data.ore.length} minerais · ${data.inTown ? "ville" : "hors ville"}`;
    status.style.color = data.inTown ? "#69e56f" : "#74d8ff";
    status.style.background = "rgba(105,229,111,.1)";
  }
  wrap.append(status);

  // Contrôles
  const controls = document.createElement("div");
  controls.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:4px;background:rgba(0,0,0,.2);border-radius:4px;";

  const cbLabel = document.createElement("label");
  cbLabel.style.cssText = "display:flex;align-items:center;gap:4px;cursor:pointer;";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = forceSubscribe;
  cb.onchange = () => {
    forceSubscribe = cb.checked;
    localStorage.setItem(FORCE_SUB_KEY, String(forceSubscribe));
    if (!forceSubscribe) { try { getCoop()?.followExchange?.(false); } catch {} }
    else { lastSubAttempt = 0; }
  };
  cbLabel.append(cb, document.createTextNode("Forcer abonnement"));

  const alertLabel = document.createElement("label");
  alertLabel.style.cssText = "display:flex;align-items:center;gap:4px;";
  const alertInput = document.createElement("input");
  alertInput.type = "number";
  alertInput.min = "1"; alertInput.max = "99";
  alertInput.value = String(spreadAlertPct);
  alertInput.style.cssText = "width:35px;background:#2a2a2a;color:#fff;border:1px solid #444;border-radius:3px;text-align:center;";
  alertInput.onchange = () => {
    const v = parseFloat(alertInput.value);
    if (!isNaN(v) && v >= 1 && v <= 99) {
      spreadAlertPct = v;
      localStorage.setItem(ALERT_KEY, String(v));
    } else alertInput.value = String(spreadAlertPct);
  };
  alertLabel.append(document.createTextNode("⚠️ >"), alertInput, document.createTextNode("%"));

  controls.append(cbLabel, alertLabel);
  wrap.append(controls);

  // Tables
  const buildTable = (bucket: Bucket, rows: ExchangeRow[]) => {
    if (rows.length === 0) return null;
    const table = document.createElement("table");
    table.style.cssText = "width:100%;border-collapse:collapse;font-size:10px;margin-top:4px;";
    
    const thead = document.createElement("thead");
    const trHead = document.createElement("tr");
    const cols: { key: keyof ExchangeRow; label: string }[] = [
      { key: "itemId", label: "Item" },
      { key: "lowestAsk", label: "Ask" },
      { key: "highestBid", label: "Bid" },
      { key: "spreadPct", label: "Δ%" },
      { key: "forSale", label: "Qté" },
      { key: "owned", label: "Inv" }
    ];
    
    cols.forEach(c => {
      const th = document.createElement("th");
      th.textContent = c.label;
      th.style.cssText = "text-align:right;color:#888;padding:2px;border-bottom:1px solid #444;cursor:pointer;";
      if (c.key === "itemId") th.style.textAlign = "left";
      
      const s = sortState[bucket];
      if (s.key === c.key) {
        th.textContent += s.dir > 0 ? " ▲" : " ▼";
        th.style.color = "#74d8ff";
      }
      
      th.onclick = () => {
        if (sortState[bucket].key === c.key) sortState[bucket].dir *= -1;
        else { sortState[bucket].key = c.key; sortState[bucket].dir = 1; }
        localStorage.setItem(SORT_KEY, JSON.stringify(sortState));
      };
      trHead.append(th);
    });
    thead.append(trHead);
    table.append(thead);

    const tbody = document.createElement("tbody");
    rows.forEach(r => {
      const tr = document.createElement("tr");
      
      const tdId = document.createElement("td");
      tdId.textContent = r.itemId.replace("_log", "").replace("_ore", "").replace("_", " ");
      tdId.style.cssText = "text-align:left;padding:2px;color:#b7c5b7;";
      
      const tdAsk = document.createElement("td");
      tdAsk.textContent = r.lowestAsk > 0 ? String(r.lowestAsk) : "—";
      tdAsk.style.cssText = "text-align:right;padding:2px;color:#69e56f;font-weight:bold;";
      
      const tdBid = document.createElement("td");
      tdBid.textContent = r.highestBid > 0 ? String(r.highestBid) : "—";
      tdBid.style.cssText = "text-align:right;padding:2px;color:#74d8ff;";
      
      const tdSpread = document.createElement("td");
      tdSpread.textContent = r.spreadPct !== null ? r.spreadPct.toFixed(1) + "%" : "—";
      tdSpread.style.cssText = `text-align:right;padding:2px;color:${spreadColor(r.spreadPct)};font-weight:bold;`;
      
      const tdQty = document.createElement("td");
      tdQty.textContent = String(r.forSale);
      tdQty.style.cssText = "text-align:right;padding:2px;color:#888;";
      
      const tdInv = document.createElement("td");
      tdInv.textContent = String(r.owned);
      tdInv.style.cssText = `text-align:right;padding:2px;color:${r.owned > 0 ? "#69e56f" : "#666"};`;

      tr.append(tdId, tdAsk, tdBid, tdSpread, tdQty, tdInv);
      tbody.append(tr);
    });
    table.append(tbody);
    return table;
  };

  const woodTable = buildTable("wood", data.wood);
  if (woodTable) {
    const title = document.createElement("div");
    title.textContent = "🌲 Bois";
    title.style.cssText = "color:#6c6;font-weight:bold;margin-top:4px;";
    wrap.append(title, woodTable);
  }

  const oreTable = buildTable("ore", data.ore);
  if (oreTable) {
    const title = document.createElement("div");
    title.textContent = "⛏️ Minerai";
    title.style.cssText = "color:#c96;font-weight:bold;margin-top:4px;";
    wrap.append(title, oreTable);
  }

  return wrap;
}

export function registerTradeMarketMod(): void {
  REGISTERED_MODS.push({
    id: "trade-market",
    name: "Exchange Prices",
    category: "TRADE",
    description: "Surveille les prix du bois et des minerais. Force l'abonnement pour charger à distance.",
    switch: { label: "On", get: isEnabled, set: setEnabled },
    status: { render: renderStatus, intervalMs: 2000 },
    install: () => {
      if (isEnabled()) startHeartbeat();
    },
  });
}