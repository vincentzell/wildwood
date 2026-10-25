import { describe, expect, it } from "vitest";
import { bootGame, gameWorld, playAs, type GameTab } from "./harness/game";
import { answerConfirm, distance, openChallenges, pressKey, statTracker, tapSelector } from "./harness/farm";
import { AGGRO_GROUPS } from "../../src/game/runtime/auto-farm/aggro-picks";
import { PLAYER_SPEED } from "../../shared/rules";
import { createSpawnSites } from "../../src/game/world";
import { ENEMY_TYPES } from "../../src/game/enemies";
import { farmer, strong } from "./harness/farmer";

// Auto Farm in the booted game: the card, its key and the windows around it
// (through a lost connection and a duel: autofarm-interruptions.test.ts).

/** The stat rows the open Auto Farm window offers, by group ("stat:health"). */
const farmRows = (tab: GameTab) => [...tab.document.querySelectorAll<HTMLElement>("#autoFarmContent [data-group]")].map(row => row.dataset.group!);
const startButton = (tab: GameTab) => tab.document.querySelector<HTMLButtonElement>("#autoFarmSheet .farm-start")!;

describe("The Auto Farm card (FARM-11)", () => {
  it("sets stats Off or Farm, starts and stops from the card or F; a farm comes back after a reload, a stopped one or a new tab does not", async () => {
    const world = gameWorld();
    const ann = await farmer(world, "Ann", strong);
    const { tab } = ann;

    // The card opens the window: a row for each stat this map pays.
    tapSelector(tab, "#autoFarmSheet .farm-toggle");
    expect(tab.shown("autoFarmContent")).toBe(true);
    const stats = farmRows(tab);
    expect(stats).toContain("stat:health");
    expect(stats.length).toBeGreaterThan(2);
    // Every stat Off: nothing to start.
    for (const stat of stats) tapSelector(tab, `[data-group="${stat}"] [data-mode="off"]`);
    expect(startButton(tab).disabled).toBe(true);
    // Max Health alone on Farm, Target Lowest HP: Start farms it, and only it.
    tapSelector(tab, `[data-group="stat:health"] [data-mode="farm"]`);
    tapSelector(tab, `#autoFarmSheet [data-priority="lowest"]`);
    tapSelector(tab, "#autoFarmSheet .farm-start");
    expect(tab.shown("autoFarmContent")).toBe(false);
    expect(await tab.until(() => ann.group() === "stat:health", 10_000)).toBe(true);
    for (let second = 0; second < 30; second++) { await tab.play(1_000); expect(ann.group()).toBe("stat:health"); }

    // The card's Stop ends it.
    tapSelector(tab, "#autoFarmSheet .farm-toggle");
    tapSelector(tab, "#autoFarmSheet .farm-close");
    expect(await tab.until(() => !ann.farming(), 6_000)).toBe(true);

    // F starts it again with the stats last set, and stops it; typed into the chat box, F is just a letter.
    pressKey(tab, "KeyF");
    expect(await tab.until(() => ann.group() === "stat:health", 10_000)).toBe(true);
    pressKey(tab, "KeyF");
    expect(await tab.until(() => !ann.farming(), 6_000)).toBe(true);
    tab.key("KeyF", "keydown", tab.element("chatInput"));
    await tab.play(5_000);
    expect(ann.farming()).toBe(false);

    // A stopped farm stays stopped through a reload, its Target kept; there, F starts it.
    const fresh = await tab.reload();
    expect(await fresh.until(fresh.playing, 20_000)).toBe(true);
    await fresh.play(5_000);
    tapSelector(fresh, "#autoFarmSheet .farm-toggle");
    expect(fresh.document.querySelector(`#autoFarmSheet [data-priority="lowest"]`)!.getAttribute("aria-checked")).toBe("true");
    tapSelector(fresh, "#autoFarmSheet .farm-close");
    pressKey(fresh, "KeyF");
    expect(await fresh.until(ann.farming, 10_000)).toBe(true);

    // Farming through an update reload: the same character farms again, unasked (its kills come in).
    const reloaded = await fresh.reload();
    expect(await reloaded.until(reloaded.playing, 20_000)).toBe(true);
    const kills = ann.kills();
    expect(await reloaded.until(() => ann.kills() > kills, 75_000)).toBe(true);

    // A new tab of the same browser (its own session) starts with the farm off: there, F starts it.
    reloaded.connection()?.disconnect();
    const another = await bootGame(world, { localStorage: reloaded.localStorage });
    expect(await another.until(another.playing, 20_000)).toBe(true);
    await another.play(5_000);
    pressKey(another, "KeyF");
    expect(await another.until(ann.farming, 10_000)).toBe(true);
  }, 90_000);

  it("in the phone app, a farm comes back after the app restarts its WebView", async () => {
    const world = gameWorld();
    const native = { WILDSTAT_NATIVE_PREVIEW: true };
    const ann = world.join("Ann");
    ann.patch("playerProgress", { desertUnlocked: true });
    ann.disconnect();
    const tab = await playAs(world, "Ann", { windowProps: native });
    const kills = () => Number(world.db.playerLifetime.identity.find(ann.identity)?.enemyKills ?? 0);
    pressKey(tab, "KeyF");
    expect(await tab.until(() => Boolean(world.db.playerAutoFarmPuppet.identity.find(ann.identity)), 10_000)).toBe(true);
    // An app upgrade destroys the WebView: its session storage goes, the app's storage stays.
    tab.connection()?.disconnect();
    const restarted = await bootGame(world, { localStorage: tab.localStorage, windowProps: native });
    expect(await restarted.until(restarted.playing, 20_000)).toBe(true);
    const before = kills();
    expect(await restarted.until(() => kills() > before, 75_000)).toBe(true);
  }, 60_000);
});

