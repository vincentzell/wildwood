// The Trade Chrysanthemum (shared/exchange.ts): resource offers matched like an order book, gear listed at a
// fixed price. What is offered leaves the bag at once and waits here; what is bought or handed back waits in
// the owner's collection box until there is room for it.
import { table, t, SenderError } from "spacetimedb/server";
import type { Identity } from "spacetimedb";
import type spacetimedbType from "./index";
import { canonicalItemId } from "../../shared/items";
import { isTownMap, TOWN_EXCHANGE_POSITION, TOWN_EXCHANGE_SERVER_REACH, TOWN_FEET_OFFSET } from "../../shared/town";
import { EXCHANGE_FEE_PERCENT, exchangeFee, exchangeOfferSlots, exchangePrice, exchangeQuantity, EXCHANGE_HISTORY, isExchangeGear,
  isExchangeResource } from "../../shared/exchange";
import type { WeaponSkillRoll } from "../../shared/weapon-skills";
import { hasSpacetimeAuthAccount } from "./session-guards";
import { withinStationReach } from "./door-reach";
import { readPlayerProgress } from "./wide-stats";
import { equipmentLocked } from "./equipment-locks";
import { challengeActive } from "./prestige-challenge";
import { patreonStatus } from "./patreon";
import { takeGold } from "./gold";
import { addOres, oreCount, refineLevelFor, setRefineLevel, takeOres } from "./item-refine";
import { weaponSkillRollFor } from "./weapon-skills";
import { collectItem, copyRollOf, freeBagSlots, insertKeptCopy, setFirstCopyRoll } from "./equipment-copies";
import { sendPersonalMail } from "./dev-review-mail";
import { REFINE_ORES } from "../../shared/refine";
import { itemDisplayName } from "../../shared/items";

type Ctx = any;

export const exchangeTables = {
  /** Open resource offers: `buy` holds price × what is left in gold, a sell holds what is left. */
  exchangeOffer: table({ name: "exchange_offer", public: true }, {
    id: t.u64().primaryKey().autoInc(), identity: t.identity().index("btree"), name: t.string(), nameColor: t.u8(), buy: t.bool(), itemId: t.string().index("btree"),
    price: t.u64(), quantity: t.u32(), filled: t.u32(), placedAt: t.timestamp(),
  }),
  /** Gear on sale, each piece with the roll and refine it left the seller's bag with. */
  exchangeListing: table({ name: "exchange_listing", public: true }, {
    id: t.u64().primaryKey().autoInc(), identity: t.identity().index("btree"), name: t.string(), nameColor: t.u8(), itemId: t.string().index("btree"),
    rollJson: t.string(), refine: t.u8(), price: t.u64(), listedAt: t.timestamp(),
  }),
  /** Waiting for its owner: resources (count > 0) or one gear piece (count 0). Read through my_exchange_collect. */
  exchangeCollect: table({ name: "exchange_collect", public: false }, {
    id: t.u64().primaryKey().autoInc(), identity: t.identity().index("btree"), itemId: t.string(), count: t.u32(),
    rollJson: t.string(), refine: t.u8(), arrivedAt: t.timestamp(),
  }),
  /**
   * One row per item on the market: what the browse grid and an offer's price line read, so a client never needs
   * every offer to see prices. 0 means none. Kept up to date by every change to that item's offers and listings.
   */
  exchangePrice: table({ name: "exchange_price", public: true }, {
    itemId: t.string().primaryKey(), lowestAsk: t.u64(), highestBid: t.u64(), forSale: t.u32(), lastPrice: t.u64(), updatedAt: t.timestamp(),
  }),
  /** The latest trades, for the price guide. */
  exchangeTrade: table({ name: "exchange_trade", public: true }, {
    id: t.u64().primaryKey().autoInc(), itemId: t.string(), price: t.u64(), quantity: t.u32(), tradedAt: t.timestamp(),
  }),
};

