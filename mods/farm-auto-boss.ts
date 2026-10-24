import { CAMPAIGN_MAPS } from "../shared/campaign-registry";
import { REGISTERED_MODS } from "./registry";

const ENABLED_KEY = "wildwood-mod-auto-card-boss-enabled";
const MAP_KEY = "wildwood-mod-auto-card-boss-map";
const REPEAT_BOSS_KEY = "wildwood-mod-auto-card-boss-mode";
const POLL_INTERVAL_MS = 5_000;
const TRAVEL_WAIT_MS = 15_000;

type CoopLike = {
  travelToMap?: (mapId: string) => Promise<boolean>;
  localState?: () => { mapId?: string } | null;
};

type BossMap = { id: string; name: string };
type Phase = "idle" | "traveling" | "farming" | "unavailable";

const BOSS_MAPS: BossMap[] = CAMPAIGN_MAPS.map(map => ({ id: map.id, name: map.name }));

let phase: Phase = "idle";
let statusMessage = "";
let intervalId: number | null = null;
/**
 * Map sur laquelle on a déjà configuré le panneau auto-farm dans
 * cette session. Évite de réouvrir/reconfigurer à chaque tick.
 */
let panelHandledForMap: string | null = null;

/** Garde anti-réentrance : un tick à la fois. */
let tickInProgress = false;

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

function isEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === "true";
  } catch (error) {
    console.warn("[mod-auto-card-boss] lecture du réglage impossible", error);
    return false;
  }
}

function selectedMap(): BossMap {
  try {
    const id = localStorage.getItem(MAP_KEY);
    return BOSS_MAPS.find(map => map.id === id) ?? BOSS_MAPS[0];
  } catch (error) {
    console.warn("[mod-auto-card-boss] lecture de la map impossible", error);
    return BOSS_MAPS[0];
  }
}

function saveSelectedMap(id: string): void {
  if (!BOSS_MAPS.some(map => map.id === id)) return;
  try {
    localStorage.setItem(MAP_KEY, id);
  } catch (error) {
    console.warn("[mod-auto-card-boss] enregistrement de la map impossible", error);
  }
}

function setRepeatBoss(value: boolean): void {
  try {
    localStorage.setItem(REPEAT_BOSS_KEY, String(value));
  } catch (error) {
    console.warn("[mod-auto-card-boss] réglage repeatBoss impossible", error);
  }
}

async function travelToMap(coop: CoopLike, map: BossMap): Promise<boolean> {
  if (!coop.travelToMap) {
    statusMessage = "API de voyage indisponible";
    return false;
  }
  if (coop.localState?.()?.mapId === map.id) return true;

  let moved: boolean;
  try {
    moved = await coop.travelToMap(map.id);
  } catch (error) {
    statusMessage = `Voyage vers ${map.name} impossible`;
    console.warn(`[mod-auto-card-boss] voyage vers ${map.name} impossible`, error);
    return false;
  }
  if (!moved) {
    statusMessage = `Voyage vers ${map.name} refusé`;
    console.warn(`[mod-auto-card-boss] voyage vers ${map.name} refusé`);
    return false;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < TRAVEL_WAIT_MS) {
    if (!isEnabled() || selectedMap().id !== map.id) return false;
    await new Promise(resolve => window.setTimeout(resolve, 300));
    if (coop.localState?.()?.mapId === map.id) return true;
  }
  statusMessage = `Arrivée à ${map.name} non confirmée`;
  console.warn(`[mod-auto-card-boss] arrivée à ${map.name} non confirmée`);
  return false;
}