describe("The stat tracker (FARM-12)", () => {
  it("counts a farm's gains an hour and keeps the session, its hidden stats, fold and prestige choice through a reload", async () => {
    const world = gameWorld();
    const ann = await farmer(world, "Ann", strong);
    let { tab } = ann;
    tab.tap("statTrackerToggle");
    await tab.play(1_500);
    const start = statTracker(tab)!;
    expect(start.rows.kills.current).toBe(0);
    expect(Object.values(start.rows).every(row => row.gain === 0)).toBe(true);

    // A minute of farming: kills and the stats they pay show as gains, and an hour's worth.
    pressKey(tab, "KeyF");
    await tab.play(70_000);
    const farmed = statTracker(tab)!;
    expect(farmed.rows.kills.gain).toBeGreaterThan(0);
    expect(farmed.rows.power.gain).toBeGreaterThan(0);
    expect(farmed.rows.kills.perHour).toBeGreaterThan(farmed.rows.kills.gain * 30);
    // Nothing shows a loss.
    expect(Object.values(farmed.rows).every(row => row.gain >= 0 && row.perHour >= 0)).toBe(true);

    // The gear: Kills hidden, a prestige set to carry the session on; then the card folded away with a tap.
    tapSelector(tab, ".stat-tracker-gear");
    const setting = (selector: string) => tab.document.querySelector<HTMLInputElement>(`.stat-tracker-settings ${selector}`)!;
    for (const box of [setting('input[data-stat="kills"]'), setting(".stat-tracker-prestige-reset input")]) {
      box.checked = false;
      box.dispatchEvent(new (tab.window as any).Event("change", { bubbles: true }));
    }
    expect(statTracker(tab)!.rows.kills).toBeUndefined();
    // A tap folds it once the double-tap window (which locks it) has passed.
    tapSelector(tab, ".stat-tracker-handle");
    await tab.play(400);
    const folded = () => tab.document.querySelector<HTMLElement>(".stat-tracker:not(.stat-tracker-settings) table")!.hidden;
    expect(folded()).toBe(true);

    // Leaving the page (as a reload does) hides it first. Reloaded: the same session, Kills hidden, the card folded, the choice kept.
    tab.setHidden(true);
    await tab.play(1_000);
    tab = await tab.reload();
    expect(await tab.until(tab.playing, 20_000)).toBe(true);
    await tab.play(2_000);
    expect(folded()).toBe(true);
    expect(setting(".stat-tracker-prestige-reset input").checked).toBe(false);
    tapSelector(tab, ".stat-tracker-handle");
    await tab.play(400);
    const reloaded = statTracker(tab)!;
    expect(reloaded.seconds).toBeGreaterThanOrEqual(farmed.seconds);
    expect(reloaded.rows.power.gain).toBeGreaterThan(0);
    expect(reloaded.rows.kills).toBeUndefined();
  }, 90_000);
});

