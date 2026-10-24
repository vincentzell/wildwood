import { RESEARCH_IDS, researchIsAvailable, type ResearchId, type ResearchRanks } from "../shared/research";
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-auto-tech-tree-enabled";
const POLL_MS = 10_000;

type CoopLike = {
  activeResearch?: () => unknown;
  research?: () => ResearchRanks;
  startResearch?: (id: ResearchId) => Promise<{ ok: boolean; error?: string }>;
};

function getCoop(): CoopLike | null {
  const w = window as unknown as {
    wildstatCoop?: CoopLike;
    wildwoodCoop?: CoopLike;
  };
  return w.wildstatCoop ?? w.wildwoodCoop ?? null;
}

export function isAutoTechTreeEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let running = false;
let lastAttemptTs = 0;
let lastAction = "";
let lastError = "";
let intervalId: number | null = null;

function pickResearchToStart(ranks: ResearchRanks): ResearchId | null {
  return RESEARCH_IDS.find(id => researchIsAvailable(id, ranks)) ?? null;
}

async function tick(): Promise<void> {
  if (running || !isAutoTechTreeEnabled() || Date.now() - lastAttemptTs < POLL_MS) return;
  const coop = getCoop();
  if (!coop?.startResearch || !coop.research) return;

  running = true;
  lastAttemptTs = Date.now();
  try {
    if (coop.activeResearch?.()) return;
    const target = pickResearchToStart(coop.research());
    if (!target) {
      lastError = "";
      lastAction = "Aucune recherche disponible";
      return;
    }

    const result = await coop.startResearch(target);
    if (result.ok) {
      lastError = "";
      lastAction = `▶ ${target}`;
    } else {
      lastError = result.error ?? "Refus serveur";
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error("[mod-auto-tech-tree] échec du démarrage de recherche", error);
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
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  if (!isAutoTechTreeEnabled()) {
    wrap.style.cssText = "font-size:10px;opacity:.6;";
    wrap.textContent = "Désactivé";
    return wrap;
  }
  const line = document.createElement("div");
  line.style.cssText = "font-size:10px;opacity:.75;";
  line.textContent = lastError ? `⚠ ${lastError}` : (lastAction || "En attente de recherche disponible");
  wrap.append(line);
  return wrap;
}

export function registerAutoTechTreeMod(): void {
  REGISTERED_MODS.push({
    id: "misc-auto-tech-tree",
    name: "Auto Tech Tree",
    category: "MISC",
    switch: {
      label: "On",
      get: isAutoTechTreeEnabled,
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
    install: () => { if (isAutoTechTreeEnabled()) startPolling(); },
  });
}
