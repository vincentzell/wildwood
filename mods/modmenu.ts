// mods/modmenu.ts
import { installMovableHudCard } from "../src/ui/movable-hud-card";
import { REGISTERED_MODS, type Mod, type ModCategory } from "./registry";

const MOD_MENU_ID = "mod-modmenu";
const POSITION_KEY = "wildwood-mod-modmenu-position";
const COLLAPSED_KEY = "wildwood-mod-modmenu-collapsed";
const ACTIVE_TAB_KEY = "wildwood-mod-modmenu-tab";
const CARD_COLLAPSED_PREFIX = "wildwood-mod-modmenu-card-";

const CATEGORIES: readonly ModCategory[] = ["FARM", "QUEST", "CARD", "MISC"];

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

  const header = document.createElement("header");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "stat-tracker-handle";
  header.append(handle);

  const tabsBar = document.createElement("nav");
  tabsBar.setAttribute("role", "tablist");
  Object.assign(tabsBar.style, {
    display: "flex",
    gap: "2px",
    padding: "4px 6px",
    borderBottom: "1px solid rgba(255,255,255,.1)",
  });

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

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    /* idem */
  }

  const isCardCollapsed = (id: string): boolean => {
    try {
      return localStorage.getItem(CARD_COLLAPSED_PREFIX + id) === "true";
    } catch {
      return false;
    }
  };
  const setCardCollapsed = (id: string, value: boolean): void => {
    try {
      localStorage.setItem(CARD_COLLAPSED_PREFIX + id, String(value));
    } catch {
      /* idem */
    }
  };

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
      cursor: "pointer",
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
      label.addEventListener("click", (e) => e.stopPropagation());
      label.append(checkbox, document.createTextNode(sw.label));
      cardHeader.append(cardTitle, label);
    } else {
      cardHeader.append(cardTitle);
    }

    const caret = document.createElement("span");
    caret.style.fontSize = "11px";
    const startCollapsed = isCardCollapsed(mod.id);
    caret.textContent = startCollapsed ? "▸" : "▾";
    cardHeader.append(caret);

    const cardBody = document.createElement("div");
    Object.assign(cardBody.style, {
      padding: "4px 8px 6px",
      fontSize: "11px",
      opacity: "0.85",
    });
    cardBody.textContent = mod.description ?? "";
    cardBody.hidden = startCollapsed;

    cardHeader.addEventListener("click", () => {
      const nowCollapsed = !isCardCollapsed(mod.id);
      setCardCollapsed(mod.id, nowCollapsed);
      cardBody.hidden = nowCollapsed;
      caret.textContent = nowCollapsed ? "▸" : "▾";
      movable.place();
    });

    card.append(cardHeader, cardBody);
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
  }

  function renderCollapsed(): void {
    panel.classList.toggle("is-collapsed", collapsed);
    handle.setAttribute("aria-expanded", String(!collapsed));
    handle.textContent = `Mods ${collapsed ? "▸" : "▾"}`;
    tabsBar.hidden = collapsed;
    content.hidden = collapsed;
    movable.place();
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
