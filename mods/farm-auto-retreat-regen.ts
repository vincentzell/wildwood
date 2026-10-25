import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-retreat-enabled";
const THRESHOLD_KEY = "wildwood-mod-auto-retreat-threshold";
const RETURN_MAP_KEY = "wildwood-mod-auto-retreat-return-map";
const POLL_MS = 2_000;
const COOLDOWN_MS = 5_000;

type CoopLike = {
  localState?: () => { mapId?: string } | null;
  localDuel?: () => unknown;
  travelToMap?: (mapId: string) => Promise<boolean>;
  teleportToTownSquare?: () => Promise<boolean>;
  changeMap?: (mapId: string, x: number, y: number) => Promise<boolean>;
};

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function isAutoRetreatEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function getThreshold(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(THRESHOLD_KEY) ?? "30", 10);
    return Math.max(5, Math.min(99, value > 0 ? value : 30));
  } catch {
    return 30;
  }
}

function setThreshold(value: number): void {
  try {
    localStorage.setItem(THRESHOLD_KEY, String(Math.max(5, Math.min(99, value))));
  } catch {
    // Ignore unavailable local storage.
  }
}

function parseCompactNumber(text: string): number {
  const cleaned = text.replace(/[\s,]/g, "").trim();
  const match = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (!match) return NaN;
  const value = Number.parseFloat(match[1]);
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1e3 : suffix === "M" ? 1e6
    : suffix === "B" ? 1e9 : suffix === "T" ? 1e12 : 1;
  return value * multiplier;
}

function readHpRatio(): number | null {
  const element = document.getElementById("hpText");
  if (!element) return null;
  const text = element.firstChild?.textContent?.trim() ?? "";
  const parts = text.split("/").map(part => part.trim());
  if (parts.length !== 2) return null;
  const hp = parseCompactNumber(parts[0]);
  const maxHp = parseCompactNumber(parts[1]);
  if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return null;
  return (hp / maxHp) * 100;
}

type Phase = "idle" | "retreating" | "healing" | "returning";

let phase: Phase = "idle";
let returnMap = "";
let lastAttemptTs = 0;
let intervalId: number | null = null;
let tickInProgress = false;

