import { cardDefinition, type CardDefinition } from "../../shared/cards";
import { cardShopOffer, cardShopPrice, cardShopRotation, cardShopRotationEndsAt } from "../../shared/card-shop";
import { CARD_SLOT_NAMES, cardEffectText, cardName, cardOrigin } from "../../shared/card-text";
import { REFINE_ORES, type OreId } from "../../shared/refine";
import { REFINE_ORE_ORDER } from "../../shared/ore-bag";
import { cardTile } from "./cards-tab";
import { fillCardEffect } from "./card-effect-line";

type Result = { ok: boolean; error?: string } | undefined;
type Ores = Readonly<Partial<Record<OreId, number>>>;

/** How long until the next cards: "2h 14m", "14m", or "45s" in the last minute. */
export function cardShopCountdown(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m` : `${seconds}s`;
}

/**
 * The Card Seller's window, at the market stall on the Town's square: the rotation's three cards, what each
 * costs in ore, and a Buy for each. The server checks and takes the ore (buy_shop_card); this window shows the
 * offer, which every client works out the same way (shared/card-shop.ts), and when it changes.
 */
export function createCardSellerController(deps: {
  inTown: () => boolean;
  clearInput?: () => void;
  showMessage: (text: string, color: string) => void;
  /** The clock the offer follows; the server's rotation is the one that counts. */
  now?: () => number;
  ores: () => Ores;
  cards: () => Readonly<Record<string, number>>;
  bought: (rotation: number) => readonly string[];
  buy: (rotation: number, cardId: string) => Promise<Result>;
}) {
  const now = deps.now ?? (() => Date.now());
  const dialog = document.createElement("dialog");
  dialog.className = "farm-sheet quest-sheet smith-sheet card-seller-sheet";
  dialog.setAttribute("aria-labelledby", "cardSellerTitle");
  dialog.innerHTML = `<header class="farm-header"><h2 id="cardSellerTitle" class="window-banner"><span>Card Seller</span></h2></header>`
    + `<div class="quest-body"><p class="farm-map smith-intro">Three cards for ore. Each one can be bought once before the cards change.</p>`
    + `<p class="card-seller-timer" aria-live="polite"></p>`
    + `<div class="card-seller-offers" role="list" aria-label="Cards for sale"></div>`
    + `<p class="smith-outcome" hidden></p>`
    + `<p class="smith-ores" aria-label="Your ores"></p></div>`
    + `<footer class="farm-footer"><div class="farm-actions"><button type="button" class="window-back-button">Back</button></div></footer>`;
  document.body.append(dialog);
  const timer = dialog.querySelector<HTMLElement>(".card-seller-timer")!;
  const offers = dialog.querySelector<HTMLElement>(".card-seller-offers")!;
  const outcome = dialog.querySelector<HTMLElement>(".smith-outcome")!;
  const oreLine = dialog.querySelector<HTMLElement>(".smith-ores")!;
  const back = dialog.querySelector<HTMLButtonElement>(".window-back-button")!;
  let buying: string | null = null;
  /** Bought here and on its way: the button reads Bought before the server's row arrives. */
  const justBought = new Set<string>();
  let lastResult: { text: string; good: boolean } | null = null;
  let shownRotation = -1;
  let renderedState = "";
  let ticker: ReturnType<typeof setInterval> | null = null;

  function offerRow(card: CardDefinition, rotation: number, bought: boolean, held: Ores) {
    const row = document.createElement("article");
    row.className = `card-seller-offer is-${card.rarity}`;
    row.setAttribute("role", "listitem");
    row.dataset.cardId = card.id;
    const art = document.createElement("div");
    art.className = "inventory-items card-seller-art";
    // The card as the bag shows it, with the count held; the name and the rest are beside it.
    art.setAttribute("aria-hidden", "true");
    const tile = cardTile(card, deps.cards()[card.id] ?? 0, () => {});
    tile.tabIndex = -1;
    art.append(tile);
    const copy = document.createElement("div");
    copy.className = "card-seller-copy";
    const name = document.createElement("strong");
    name.textContent = cardName(card);
    const origin = document.createElement("span");
    origin.className = `card-origin is-${card.rarity}`;
    origin.textContent = cardOrigin(card);
    const slot = document.createElement("span");
    slot.className = "card-seller-slot";
    slot.textContent = `Goes In: ${CARD_SLOT_NAMES[card.slot]}`;
    const effects = document.createElement("ul");
    effects.className = "smith-card-effects card-seller-effects";
    for (const effect of card.effects) {
      const line = document.createElement("li");
      fillCardEffect(line, cardEffectText(effect));
      if (effect.value < 0) line.className = "is-cost";
      effects.append(line);
    }
    const price = cardShopPrice(card.id) ?? {};
    const cost = document.createElement("ul");
    cost.className = "card-seller-price";
    cost.setAttribute("aria-label", "Price");
    const short: OreId[] = [];
    for (const [oreId, count] of Object.entries(price) as [OreId, number][]) {
      const have = held[oreId] ?? 0;
      if (have < count) short.push(oreId);
      const line = document.createElement("li");
      if (have < count) line.className = "is-short";
      line.innerHTML = "<span></span><span class=\"card-seller-have\"></span>";
      line.firstElementChild!.textContent = `${count} ${REFINE_ORES[oreId].name}`;
      line.lastElementChild!.textContent = `You Have ${have.toLocaleString()}`;
      cost.append(line);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "farm-start smith-refine card-seller-buy";
    button.textContent = bought ? "Bought" : buying === card.id ? "Buying…" : short.length ? `Need ${short.map(oreId => REFINE_ORES[oreId].name).join(" + ")}` : "Buy";
    button.disabled = bought || buying !== null || short.length > 0;
    button.addEventListener("click", () => { void buy(rotation, card); });
    copy.append(name, origin, slot, effects, cost, button);
    row.append(art, copy);
    return row;
  }

  function render() {
    const at = now(), rotation = cardShopRotation(at);
    // A new rotation is a new offer: what was said about the last one no longer applies.
    if (rotation !== shownRotation) {
      if (shownRotation >= 0) lastResult = null;
      shownRotation = rotation;
      justBought.clear();
    }
    const offer = cardShopOffer(rotation).map(cardId => cardDefinition(cardId)).filter((card): card is CardDefinition => Boolean(card));
    const bought = new Set([...deps.bought(rotation), ...justBought]);
    const held = deps.ores(), cards = deps.cards();
    const countdown = cardShopCountdown(cardShopRotationEndsAt(rotation) - at);
    // Presence updates also refresh open windows. Keep buttons in place until this window changes.
    const state = JSON.stringify([rotation, countdown, [...bought], buying, lastResult, held, offer.map(card => cards[card.id] ?? 0)]);
    if (state === renderedState) return;
    renderedState = state;
    timer.textContent = `New cards in ${countdown}`;
    offers.replaceChildren(...offer.map(card => offerRow(card, rotation, bought.has(card.id), held)));
    outcome.hidden = !lastResult;
    outcome.textContent = lastResult?.text ?? "";
    outcome.className = `smith-outcome ${lastResult?.good ? "is-good" : "is-bad"}`;
    oreLine.textContent = REFINE_ORE_ORDER.map(oreId => `${REFINE_ORES[oreId].name} ${held[oreId] ?? 0}`).join(" · ");
  }

  async function buy(rotation: number, card: CardDefinition) {
    if (buying) return;
    buying = card.id;
    lastResult = null;
    render();
    try {
      const result = await deps.buy(rotation, card.id);
      if (result?.ok) {
        if (rotation === shownRotation) justBought.add(card.id);
        lastResult = { text: `${cardName(card)} is in your cards. Switch it on in the Cards tab.`, good: true };
        deps.showMessage(`Card Bought · ${cardName(card)}`, "#ffd75e");
      } else {
        lastResult = { text: result?.error ?? "Not connected", good: false };
        deps.showMessage(result?.error ?? "Not Connected", "#ff9b91");
      }
    } finally {
      buying = null;
      if (dialog.open) render();
    }
  }

  function close() {
    if (!dialog.open) return false;
    dialog.close();
    if (ticker) { clearInterval(ticker); ticker = null; }
    deps.clearInput?.();
    return true;
  }

  function open() {
    if (!deps.inTown() || dialog.open) return;
    lastResult = null;
    render();
    deps.clearInput?.();
    dialog.showModal();
    // The countdown runs while the window is open, and the offer turns over with it.
    ticker = setInterval(() => { if (dialog.open) render(); }, 1000);
    back.focus();
  }

  back.addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  return { open, close, isOpen: () => dialog.open, render, destroy() { close(); dialog.remove(); } };
}

/** The Card Seller as main.ts uses it: the offer, the player's ores and cards, and buying through the coop session. */
export function createCardSellerRuntime(deps: {
  coop: () => {
    ores?: () => Ores;
    cards?: () => Readonly<Record<string, number>>;
    cardShopBought?: (rotation: number) => readonly string[];
    buyShopCard?: (rotation: number, cardId: string) => Promise<Result>;
    serverNowMs?: () => number;
  } | null | undefined;
  showMessage: (text: string, color: string) => void;
  clearInput?: () => void;
  inTown: () => boolean;
}) {
  return createCardSellerController({
    inTown: deps.inTown, clearInput: deps.clearInput, showMessage: deps.showMessage,
    // The server's clock, so a device set to the wrong time still shows the cards the server sells.
    now: () => deps.coop()?.serverNowMs?.() ?? Date.now(),
    ores: () => deps.coop()?.ores?.() ?? {},
    cards: () => deps.coop()?.cards?.() ?? {},
    bought: rotation => deps.coop()?.cardShopBought?.(rotation) ?? [],
    buy: async (rotation, cardId) => deps.coop()?.buyShopCard?.(rotation, cardId) ?? { ok: false, error: "Not Connected" },
  });
}
