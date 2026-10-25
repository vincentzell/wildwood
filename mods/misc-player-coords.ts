// mods/misc-player-coords.ts
import { REGISTERED_MODS } from "./registry";
import { getPlayerCoords, PlayerPos } from "./lib/player-coords";

const STORAGE_KEY = "wildwood-mod-player-coords-enabled";
const WAYPOINTS_KEY = "wildwood-mod-player-coords-waypoints";

function isEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

function setEnabled(v: boolean): void {
  try { localStorage.setItem(STORAGE_KEY, String(v)); }
  catch { /* idem */ }
}

let recordedWaypoints: PlayerPos[] = [];
try {
  const saved = JSON.parse(localStorage.getItem(WAYPOINTS_KEY) || "[]");
  if (Array.isArray(saved)) recordedWaypoints = saved;
} catch { /* idem */ }

function saveWaypoints() {
  try { localStorage.setItem(WAYPOINTS_KEY, JSON.stringify(recordedWaypoints)); }
  catch { /* idem */ }
}

function renderStatus(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "font-size:10px;display:flex;flex-direction:column;gap:4px;";

  if (!isEnabled()) {
    wrap.innerHTML = '<div style="color:#888;text-align:center;padding:10px;">Mod désactivé (Switch OFF)</div>';
    return wrap;
  }

  const pos = getPlayerCoords();
  const liveEl = document.createElement("div");
  liveEl.style.cssText = "font-weight:900;color:#74d8ff;font-size:12px;text-align:center;background:rgba(0,0,0,.3);padding:6px;border-radius:4px;";
  liveEl.textContent = pos ? `📍 (${Math.round(pos.x)}, ${Math.round(pos.y)}) [${pos.mapId}]` : "📍 (recherche...)";
  wrap.append(liveEl);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:4px;margin-top:4px;";

  const btnRecord = document.createElement("button");
  btnRecord.textContent = "📸 Enregistrer WP";
  btnRecord.style.cssText = "flex:1;padding:5px;background:rgba(105,229,111,.22);color:inherit;border:0;border-radius:3px;cursor:pointer;font-weight:bold;";
  btnRecord.onclick = () => {
    const p = getPlayerCoords();
    if (!p) return;
    recordedWaypoints.push({ x: Math.round(p.x), y: Math.round(p.y), mapId: p.mapId });
    saveWaypoints();
    renderList();
  };

  const btnCopy = document.createElement("button");
  btnCopy.textContent = "📋 Copier JSON";
  btnCopy.style.cssText = "flex:1;padding:5px;background:rgba(116,216,255,.22);color:inherit;border:0;border-radius:3px;cursor:pointer;font-weight:bold;";
  btnCopy.onclick = async () => {
    if (recordedWaypoints.length === 0) return;
    const json = JSON.stringify(recordedWaypoints, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      btnCopy.textContent = "✅ Copié !";
      setTimeout(() => { btnCopy.textContent = "📋 Copier JSON"; }, 1500);
    } catch {
      console.log(json);
      btnCopy.textContent = "❌ Console";
      setTimeout(() => { btnCopy.textContent = "📋 Copier JSON"; }, 1500);
    }
  };

  actions.append(btnRecord, btnCopy);
  wrap.append(actions);

  const listEl = document.createElement("div");
  listEl.style.cssText = "max-height:120px;overflow-y:auto;background:rgba(0,0,0,.2);border-radius:4px;margin-top:4px;padding:2px;";

  function renderList() {
    listEl.innerHTML = "";
    if (recordedWaypoints.length === 0) {
      listEl.innerHTML = '<div style="color:#666;text-align:center;padding:6px;font-size:9px;">Aucun waypoint enregistré</div>';
      return;
    }
    recordedWaypoints.forEach((p, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;justify-content:space-between;padding:3px 6px;border-bottom:1px solid #333;font-size:9px;align-items:center;";
      
      const txt = document.createElement("span");
      txt.textContent = `${i+1}. (${p.x}, ${p.y})`;
      
      const del = document.createElement("button");
      del.textContent = "✕";
      del.style.cssText = "background:none;border:0;color:#ff6767;cursor:pointer;font-weight:bold;";
      del.onclick = () => {
        recordedWaypoints.splice(i, 1);
        saveWaypoints();
        renderList();
      };

      row.append(txt, del);
      listEl.append(row);
    });
  }
  renderList();
  wrap.append(listEl);

  const btnClear = document.createElement("button");
  btnClear.textContent = "🗑️ Vider la liste";
  btnClear.style.cssText = "margin-top:4px;padding:4px;background:rgba(255,103,103,.15);color:#ff6767;border:0;border-radius:3px;cursor:pointer;font-size:9px;width:100%;";
  btnClear.onclick = () => {
    if (!confirm("Vider tous les waypoints ?")) return;
    recordedWaypoints = [];
    saveWaypoints();
    renderList();
  };
  wrap.append(btnClear);

  return wrap;
}

export function registerPlayerCoordsMod(): void {
  REGISTERED_MODS.push({
    id: "misc-player-coords",
    name: "Player Coords",
    category: "MISC",
    description: "Affiche tes coordonnées exactes et permet d'enregistrer des waypoints pour les autres mods.",
    switch: { label: "On", get: isEnabled, set: setEnabled },
    status: { render: renderStatus, intervalMs: 100 },
    install: () => { /* Rien à installer */ },
  });
}
