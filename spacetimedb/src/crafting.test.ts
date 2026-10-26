import { describe, expect, it, vi } from "vitest";
import { crystalFixture, server } from "../../tests/helpers/crystal-hollows-fixture";
import { progressOf } from "../../tests/helpers/progress";
import { TOWN_FEET_OFFSET, TOWN_SCHOOL_POSITIONS, TOWN_SMITH_POSITION } from "../../shared/town";
import { CRAFTED_REFINE, craftExperience, craftExperienceForLevel, type CraftSkill } from "../../shared/crafting";
import { craftMaterialsKey, gradeCraftMaterials } from "../../shared/grade-craft";
import { BOW_SKILL_APPEAR_CHANCE } from "../../shared/bow-skills";
import { masteryPointsForLevel, type WeaponSchool } from "../../shared/weapon-mastery";
import { bagSlotsUsed } from "../../shared/equipment-copies";
import { inventorySlotCapacity } from "../../shared/gems";
import { IRON_BOW } from "../../shared/items";
import type { OreId } from "../../shared/refine";
import { addOres, oreCount, refineLevelFor } from "./item-refine";
import { masteryKey } from "./weapon-mastery";
import { addGold } from "./gold";
import { GRADE_GOLD_PRICE } from "../../shared/gear-grades";
import { craftKey, craftSkillExperience } from "./crafting";
import { inventoryForProgress } from "./progress-helpers";
import { toolKey } from "./tools";
import { CRAFT_TOOL, toolCraftCost } from "../../shared/tools";
vi.mock("spacetimedb/server", () => import("../../tests/helpers/spacetime-module"));

type Station = "smith" | "archery" | "sorcery" | "swordplay";
const STATIONS: Record<Station, { x: number; y: number }> = {
  smith: TOWN_SMITH_POSITION,
  archery: TOWN_SCHOOL_POSITIONS.archery, sorcery: TOWN_SCHOOL_POSITIONS.sorcery, swordplay: TOWN_SCHOOL_POSITIONS.swordplay,
};

/** At a station in the Town, with plenty of every material, each school and craft at a level. */
function crafter(station: Station, options: { levels?: Partial<Record<WeaponSchool, number>>; crafts?: Partial<Record<CraftSkill, number>>; stock?: number } = {}) {
  const f = crystalFixture();
  // A craft writes the player's motion row; a test move clears it so the new spot is the one read.
  const stand = (where: Station, mapId = "town") => {
    f.transaction(() => { if (f.db.playerMotion.identity.find(f.ctx.sender)) f.db.playerMotion.identity.delete(f.ctx.sender); });
    f.patch("player", { mapId, x: STATIONS[where].x, y: STATIONS[where].y - TOWN_FEET_OFFSET });
  };
  stand(station);
  f.transaction(() => {
    for (const oreId of ["copper_ore", "iron_ore", "mithril_ore", "adamant_ore", "starshard", "pine_log", "oak_log", "yew_log", "elder_log", "arcane_crystal"] as OreId[]) {
      addOres(f.ctx, f.ctx.sender, oreId, options.stock ?? 100_000);
    }
    for (const [school, level] of Object.entries(options.levels ?? {})) {
      f.db.playerWeaponMastery.insert({ key: masteryKey(f.ctx.sender, school as WeaponSchool), identity: f.ctx.sender, school, points: BigInt(masteryPointsForLevel(level)) });
    }
    for (const [skill, level] of Object.entries(options.crafts ?? {})) {
      f.db.playerCraftSkill.insert({ key: craftKey(f.ctx.sender, skill as CraftSkill), identity: f.ctx.sender, skill, experience: BigInt(craftExperienceForLevel(level)) });
    }
  });
  const craft = (itemId: string, expected = craftMaterialsKey(gradeCraftMaterials(itemId) ?? {}), reducer: "craftGradeItem" | "craftGradeGear" = "craftGradeItem") =>
    f.run(server[reducer], { itemId, expectedMaterials: expected });
  const reforge = (itemId: string, copyId: bigint) =>
    f.run(server.reforgeWeapon, { itemId, copyId, expectedMaterials: craftMaterialsKey(gradeCraftMaterials(itemId)!) });
  const bag = () => inventoryForProgress(progressOf(f));
  const ore = (oreId: string) => oreCount(f.ctx, f.ctx.sender, oreId);
  const experience = () => craftSkillExperience(f.ctx, f.ctx.sender);
  return { ...f, stand, craft, reforge, bag, ore, experience };
}

