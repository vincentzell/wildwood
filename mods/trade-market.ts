// mods/trade-market.ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-trade-market-force-subscribe";
const INTERVAL_MS = 3_000;

const WOOD_IDS = new Set(["pine_log", "oak_log", "yew_log", "elder_log"]);
const ORE_IDS  = new Set(["copper_ore", "iron_ore", "mithril_ore", "adamant_ore", "arcane_crystal", "starshard"]);

type ExchangeRow = {
  itemId?: string; item_id?: string; id?: string;
  lowestAsk?: number; lowest_ask?: number;
  highestBid?: number; highest_bid?: number;
  forSale?: number; for_sale?: number;
  lastPrice?: number; last_price?: number;
};

type CoopLike = {
  exchangePrices?: () => ExchangeRow[] | Record<string, ExchangeRow>;
  ores?: () => Record<string, number>;
  localState?: () => { mapId?: string } | null;
  followExchange?: (enable?: boolean) => void;
};

function getCoop(): CoopLike | null {
  const w = window as unknown as { wildstatCoop?: CoopLike; wildwoodCoop?: CoopLike };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

function isForceSubscribe(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
}

function setForceSubscribe(value: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* idem */ }
  if (!value) {
    try { getCoop()?.followExchange?.(); } catch { /* idem */ }
  }
}

function classify(id: string): "wood" | "ore" | null {
  if (ORE_IDS.has(id)) return "ore";
  if (WOOD_IDS.has(id)) return "wood";
  return null;
}

function spreadClass(pct: number | null, alertPct = 25): string {
  if (pct === null) return "color:#666;font-style:italic";
  if (pct < 5) return "color:#69e56f;font-weight:900";
  if (pct < 15) return "color:#f5f5e9";
  if (pct < alertPct) return "color:#ffd85b;font-weight:900";
  return "color:#ff655a;font-weight:900";
}

type MarketRow = {
  itemId: string;
  lowestAsk: number;
  highestBid: number;
  forSale: number;
  lastPrice: number;
  spread: number | null;
  spreadPct: number | null;
  owned: number;
};

function readMarket(): { wood: MarketRow[]; ore: MarketRow[]; inTown: boolean; invOk: boolean } {
  const coop = getCoop();
  const empty = { wood: [] as MarketRow[], ore: [] as MarketRow[], inTown: false, invOk: false };
  if (!coop?.exchangePrices) return empty;

  let inTown = false;
  try { inTown = coop.localState?.()?.mapId === "town"; } catch { /* idem */ }

  let raw: ExchangeRow[] = [];
  try {
    const r = coop.exchangePrices();
    raw = Array.isArray(r) ? r : Object.values(r ?? {});
  } catch { return { ...empty, inTown }; }

  let inv: Record<string, number> = {};
  let invOk = false;
  try {
    const o = coop.ores?.();
    if (o && typeof o === "object") { inv = o; invOk = true; }
  } catch { /* idem */ }

  const out = { wood: [] as MarketRow[], ore: [] as MarketRow[], inTown, invOk };
  for (const r of raw) {
    const id = r.itemId ?? r.item_id ?? r.id ?? "";
    const bucket = classify(id);
    if (!bucket) continue;
    
    const ask = Number(r.lowestAsk ?? r.lowest_ask ?? 0);
    const bid = Number(r.highestBid ?? r.highest_bid ?? 0);
    const last = Number(r.lastPrice ?? r.last_price ?? 0);
    const spread = ask > 0 && bid > 0 ? ask - bid : null;
    const spreadPct = spread !== null && ask > 0 ? (spread / ask) * 100 : null;
    
    out[bucket].push({
      itemId: id,
      lowestAsk: ask,
      highestBid: bid,
      forSale: Number(r.forSale ?? r.for_sale ?? 0),
      lastPrice: last,
      spread,
      spreadPct,
      owned: Number(inv[id] ?? 0),
    });
  }
  
  out.wood.sort((a, b) => a.lowestAsk - b.lowestAsk);
  out.ore.sort((a, b) => a.lowestAsk - b.lowestAsk);
  return out;
}