async function tick(): Promise<void> {
  if (tickInProgress) return;
  if (!isEnabled()) return;
  tickInProgress = true;
  try {
    statusMessage = "";
    const coop = getCoop();
    if (!coop) {
      phase = "unavailable";
      statusMessage = "API coop indisponible";
      return;
    }
    const targetMap = selectedMap().id;
    const current = coop.localState?.()?.mapId;

    if (current !== targetMap) {
      phase = "traveling";
      if (panelHandledForMap !== targetMap) {
        panelHandledForMap = null;
        setRepeatBoss(false);
      }
      const map = BOSS_MAPS.find(candidate => candidate.id === targetMap) ?? BOSS_MAPS[0];
      const ok = await travelToMap(coop, map);
      if (!ok) {
        if (isEnabled() && selectedMap().id === targetMap) phase = "unavailable";
        return;
      }
      if (!isEnabled() || selectedMap().id !== targetMap) return;
      setRepeatBoss(true);
      phase = "farming";
      return;
    }

    setRepeatBoss(true);
    phase = "farming";

    if (panelHandledForMap === targetMap) return;
    const sheet = document.getElementById("autoFarmSheet");
    if (!sheet) {
      phase = "unavailable";
      statusMessage = "Panneau Auto Farm indisponible";
      return;
    }
    const content = sheet.querySelector<HTMLElement>("#autoFarmContent");
    const wasHidden = content?.hidden ?? true;
    panelHandledForMap = targetMap;

    if (wasHidden) {
      sheet.querySelector<HTMLButtonElement>(".farm-toggle")?.click();
      await new Promise(resolve => window.setTimeout(resolve, 300));
    }

    const advance = sheet.querySelector<HTMLElement>('[data-switch="advance"]');
    if (advance?.getAttribute("aria-checked") !== "true") advance?.click();

    let started = sheet.classList.contains("is-farming");
    if (!started) {
      const start = sheet.querySelector<HTMLButtonElement>(".farm-start");
      if (start?.disabled) {
        sheet.querySelector<HTMLButtonElement>('.farm-weights [data-mode="farm"]')?.click();
      }
      if (start && !start.disabled) {
        start.click();
        started = sheet.classList.contains("is-farming");
      }
    }

    if (wasHidden) {
      await new Promise(resolve => window.setTimeout(resolve, 300));
      if (content && !content.hidden) {
        sheet.querySelector<HTMLButtonElement>(".farm-toggle")?.click();
      }
    }
    if (!started) {
      phase = "unavailable";
      statusMessage = "Démarrage d'Auto Farm impossible";
    }
  } finally {
    tickInProgress = false;
  }
}

function startPolling(): void {
  if (intervalId !== null) return;
  intervalId = window.setInterval(() => {
    void tick().catch(error => console.error("[mod-auto-card-boss] boucle interrompue", error));
  }, POLL_INTERVAL_MS);
  void tick().catch(error => console.error("[mod-auto-card-boss] boucle interrompue", error));
}

function stopPolling(): void {
  if (intervalId !== null) {
    window.clearInterval(intervalId);
    intervalId = null;
  }
  phase = "idle";
  statusMessage = "";
  setRepeatBoss(false);
  panelHandledForMap = null;
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  const status = document.createElement("div");
  status.style.cssText = "margin-bottom:4px;font-weight:600;color:#b7c5b7;";
  const labels: Record<Phase, string> = {
    idle: "Désactivé",
    traveling: `Voyage vers ${selectedMap().name}`,
    farming: `Farm du boss · ${selectedMap().name}`,
    unavailable: "Auto Farm indisponible",
  };
  status.textContent = isEnabled() ? statusMessage || labels[phase] : labels.idle;
  wrap.append(status);

  const select = document.createElement("select");
  select.style.cssText = "width:100%;font-size:11px;";
  for (const map of BOSS_MAPS) {
    const option = document.createElement("option");
    option.value = map.id;
    option.textContent = map.name;
    option.selected = map.id === selectedMap().id;
    select.append(option);
  }
  select.addEventListener("change", () => saveSelectedMap(select.value));
  wrap.append(select);
  return wrap;
}

export function registerAutoFarmBossMod(): void {
  REGISTERED_MODS.push({
    id: "farm-auto-boss",
    name: "Auto Farm Boss",
    category: "FARM",
    switch: {
      label: "On",
      get: isEnabled,
      set: value => {
        try {
          localStorage.setItem(ENABLED_KEY, String(value));
        } catch (error) {
          console.warn("[mod-auto-card-boss] enregistrement du réglage impossible", error);
        }
        if (value) startPolling();
        else stopPolling();
      },
    },
    status: { render: renderStatus, intervalMs: 1_500 },
    install: () => {
      if (isEnabled()) startPolling();
    },
  });
}
