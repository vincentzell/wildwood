import type { ConfirmPrompt } from "./confirm-dialog";

type Result = { ok: boolean; error?: string } | undefined;

const TRASH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';

export type InventoryDeleteModeDependencies = {
  /** Starter gear and anything else the server will not destroy cannot be picked. */
  canDelete: (itemId: string, copyId?: bigint) => boolean;
  /** The ids of an item's kept copies, beyond its first. */
  keptCopyIds: (itemId: string) => readonly bigint[];
  destroyEquipment: (itemId: string) => Promise<Result>;
  /** Copy id 0n is the item's first copy; the server moves a kept copy into its place. */
  destroyEquipmentCopy?: (itemId: string, copyId: bigint) => Promise<Result>;
  confirm: ConfirmPrompt;
  /** What the sellers pay for one copy, for gear they buy; it is sold for that, as the item window's trash can does. */
  salePrice?: (itemId: string) => number | undefined;
  sellGradedItem?: (itemId: string, copyId: bigint) => Promise<Result>;
  /** One copy's refine (★N), so the prompt can warn before refined gear goes. */
  refineLevel?: (itemId: string, copyId: bigint) => number;
  showMessage: (message: string, color?: string) => void;
  /** After a deletion: the bag has changed and must be drawn again. */
  onDeleted: () => void;
  /** Entering or leaving the mode, for the toolbar around it. */
  onModeChange?: (active: boolean) => void;
  /** Takes the is-delete-mode class while the mode is on. */
  panel?: HTMLElement;
};

const keyOf = (itemId: string, copyId: bigint) => `${itemId}:${copyId}`;

/**
 * Deleting several bag items at once. The trash button beside Equip best
 * turns the mode on and then reads "Delete"; in the mode a tap on a bag item
 * picks it (a red highlight) instead of opening it, and Delete asks once for
 * everything picked. Gear the sellers buy is sold for gold, the rest destroyed.
 * Cancel, or Delete with nothing picked, leaves the mode.
 * Equipped gear is never in the bag grid, so it cannot be picked.
 */