export type ExchangeDeps = {
  requireControllingPlayer: (ctx: Ctx) => any;
  activeDuelFor: (ctx: Ctx, identity: Identity) => unknown;
  inventoryForProgress: (progress: any) => string[];
  restoreItemToProgress: (progress: any, itemId: string) => any;
  writeProgressAndPresentation: (ctx: Ctx, progress: any) => unknown;
  /** One copy out of the sender's bag (equipment-copies.ts removeCopy). */
  removeCopy: (ctx: Ctx, itemId: string, copyId: bigint) => void;
};

const same = (a: Identity, b: Identity) => a.toHexString() === b.toHexString();
/** The name buyers see on an offer, as it was when it went up. */
const traderName = (ctx: Ctx) => ctx.db.playerProfile.identity.find(ctx.sender)?.displayName || "A trader";
/** Their chat name color, so buyers see the name as it looks in chat (0 is Auto). */
const traderColor = (ctx: Ctx) => ctx.db.playerNameColor.identity.find(ctx.sender)?.color ?? 0;
const CLERK = { x: TOWN_EXCHANGE_POSITION.x, y: TOWN_EXCHANGE_POSITION.y - TOWN_FEET_OFFSET };

/** Gold in, exact: addGold takes a number, which loses whole gold past 2^53. */
export function creditGold(ctx: Ctx, identity: Identity, amount: bigint) {
  if (amount <= 0n) return;
  const row = ctx.db.playerGold.identity.find(identity);
  if (row) ctx.db.playerGold.identity.update({ ...row, gold: row.gold + amount });
  else ctx.db.playerGold.insert({ identity, gold: amount });
}

const rollJsonOf = (roll: WeaponSkillRoll) => JSON.stringify(roll ?? {});
function rollOf(json: string): WeaponSkillRoll {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === "number" && Number.isFinite(value))) as WeaponSkillRoll;
  } catch { return {}; }
}

/**
 * Puts resources (count > 0) or one gear piece (count 0) in a player's bag, whoever is acting, or says why it cannot
 * (a full bag). Bought things arrive this way without a trip to the clerk.
 */
function deliver(ctx: Ctx, deps: ExchangeDeps, identity: Identity, itemId: string, count: number, rollJson: string, refine: number): string | null {
  const progress = readPlayerProgress(ctx, identity);
  if (!progress) return "Player unavailable.";
  const inventory = deps.inventoryForProgress(progress);
  const free = freeBagSlots(ctx, identity, progress, inventory);
  if (count > 0) {
    if (!isExchangeResource(itemId)) return null;
    if (oreCount(ctx, identity, itemId) <= 0 && free <= 0) return "Your bag is full. Free a slot to collect.";
    addOres(ctx, identity, itemId, count);
    return null;
  }
  if (free <= 0) return "Your bag is full. Free a slot to collect.";
  const roll = rollOf(rollJson);
  if (inventory.includes(itemId)) insertKeptCopy(ctx, identity, itemId, roll, refine);
  else {
    deps.writeProgressAndPresentation(ctx, deps.restoreItemToProgress(progress, itemId));
    setFirstCopyRoll(ctx, identity, itemId, roll);
    setRefineLevel(ctx, identity, itemId, 0n, refine);
  }
  collectItem(ctx, identity, itemId);
  return null;
}

/** Into the bag when it fits; otherwise, or during a challenge run (whose bag is put back after), the collection box. */
function toCollect(ctx: Ctx, deps: ExchangeDeps, identity: Identity, itemId: string, count: number, rollJson = "", refine = 0) {
  if (!challengeActive(ctx, identity) && deliver(ctx, deps, identity, itemId, count, rollJson, refine) === null) return;
  ctx.db.exchangeCollect.insert({ id: 0n, identity, itemId, count, rollJson, refine, arrivedAt: ctx.timestamp });
}

