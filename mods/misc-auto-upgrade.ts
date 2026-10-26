// mods/misc-auto-upgrade.ts
import { MAX_SLOT_UPGRADE_TIER, type UpgradeSlot } from "../shared/items";
import { upgradeSlotForItem } from "../shared/slot-upgrades";
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-upgrade-enabled";
const POLL_MS = 30_000;
const UPGRADE_TRACKS: readonly UpgradeSlot[] = ["HAND", "HEAD", "CHEST"];
const UPGRADE_QUEUES = [1, 2, 3] as const;

// Backoff après un rejet "bench|smith" du serveur, reset si la position change
const NOT_AT_BENCH_BACKOFF_MS = 2 * 60 * 1000;

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
  localState?: () => { x?: number; y?: number; mapId?: string } | null;
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

// Garde-fou : backoff + détection "position stable"
let notAtBenchUntilMs = 0;
let lastPosKey = "";

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

function isVisible(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.hasAttribute("hidden")) return false;
  const s = window.getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
  return el.getClientRects().length > 0;
}

/**
 * Garde-fou : le Smith et le bench Slot Upgrades sont à Town, comme l'Exchange.
 * - Si on n'est pas dans Town → inutile d'appeler l'API, le serveur rejettera.
 * - Si le bouton natif "Gear Upgrades In Town" est visible → signal que le joueur
 *   n'est pas à portée du Smith (le jeu l'affiche pour l'inviter à y aller).
 */
function isAtSmithLocation(): boolean {
  try {
    if (getCoop()?.localState?.()?.mapId !== "town") return false;
  } catch { return false; }
  const notice = document.getElementById("smithBuyNotice");
  if (notice && isVisible(notice)) return false;
  return true;
}

async function tick(): Promise<void> {
  if (running || !isAutoUpgradeEnabled() || Date.now() - lastAttemptTs < POLL_MS) return;
  const coop = getCoop();
  if (!coop?.startItemUpgrade || !coop.localState || !coop.savedProgress || !coop.activeItemUpgrades
    || !coop.slotUpgradeTier) return;

  const position = coop.localState();
  if (!position || typeof position.x !== "number" || typeof position.y !== "number") return;

  // ─── Garde-fou 1 : pas dans Town / pas à portée du Smith ───
  // Évite 2880 appels rejetés/jour quand le joueur farme sur une map enemy.
  if (!isAtSmithLocation()) {
    lastError = "";
    lastAction = "Hors portée du Smith (Town)";
    return;
  }

  // ─── Garde-fou 2 : backoff après un rejet "bench|smith" ───
  // Reset dès que la position change de >1px (joueur s'est rapproché, téléport, etc.)
  const posKey = `${Math.round(position.x)},${Math.round(position.y)}`;
  if (posKey !== lastPosKey) {
    lastPosKey = posKey;
    notAtBenchUntilMs = 0;
  }
  if (notAtBenchUntilMs > 0 && Date.now() < notAtBenchUntilMs) {
    lastError = "";
    const left = Math.ceil((notAtBenchUntilMs - Date.now()) / 1000);
    lastAction = `Hors portée — retry dans ${left}s`;
    return;
  }

  const progress = coop.savedProgress();
  if (!progress) return;
  const tracks = equippedTracks(progress);
  if (tracks.length === 0) {
    lastError = "";
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
          notAtBenchUntilMs = 0;
          return;
        }
        if (result.error) {
          if (/bench|smith/i.test(result.error)) {
            // Backoff long : on retente quand le joueur bouge (donc quand il s'approche)
            notAtBenchUntilMs = Date.now() + NOT_AT_BENCH_BACKOFF_MS;
            lastError = "";
            lastAction = "Pas au Smith — bouge pour réessayer";
            return;
          }
          reportError(result.error);
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
  notAtBenchUntilMs = 0;
  lastPosKey = "";
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