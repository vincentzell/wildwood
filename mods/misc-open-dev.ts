import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-open-dev-enabled";

export function isOpenDevEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function showDevButton(): void {
  const button = document.getElementById("devAuditBtn");
  if (button) button.removeAttribute("hidden");
}

function openPanel(): void {
  const panel = document.getElementById("devAudit");
  if (panel) panel.removeAttribute("hidden");
  showDevButton();
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  if (!isOpenDevEnabled()) {
    wrap.style.cssText = "font-size:10px;opacity:.6;";
    wrap.textContent = "Désactivé";
    return wrap;
  }

  const warning = document.createElement("div");
  warning.style.cssText = "font-size:9px;color:#ffd85b;margin-bottom:4px;";
  warning.textContent = "⚠ Actions serveur échoueront (pas dev). Onglets locaux OK : Performance, Prestige Preview, Boss Hitboxes.";

  const button = document.createElement("button");
  button.className = "wp-btn wp-primary";
  button.textContent = "🔓 Open Dev Panel";
  button.style.cssText = "font-size:10px;width:100%;";
  button.onclick = openPanel;
  wrap.append(warning, button);
  return wrap;
}

export function registerOpenDevMod(): void {
  REGISTERED_MODS.push({
    id: "misc-open-dev",
    name: "Open Dev Panel",
    category: "MISC",
    switch: {
      label: "On",
      get: isOpenDevEnabled,
      set: value => {
        try {
          localStorage.setItem(STORAGE_KEY, String(value));
        } catch {
          // Ignore unavailable local storage.
        }
        if (value) showDevButton();
      },
    },
    status: { render: renderStatus, intervalMs: 2000 },
    install: () => { if (isOpenDevEnabled()) showDevButton(); },
  });
}