function recordTrade(ctx: Ctx, itemId: string, price: bigint, quantity: number) {
  const row = ctx.db.exchangeTrade.insert({ id: 0n, itemId, price, quantity, tradedAt: ctx.timestamp });
  // Ids count up, so the one that falls out of the history is a single delete, not a scan.
  if (row.id > BigInt(EXCHANGE_HISTORY)) ctx.db.exchangeTrade.id.delete(row.id - BigInt(EXCHANGE_HISTORY));
  const price_ = ctx.db.exchangePrice.itemId.find(itemId);
  if (price_) ctx.db.exchangePrice.itemId.update({ ...price_, lastPrice: price, updatedAt: ctx.timestamp });
  else ctx.db.exchangePrice.insert({ itemId, lowestAsk: 0n, highestBid: 0n, forSale: 0, lastPrice: price, updatedAt: ctx.timestamp });
}

/** Recounts one item's line on the price table from its own offers and listings (the itemId index, never the whole market). */
export function refreshPrice(ctx: Ctx, itemId: string) {
  let lowestAsk = 0n, highestBid = 0n, forSale = 0;
  for (const offer of ctx.db.exchangeOffer.itemId.filter(itemId)) {
    const left = offer.quantity - offer.filled;
    if (left <= 0) continue;
    if (offer.buy) { if (offer.price > highestBid) highestBid = offer.price; }
    else { forSale += left; if (lowestAsk === 0n || offer.price < lowestAsk) lowestAsk = offer.price; }
  }
  for (const listing of ctx.db.exchangeListing.itemId.filter(itemId)) {
    forSale += 1;
    if (lowestAsk === 0n || listing.price < lowestAsk) lowestAsk = listing.price;
  }
  const row = ctx.db.exchangePrice.itemId.find(itemId);
  const next = { itemId, lowestAsk, highestBid, forSale, lastPrice: row?.lastPrice ?? 0n, updatedAt: ctx.timestamp };
  if (row) {
    if (row.lowestAsk !== lowestAsk || row.highestBid !== highestBid || row.forSale !== forSale) ctx.db.exchangePrice.itemId.update(next);
  } else if (forSale > 0 || highestBid > 0n) ctx.db.exchangePrice.insert(next);
}

const openCount = (ctx: Ctx, identity: Identity) =>
  [...ctx.db.exchangeOffer.identity.filter(identity)].length + [...ctx.db.exchangeListing.identity.filter(identity)].length;

/** The checks every trade makes: signed in, in control, at the clerk, no duel, no challenge run. */
function requireTrader(ctx: Ctx, deps: ExchangeDeps) {
  const player = deps.requireControllingPlayer(ctx);
  if (!hasSpacetimeAuthAccount(ctx)) throw new SenderError("Sign in to use the Trade Chrysanthemum.");
  if (deps.activeDuelFor(ctx, ctx.sender)) throw new SenderError("Finish your duel first.");
  // A challenge run's bag is put back when it ends, so anything traded during one would come back.
  if (challengeActive(ctx, ctx.sender)) throw new SenderError("Finish your challenge run before trading.");
  if (!isTownMap(player.mapId) || !withinStationReach(ctx, player, CLERK, TOWN_EXCHANGE_SERVER_REACH)) {
    throw new SenderError("Walk up to the Trade Chrysanthemum to trade.");
  }
  return player;
}

function requireRoom(ctx: Ctx) {
  const supporter = patreonStatus(ctx, ctx.sender).tier !== "none", slots = exchangeOfferSlots(supporter);
  if (openCount(ctx, ctx.sender) < slots) return;
  throw new SenderError(slots > 1 ? `Your ${slots} slots are full.` : "Your slot is in use.");
}