function el(tag: string, style: string = "", text?: string): HTMLElement {
      const e = document.createElement(tag);
  e.style.cssText = style;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderTable(rows: MarketRow[], title: string, color: string, invOk: boolean): HTMLElement {
  const wrap = el("div", "margin-bottom:6px");
  wrap.append(el("div", `font-size:10px;font-weight:900;text-transform:uppercase;padding:2px 4px;border-radius:3px;color:${color};background:${color}22`, `${title} (${rows.length})`));
  
  if (rows.length === 0) {
    wrap.append(el("div", "color:#888;font-style:italic;font-size:10px;padding:4px", "—"));
    return wrap;
  }

  const table = el("table", "width:100%;border-collapse:collapse;font-size:10px");
  const thead = el("thead");
  const tr = el("tr","");
  
  for (const [label, align] of [["Item", "left"], ["Ask", "right"], ["Bid", "right"], ["Δ", "right"], ["Δ%", "right"], ["Qté", "right"], ["Last", "right"], ["Inv", "right"]] as const) {
    const th = el("th", `text-align:${align};color:#888;font-weight:900;font-size:8px;text-transform:uppercase;padding:2px 3px;border-bottom:1px solid rgba(255,255,255,.1)`, label);
    tr.append(th);
  }
  
  thead.append(tr);
  const tbody = el("tbody","");
  
  for (const r of rows) {
    const tr = el("tr","");
    const cells: Array<[string, string]> = [
      [r.itemId.replace(/_log|_ore/, ""), "color:#b7c5b7"],
      [r.lowestAsk > 0 ? String(r.lowestAsk) : "—", "color:#69e56f;font-weight:900"],
      [r.highestBid > 0 ? String(r.highestBid) : "—", "color:#74d8ff"],
      [r.spread !== null ? String(r.spread) : "—", spreadClass(r.spreadPct)],
      [r.spreadPct !== null ? r.spreadPct.toFixed(1) + "%" : "—", spreadClass(r.spreadPct)],
      [r.forSale > 0 ? String(r.forSale) : "—", "color:#f5f5e9"],
      [r.lastPrice > 0 ? String(r.lastPrice) : "—", "color:#b47fff"],
      [invOk ? String(r.owned) : "?", invOk ? (r.owned > 0 ? "color:#69e56f;font-weight:900" : "color:#666") : "color:#666"],
    ];
    for (const [text, style] of cells) {
      tr.append(el("td", `text-align:right;padding:2px 3px;border-bottom:1px solid rgba(255,255,255,.05);${style}`, text));
    }
    tbody.append(tr);
  }
  
  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

function renderStatus(): HTMLElement {
  const root = el("div", "font-size:10px");
  const data = readMarket();
  const total = data.wood.length + data.ore.length;

  const badge = el("div", "display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:9px");
  const invBadge = el("span", `padding:1px 5px;border-radius:3px;font-weight:900;background:${data.invOk ? "rgba(105,229,111,.2)" : "rgba(255,101,90,.2)"};color:${data.invOk ? "#69e56f" : "#ff655a"}`, data.invOk ? "Inv ✓" : "Inv ?");
  invBadge.title = "Inventaire lu via wildstatCoop.ores()";
  badge.append(invBadge);
  
  if (total === 0) {
    badge.append(el("span", "color:#ffd85b", data.inTown ? "⏳ en ville — abonnement en cours" : "📍 entre en ville"));
  } else {
    badge.append(el("span", "color:#69e56f", `✅ ${data.wood.length} bois · ${data.ore.length} minerai`));
  }
  root.append(badge);

  if (total === 0) {
    root.append(el("div", "color:#888;font-style:italic;padding:6px", data.inTown ? "Les prix se chargent…" : "L'Exchange n'est lisible qu'en ville."));
    return root;
  }

  root.append(renderTable(data.wood, "Bois", "#6c6", data.invOk));
  root.append(renderTable(data.ore, "Minerai", "#c96", data.invOk));

  const copyBtn = el("button", "margin-top:4px;padding:3px 6px;font:inherit;cursor:pointer;background:rgba(255,255,255,.06);color:#f5f5e9;border:0;border-radius:3px", "📋 Copier TSV");
  copyBtn.addEventListener("click", async () => {
    const lines = [`# Exchange Prices — ${new Date().toISOString()}`];
    for (const [label, rows] of [["BOIS", data.wood], ["MINERAI", data.ore]] as const) {
      lines.push(`# ${label} (${rows.length})`);
      lines.push(["Item", "Ask", "Bid", "Spread", "Spread%", "Qty", "LastPrice", "Inv"].join("\t"));
      for (const r of rows) {
        lines.push([
          r.itemId,
          r.lowestAsk || "",
          r.highestBid || "",
          r.spread ?? "",
          r.spreadPct !== null ? r.spreadPct.toFixed(1) : "",
          r.forSale || "",
          r.lastPrice || "",
          data.invOk ? r.owned : "",
        ].join("\t"));
      }
      lines.push("");
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      copyBtn.textContent = "✅ Copié";
      setTimeout(() => { copyBtn.textContent = "📋 Copier TSV"; }, 1500);
    } catch {
      copyBtn.textContent = "❌ Échec";
      setTimeout(() => { copyBtn.textContent = "📋 Copier TSV"; }, 1500);
    }
  });
  root.append(copyBtn);
  return root;
}

export function registerTradeMarketMod(): void {
  REGISTERED_MODS.push({
    id: "trade-market",
    name: "Market",
    category: "TRADE",
    description: "Prix de l'Autel des ventes (bois/minerai), spread, inventaire.",
    switch: {
      label: "Forcer abonnement",
      get: isForceSubscribe,
      set: setForceSubscribe,
    },
    status: {
      render: renderStatus,
      intervalMs: INTERVAL_MS,
    },
    install: () => {
      if (isForceSubscribe()) {
        const coop = getCoop();
        try { coop?.followExchange?.(true); } catch { /* idem */ }
      }
    },
  });
}