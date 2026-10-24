import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-open-dev-enabled";

let keepOpen = false;
let enforceInterval: number | null = null;

export function isOpenDevEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function enforce(): void {
  if (!isOpenDevEnabled() || !keepOpen) return;
  const button = document.getElementById("devAuditBtn");
  if (button) button.removeAttribute("hidden");
  const panel = document.getElementById("devAudit");
  if (panel) panel.removeAttribute("hidden");
}

function startEnforce(): void {
  if (enforceInterval !== null) return;
  enforceInterval = window.setInterval(enforce, 150);
  enforce();
}

function stopEnforce(): void {
  if (enforceInterval !== null) {
    window.clearInterval(enforceInterval);
    enforceInterval = null;
  }
  keepOpen = false;
}

function openPanel(): void {
  keepOpen = true;
  enforce();
}

function togglePanel(): void {
  if (keepOpen) {
    const panel = document.getElementById("devAudit");
    if (panel) panel.setAttribute("hidden", "");
    stopEnforce();
    return;
  }
  openPanel();
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
  button.textContent = keepOpen ? "🔒 Close Dev Panel" : "🔓 Open Dev Panel";
  button.style.cssText = "font-size:10px;width:100%;";
  button.onclick = togglePanel;
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
        if (value) startEnforce();
        else stopEnforce();
      },
    },
    status: { render: renderStatus, intervalMs: 2000 },
    install: () => { if (isOpenDevEnabled()) startEnforce(); },
  });
}