/** Fills `incoming` against the best opposite offers, each at the price of the one that was waiting. */
function match(ctx: Ctx, deps: ExchangeDeps, incoming: any) {
  let left = incoming.quantity - incoming.filled, traded = 0n;
  const waiting = [...ctx.db.exchangeOffer.itemId.filter(incoming.itemId)]
    .filter((offer: any) => offer.buy !== incoming.buy && !same(offer.identity, incoming.identity) && offer.quantity > offer.filled
      && (incoming.buy ? offer.price <= incoming.price : offer.price >= incoming.price))
    .sort((a: any, b: any) => (a.price === b.price ? (a.id < b.id ? -1 : 1) : (incoming.buy ? (a.price < b.price ? -1 : 1) : (a.price > b.price ? -1 : 1))));
  for (const offer of waiting) {
    if (left <= 0) break;
    const quantity = Math.min(left, offer.quantity - offer.filled), price: bigint = offer.price;
    const buy = incoming.buy ? incoming : offer, sell = incoming.buy ? offer : incoming;
    const total = price * BigInt(quantity);
    traded += total;
    creditGold(ctx, sell.identity, total - exchangeFee(total));
    // The buyer set aside their own price; anything under it comes back.
    creditGold(ctx, buy.identity, (buy.price - price) * BigInt(quantity));
    toCollect(ctx, deps, buy.identity, incoming.itemId, quantity);
    recordTrade(ctx, incoming.itemId, price, quantity);
    left -= quantity;
    const filled = { ...offer, filled: offer.filled + quantity };
    settle(ctx, filled);
    if (filled.filled >= filled.quantity) mailComplete(ctx, filled);
  }
  settle(ctx, { ...incoming, filled: incoming.quantity - left });
  // Traded in full the moment it went up: it never shows in a slot, so a letter says what it fetched.
  if (left <= 0 && incoming.filled < incoming.quantity) mailComplete(ctx, incoming, traded);
}

const goldText = (gold: bigint) => gold.toLocaleString("en-US");
// Gear names are stored in capitals ("STONE BOW"); letters read them in Title Case.
const nameOf = (itemId: string) => isExchangeResource(itemId) ? REFINE_ORES[itemId].name
  : itemDisplayName(itemId).toLowerCase().replace(/(^|[\s/-])([a-z])/g, (_, gap: string, letter: string) => gap + letter.toUpperCase());

/**
 * A letter when an offer completes: one that was waiting filled, or one traded in full as it went up. `total` is
 * the gold it traded for: the waiting side's own price, or each fill's for one that traded at once.
 */
function mailComplete(ctx: Ctx, offer: any, total: bigint = offer.price * BigInt(offer.quantity)) {
  const item = `${offer.quantity.toLocaleString("en-US")} ${nameOf(offer.itemId)}`;
  sendPersonalMail(ctx, { key: `exchange-offer-${offer.id}`, identity: offer.identity, title: "Trade Chrysanthemum: Offer Complete",
    body: offer.buy
      ? `You bought ${item} for ${goldText(total)} Gold. It went to your bag, or waits at the Trade Chrysanthemum if your bag was full.`
      : `You sold ${item} for ${goldText(total)} Gold, less the ${EXCHANGE_FEE_PERCENT}% fee. The gold is already yours.` });
}

/** Writes an offer's fill, and drops it once it is complete. */
function settle(ctx: Ctx, offer: any) {
  if (offer.filled >= offer.quantity) ctx.db.exchangeOffer.id.delete(offer.id);
  else ctx.db.exchangeOffer.id.update(offer);
}

export function placeExchangeOfferFor(ctx: Ctx, args: { buy: boolean; itemId: string; quantity: number; price: bigint }, deps: ExchangeDeps) {
  requireTrader(ctx, deps);
  const itemId = args.itemId, quantity = exchangeQuantity(args.quantity), price = exchangePrice(args.price);
  if (!isExchangeResource(itemId)) throw new SenderError("That cannot be traded here.");
  if (quantity === null || price === null) throw new SenderError("Enter a quantity and a price.");
  requireRoom(ctx);
  if (args.buy) {
    if (!takeGold(ctx, ctx.sender, price * BigInt(quantity))) throw new SenderError("Not enough gold.");
  } else if (oreCount(ctx, ctx.sender, itemId) < quantity || !takeOres(ctx, ctx.sender, { [itemId]: quantity })) {
    throw new SenderError("You do not have that many.");
  }
  const offer = ctx.db.exchangeOffer.insert({ id: 0n, identity: ctx.sender, name: traderName(ctx), nameColor: traderColor(ctx), buy: args.buy, itemId, price, quantity, filled: 0, placedAt: ctx.timestamp });
  match(ctx, deps, offer);
  refreshPrice(ctx, itemId);
}

