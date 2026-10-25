// mods/lib/player-coords.ts
// Lecture des coordonnées en temps réel via la Minimap (Canvas) + fallback localState

export type PlayerPos = { x: number; y: number; mapId: string };

let _lastTownPos: { x: number; y: number } | null = null;
const TOWN_MINIMAP_FRAMES = [
  { tag: 'v', cx: 3120, cy: 2645, span: 5320 }, // village
  { tag: 'g', cx:  230, cy: 3605, span: 3190 }, // grove (Timberwood)
  { tag: 'h', cx: 8140, cy: 2515, span: 5580 }, // hills (Copper Hills)
];

// Installation du hook sur le Canvas
function installMinimapHook() {
  if (typeof window === "undefined" || (window as any).__ww_minimap_hooked__) return;
  (window as any).__ww_minimap_hooked__ = true;

  const origMoveTo = CanvasRenderingContext2D.prototype.moveTo;
  const origLineTo = CanvasRenderingContext2D.prototype.lineTo;
  const origFill = CanvasRenderingContext2D.prototype.fill;
  const origBeginPath = CanvasRenderingContext2D.prototype.beginPath;
  let minimapPath: any[] = [];

  CanvasRenderingContext2D.prototype.beginPath = function(this: any) { 
    minimapPath = []; 
    return origBeginPath.call(this); 
  };
  
  CanvasRenderingContext2D.prototype.moveTo = function(this: any, x: number, y: number) { 
    if (Number.isFinite(x) && Number.isFinite(y)) minimapPath.push({ op: 'moveTo', x, y }); 
    return origMoveTo.call(this, x, y); 
  };
  
  CanvasRenderingContext2D.prototype.lineTo = function(this: any, x: number, y: number) { 
    if (Number.isFinite(x) && Number.isFinite(y)) minimapPath.push({ op: 'lineTo', x, y }); 
    return origLineTo.call(this, x, y); 
  };
  
  CanvasRenderingContext2D.prototype.fill = function(this: any, ...args: any[]) {
    try {
      if (minimapPath.length === 4) {
        const fillStyle = this.fillStyle;
        if (fillStyle === '#ffffff' || fillStyle === 'rgb(255, 255, 255)') {
          const ops = minimapPath.map(p => p.op);
          if (ops[0] === 'moveTo' && ops.slice(1).every(o => o === 'lineTo')) {
            const pts = minimapPath.map(p => ({ x: p.x, y: p.y }));
            const cx = (pts[0].x + pts[2].x) / 2;
            const cy = (pts[0].y + pts[2].y) / 2;
            const avgDist = (Math.hypot(pts[0].x - cx, pts[0].y - cy) + Math.hypot(pts[1].x - cx, pts[1].y - cy) + Math.hypot(pts[2].x - cx, pts[2].y - cy) + Math.hypot(pts[3].x - cx, pts[3].y - cy)) / 4;
            if (avgDist >= 2 && avgDist <= 15) {
              const canvas = this.canvas;
              (window as any).__ww_minimap_json__ = JSON.stringify({ cx, cy, canvas: canvas ? (canvas.width + '×' + canvas.height) : '?', ts: Date.now() });
            }
          }
        }
      }
    } catch (e) {}
    return (origFill as any).apply(this, args);
  };
}

installMinimapHook();

export function getPlayerCoords(): PlayerPos | null {
  const c = (window as any).wildstatCoop || (window as any).wildwoodCoop;
  if (!c) return null;

  let mapId = 'unknown';
  let localX = 0, localY = 0;
  try {
    const s = c.localState?.();
    if (s) {
      mapId = s.mapId || 'unknown';
      if (s.x !== undefined && s.y !== undefined) { localX = s.x; localY = s.y; }
    }
  } catch {}

  // 1. Essayer la minimap (temps réel)
  try {
    const json = (window as any).__ww_minimap_json__;
    if (json) {
      const d = JSON.parse(json);
      const sizeMatch = d.canvas && d.canvas.match(/^(\d+)×(\d+)$/);
      if (sizeMatch) {
        const size = parseInt(sizeMatch[1], 10);
        if (mapId === 'town') {
          const candidates = TOWN_MINIMAP_FRAMES.map(f => ({
            x: f.cx + (d.cx / size) * f.span,
            y: f.cy + (d.cy / size) * f.span,
            ts: d.ts,
          }));

          // Synchronisation : si on n'a pas de repère (ex: spawn de Town), 
          // ou si localState est très loin du dernier point connu (téléportation),
          // on recale _lastTownPos sur localState.
          if (!_lastTownPos || Math.hypot(localX - _lastTownPos.x, localY - _lastTownPos.y) > 3000) {
            if (localX > 0 && localY > 0) {
              _lastTownPos = { x: localX, y: localY };
            }
          }

          let best = candidates[0];
          if (_lastTownPos) {
            let bestD = Infinity;
            for (const cand of candidates) {
              const dist = Math.hypot(cand.x - _lastTownPos.x, cand.y - _lastTownPos.y);
              if (dist < bestD) { bestD = dist; best = cand; }
            }
          }
          _lastTownPos = { x: best.x, y: best.y };
          return { x: best.x, y: best.y, mapId };
        }
        _lastTownPos = null;
        const WORLD_SIZE = 4800;
        return { x: (d.cx / size) * WORLD_SIZE, y: (d.cy / size) * WORLD_SIZE, mapId };
      }
    }
  } catch (e) {}

  // 2. Fallback localState
  try {
    if (localX > 0 && localY > 0) {
      return { x: localX, y: localY, mapId };
    }
  } catch (e) {}

  return null;
}