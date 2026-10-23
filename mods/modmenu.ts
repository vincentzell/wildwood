// mods/modmenu.ts
import { installMovableHudCard } from "../src/ui/movable-hud-card";
import { REGISTERED_MODS, type Mod, type ModCategory } from "./registry";

const MOD_MENU_ID = "mod-modmenu";
const POSITION_KEY = "wildwood-mod-modmenu-position";
const COLLAPSED_KEY = "wildwood-mod-modmenu-collapsed";
const ACTIVE_TAB_KEY = "wildwood-mod-modmenu-tab";

const CATEGORIES: readonly ModCategory[] = ["FARM", "QUEST", "CARD", "MISC"];

const PLAYER_HUD_SELECTOR = ".player-hud-card";

function playerHudWidth(): number | null {
  const el = document.querySelector(PLAYER_HUD_SELECTOR);
  if (!el) return null;
  const w = el.getBoundingClientRect().width;
  return w > 0 ? Math.round(w) : null;
}

function applyMaxWidth(panel: HTMLElement): void {
  const hudW = playerHudWidth() ?? 320;
  const cap = Math.max(200, Math.min(hudW, window.innerWidth - 16));
  panel.style.maxWidth = `${cap}px`;
}

/**
 * Menu flottant des mods, avec onglets par catégorie.
 * Rejoue la mécanique du stat tracker : classe `.stat-tracker`,
 * ancré dans `#hud`, déplaçable via `installMovableHudCard`.
 */
export function installModMenu(): void {
  if (document.getElementById(MOD_MENU_ID)) return;

  const hud = document.getElementById("hud");
  if (!hud) {
    console.warn("[modmenu] #hud introuvable, menu non installé");
    return;
  }

  const panel = document.createElement("section");
  panel.id = MOD_MENU_ID;
  panel.className = "stat-tracker";
  panel.setAttribute("aria-label", "Mod menu");
  panel.style.right = "16px";
  panel.style.left = "auto";
  panel.style.top = "16px";

  const header = document.createElement("header");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "stat-tracker-handle";
  header.append(handle);

  // Barre d'onglets
  const tabsBar = document.createElement("nav");
  tabsBar.setAttribute("role", "tablist");
  Object.assign(tabsBar.style, {
    display: "flex",
    gap: "2px",
    padding: "4px 6px",
    borderBottom: "1px solid rgba(255,255,255,.1)",
  });

  // Zone de contenu (cartes des mods actifs de l'onglet courant)
  const content = document.createElement("div");
  content.style.padding = "6px 8px";

  let activeTab: ModCategory = "FARM";
  try {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY) as ModCategory | null;
    if (saved && CATEGORIES.includes(saved)) activeTab = saved;
  } catch {
    /* idem */
  }

  const tabButtons = new Map<ModCategory, HTMLButtonElement>();
  for (const category of CATEGORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = category;
    btn.setAttribute("role", "tab");
    Object.assign(btn.style, {
      flex: "1",
      font: "inherit",
      padding: "3px 6px",
      cursor: "pointer",
      background: "transparent",
      border: "1px solid transparent",
      borderRadius: "4px",
      color: "inherit",
    });
    btn.addEventListener("click", () => {
      activeTab = category;
      try {
        localStorage.setItem(ACTIVE_TAB_KEY, category);
      } catch {
        /* idem */
      }
      render();
    });
    tabButtons.set(category, btn);
    tabsBar.append(btn);
  }

  panel.append(header, tabsBar, content);
  hud.append(panel);
  applyMaxWidth(panel);
  window.addEventListener("resize", () => {
    applyMaxWidth(panel);
    applyInitialPosition();
  });
  if (typeof ResizeObserver !== "undefined") {
    const target = document.querySelector(PLAYER_HUD_SELECTOR);
    if (target) new ResizeObserver(() => {
      applyMaxWidth(panel);
      applyInitialPosition();
    }).observe(target);
  }

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    /* idem */
  }

  const hasSavedPosition = (): boolean => {
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
      return Boolean(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y));
    } catch {
      return false;
    }
  };
  function applyInitialPosition(): void {
    if (hasSavedPosition()) return;
    panel.style.right = "16px";
    panel.style.left = "auto";
    panel.style.top = "16px";
  }

  function renderCard(mod: Mod): HTMLElement {
    const card = document.createElement("div");
    Object.assign(card.style, {
      border: "1px solid rgba(255,255,255,.15)",
      borderRadius: "4px",
      margin: "4px 0",
      overflow: "hidden",
    });

    const cardHeader = document.createElement("div");
    Object.assign(cardHeader.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px",
      padding: "4px 6px",
      userSelect: "none",
    });

    const cardTitle = document.createElement("span");
    cardTitle.textContent = mod.name;
    Object.assign(cardTitle.style, { flex: "1", fontWeight: "600" });

    if (mod.switch) {
      const sw = mod.switch;
      const label = document.createElement("label");
      Object.assign(label.style, {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "11px",
        cursor: "pointer",
      });
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = sw.get();
      checkbox.addEventListener("change", () => sw.set(checkbox.checked));
      label.append(checkbox, document.createTextNode(sw.label));
      cardHeader.append(cardTitle, label);
    } else {
      cardHeader.append(cardTitle);
    }

    card.append(cardHeader);
    return card;
  }

  function render(): void {
    for (const [category, btn] of tabButtons) {
      const isActive = category === activeTab;
      btn.style.background = isActive ? "rgba(255,255,255,.15)" : "transparent";
      btn.style.borderColor = isActive ? "rgba(255,255,255,.3)" : "transparent";
      btn.setAttribute("aria-selected", String(isActive));
    }
    content.replaceChildren();
    const mods = REGISTERED_MODS.filter((m) => m.category === activeTab);
    if (mods.length === 0) {
      const empty = document.createElement("p");
      Object.assign(empty.style, { margin: "4px 0", opacity: "0.6", fontSize: "11px" });
      empty.textContent = `Aucun mod ${activeTab}.`;
      content.append(empty);
    } else {
      for (const mod of mods) content.append(renderCard(mod));
    }
    movable.place();
    applyInitialPosition();
  }

  function renderCollapsed(): void {
    panel.classList.toggle("is-collapsed", collapsed);
    handle.setAttribute("aria-expanded", String(!collapsed));
    handle.textContent = `Mods ${collapsed ? "▸" : "▾"}`;
    tabsBar.hidden = collapsed;
    content.hidden = collapsed;
    movable.place();
    applyInitialPosition();
  }

  const movable = installMovableHudCard({
    panel,
    handle,
    storage: () => localStorage,
    positionKey: POSITION_KEY,
    toggle: () => {
      collapsed = !collapsed;
      try {
        localStorage.setItem(COLLAPSED_KEY, String(collapsed));
      } catch {
        /* idem */
      }
      renderCollapsed();
    },
  });

  renderCollapsed();
  render();
}