describe("An autofarmer as others see them (FARM-13)", () => {
  it("a visible farmer's puppet walks from its anchor to its stat's camps at its own speed for every viewer, and goes when they hide", async () => {
    const world = gameWorld();
    // Ann farms Damage on another device: the server holds her puppet where it last placed her.
    const ann = world.join("Ann");
    ann.call("setMultiplayerEnabled", { enabled: true });
    ann.call("setAutoFarmPuppet", { group: "stat:damage", camp: "" });
    const anchor = world.db.playerAutoFarmPuppet.identity.find(ann.identity)!;
    let tab = await playAs(world, "Bob");
    // Bob opens his eye on other players.
    tab.tap("playerVisibilityToggle");
    const annSeen = () => (tab.coop.remotePlayers() as { id: string; x: number; y: number }[]).find(figure => figure.id === ann.hex) ?? null;
    expect(await tab.until(() => annSeen() !== null, 5_000)).toBe(true);
    expect(distance(annSeen()!, anchor)).toBeLessThan(PLAYER_SPEED);

    // Watched half a second at a time: never faster than a walk, off to the camps that pay damage and fighting there.
    const damageCamps = createSpawnSites({ x: 0, y: 0 }).filter(site => ENEMY_TYPES[site.type].reward.type === "damage");
    async function watch(seconds: number) {
      let last = { ...annSeen()! }, closestCamp = Infinity, walked = 0;
      for (let step = 0; step < seconds * 2; step++) {
        await tab.play(500);
        const now = annSeen()!;
        expect(distance(now, last)).toBeLessThan(PLAYER_SPEED * .5 * 1.3 + 2);
        walked += distance(now, last);
        closestCamp = Math.min(closestCamp, ...damageCamps.map(site => distance(site, now)));
        last = { ...now };
      }
      return { walked, closestCamp, last };
    }
    const first = await watch(30);
    expect(distance(first.last, anchor)).toBeGreaterThan(300);
    expect(first.closestCamp).toBeLessThan(250);

    // Another viewer (Bob's page reloaded, his eye still open) sees her too, walking her rounds without a jump.
    tab = await tab.reload();
    expect(await tab.until(tab.playing, 20_000)).toBe(true);
    expect(await tab.until(() => annSeen() !== null, 5_000)).toBe(true);
    const second = await watch(20);
    expect(second.walked).toBeGreaterThan(300);
    expect(second.closestCamp).toBeLessThan(250);

    // She hides from other players: her puppet goes with her.
    ann.call("setMultiplayerEnabled", { enabled: false });
    expect(await tab.until(() => annSeen() === null, 5_000)).toBe(true);
    // Hidden, the server keeps no puppet for her, whatever her farm sends.
    await tab.play(5_000);
    ann.call("setAutoFarmPuppet", { group: "stat:health", camp: "" });
    expect(world.db.playerAutoFarmPuppet.identity.find(ann.identity)).toBeFalsy();

    // Cara reloads her page while farming: others see her farm again as soon as she is back, not a checkpoint later.
    const cara = await farmer(world, "Cara", strong);
    pressKey(cara.tab, "KeyF");
    expect(await cara.tab.until(cara.farming, 10_000)).toBe(true);
    cara.tab.setHidden(true);
    await cara.tab.play(1_000);
    const back = await cara.tab.reload();
    expect(await back.until(back.playing, 20_000)).toBe(true);
    expect(await back.until(cara.farming, 5_000)).toBe(true);
  }, 90_000);
});

