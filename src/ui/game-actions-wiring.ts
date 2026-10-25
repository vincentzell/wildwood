import type { CoopAccess } from "../game/runtime/coop-access";
import type { createGameBootstrap } from "../game/runtime/game-bootstrap";
import type { createGameElements } from "./game-elements";
import { createGameActionsRuntime } from "./game-ui-runtime";
import type { createHudTimerColumn } from "./hud-timer-column";
import type { createInventoryController } from "./inventory-controller";
import type { createItemInspectionController } from "./item-inspection-controller";

type ClosableWindow = { isOpen: () => boolean; close: () => void };

export type GameActionsDeps = {
  coop: CoopAccess;
  e: ReturnType<typeof createGameElements>;
  inventory: ReturnType<typeof createGameBootstrap>["inventory"];
  inventoryController: ReturnType<typeof createInventoryController>;
  itemInspection: ReturnType<typeof createItemInspectionController>;
  renderInventory: () => void;
  logPickup: (text: string, color: string, value?: number) => void;
  showMessage: (text: string, color?: string) => void;
  clearInput: () => void;
  minimizeChat: () => void;
  openSupporter: () => void;
  drawDiamondLook: (canvas: HTMLCanvasElement) => void;
  closeIconPicker: () => void;
  leaveDuelResult: () => void;
  closeDuelReplay: () => void;
  /** The windows a toolbar window closes when it opens, and Escape closes one at a time. */
  windows: {
    profile: ClosableWindow & { isNameEditorOpen: () => boolean; closeNameEditor: () => void };
    guild: { close: () => void };
    mapGuide: ClosableWindow;
    slotUpgrades: ClosableWindow;
    leaderboard: ClosableWindow;
    devPanel: ClosableWindow;
    techTree: { close: () => void };
    rewardedRespawnAd: ReturnType<typeof createHudTimerColumn>;
  };
  setGameplayPause: (reason: string, active: boolean) => void;
  clearProgressState: () => void;
  setTotalKills: (kills: number) => void;
  bootsPickup: { collected: boolean };
  /** Returns the world to a fresh start in the forest after a progress reset. */
  resetGame: () => Promise<void>;
  session: { stop: () => void; refreshFrameClock: () => void };
  restartStartup: () => void;
  hideGameOver: () => void;
};

/**
 * The toolbar's windows (settings, bag, shop), resetting progress, and what
 * Escape closes. Returns the handler player input calls on Escape.
 */
export function createGameActions(deps: GameActionsDeps) {
  const { coop, e, windows } = deps;
  const { profile, leaderboard, devPanel } = windows;
  return createGameActionsRuntime({
    coop: coop.client,
    openSupporter: deps.openSupporter, drawDiamondLook: deps.drawDiamondLook,
    setShopOpen: () => { deps.clearInput(); },
    e, inventory: deps.inventory, renderInventory: deps.renderInventory, logPickup: deps.logPickup, showMessage: deps.showMessage,
    leaveDuelResult: deps.leaveDuelResult,
    itemInspectionController: deps.itemInspection,
    minimizeChat: deps.minimizeChat,
    closeCompetingWindows: () => {
      profile.close();
      windows.guild.close();
      windows.mapGuide.close();
      windows.slotUpgrades.close();
      leaderboard.close();
      devPanel.close();
      windows.techTree.close();
    },
    closeDuelReplay: deps.closeDuelReplay,
    resetServerProgress: async () => await coop.client?.resetProgress?.() ?? { ok: false, error: "Connect to your character before resetting." },
    setResetPending: (pending: boolean) => deps.setGameplayPause("reset-progress", pending),
    clearProgressState: deps.clearProgressState,
    setTotalKills: deps.setTotalKills,
    setBootsCollected: (collected: boolean) => { deps.bootsPickup.collected = collected; },
    clearPlayerInput: deps.clearInput,
    resetGame: deps.resetGame,
    stopGame: deps.session.stop, restartStartup: deps.restartStartup, hideGameOver: deps.hideGameOver,
    refreshFrameClock: deps.session.refreshFrameClock, closeProfileIconPicker: deps.closeIconPicker,
    inventoryController: deps.inventoryController,
    leaderboard, closeLeaderboard: () => leaderboard.close(), devPanel, profileWindow: profile,
    slotUpgradesController: windows.slotUpgrades, mapGuide: windows.mapGuide, rewardedRespawnAd: windows.rewardedRespawnAd,
  }).handleInputEscape;
}
