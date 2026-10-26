import { describe, expect, it, vi } from "vitest";
import { ConnectionId } from "spacetimedb";
import { crystalFixture, identity, server } from "../../tests/helpers/crystal-hollows-fixture";
import { progressOf } from "../../tests/helpers/progress";
import { TOWN_EXCHANGE_POSITION, TOWN_FEET_OFFSET } from "../../shared/town";
import { PROTOCOL_VERSION, SPACETIME_AUTH_CLIENT_ID, SPACETIME_AUTH_ISSUER } from "../../shared/rules";
import { IRON_BOW } from "../../shared/items";
import { addOres, oreCount, refineLevelFor, setRefineLevel } from "./item-refine";
import { addGold, goldFor } from "./gold";
import { inventoryForProgress } from "./progress-helpers";
import { weaponSkillRollFor } from "./weapon-skills";
import { setFirstCopyRoll } from "./equipment-copies";
import { forfeitExchange } from "./exchange";
vi.mock("spacetimedb/server", () => import("../../tests/helpers/spacetime-module"));

const SELLER = identity("1"), BUYER = identity("2");
const SIGNED_IN = { jwt: { issuer: SPACETIME_AUTH_ISSUER, audience: [SPACETIME_AUTH_CLIENT_ID] } };

/** Two signed-in players standing at the clerk, the seller with copper and the buyer with gold. */
function market() {
  const f = crystalFixture();
  const at = { mapId: "town", x: TOWN_EXCHANGE_POSITION.x, y: TOWN_EXCHANGE_POSITION.y - TOWN_FEET_OFFSET };
  f.patch("player", at);
  f.progress(BUYER);
  f.seed("player", { identity: BUYER, ...at, hp: 100, maxHp: 100, speed: 180, protocolVersion: PROTOCOL_VERSION, lastInputAt: f.ctx.timestamp });
  f.seed("playerProfile", { identity: BUYER, displayName: "Buyer", skinTone: 3 });
  f.seed("playerSession", { connectionId: new ConnectionId(2n), identity: BUYER, enteredWorld: true, protocolVersion: PROTOCOL_VERSION,
    connectedAt: f.ctx.timestamp, tabId: "buyer" });
  f.seed("playerController", { identity: BUYER, connectionId: new ConnectionId(2n) });
  f.transaction(() => { addOres(f.ctx, SELLER, "copper_ore", 100); addGold(f.ctx, BUYER, 10_000); });
  f.ctx.senderAuth = SIGNED_IN;
  const as = (who: typeof SELLER) => {
    f.ctx.sender = who;
    f.ctx.connectionId = new ConnectionId(who === SELLER ? 1n : 2n);
  };
  const collect = () => f.run(server.collectExchange);
  return { ...f, as, collect };
}

