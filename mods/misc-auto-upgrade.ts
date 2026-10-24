import { MAX_SLOT_UPGRADE_TIER, type UpgradeSlot } from "../shared/items";
import { upgradeSlotForItem } from "../shared/slot-upgrades";
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-upgrade-enabled";
const POLL_MS = 30_000;
const UPGRADE_TRACKS: readonly UpgradeSlot[] = ["HAND", "HEAD", "CHEST"];
const UPGRADE_QUEUES = [1, 2, 3] as const;

type UpgradeQueue = typeof UPGRADE_QUEUES[number];
type SavedProgress = {
  equippedRightHand?: string;
  equippedHead?: string;
  equippedChest?: string;
  equippedFeet?: string;
  inventoryJson?: string;
} | null;

type CoopLike = {
  savedProgress?: () => SavedProgress;
  localState?: () => { x?: number; y?: number } | null;
  activeItemUpgrades?: () => { slot: UpgradeQueue; itemId: string }[];
  secondUpgradeSlotUnlocked?: () => boolean;
  thirdUpgradeSlotUnlocked?: () => boolean;
  slotUpgradeTier?: (slot: UpgradeSlot) => number;
  startItemUpgrade?: (
    queue: UpgradeQueue,
    slot: UpgradeSlot,
    position: { x: number; y: number },
  ) => Promise<{ ok: boolean; error?: string }>;
};

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function isAutoUpgradeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let running = false;
let warnedNotAtBench = false;
let lastAttemptTs = 0;
let lastAction = "";
let lastError = "";
let intervalId: number | null = null;

function equippedTracks(progress: NonNullable<SavedProgress>): UpgradeSlot[] {
  const itemIds = [
    progress.equippedRightHand,
    progress.equippedHead,
    progress.equippedChest,
    progress.equippedFeet,
  ];
  const tracks = new Set<UpgradeSlot>();
  for (const itemId of itemIds) {
    const track = itemId ? upgradeSlotForItem(itemId) : null;
    if (track) tracks.add(track);
  }
  return UPGRADE_TRACKS.filter(track => tracks.has(track));
}

function reportError(message: string): void {
  lastError = message;
  if (/bench|smith/i.test(message)) {
    if (!warnedNotAtBench) {
      console.warn("[mod-auto-upgrade] Le serveur exige le bench Slot Upgrades ou le Smith pour démarrer une amélioration.", message);
      warnedNotAtBench = true;
    }
  }
}

async function tick(): Promise<void> {
  if (running || !isAutoUpgradeEnabled() || Date.now() - lastAttemptTs < POLL_MS) return;
  const coop = getCoop();
  if (!coop?.startItemUpgrade || !coop.localState || !coop.savedProgress || !coop.activeItemUpgrades
    || !coop.slotUpgradeTier) return;

  const position = coop.localState();
  if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;
  const progress = coop.savedProgress();
  if (!progress) return;
  const tracks = equippedTracks(progress);
  if (tracks.length === 0) {
    lastAction = "Aucun équipement améliorable équipé";
    return;
  }

  running = true;
  lastAttemptTs = Date.now();
  try {
    const active = coop.activeItemUpgrades();
    const occupiedQueues = new Set(active.map(upgrade => upgrade.slot));
    const activeTracks = new Set(active.map(upgrade => upgrade.itemId));
    const availableQueues = UPGRADE_QUEUES.filter(queue => {
      if (queue === 2 && !coop.secondUpgradeSlotUnlocked?.()) return false;
      if (queue === 3 && !coop.thirdUpgradeSlotUnlocked?.()) return false;
      return !occupiedQueues.has(queue);
    });

    for (const queue of availableQueues) {
      for (const track of tracks) {
        if (activeTracks.has(track) || coop.slotUpgradeTier(track) >= MAX_SLOT_UPGRADE_TIER) continue;
        const result = await coop.startItemUpgrade(queue, track, { x: position.x, y: position.y });
        if (result.ok) {
          lastError = "";
          lastAction = `▶ Q${queue} ${track}`;
          warnedNotAtBench = false;
          return;
        }
        if (result.error) {
          reportError(result.error);
          if (/bench|smith/i.test(result.error)) return;
        }
      }
    }
    if (lastError) return;
    lastAction = "En attente d'une file libre";
  } catch (error) {
    reportError(error instanceof Error ? error.message : String(error));
    console.error("[mod-auto-upgrade] échec du démarrage d'une amélioration", error);
  } finally {
    running = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => { void tick(); }, POLL_MS);
  void tick();
}

function stopPolling(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  if (!isAutoUpgradeEnabled()) {
    wrap.style.cssText = "font-size:10px;opacity:.6;";
    wrap.textContent = "Désactivé";
    return wrap;
  }
  const line = document.createElement("div");
  line.style.cssText = "font-size:10px;opacity:.75;";
  line.textContent = lastError ? `⚠ ${lastError}` : (lastAction || "En attente d'un bench libre");
  wrap.append(line);
  return wrap;
}

export function registerAutoUpgradeMod(): void {
  REGISTERED_MODS.push({
    id: "misc-auto-upgrade",
    name: "Auto Upgrade",
    category: "MISC",
    switch: {
      label: "On",
      get: isAutoUpgradeEnabled,
      set: value => {
        try {
          localStorage.setItem(STORAGE_KEY, String(value));
        } catch {
          // Ignore unavailable local storage.
        }
        if (value) startPolling();
        else stopPolling();
      },
    },
    status: { render: renderStatus, intervalMs: 2000 },
    install: () => { if (isAutoUpgradeEnabled()) startPolling(); },
  });
}