export function createInventoryDeleteMode(dependencies: InventoryDeleteModeDependencies) {
  const element = document.createElement("div");
  element.className = "inventory-delete-controls";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "inventory-delete-cancel";
  cancel.textContent = "Cancel";
  cancel.hidden = true;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "inventory-delete-toggle";
  const label = document.createElement("span");
  label.className = "inventory-delete-label";
  toggle.innerHTML = TRASH_ICON;
  toggle.append(label);
  element.append(cancel, toggle);

  let active = false;
  let busy = false;
  const selected = new Set<string>();
  let grid: HTMLElement | null = null;

  function sync() {
    element.classList.toggle("is-active", active);
    cancel.hidden = !active;
    label.textContent = active ? (selected.size ? `Delete ${selected.size}` : "Delete") : "";
    toggle.setAttribute("aria-pressed", String(active));
    toggle.setAttribute("aria-label", !active ? "Select items to delete"
      : selected.size ? `Delete ${selected.size} selected item${selected.size === 1 ? "" : "s"}` : "Leave delete mode");
    toggle.title = active ? "Delete selected" : "Delete items";
    toggle.disabled = busy;
    if (grid) decorate(grid);
  }

  /** Marks picked bag items red and dims the ones that cannot be deleted. */
  function decorate(items: HTMLElement) {
    grid = items;
    dependencies.panel?.classList.toggle("is-delete-mode", active);
    for (const button of items.querySelectorAll<HTMLElement>(".inventory-item[data-item-id]")) {
      if (button.dataset.inventoryLocation !== "BAG") continue;
      const itemId = button.dataset.itemId!;
      const key = keyOf(itemId, BigInt(button.dataset.copyId ?? "0"));
      const picked = active && selected.has(key);
      button.classList.toggle("is-delete-selected", picked);
      button.classList.toggle("is-delete-locked", active && !dependencies.canDelete(itemId, BigInt(button.dataset.copyId ?? "0")));
      if (active) button.setAttribute("aria-pressed", String(picked));
      else button.removeAttribute("aria-pressed");
    }
  }

  function setActive(next: boolean) {
    if (active === next) return;
    active = next;
    selected.clear();
    sync();
    dependencies.onModeChange?.(active);
  }

  /** A bag tap while the mode is on. Returns false when the mode is off, so the tap opens the item as usual. */
  function pick(itemId: string, copyId = 0n) {
    if (!active) return false;
    if (busy || !dependencies.canDelete(itemId, copyId)) return true;
    const key = keyOf(itemId, copyId);
    if (selected.has(key)) selected.delete(key); else selected.add(key);
    sync();
    return true;
  }

  /**
   * Kept copies go first, then a picked first copy: while other copies of it
   * remain the server moves one into its place, and only the last copy takes
   * the item out of the bag.
   */
  async function deleteSelected() {
    const picks = new Map<string, bigint[]>();
    for (const key of selected) {
      const split = key.lastIndexOf(":");
      const itemId = key.slice(0, split);
      picks.set(itemId, [...(picks.get(itemId) ?? []), BigInt(key.slice(split + 1))]);
    }
    const count = selected.size;
    const priceOf = (itemId: string) => dependencies.sellGradedItem ? dependencies.salePrice?.(itemId) : undefined;
    const allSold = [...picks.keys()].every(itemId => priceOf(itemId) !== undefined);
    const gold = [...picks].reduce((total, [itemId, copyIds]) => total + (priceOf(itemId) ?? 0) * copyIds.length, 0);
    const refined = [...picks].reduce((total, [itemId, copyIds]) =>
      total + copyIds.filter(copyId => (dependencies.refineLevel?.(itemId, copyId) ?? 0) > 0).length, 0);
    if (!await dependencies.confirm({
      // All sold: the prompt says so; anything the sellers do not buy is deleted.
      message: allSold ? `Sell ${count} selected item${count === 1 ? "" : "s"}?` : `Delete ${count} selected item${count === 1 ? "" : "s"} permanently?`,
      details: [...(gold ? [{ label: "You Get", value: `${gold.toLocaleString("en-US")} Gold` }] : []),
        ...(refined ? [{ label: "Refined Gear", value: `${refined} Item${refined === 1 ? "" : "s"} ★` }] : [])],
      confirmLabel: allSold ? "Sell" : "Delete", danger: true,
    })) return;
    busy = true;
    sync();
    let deleted = 0, sold = 0;
    let error = "";
    const destroyCopy = dependencies.destroyEquipmentCopy;
    for (const [itemId, copyIds] of picks) {
      // Kept copies first, then the first copy: the server moves a kept one into its place.
      if (priceOf(itemId) !== undefined) {
        for (const copyId of [...copyIds].sort((a, b) => Number(a === 0n) - Number(b === 0n))) {
          const result = await dependencies.sellGradedItem!(itemId, copyId);
          if (result?.ok) sold += priceOf(itemId)!; else error ||= result?.error ?? "Not Connected";
        }
        continue;
      }
      const kept = copyIds.filter(copyId => copyId !== 0n);
      for (const copyId of kept) {
        const result = destroyCopy ? await destroyCopy(itemId, copyId) : undefined;
        if (result?.ok) deleted++; else error ||= result?.error ?? "NOT CONNECTED";
      }
      if (!copyIds.includes(0n)) continue;
      const others = dependencies.keptCopyIds(itemId).filter(copyId => !kept.includes(copyId));
      const result = others.length && destroyCopy ? await destroyCopy(itemId, 0n) : await dependencies.destroyEquipment(itemId);
      if (result?.ok) deleted++; else error ||= result?.error ?? "NOT CONNECTED";
    }
    busy = false;
    active = false;
    selected.clear();
    sync();
    dependencies.onModeChange?.(false);
    dependencies.onDeleted();
    if (sold) dependencies.showMessage(`Sold for ${sold.toLocaleString("en-US")} Gold`, "#ffd75e");
    if (deleted) dependencies.showMessage(`${deleted} Item${deleted === 1 ? "" : "s"} Destroyed`, "#ff9b91");
    if (error) dependencies.showMessage(error, "#ff9b91");
  }

  toggle.addEventListener("click", () => {
    if (busy) return;
    if (!active) setActive(true);
    else if (!selected.size) setActive(false);
    else void deleteSelected();
  });
  cancel.addEventListener("click", () => { if (!busy) setActive(false); });
  sync();

  return {
    element,
    active: () => active,
    pick,
    decorate,
    /** Leaves the mode: the inventory closed, or it switched to cosmetics. */
    exit: () => { if (!busy) setActive(false); },
    selectedCount: () => selected.size,
  };
}