describe("Trade Chrysanthemum resources", () => {
  it("holds a sale, fills it at the waiting price, refunds the buyer's surplus and takes the fee", () => {
    const f = market();
    f.as(SELLER);
    f.run(server.placeExchangeOffer, { buy: false, itemId: "copper_ore", quantity: 50, price: 10n });
    expect(oreCount(f.ctx, SELLER, "copper_ore")).toBe(50);
    f.as(BUYER);
    f.run(server.placeExchangeOffer, { buy: true, itemId: "copper_ore", quantity: 20, price: 15n });
    // 20 at the seller's 10 each: the buyer set aside 300 and gets 100 back; the seller gets 200 less 2%.
    expect(goldFor(f.ctx, BUYER)).toBe(10_000n - 200n);
    expect(goldFor(f.ctx, SELLER)).toBe(196n);
    f.collect();
    expect(oreCount(f.ctx, BUYER, "copper_ore")).toBe(20);
    const [left] = [...f.db.exchangeOffer.iter()];
    expect(left).toMatchObject({ buy: false, quantity: 50, filled: 20 });
    // The price line browsing reads: 30 left at 10, last traded at 10.
    expect(f.db.exchangePrice.itemId.find("copper_ore")).toMatchObject({ lowestAsk: 10n, highestBid: 0n, forSale: 30, lastPrice: 10n });
    // The buyer's offer traded in full as it went up: a letter says so, at the 200 it cost, not the 300 set aside.
    // The seller's, only part filled, gets none yet.
    const letters = (who: typeof SELLER) => [...f.db.playerMail.iter()].filter((mail: any) => mail.identity.toHexString() === who.toHexString());
    expect(letters(SELLER)).toEqual([]);
    expect(letters(BUYER).map((mail: any) => mail.body)).toEqual([expect.stringContaining("for 200 Gold")]);
    f.run(server.placeExchangeOffer, { buy: true, itemId: "copper_ore", quantity: 10, price: 10n });
    f.run(server.placeExchangeOffer, { buy: true, itemId: "copper_ore", quantity: 20, price: 10n });
    // The last 30 complete the seller's: one letter, never one a fill.
    expect(letters(SELLER)).toHaveLength(1);
  });

  it("gives back what is left on cancel: gold for a buy, the resources for a sale", () => {
    const f = market();
    f.as(BUYER);
    f.run(server.placeExchangeOffer, { buy: true, itemId: "iron_ore", quantity: 10, price: 7n });
    expect(goldFor(f.ctx, BUYER)).toBe(10_000n - 70n);
    const [buy] = [...f.db.exchangeOffer.iter()];
    f.run(server.cancelExchangeOffer, { id: buy.id });
    expect(goldFor(f.ctx, BUYER)).toBe(10_000n);
    f.as(SELLER);
    f.run(server.placeExchangeOffer, { buy: false, itemId: "copper_ore", quantity: 30, price: 5n });
    const [sale] = [...f.db.exchangeOffer.iter()];
    f.run(server.cancelExchangeOffer, { id: sale.id });
    f.collect();
    expect(oreCount(f.ctx, SELLER, "copper_ore")).toBe(100);
    // A free player has three slots: three go up, a fourth does not.
    f.as(BUYER);
    for (const itemId of ["iron_ore", "oak_log", "pine_log"]) f.run(server.placeExchangeOffer, { buy: true, itemId, quantity: 1, price: 1n });
    expect(() => f.run(server.placeExchangeOffer, { buy: true, itemId: "yew_log", quantity: 1, price: 1n })).toThrow("slots");
  });

  it("refuses guests, players away from the clerk, cards and amounts out of range", () => {
    const f = market();
    f.as(SELLER);
    const place = (args: Record<string, unknown>) => f.run(server.placeExchangeOffer, { buy: false, itemId: "copper_ore", quantity: 1, price: 1n, ...args });
    expect(() => place({ quantity: 0 })).toThrow();
    expect(() => place({ quantity: 101 })).toThrow("do not have");
    expect(() => place({ itemId: "starter_stone" })).toThrow("cannot be traded");
    f.ctx.senderAuth = {};
    expect(() => place({})).toThrow("Sign in");
    f.ctx.senderAuth = SIGNED_IN;
    f.patch("player", { x: TOWN_EXCHANGE_POSITION.x + 2_000 });
    expect(() => place({})).toThrow("Walk up");
    expect(oreCount(f.ctx, SELLER, "copper_ore")).toBe(100);
  });
});

describe("Trade Chrysanthemum gear", () => {
  it("moves the exact piece, refine and roll included, and pays the seller less the fee", () => {
    const f = market();
    f.as(SELLER);
    f.transaction(() => {
      f.db.playerProgress.identity.update({ ...f.db.playerProgress.identity.find(SELLER), inventoryJson: JSON.stringify([IRON_BOW]) });
      setFirstCopyRoll(f.ctx, SELLER, IRON_BOW, { arrowStorm: 12, ricochet: 3 });
      setRefineLevel(f.ctx, SELLER, IRON_BOW, 0n, 7);
    });
    f.run(server.listExchangeGear, { itemId: IRON_BOW, copyId: 0n, price: 1_000n });
    expect(inventoryForProgress(progressOf(f, SELLER))).not.toContain(IRON_BOW);
    const [listing] = [...f.db.exchangeListing.iter()];
    f.as(BUYER);
    f.run(server.buyExchangeGear, { id: listing.id });
    expect(goldFor(f.ctx, BUYER)).toBe(9_000n);
    expect(goldFor(f.ctx, SELLER)).toBe(980n);
    f.collect();
    expect(inventoryForProgress(progressOf(f, BUYER))).toContain(IRON_BOW);
    expect(refineLevelFor(f.ctx, BUYER, IRON_BOW)).toBe(7);
    expect(weaponSkillRollFor(f.ctx as never, BUYER, IRON_BOW)).toMatchObject({ arrowStorm: 12, ricochet: 3 });
  });

  it("will not list worn gear, and Reset Save forfeits what is on the exchange", () => {
    const f = market();
    f.as(SELLER);
    f.transaction(() => f.db.playerProgress.identity.update({ ...f.db.playerProgress.identity.find(SELLER),
      inventoryJson: JSON.stringify([IRON_BOW]), equippedRightHand: IRON_BOW }));
    expect(() => f.run(server.listExchangeGear, { itemId: IRON_BOW, copyId: 0n, price: 5n })).toThrow("Take it off");
    f.run(server.placeExchangeOffer, { buy: false, itemId: "copper_ore", quantity: 10, price: 5n });
    expect([...f.db.exchangeOffer.iter()]).toHaveLength(1);
    f.transaction(() => forfeitExchange(f.ctx, SELLER));
    expect([...f.db.exchangeOffer.iter()]).toHaveLength(0);
  });
});