// The skill rolls a craft makes, which need the draws pinned; the craft flow itself is tests/scenarios/gear-shop.test.ts (GEAR-10).
describe("crafted weapon skills", () => {
  const crude = craftExperience("crude");

  it("crafts another copy of a weapon held, and reforges the copy picked: its skills only go up, the materials and experience as a craft, no room needed", () => {
    const f = crafter("archery", { levels: { archery: 5 } });
    const firstRoll = () => { const row = f.db.playerBowSkill.key.find(`${f.ctx.sender.toHexString()}:crude_bow`); return [row.arrowStorm, row.ricochet, row.piercingShot]; };
    const copies = () => [...f.db.playerEquipmentCopy.iter()].filter((copy: any) => copy.itemId === "crude_bow") as any[];
    const draws = (value: number) => Object.assign(f.ctx, { random: Object.assign(() => value, { integerInRange: (_min: number, max: number) => max }) });
    // Crafted twice with every appear draw missing: two bows, neither with skills, both at the crafted refine.
    draws(.999);
    f.craft("crude_bow");
    f.craft("crude_bow");
    const [copy] = copies();
    expect(copies().length).toBe(1);
    expect(firstRoll()).toEqual([0, 0, 0]);
    expect(refineLevelFor(f.ctx, f.ctx.sender, "crude_bow", copy.id)).toBe(CRAFTED_REFINE);
    const bag = f.bag().length;
    // Fill the bag: a Reforge takes no slot.
    for (let index = bagSlotsUsed(f.bag(), [], copies().length) + 2; index < inventorySlotCapacity(0); index++) {
      f.seed("playerEquipmentCopy", { id: 0n, identity: f.ctx.sender, itemId: IRON_BOW, arrowStorm: 0, ricochet: 0, piercingShot: 0, acquiredAt: f.ctx.timestamp });
    }
    expect(() => f.craft("crude_light_armor")).toThrow("Your bag is full.");
    // The second copy reforged: only it changes.
    draws(0);
    f.reforge("crude_bow", copy.id);
    const best = copies()[0];
    expect([best.arrowStorm, best.ricochet, best.piercingShot].every(chance => chance > 0)).toBe(true);
    expect(firstRoll()).toEqual([0, 0, 0]);
    // A poor roll never lowers them; a copy not the player's is refused.
    draws(.999);
    f.reforge("crude_bow", copy.id);
    expect(copies()[0]).toEqual(best);
    expect(() => f.reforge("crude_bow", 999n)).toThrow();
    // An older tab crafting a bow held reforges its first copy.
    draws(0);
    f.craft("crude_bow", undefined, "craftGradeGear");
    expect(firstRoll().every(chance => chance > 0)).toBe(true);
    expect(f.bag().length).toBe(bag);
    expect(f.ore("pine_log")).toBe(100_000 - 5 * 10);
    expect(f.experience().fletching).toBe(BigInt(5 * crude));
    expect(copies().length).toBe(1);
  });

  it("rolls a weapon's skills with three more ranks of Skill Luck than a bought one", () => {
    const f = crafter("archery", { levels: { archery: 5 } });
    // Above the bare appear chance, below it with three ranks (5% a rank).
    const draw = BOW_SKILL_APPEAR_CHANCE * 1.1;
    Object.assign(f.ctx, { random: Object.assign(() => draw, { integerInRange: (min: number, max: number) => Math.floor((min + max) / 2) }) });
    f.craft("crude_bow");
    const roll = f.db.playerBowSkill.key.find(`${f.ctx.sender.toHexString()}:crude_bow`);
    expect([roll.arrowStorm, roll.ricochet, roll.piercingShot].every(chance => chance > 0)).toBe(true);
    f.stand("smith");
    f.transaction(() => addGold(f.ctx, f.ctx.sender, 1_000));
    f.run(server.buyGradeGear, { itemId: "common_bow", expectedPrice: BigInt(GRADE_GOLD_PRICE.common) });
    const bought = f.db.playerBowSkill.key.find(`${f.ctx.sender.toHexString()}:common_bow`);
    expect([bought.arrowStorm, bought.ricochet, bought.piercingShot]).toEqual([0, 0, 0]);
  });

  it("rolls a crafted weapon's skills twice and keeps the higher, so it helps at the Skill Luck cap too", () => {
    const f = crafter("archery", { levels: { archery: 5 } });
    // The first roll's three appear draws miss; every draw after lands.
    let calls = 0;
    Object.assign(f.ctx, { random: Object.assign(() => (calls++ < 3 ? .999 : 0), { integerInRange: (_min: number, max: number) => max }) });
    f.craft("crude_bow");
    const roll = f.db.playerBowSkill.key.find(`${f.ctx.sender.toHexString()}:crude_bow`);
    expect([roll.arrowStorm, roll.ricochet, roll.piercingShot].every(chance => chance > 0)).toBe(true);
  });
});

describe("a craft tool", () => {
  it("lets a craft start with only what the tool leaves of the recipe in the bag", () => {
    const itemId = "eternal_bow", recipe = gradeCraftMaterials(itemId)!;
    const f = crafter("archery", { crafts: { fletching: 99 }, stock: 0 });
    const need = toolCraftCost(recipe, 10);
    // Exactly the tool's cost in the bag, and a knife at 10: a quarter of each material is saved.
    f.transaction(() => { for (const [id, count] of Object.entries(need)) addOres(f.ctx, f.ctx.sender, id as OreId, count); });
    Object.assign(f.ctx, { random: Object.assign(() => .999, { integerInRange: (_min: number, max: number) => max }) });
    expect(() => f.craft(itemId)).toThrow(/You need/);
    f.seed("playerTool", { key: toolKey(f.ctx.sender, CRAFT_TOOL.fletching), identity: f.ctx.sender, tool: CRAFT_TOOL.fletching, level: 10 });
    f.craft(itemId);
    expect(Object.values(recipe).some((count, index) => need[Object.keys(recipe)[index]] < count)).toBe(true);
    for (const id of Object.keys(recipe)) expect(f.ore(id)).toBe(0);
  });
});
