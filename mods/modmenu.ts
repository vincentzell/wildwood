// mods/modmenu.ts
import { installMovableHudCard } from "../src/ui/movable-hud-card";
import { REGISTERED_MODS } from "./registry";
const MOD_MENU_ID = "mod-modmenu";
const POSITION_KEY = "wildwood-mod-modmenu-position";
const COLLAPSED_KEY = "wildwood-mod-modmenu-collapsed";

/**
 * Menu flottant des mods. Rejoue la mécanique du stat tracker :
 * classe CSS `.stat-tracker`, ancré dans `#hud`, déplaçable via
 * `installMovableHudCard`, repliable via `is-collapsed`.
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

  const header = document.createElement("header");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.className = "stat-tracker-handle";
  header.append(handle);

  const content = document.createElement("div");
  content.style.padding = "6px 8px";

  const greeting = document.createElement("p");
  greeting.style.margin = "0 0 6px";
  greeting.textContent = "Hello World !";

  const list = document.createElement("ul");
  list.style.margin = "0";
  list.style.padding = "0";
  list.style.listStyle = "none";

  if (REGISTERED_MODS.length === 0) {
    const empty = document.createElement("li");
    empty.style.opacity = "0.6";
    empty.style.fontSize = "11px";
    empty.textContent = "Aucun mod actif.";
    list.append(empty);
  } else {
    for (const mod of REGISTERED_MODS) {
      const li = document.createElement("li");
      li.textContent = mod.name;
      li.style.padding = "2px 0";
      list.append(li);
    }
  }

  content.append(greeting, list);
  panel.append(header, content);
  hud.append(panel);

  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSED_KEY) === "true";
  } catch {
    // localStorage indisponible : état par défaut, pas d'erreur.
  }

  function renderCollapsed(): void {
    panel.classList.toggle("is-collapsed", collapsed);
    handle.setAttribute("aria-expanded", String(!collapsed));
    handle.setAttribute(
      "aria-label",
      `${collapsed ? "Expand" : "Collapse"} mod menu. Drag to move; Home to reset position.`,
    );
    handle.textContent = `Mods ${collapsed ? "▸" : "▾"}`;
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
        // Ignore : la persistance est optionnelle.
      }
      renderCollapsed();
    },
  });

  renderCollapsed();
}