describe("An Aggro run (FARM-09)", () => {
  it("asks for its pick before it starts, fights what chases, swaps the pick from the farm window, and gives the button back when the server never answers", async () => {
    const world = gameWorld();
    const ann = world.join("Ann");
    world.setup(ctx => ctx.db.playerPrestige.insert({ identity: ann.identity, level: 1, perkPoints: 0, peakPower: 1_000, prestigedAt: ctx.timestamp }));
    ann.disconnect();
    const tab = await playAs(world, "Ann");
    const puppet = () => world.db.playerAutoFarmPuppet.identity.find(ann.identity)?.group ?? null;
    const run = () => world.db.playerAggroChallenge.identity.find(ann.identity);

    // The Aggro challenge waits for the group that will chase; with one to pick, a tap switches it.
    await openChallenges(tab);
    const card = () => tab.document.querySelector<HTMLElement>(".aggro-challenge")!;
    const action = () => card().querySelector<HTMLButtonElement>(".prestige-challenge-action")!;
    const pickIn = (root: () => Element) => (group: string) => root().querySelectorAll<HTMLButtonElement>(".aggro-pick")[AGGRO_GROUPS.indexOf(group as never)];
    const picked = (root: () => Element) => AGGRO_GROUPS.filter((_group, index) => root().querySelectorAll(".aggro-pick")[index].getAttribute("aria-pressed") === "true");
    expect(action().disabled).toBe(true);
    pickIn(card)("armor").click();
    pickIn(card)("damage").click();
    expect(picked(card)).toEqual(["damage"]);
    expect(action().disabled).toBe(false);
    action().click();
    await tab.play(100);
    answerConfirm(tab);
    expect(await tab.until(() => Boolean(run()?.active), 5_000)).toBe(true);
    tab.tap("closePrestigeBtn");
    tab.tap("closePlayerProfileBtn");
    await tab.play(2_000);

    // Nothing on Farm: the farm fights only what chases, the picked group.
    tapSelector(tab, "#autoFarmSheet .farm-toggle");
    for (const row of tab.document.querySelectorAll<HTMLElement>("#autoFarmContent [data-group]")) tapSelector(tab, `[data-group="${row.dataset.group}"] [data-mode="off"]`);
    tapSelector(tab, "#autoFarmSheet .farm-start");
    expect(await tab.until(() => puppet() === "stat:damage", 10_000)).toBe(true);

    // Chasing Groups in the farm window opens the picker: Damage out, Armor in, Done.
    tapSelector(tab, "#autoFarmSheet .farm-toggle");
    tapSelector(tab, "#autoFarmSheet .farm-aggro-pick");
    const prompt = () => tab.document.querySelector<HTMLElement>(".aggro-pick-overlay")!;
    expect(prompt().hidden).toBe(false);
    expect(picked(prompt)).toEqual(["damage"]);
    pickIn(prompt)("damage").click();
    pickIn(prompt)("armor").click();
    tapSelector(tab, ".aggro-pick-overlay .aggro-pick-done");
    expect(prompt().hidden).toBe(true);
    // Opened again, the picker holds the new pick.
    tapSelector(tab, "#autoFarmSheet .farm-toggle");
    tapSelector(tab, "#autoFarmSheet .farm-aggro-pick");
    expect(picked(prompt)).toEqual(["armor"]);
    tapSelector(tab, ".aggro-pick-overlay .aggro-pick-done");

    // Dropping out while the server never answers: the button comes back, and the run is still on.
    tab.connection()!.fake.setHold(true);
    await openChallenges(tab);
    action().click();
    await tab.play(100);
    answerConfirm(tab);
    await tab.play(1_000);
    expect(action().disabled).toBe(true);
    await tab.play(16_000);
    expect(action().disabled).toBe(false);
    expect(run()?.active).toBe(true);
    tab.connection()!.fake.setHold(false);
  }, 90_000);
});
