import { afterEach, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { CARDS } from "../../shared/cards";
import { BASE_CARD_SLOTS, NO_ACTIVE_CARDS } from "../../shared/active-cards";
import { cardName, mapName } from "../../shared/card-text";
import { cardPortrait } from "./card-portrait";
import { createCardsTab } from "./cards-tab";

vi.mock("./card-portrait", () => ({ cardPortrait: vi.fn(async () => "") }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function setup(view = "cards", collapsed?: string, initialQuery = "") {
  const { document, window } = parseHTML("<html><body></body></html>");
  vi.stubGlobal("document", document);
  const saved = new Map<string, string>([["wildstat.cardsView", view]]);
  if (collapsed) saved.set("wildstat.cardZonesOpen.v2", JSON.stringify({ [collapsed]: false }));
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value) });
  const tab = createCardsTab({ port: {
    cards: () => Object.fromEntries(CARDS.map(card => [card.id, 1])), activeCards: () => NO_ACTIVE_CARDS,
    slots: () => BASE_CARD_SLOTS, storedRanks: () => ({}), cardHunter: () => 0, cardLuck: () => 0,
    activate: async () => ({ ok: true }), deactivate: async () => ({ ok: true }),
  }, onInspect: vi.fn() });
  document.body.append(tab.element);
  const search = (value: string) => {
    const input = tab.element.querySelector<HTMLInputElement>(".cards-search")!;
    input.value = value;
    input.dispatchEvent(new window.Event("input"));
  };
  const visible = () => [...tab.element.querySelectorAll<HTMLElement>(".inventory-item[data-card-id]")]
    .filter(tile => !tile.hidden).map(tile => tile.dataset.cardId!);
  const zone = (id: string) => tab.element.querySelector<HTMLElement>(`[data-map-id="${id}"]`)!;
  if (initialQuery) search(initialQuery);
  tab.show(true);
  return { tab, saved, search, visible, zone };
}

it("searches names, areas and descriptions with case-insensitive word prefixes", () => {
  const s = setup();
  const card = CARDS.find(card => card.effects.some(effect => effect.effect === "oreFind"))!;
  s.search("ORE");
  expect(s.visible()).toContain(card.id);
  expect(s.visible().every(id => CARDS.find(card => card.id === id)!.effects.some(effect => effect.effect === "oreFind"))).toBe(true);
  s.search(cardName(card));
  expect(s.visible()).toContain(card.id);
  s.search(mapName(card.mapId));
  expect(s.visible()).toContain(card.id);
  s.search("extra ore");
  expect(s.visible()).toContain(card.id);
  s.search("zzznomatch");
  expect(s.visible()).toEqual([]);
  expect(s.tab.element.querySelector(".cards-search-status")!.textContent).toBe("No matching cards in this view.");
});

it("keeps search expansion separate from saved zones and restores them when cleared", () => {
  const mapId = CARDS[0].mapId;
  const s = setup("cards", mapId);
  const before = s.saved.get("wildstat.cardZonesOpen.v2");
  s.search(mapName(mapId));
  expect(s.zone(mapId).querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
  s.zone(mapId).querySelector<HTMLButtonElement>("button")!.click();
  expect(s.zone(mapId).hidden).toBe(false);
  expect(s.zone(mapId).querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  expect(s.saved.get("wildstat.cardZonesOpen.v2")).toBe(before);
  s.zone(mapId).querySelector<HTMLButtonElement>("button")!.click();
  s.search("");
  expect(s.zone(mapId).querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
  expect(s.saved.get("wildstat.cardZonesOpen.v2")).toBe(before);
});

it.each(["cards", "equip"])("loads only matching tile portraits during %s search and loads newly revealed matches", view => {
  const s = setup(view, undefined, "zzznomatch");
  expect(cardPortrait).not.toHaveBeenCalled();
  vi.mocked(cardPortrait).mockClear();
  s.search("zzznomatch");
  s.tab.render();
  expect(cardPortrait).not.toHaveBeenCalled();
  const term = view === "equip" ? "damage" : "ore";
  s.search(term);
  expect(s.visible().length).toBeGreaterThan(0);
  expect(vi.mocked(cardPortrait).mock.calls.map(([id]) => id).sort()).toEqual(s.visible().sort());
  vi.mocked(cardPortrait).mockClear();
  s.search(term.toUpperCase());
  expect(cardPortrait).not.toHaveBeenCalled();
  s.search("");
  expect(s.visible().length).toBeGreaterThan(1);
});