async function tick(): Promise<void> {
  if (tickInProgress || !isAutoRetreatEnabled()) return;
  if (Date.now() - lastAttemptTs < COOLDOWN_MS) return;
  const coop = getCoop();
  if (!coop?.localState || coop.localDuel?.()) return;

  const state = coop.localState();
  if (!state) return;
  const mapId = state.mapId ?? "";
  const inTown = mapId === "town";
  const ratio = readHpRatio();
  if (ratio === null) return;

  tickInProgress = true;
  try {
    if (inTown && ratio >= 99.5 && returnMap) {
      phase = "returning";
      try {
        const ok = await coop.travelToMap?.(returnMap);
        if (ok) {
          console.info(`[mod-auto-retreat] retour ${returnMap}`);
          returnMap = "";
          try {
            localStorage.removeItem(RETURN_MAP_KEY);
          } catch {
            // Ignore unavailable local storage.
          }
          phase = "idle";
        }
      } catch (error) {
        console.warn(`[mod-auto-retreat] retour vers ${returnMap} impossible`, error);
      }
      lastAttemptTs = Date.now();
      return;
    }

    if (!inTown && ratio < getThreshold()) {
      // Ne pas TP si mort : laisser le respawn faire son travail.
      if (ratio <= 0.5) { phase = "healing"; return; }
      phase = "retreating";
      if (returnMap !== mapId) {
        returnMap = mapId;
        try { localStorage.setItem(RETURN_MAP_KEY, returnMap); } catch {}
      }
      console.info("[mod-auto-retreat] retraite (" + Math.round(ratio) + "% < " + getThreshold() + "%) depuis " + returnMap);

      // Priorité : changeMap('town', 2400, 2400) — marche depuis n'importe où,
      // y compris les maps Endless où travelToMap est refusé par le serveur.
      let tpOk = false;
      try {
        if (coop.changeMap) tpOk = (await coop.changeMap("town", 2400, 2400)) === true;
      } catch (error) {
        console.warn("[mod-auto-retreat] changeMap('town') exception", error);
      }
      // Fallback 1 : travelToMap('town') — marche sur les maps campaign.
      if (!tpOk && coop.travelToMap) {
        try { tpOk = (await coop.travelToMap("town")) === true; } catch {}
      }
      // Fallback 2 : téléport intra-ville (ne sort pas de la map, dernier recours).
      if (!tpOk && coop.teleportToTownSquare) {
        try { await coop.teleportToTownSquare(); } catch {}
      }

      // Attendre la réplication serveur (jusqu'à 3 s).
      if (tpOk) {
        const start = Date.now();
        while (Date.now() - start < 3000) {
          if (coop.localState?.()?.mapId === "town") break;
          await new Promise(r => setTimeout(r, 150));
        }
      }

      const after = coop.localState?.();
      if (after?.mapId === "town") {
        console.info("[mod-auto-retreat] retraite réussie");
        phase = "healing";
      } else {
        console.warn("[mod-auto-retreat] TP vers Town échoué (mapId=" + (after?.mapId ?? "?") + ")");
        phase = "idle";
      }
      lastAttemptTs = Date.now();
      return;
    }

    if (inTown && ratio < 99.5) {
      phase = "healing";
      return;
    }

    phase = "idle";
  } finally {
    tickInProgress = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  try {
    const saved = localStorage.getItem(RETURN_MAP_KEY);
    if (saved) returnMap = saved;
  } catch {
    // Ignore unavailable local storage.
  }
  intervalId = window.setInterval(() => { void tick(); }, POLL_MS);
  void tick();
}

function stopPolling(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
  phase = "idle";
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  const enabled = isAutoRetreatEnabled();
  const row = document.createElement("div");
  row.style.cssText = "display:flex;align-items:center;gap:4px;margin:4px 0;font-size:10px;";
  const label = document.createElement("span");
  label.textContent = "Seuil HP :";
  label.style.opacity = ".7";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "5";
  input.max = "99";
  input.value = String(getThreshold());
  input.style.cssText =
    "width:50px;background:rgba(0,0,0,.3);color:inherit;border:1px solid rgba(255,255,255,.15);" +
    "border-radius:3px;padding:1px 4px;font:inherit;font-size:10px;";
  input.addEventListener("change", () => {
    const value = Number.parseInt(input.value, 10);
    setThreshold(value > 0 ? value : 30);
  });
  const percent = document.createElement("span");
  percent.textContent = "%";
  percent.style.opacity = ".7";
  row.append(label, input, percent);
  wrap.append(row);

  if (!enabled) {
    const off = document.createElement("div");
    off.style.cssText = "font-size:10px;opacity:.55;";
    off.textContent = "Désactivé";
    wrap.append(off);
    return wrap;
  }

  const phaseText: Record<Phase, string> = {
    idle: "Surveille HP",
    retreating: "→ Retraite vers Town",
    healing: "→ Attente heal complet",
    returning: `→ Retour ${returnMap || "map"}`,
  };
  const state = document.createElement("div");
  state.style.cssText = "font-size:10px;opacity:.75;";
  state.textContent = phaseText[phase];
  wrap.append(state);
  return wrap;
}

export function registerAutoRetreatRegenMod(): void {
  REGISTERED_MODS.push({
    id: "farm-auto-retreat",
    name: "Auto Retreat Regen",
    category: "FARM",
    switch: {
      label: "On",
      get: isAutoRetreatEnabled,
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
    status: { render: renderStatus, intervalMs: 1500 },
    install: () => { if (isAutoRetreatEnabled()) startPolling(); },
  });
}
