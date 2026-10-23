import { describe, expect, it } from "vitest";
import { bootGame, gameWorld, storageKeys, type GameTab } from "./harness/game";
import { fakeSpacetimeAuth, memoryStorage } from "./harness/boot-ops";
import { scenarioWorld } from "./harness/server";
import { PORTAL_CUTSCENES } from "../../shared/portal-cutscenes";

/** What a settings toggle shows: on or off. */
const isOn = (tab: GameTab, toggle: Element) => toggle.getAttribute("aria-pressed") === "true";
const toggle = (tab: GameTab, id: string) => tab.element(id);
/** The HUD countdown switches are found by their label, as a screen reader would. */
const timerToggle = (tab: GameTab, label: string) => tab.document.querySelector(`#settingsPanel button[aria-label="${label}"]`) as HTMLElement;
const lastNavigation = (tab: GameTab) => tab.navigations[tab.navigations.length - 1]?.url ?? "";
const press = (tab: GameTab, element: HTMLElement) => element.dispatchEvent(new (tab.window as any).Event("click", { bubbles: true }));

/** The browser's Screen Wake Lock: how many locks are held. */
function wakeLock(tab: GameTab, options: { refuse?: boolean } = {}) {
  const lock = { held: 0, requests: 0 };
  const navigator = Object.create(globalThis.navigator, { wakeLock: { value: {
    request: async () => {
      lock.requests++;
      if (options.refuse) throw new Error("NotAllowedError");
      lock.held++;
      let released = false;
      return { get released() { return released; }, addEventListener() {}, release: async () => { if (!released) { released = true; lock.held--; } } };
    },
  } } });
  Object.defineProperty(tab.window, "navigator", { configurable: true, value: navigator });
  return lock;
}

/** Toolbar haptic pulses the page asks the device for. */
function haptics(tab: GameTab) {
  const pulses = { count: 0 };
  tab.window.addEventListener("wildstat:toolbar-haptic", () => { pulses.count++; });
  return pulses;
}

/** Opens the game for a returning guest with a wake lock and haptics watched from the first frame. */
async function open(world: ReturnType<typeof gameWorld>, previous?: GameTab, device: { refuse?: boolean; noWakeLock?: boolean } = {}) {
  const tab = previous ? await previous.reload() : await bootGame(world, { name: "Ann" });
  const lock = device.noWakeLock ? { held: 0, requests: 0 } : wakeLock(tab, device);
  const pulses = haptics(tab);
  if (!await tab.until(tab.playing, 20_000)) throw new Error("Never reached the world");
  return { tab, lock, pulses };
}

const DEVICE_TOGGLES = ["selfProfileTapToggle", "scientificNotationToggle", "statPopupsToggle", "ownNamePlateToggle", "enemyHpNumbersToggle", "damageNumbersToggle", "chatTimestampsToggle"];