export function cancelExchangeOfferFor(ctx: Ctx, id: bigint, deps: ExchangeDeps) {
  deps.requireControllingPlayer(ctx);
  const offer = ctx.db.exchangeOffer.id.find(id);
  if (!offer || !same(offer.identity, ctx.sender)) throw new SenderError("That offer is not yours.");
  const left = offer.quantity - offer.filled;
  ctx.db.exchangeOffer.id.delete(offer.id);
  if (offer.buy) creditGold(ctx, ctx.sender, offer.price * BigInt(left));
  else if (left > 0) toCollect(ctx, deps, ctx.sender, offer.itemId, left);
  refreshPrice(ctx, offer.itemId);
}

export function listExchangeGearFor(ctx: Ctx, args: { itemId: string; copyId: bigint; price: bigint }, deps: ExchangeDeps) {
  requireTrader(ctx, deps);
  const itemId = canonicalItemId(args.itemId), price = exchangePrice(args.price);
  if (!itemId || !isExchangeGear(itemId)) throw new SenderError("That cannot be traded here.");
  if (price === null) throw new SenderError("Enter a price.");
  requireRoom(ctx);
  const progress = readPlayerProgress(ctx, ctx.sender);
  if (!progress || !deps.inventoryForProgress(progress).includes(itemId)) throw new SenderError("That item is not in your inventory.");
  const worn = [progress.equippedHead, progress.equippedChest, progress.equippedFeet, progress.equippedRightHand, progress.equippedLeftHand];
  if (args.copyId === 0n && worn.includes(itemId)) throw new SenderError("Take it off before selling it.");
  if (equipmentLocked(ctx, ctx.sender, itemId, args.copyId)) throw new SenderError("Unlock this equipment before selling it.");
  let roll: WeaponSkillRoll;
  if (args.copyId === 0n) roll = weaponSkillRollFor(ctx, ctx.sender, itemId);
  else {
    const copy = ctx.db.playerEquipmentCopy.id.find(args.copyId);
    if (!copy || !same(copy.identity, ctx.sender) || copy.itemId !== itemId) throw new SenderError("That copy is not in your inventory.");
    roll = copyRollOf(ctx, copy);
  }
  const refine = refineLevelFor(ctx, ctx.sender, itemId, args.copyId);
  deps.removeCopy(ctx, itemId, args.copyId);
  ctx.db.exchangeListing.insert({ id: 0n, identity: ctx.sender, name: traderName(ctx), nameColor: traderColor(ctx), itemId, rollJson: rollJsonOf(roll), refine, price, listedAt: ctx.timestamp });
  refreshPrice(ctx, itemId);
}

export function buyExchangeGearFor(ctx: Ctx, id: bigint, deps: ExchangeDeps) {
  requireTrader(ctx, deps);
  const listing = ctx.db.exchangeListing.id.find(id);
  if (!listing) throw new SenderError("Someone else bought it first.");
  if (same(listing.identity, ctx.sender)) throw new SenderError("That is your own listing.");
  if (!takeGold(ctx, ctx.sender, listing.price)) throw new SenderError("Not enough gold.");
  ctx.db.exchangeListing.id.delete(listing.id);
  creditGold(ctx, listing.identity, listing.price - exchangeFee(listing.price));
  toCollect(ctx, deps, ctx.sender, listing.itemId, 0, listing.rollJson, listing.refine);
  refreshPrice(ctx, listing.itemId);
  sendPersonalMail(ctx, { key: `exchange-listing-${listing.id}`, identity: listing.identity, title: "Trade Chrysanthemum: Sold",
    body: `Your ${nameOf(listing.itemId)}${listing.refine ? ` ★${listing.refine}` : ""} sold for ${goldText(listing.price)} Gold, less the ${EXCHANGE_FEE_PERCENT}% fee. The gold is already yours.` });
  recordTrade(ctx, listing.itemId, listing.price, 1);
}