describe("settings", () => {
  it("BOOT-16 device settings (haptics, display toggles, HUD timers, keep screen on) stay as set across a reload", async () => {
    const world = gameWorld();
    world.join("Ann").disconnect();
    let { tab, lock, pulses } = await open(world);

    // Toolbar taps pulse by default; off, they stop.
    tab.tap("inventoryBtn");
    tab.tap("inventoryBtn");
    expect(pulses.count).toBe(2);
    tab.tap("settingsBtn");
    tab.tap("toolbarHapticsToggle");
    tab.tap("inventoryBtn");
    expect(pulses.count).toBe(2);

    // Every display toggle flipped from its default, two HUD timers hidden and the ad timer shown.
    const before = Object.fromEntries(DEVICE_TOGGLES.map(id => [id, isOn(tab, toggle(tab, id))]));
    for (const id of DEVICE_TOGGLES) tab.tap(id);
    press(tab, timerToggle(tab, "upgrade queue 1 timer"));
    press(tab, timerToggle(tab, "tech timer"));
    expect(isOn(tab, timerToggle(tab, "ad timer"))).toBe(false);
    press(tab, timerToggle(tab, "ad timer"));

    // Keep Screen On holds a lock while the tab is shown, lets it go in the background, takes it back on return.
    expect(isOn(tab, toggle(tab, "keepScreenOnToggle"))).toBe(false);
    expect(lock.held).toBe(0);
    tab.tap("keepScreenOnToggle");
    await tab.play(200);
    expect(lock.held).toBe(1);
    tab.setHidden(true);
    await tab.play(200);
    expect(lock.held).toBe(0);
    tab.setHidden(false);
    await tab.play(200);
    expect(lock.held).toBe(1);

    // A reload keeps every choice.
    ({ tab, lock, pulses } = await open(world, tab));
    for (const id of DEVICE_TOGGLES) expect([id, isOn(tab, toggle(tab, id))]).toEqual([id, !before[id]]);
    expect(isOn(tab, timerToggle(tab, "upgrade queue 1 timer"))).toBe(false);
    expect(isOn(tab, timerToggle(tab, "tech timer"))).toBe(false);
    expect(isOn(tab, timerToggle(tab, "upgrade queue 2 timer"))).toBe(true);
    expect(isOn(tab, timerToggle(tab, "ad timer"))).toBe(true);
    expect(isOn(tab, toggle(tab, "keepScreenOnToggle"))).toBe(true);
    expect(lock.held).toBe(1);
    tab.tap("inventoryBtn");
    expect(pulses.count).toBe(0);

    // A device that refuses the lock is asked once, not over and over.
    ({ tab, lock } = await open(world, tab, { refuse: true }));
    await tab.play(10_000);
    expect(lock.requests).toBe(1);
    expect(lock.held).toBe(0);

    // A browser without the API shows the switch unavailable.
    ({ tab } = await open(world, tab, { noWakeLock: true }));
    expect((toggle(tab, "keepScreenOnToggle") as HTMLButtonElement).disabled).toBe(true);
  }, 60_000);

  it("BOOT-09 Move to Google moves the character to the new sign-in; Sign Out works offline and leaves no credentials", async () => {
    const world = gameWorld();
    const auth = await fakeSpacetimeAuth();
    const email = world.join("email-account", { kind: "account" });
    email.patch("playerProgress", { crystalHollowsUnlocked: true });
    email.disconnect();
    const save = email.progress()!;
    const storage = memoryStorage();
    await auth.rememberSignIn(storage, "email-account");
    let tab = await bootGame(world, { localStorage: storage, route: auth.route });
    expect(await tab.until(tab.playing, 20_000)).toBe(true);

    // Settings → Move to Google, confirmed: this login is signed out, then the sign-in page asks for a login.
    tab.tap("settingsBtn");
    tab.tap("settings-account-tab");
    expect(tab.shown("moveToGoogleButton")).toBe(true);
    tab.tap("moveToGoogleButton");
    press(tab, tab.document.querySelector("[data-move-confirm]") as HTMLElement);
    expect(await tab.until(() => lastNavigation(tab).includes("/oidc/session/end"), 10_000)).toBe(true);
    tab = await tab.reload({ url: "https://wildstatmmo.com/" });
    expect(
      await tab.until(
        () => lastNavigation(tab).startsWith("https://auth.spacetimedb.com/oidc/auth"),
        10_000,
      ),
    ).toBe(true);
    expect(new URL(lastNavigation(tab)).searchParams.get("prompt")).toBe("login");

    // The player picks Google: the character is now that login's.
    tab = await tab.reload({ url: auth.signInAs(lastNavigation(tab), "google-account") });
    expect(await tab.until(tab.playing, 20_000)).toBe(true);
    await tab.play(2_000);
    const google = world.player("google-account", "account");
    expect(tab.connection()!.identity.toHexString()).toBe(google.hex);
    expect(google.progress()).toMatchObject({ crystalHollowsUnlocked: true, damage: save.damage, maxHp: save.maxHp });
    expect(email.progress()?.crystalHollowsUnlocked).not.toBe(true);

    // Offline, Settings → Sign Out still signs out, and the browser keeps no sign-in.
    tab.network.connections.forEach(connection => connection.fake.drop(new Error("offline")));
    tab.setOnline(false);
    await tab.play(1_000);
    tab.tap("settingsBtn");
    tab.tap("settings-account-tab");
    expect(tab.shown("accountButton")).toBe(true);
    tab.tap("accountButton");
    await tab.play(500);
    expect(lastNavigation(tab)).toContain("/oidc/session/end");
    for (const key of [storageKeys.accountTokenKey, `${storageKeys.accountTokenKey}:refresh`, storageKeys.knownAccountKey, storageKeys.knownAccountCharacterKey]) {
      expect([key, tab.localStorage.getItem(key)]).toEqual([key, null]);
    }
  }, 60_000);

  it("BOOT-10 Reset Save clears the character only once the server confirms it, then starts over; a reset that never lands keeps everything", async () => {
    const world = gameWorld();
    const ann = world.join("Ann");
    ann.patch("playerProgress", { damage: 5_000, maxHp: 900 });
    world.setup(ctx => ctx.db.playerGold.insert({ identity: ann.identity, gold: 777n }));
    ann.disconnect();
    const client: { hold?: boolean } = {};
    const tab = await bootGame(world, { name: "Ann", client });
    expect(await tab.until(tab.playing, 20_000)).toBe(true);
    await tab.play(1_000);
    const shownGold = tab.element("hudGoldBalance").textContent;
    const reset = () => {
      tab.tap("settingsBtn");
      tab.tap("resetProgressBtn");
      press(tab, tab.element("gameConfirm").querySelector(".game-confirm-accept") as HTMLElement);
    };

    // The network stalls on the way: nothing changes here or there while the server has not answered.
    client.hold = true;
    reset();
    await tab.play(1_000);
    expect((tab.element("resetProgressBtn") as HTMLButtonElement).disabled).toBe(true);
    expect(ann.progress()).toMatchObject({ damage: 5_000, maxHp: 900 });
    expect(tab.playing()).toBe(true);
    expect(tab.element("hudGoldBalance").textContent).toBe(shownGold);

    // The socket dies and the reset never lands: the character is as it was, and Reset Save works again.
    tab.connection()!.fake.drop(new Error("network lost"));
    tab.connection()!.fake.release();
    client.hold = false;
    await tab.play(2_000);
    expect((tab.element("resetProgressBtn") as HTMLButtonElement).disabled).toBe(false);
    expect(ann.progress()).toMatchObject({ damage: 5_000, maxHp: 900 });
    expect(world.db.playerGold.identity.find(ann.identity)?.gold).toBe(777n);
    expect(tab.shown("newPlayerPanel")).toBe(false);

    // Back online, the reset goes through: a fresh save, and the game starts over as a new character.
    expect(await tab.until(tab.playing, 20_000)).toBe(true);
    reset();
    expect(await tab.until(() => tab.shown("newPlayerPanel"), 20_000)).toBe(true);
    expect(tab.playing()).toBe(false);
    expect(ann.progress()!.damage).toBeLessThan(5_000);
    expect(ann.progress()!.maxHp).toBeLessThan(900);
    expect(world.db.playerGold.identity.find(ann.identity)?.gold ?? 0n).toBe(0n);
  }, 60_000);

  it("BOOT-15 account settings (volumes, offline progress, portal cutscenes seen) follow the player to another device; a refused change snaps back", async () => {
    const world = gameWorld();
    const auth = await fakeSpacetimeAuth();
    const acc = world.join("set-account", { kind: "account" });
    acc.disconnect();
    acc.patch("playerProgress", { desertUnlocked: true, snowlandsUnlocked: true });
    const [desert, snowlands] = PORTAL_CUTSCENES;
    const audio = () => world.db.playerAudioSetting.identity.find(acc.identity);
    const offline = () => world.db.playerOfflinePreference.identity.find(acc.identity)?.enabled ?? true;
    const slide = (tab: GameTab, id: string, percent: number, release = true) => {
      const slider = tab.element(id) as HTMLInputElement;
      slider.value = String(percent);
      slider.dispatchEvent(new (tab.window as any).Event("input"));
      if (release) slider.dispatchEvent(new (tab.window as any).Event("change"));
    };

    const client: { hold?: boolean } = {};
    let refusing = false;
    const deviceA = memoryStorage();
    await auth.rememberSignIn(deviceA, "set-account");
    let tab = await bootGame(world, { localStorage: deviceA, route: auth.route, client, refuse: () => refusing ? new Error("offline") : null });
    expect(await tab.until(tab.playing, 20_000)).toBe(true);
    await tab.play(2_000);
    tab.tap("settingsBtn");

    // Dragging the slider sends nothing; letting go saves the final value once.
    const before = audio();
    slide(tab, "sfxVolume", 35, false);
    slide(tab, "sfxVolume", 20, false);
    await tab.play(3_000);
    expect(audio()).toEqual(before);
    slide(tab, "sfxVolume", 20);
    await tab.play(3_000);
    expect(audio()?.sfxVolume).toBeCloseTo(0.2, 5);

    // Offline progress switched off; a change the server never confirms snaps back.
    tab.tap("offlineProgressToggle");
    await tab.play(1_000);
    expect(offline()).toBe(false);
    client.hold = true;
    tab.tap("offlineProgressToggle");
    await tab.play(500);
    expect(isOn(tab, toggle(tab, "offlineProgressToggle"))).toBe(true);
    tab.connection()!.fake.drop(new Error("network lost"));
    tab.connection()!.fake.release();
    client.hold = false;
    await tab.play(3_000);
    expect(isOn(tab, toggle(tab, "offlineProgressToggle"))).toBe(false);
    expect(offline()).toBe(false);

    // The game marks the desert portal's scene watched.
    expect(await tab.until(tab.playing, 20_000)).toBe(true);
    expect(tab.coop.hasSeenPortalCutscene(desert.id)).toBe(false);
    tab.coop.markPortalCutsceneSeen(desert.id);
    await tab.play(2_000);

    // Another device: same volumes, same switch, the watched scene not shown again.
    await tab.close();
    const deviceB = memoryStorage();
    await auth.rememberSignIn(deviceB, "set-account");
    tab = await bootGame(world, { localStorage: deviceB, route: auth.route, refuse: () => refusing ? new Error("offline") : null });
    expect(await tab.until(tab.playing, 20_000)).toBe(true);
    await tab.play(2_000);
    expect(Number((tab.element("sfxVolume") as HTMLInputElement).value)).toBe(20);
    expect(isOn(tab, toggle(tab, "offlineProgressToggle"))).toBe(false);
    expect(tab.coop.hasSeenPortalCutscene(desert.id)).toBe(true);
    expect(tab.coop.hasSeenPortalCutscene(snowlands.id)).toBe(false);

    // A change made while offline goes up on the next connection.
    refusing = true;
    tab.connection()!.fake.drop(new Error("network lost"));
    await tab.play(500);
    slide(tab, "musicVolume", 50);
    await tab.play(2_000);
    expect(audio()?.musicVolume).not.toBeCloseTo(0.5, 5);
    refusing = false;
    expect(await tab.until(() => Math.abs((audio()?.musicVolume ?? 0) - 0.5) < 1e-5, 60_000)).toBe(true);
    expect(audio()?.sfxVolume).toBeCloseTo(0.2, 5);
  }, 60_000);

  it("BOOT-15 account settings merge when a guest links, are refused out of range, and go with erasure", () => {
    const world = scenarioWorld();
    const code = (n: number) => `link-${n}-`.padEnd(40, "x");
    const link = (guest: ReturnType<typeof world.join>, account: ReturnType<typeof world.join>, n: number) => {
      guest.call("beginAccountLink", { code: code(n) });
      account.call("claimGuestAccount", { code: code(n) });
    };
    const audio = (who: { identity: unknown }) => world.db.playerAudioSetting.identity.find(who.identity);
    const offline = (who: { identity: unknown }) => world.db.playerOfflinePreference.identity.find(who.identity)?.enabled ?? true;
    const seen = (who: { identity: unknown }) => world.db.playerCutsceneHistory.identity.find(who.identity)?.seenMask ?? 0;

    // A guest with volumes, an opt-out and a watched scene, into a fresh account: all of it moves.
    const guest = world.join("Gus");
    guest.call("setAudioSettings", { musicVolume: 0.3, sfxVolume: 0.4 });
    expect(guest.refusal("setAudioSettings", { musicVolume: 1.5, sfxVolume: 0.4 })).toBeTruthy();
    expect(guest.refusal("setAudioSettings", { musicVolume: Number.NaN, sfxVolume: 0.4 })).toBeTruthy();
    expect(audio(guest)).toMatchObject({ musicVolume: expect.closeTo(0.3, 5), sfxVolume: expect.closeTo(0.4, 5) });
    guest.call("setOfflineProgressEnabled", { enabled: false });
    guest.patch("playerProgress", { desertUnlocked: true });
    guest.call("markPortalCutsceneSeen", { cutscene: PORTAL_CUTSCENES[0].id, generation: world.db.playerCutsceneHistory.identity.find(guest.identity)?.generation ?? 0 });
    // Only an unlocked portal's scene can be marked.
    expect(guest.refusal("markPortalCutsceneSeen", { cutscene: PORTAL_CUTSCENES[1].id, generation: world.db.playerCutsceneHistory.identity.find(guest.identity)?.generation ?? 0 })).toBeTruthy();
    const fresh = world.join("fresh-account", { kind: "account", tutorial: true });
    link(guest, fresh, 1);
    expect(audio(fresh)).toMatchObject({ musicVolume: expect.closeTo(0.3, 5), sfxVolume: expect.closeTo(0.4, 5) });
    expect(offline(fresh)).toBe(false);
    expect(seen(fresh) & 1).toBe(1);
    expect(audio(guest)).toBeFalsy();
    expect(world.db.playerCutsceneHistory.identity.find(guest.identity)).toBeFalsy();

    // An account that already chose keeps its own volumes and its own offline choice.
    const owner = world.join("own-account", { kind: "account", tutorial: true });
    owner.call("setAudioSettings", { musicVolume: 0.9, sfxVolume: 0.8 });
    owner.call("setOfflineProgressEnabled", { enabled: true });
    const second = world.join("Gwen");
    second.call("setAudioSettings", { musicVolume: 0.1, sfxVolume: 0.1 });
    second.call("setOfflineProgressEnabled", { enabled: false });
    link(second, owner, 2);
    expect(audio(owner)).toMatchObject({ musicVolume: expect.closeTo(0.9, 5), sfxVolume: expect.closeTo(0.8, 5) });
    expect(offline(owner)).toBe(true);

    // Reset Save forgets the scenes watched (a new character sees them again).
    fresh.call("resetPlayerProgress");
    expect(seen(fresh)).toBe(0);

    // Erasing one account takes its settings and leaves the other's.
    world.player("owner", "owner").call("devEraseAccount", { identityHex: fresh.hex, confirmation: "ERASE", reason: "Player asked for deletion" });
    expect(audio(fresh)).toBeFalsy();
    expect(world.db.playerOfflinePreference.identity.find(fresh.identity)).toBeFalsy();
    expect(world.db.playerCutsceneHistory.identity.find(fresh.identity)).toBeFalsy();
    expect(audio(owner)).toBeTruthy();
  });
});