export function cancelExchangeListingFor(ctx: Ctx, id: bigint, deps: ExchangeDeps) {
  deps.requireControllingPlayer(ctx);
  const listing = ctx.db.exchangeListing.id.find(id);
  if (!listing || !same(listing.identity, ctx.sender)) throw new SenderError("That listing is not yours.");
  ctx.db.exchangeListing.id.delete(listing.id);
  toCollect(ctx, deps, ctx.sender, listing.itemId, 0, listing.rollJson, listing.refine);
  refreshPrice(ctx, listing.itemId);
}

/** Puts one collection-box row in the bag, or says why it cannot. */
function collectRow(ctx: Ctx, row: any, deps: ExchangeDeps): string | null {
  const blocked = deliver(ctx, deps, ctx.sender, row.itemId, row.count, row.rollJson, row.refine);
  if (!blocked) ctx.db.exchangeCollect.id.delete(row.id);
  return blocked;
}

/** Collects everything that fits, oldest first. */
export function collectExchangeFor(ctx: Ctx, deps: ExchangeDeps) {
  deps.requireControllingPlayer(ctx);
  const rows = [...ctx.db.exchangeCollect.identity.filter(ctx.sender)].sort((a: any, b: any) => (a.id < b.id ? -1 : 1));
  let blocked: string | null = null;
  for (const row of rows) blocked = collectRow(ctx, row, deps) ?? blocked;
  if (blocked && rows.every((row: any) => ctx.db.exchangeCollect.id.find(row.id))) throw new SenderError(blocked);
}

/** Reset Save takes the run's gold and gear, so what was on the exchange goes with them. */
export function forfeitExchange(ctx: Ctx, identity: Identity) {
  const items = new Set<string>();
  for (const table of [ctx.db.exchangeOffer, ctx.db.exchangeListing, ctx.db.exchangeCollect]) {
    for (const row of [...table.identity.filter(identity)]) { items.add(row.itemId); table.id.delete(row.id); }
  }
  for (const itemId of items) refreshPrice(ctx, itemId);
}

export function registerExchange(spacetimedb: typeof spacetimedbType, deps: ExchangeDeps) {
  const placeExchangeOffer = spacetimedb.reducer({ buy: t.bool(), itemId: t.string(), quantity: t.u32(), price: t.u64() },
    (ctx: any, args: any) => placeExchangeOfferFor(ctx, args, deps));
  const cancelExchangeOffer = spacetimedb.reducer({ id: t.u64() }, (ctx: any, { id }: { id: bigint }) => cancelExchangeOfferFor(ctx, id, deps));
  const listExchangeGear = spacetimedb.reducer({ itemId: t.string(), copyId: t.u64(), price: t.u64() },
    (ctx: any, args: any) => listExchangeGearFor(ctx, args, deps));
  const buyExchangeGear = spacetimedb.reducer({ id: t.u64() }, (ctx: any, { id }: { id: bigint }) => buyExchangeGearFor(ctx, id, deps));
  const cancelExchangeListing = spacetimedb.reducer({ id: t.u64() }, (ctx: any, { id }: { id: bigint }) => cancelExchangeListingFor(ctx, id, deps));
  const collectExchange = spacetimedb.reducer({}, (ctx: any) => collectExchangeFor(ctx, deps));
  const myExchangeCollect = spacetimedb.view({ name: "my_exchange_collect", public: true }, t.array(exchangeTables.exchangeCollect.rowType),
    (ctx: any) => [...ctx.db.exchangeCollect.identity.filter(ctx.sender)]);
  // A player's own offers and listings, so their slots never need the whole market.
  const myExchangeOffers = spacetimedb.view({ name: "my_exchange_offers", public: true }, t.array(exchangeTables.exchangeOffer.rowType),
    (ctx: any) => [...ctx.db.exchangeOffer.identity.filter(ctx.sender)]);
  const myExchangeListings = spacetimedb.view({ name: "my_exchange_listings", public: true }, t.array(exchangeTables.exchangeListing.rowType),
    (ctx: any) => [...ctx.db.exchangeListing.identity.filter(ctx.sender)]);
  return { placeExchangeOffer, cancelExchangeOffer, listExchangeGear, buyExchangeGear, cancelExchangeListing, collectExchange,
    myExchangeCollect, myExchangeOffers, myExchangeListings };
}
