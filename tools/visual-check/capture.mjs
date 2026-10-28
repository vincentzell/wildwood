#!/usr/bin/env node
// Captures the visual-check scenes as PNGs with headless Chrome. Builds the harness, serves it with public/
// behind it on 127.0.0.1, drives Chrome over the DevTools protocol, and always kills Chrome and the server.
//
//   node tools/visual-check/capture.mjs --out <dir> [--scenes plates,gear] [--dpr 1,2] [--cap 2|3] [--no-build]
//     [--build-dir <dir>] [--public-dir <dir>] [--port 4517] [--cdp-port 9351]
// A scene can name its one width and pixel ratio: --scenes plates@2,hud:390@1 (the rest use --dpr and every width).
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const CHROME = process.env.VISUAL_CHECK_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Viewports each scene is captured at. `full` captures the whole page; otherwise just the viewport. */
const VIEWPORTS = {
  plates: [{ width: 390, height: 844, full: true }],
  gear: [{ width: 1280, height: 800, full: true }],
  enemies: [{ width: 1280, height: 800, full: true }],
  parts: [{ width: 1280, height: 800, full: true }],
  "combat-hits": [{ width: 390, height: 844, full: true }],
  world: [{ width: 1280, height: 800, full: true }],
  town: [{ width: 1280, height: 800, full: true }],
  "town-grid": [{ width: 1280, height: 800, full: true }],
  grove: [{ width: 1280, height: 800, full: true }],
  forest: [{ width: 1280, height: 800, full: true }],
  bosses: [{ width: 1280, height: 800, full: true }],
  "guild-battlefield": [{ width: 1280, height: 800, full: true }],
  icons: [{ width: 390, height: 844, full: true }, { width: 1280, height: 800, full: true }],
  hud: [{ width: 390, height: 844, full: false }, { width: 1280, height: 800, full: false }],
  "hud-arrow": [{ width: 390, height: 844, full: false }, { width: 1280, height: 800, full: false }],
  wordmark: [{ width: 390, height: 844, full: false }, { width: 1280, height: 800, full: false }],
  shops: [{ width: 390, height: 844, full: true }, { width: 1280, height: 800, full: true }],
  "gem-shop": [{ width: 390, height: 844, full: true }],
  "server-boost": [{ width: 390, height: 844, full: true }],
  grades: [{ width: 460, height: 320, full: true }],
  "quest-tracker": [{ width: 390, height: 844, full: false }],
  "dps-breakdown": [{ width: 390, height: 844, full: false }, { width: 1280, height: 800, full: false }],
  builds: [{ width: 390, height: 700, full: true }],
  "world-map-town": [{ width: 390, height: 844, full: true }, { width: 1280, height: 800, full: false }],
  "offline-choice": [{ width: 390, height: 640, full: false }, { width: 1280, height: 720, full: false }],
  "exchange-window": [{ width: 1240, height: 700, full: true }],
  "chat-announcement": [{ width: 390, height: 844, full: true }, { width: 1280, height: 800, full: true }],
  "profile-own": [{ width: 390, height: 844, full: false }],
  "item-window": [{ width: 390, height: 844, full: false }],
  "card-window": [{ width: 390, height: 844, full: false }],
  "item-window-worn": [{ width: 390, height: 844, full: false }],
  "profile-other": [{ width: 390, height: 844, full: false }],
};
const DEFAULT_VIEWPORT = [{ width: 1280, height: 800, full: true }];
/** Chrome cannot paint one capture taller than this many device pixels; taller pages are taken in bands. */
const MAX_BAND_PIXELS = 8_000;

function parseArgs(argv) {
  const args = { build: true, dpr: [1, 2], cap: null, port: 4517, cdpPort: 9351, scenes: null, out: null, buildDir: null, publicDir: join(repo, "public") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--out") args.out = resolve(value());
    else if (flag === "--scenes") args.scenes = value().split(",").filter(Boolean).map(parseScene);
    else if (flag === "--dpr") args.dpr = value().split(",").map(Number);
    else if (flag === "--cap") args.cap = Number(value());
    else if (flag === "--no-build") args.build = false;
    else if (flag === "--build-dir") args.buildDir = resolve(value());
    else if (flag === "--public-dir") args.publicDir = resolve(value());
    else if (flag === "--port") args.port = Number(value());
    else if (flag === "--cdp-port") args.cdpPort = Number(value());
    else if (flag === "--help" || flag === "-h") { console.log(readUsage()); process.exit(0); }
    else throw new Error(`Unknown flag ${flag}\n${readUsage()}`);
  }
  if (!args.out) throw new Error(`--out <dir> is required\n${readUsage()}`);
  if (args.dpr.some(dpr => !(dpr > 0))) throw new Error("--dpr takes numbers, e.g. 1,2");
  if (args.cap !== null && args.cap !== 2 && args.cap !== 3) throw new Error("--cap is 2 (the game's default) or 3 (Settings > High Resolution)");
  if ([args.port, args.cdpPort].some(port => port === 3000 || port === 8000)) throw new Error("Ports 3000 and 8000 belong to the local game server and dev site; pick another.");
  args.buildDir ??= join(repo, "local-data/visual-check-build");
  return args;
}

/** "plates", "plates@2" or "hud:390@1": the scene, and optionally its one width and pixel ratio. */
function parseScene(spec) {
  const match = /^([\w-]+)(?::(\d+))?(?:@([\d.]+))?$/.exec(spec);
  if (!match) throw new Error(`Bad scene "${spec}"; use name, name@dpr or name:width@dpr`);
  return { name: match[1], width: match[2] ? Number(match[2]) : null, dpr: match[3] ? Number(match[3]) : null };
}

function readUsage() {
  return "usage: node tools/visual-check/capture.mjs --out <dir> [--scenes plates,gear] [--dpr 1,2] [--cap 2|3] [--no-build] [--build-dir <dir>] [--public-dir <dir>] [--port 4517] [--cdp-port 9351]";
}

function portFree(port) {
  return new Promise(resolvePort => {
    const probe = createNetServer();
    probe.once("error", () => resolvePort(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePort(true)));
  });
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".map": "application/json", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".woff": "font/woff", ".ttf": "font/ttf", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".webmanifest": "application/manifest+json",
};

/** The harness build first, then public/ for the art and the game's index.html and stylesheets. */
function startServer(port, roots) {
  const missing = new Set();
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    const relative = normalize(path === "/" ? "/index.html" : path).replace(/^([/\\])+/, "");
    for (const root of roots) {
      const file = join(root, relative);
      if (!file.startsWith(root + sep) && file !== root) continue;
      if (existsSync(file) && statSync(file).isFile()) {
        response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
        createReadStream(file).pipe(response);
        return;
      }
    }
    missing.add(path);
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveServer({ server, missing }));
  });
}

/** A DevTools protocol connection over Node's built-in WebSocket. */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error(`DevTools socket ${url} failed`)), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(`${call.method}: ${message.error.message}`));
      else call?.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolveCall, reject) => pending.set(id, { resolve: resolveCall, reject, method }));
    },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { try { socket.close(); } catch { /* already closed */ } },
  };
}

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
    await sleep(100);
  }
}

// Everything that has to be undone, whatever way the run ends.
const cleanup = { chrome: null, watchdog: null, server: null, cdp: null, profile: null, done: false };

function killChrome() {
  const chrome = cleanup.chrome;
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    try { process.kill(chrome.pid, "SIGKILL"); } catch { /* gone */ }
  }
  // Anything still running on this run's own profile (helpers included).
  if (cleanup.profile) spawnSync("pkill", ["-9", "-f", `--user-data-dir=${cleanup.profile}`]);
}

function cleanupSync() {
  if (cleanup.done) return;
  cleanup.done = true;
  cleanup.cdp?.close();
  if (cleanup.watchdog) { try { process.kill(cleanup.watchdog.pid, "SIGKILL"); } catch { /* gone */ } }
  killChrome();
  cleanup.server?.close();
  cleanup.server?.closeAllConnections?.();
  if (cleanup.profile) rmSync(cleanup.profile, { recursive: true, force: true });
}

async function cleanupAsync() {
  if (cleanup.done) return;
  try { await Promise.race([cleanup.cdp?.send("Browser.close"), sleep(1_500)]); } catch { /* killed below */ }
  const chrome = cleanup.chrome;
  if (chrome) await Promise.race([new Promise(resolveExit => chrome.exitCode !== null || chrome.signalCode !== null ? resolveExit() : chrome.once("exit", resolveExit)), sleep(3_000)]);
  cleanupSync();
}

process.on("exit", cleanupSync);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => { console.error(`\n${signal}: stopping Chrome and the server`); cleanupSync(); process.exit(130); });
}
process.on("uncaughtException", error => { console.error(error); cleanupSync(); process.exit(1); });

async function launchChrome(cdpPort, profile) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set VISUAL_CHECK_CHROME)`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });
  cleanup.profile = profile;
  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, "--mute-audio", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--force-color-profile=srgb", "--disable-gpu", "--remote-allow-origins=*", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  cleanup.chrome = chrome;
  let stderr = "";
  chrome.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4_000); });
  // If this process dies without running its handlers (kill -9), the watchdog takes Chrome down with it.
  cleanup.watchdog = spawn("/bin/sh", ["-c", `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; kill -9 ${chrome.pid} 2>/dev/null; pkill -9 -f -- '--user-data-dir=${profile}' 2>/dev/null`], { detached: true, stdio: "ignore" });
  cleanup.watchdog.unref();
  const version = await waitFor(async () => {
    if (chrome.exitCode !== null) throw new Error(`Chrome exited (${chrome.exitCode}): ${stderr}`);
    try { return await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); } catch { return null; }
  }, 20_000, "Chrome's DevTools endpoint");
  const target = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" })).json();
  return { version, target };
}

async function capture(cdp, url, viewport, dpr) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: dpr, mobile: viewport.width < 768 });
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const inflight = new Set();
  const failures = [];
  const off = cdp.on(message => {
    if (message.method === "Network.requestWillBeSent") inflight.add(message.params.requestId);
    else if (message.method === "Network.loadingFinished") inflight.delete(message.params.requestId);
    else if (message.method === "Network.loadingFailed") { inflight.delete(message.params.requestId); failures.push(`${message.params.errorText} ${message.params.type ?? ""}`.trim()); }
    else if (message.method === "Runtime.exceptionThrown") failures.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
  });
  try {
    await cdp.send("Page.navigate", { url });
    const evaluate = async expression => (await cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
    await waitFor(() => evaluate("window.__visualReady === true"), 120_000, `${url} to report ready`);
    const error = await evaluate("window.__visualError ?? null");
    if (error) throw new Error(`Scene failed: ${error}`);
    // Quiet network for a moment: nothing late (a lazily loaded look) is still on its way.
    let quietSince = Date.now();
    await waitFor(() => { if (inflight.size > 0) quietSince = Date.now(); return Date.now() - quietSince > 300; }, 30_000, "the network to go quiet");
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const width = viewport.width;
    const height = viewport.full ? Math.max(viewport.height, Math.ceil(size.height)) : viewport.height;
    const bandHeight = Math.max(1, Math.floor(MAX_BAND_PIXELS / dpr));
    const bands = [];
    for (let top = 0; top < height; top += bandHeight) {
      const result = await cdp.send("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: viewport.full, fromSurface: true,
        clip: { x: 0, y: top, width, height: Math.min(bandHeight, height - top), scale: 1 },
      });
      bands.push(Buffer.from(result.data, "base64"));
    }
    return { bands, width, height, failures };
  } finally {
    off();
  }
}

async function stitch(bands) {
  if (bands.length === 1) return bands[0];
  const { default: sharp } = await import("sharp");
  const metas = await Promise.all(bands.map(band => sharp(band).metadata()));
  const width = metas[0].width;
  const height = metas.reduce((sum, meta) => sum + meta.height, 0);
  let top = 0;
  const layers = bands.map((input, index) => { const layer = { input, left: 0, top }; top += metas[index].height; return layer; });
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!(await portFree(args.port))) throw new Error(`Port ${args.port} is in use; pass --port <free port> (never 3000 or 8000).`);
  if (!(await portFree(args.cdpPort))) throw new Error(`DevTools port ${args.cdpPort} is in use; pass --cdp-port <free port>. Is another headless Chrome still running? ps aux | grep remote-debugging-port`);
  if (args.build) {
    console.log(`Building the harness into ${args.buildDir}`);
    const build = spawnSync("npx", ["vite", "build", "--config", "config/vite.visual-check.config.ts", "--logLevel", "warn"], {
      cwd: repo, stdio: "inherit", env: { ...process.env, VISUAL_CHECK_OUT_DIR: args.buildDir },
    });
    if (build.status !== 0) throw new Error("Harness build failed");
  }
  if (!existsSync(join(args.buildDir, "visual-check.html"))) throw new Error(`No harness build at ${args.buildDir}; run without --no-build`);
  mkdirSync(args.out, { recursive: true });

  const { server, missing } = await startServer(args.port, [args.buildDir, args.publicDir]);
  cleanup.server = server;
  const profile = resolve(process.env.VISUAL_CHECK_PROFILE ?? join(args.out, "..", ".visual-chrome-profile"));
  const { target, version } = await launchChrome(args.cdpPort, profile);
  const cdp = await connect(target.webSocketDebuggerUrl);
  cleanup.cdp = cdp;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });

  const base = `http://127.0.0.1:${args.port}/visual-check.html`;
  const cap = args.cap === null ? "" : `&cap=${args.cap}`;
  let run = 0;
  const listed = await capture(cdp, `${base}?run=${run++}#__list`, DEFAULT_VIEWPORT[0], 1).catch(() => null);
  const available = JSON.parse((await cdp.send("Runtime.evaluate", { expression: "JSON.stringify(window.__visualScenes ?? [])", returnByValue: true })).result.value);
  if (!listed && !available.length) throw new Error("The harness did not load; see the build output above");
  const scenes = args.scenes ?? available.map(name => ({ name, width: null, dpr: null }));
  const unknown = scenes.map(scene => scene.name).filter(scene => !available.includes(scene));
  if (unknown.length) throw new Error(`Unknown scene(s) ${unknown.join(", ")}; available: ${available.join(", ")}`);

  const manifest = [];
  let failed = 0;
  for (const { name: scene, width, dpr: sceneDpr } of scenes) {
    const viewports = (VIEWPORTS[scene] ?? DEFAULT_VIEWPORT).filter(viewport => width === null || viewport.width === width);
    if (!viewports.length) throw new Error(`Scene ${scene} has no ${width}px viewport`);
    for (const viewport of viewports) {
      for (const dpr of sceneDpr ? [sceneDpr] : args.dpr) {
        const name = `${scene}-${viewport.width}w@${dpr}x${args.cap === null ? "" : `-cap${args.cap}`}.png`;
        const started = Date.now();
        try {
          const shot = await capture(cdp, `${base}?run=${run++}${cap}#${scene}`, viewport, dpr);
          writeFileSync(join(args.out, name), await stitch(shot.bands));
          manifest.push({ scene, file: name, width: viewport.width, cssHeight: shot.height, dpr, cap: args.cap ?? 2, failures: shot.failures });
          console.log(`  ${name}  ${viewport.width}×${shot.height} css  ${Date.now() - started}ms${shot.failures.length ? `  (${shot.failures.length} load errors)` : ""}`);
        } catch (error) {
          failed += 1;
          console.error(`  ${name}  FAILED: ${error.message}`);
        }
      }
    }
  }
  writeFileSync(join(args.out, "manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(), chrome: version?.Browser, buildDir: args.buildDir, captures: manifest, missing: [...missing] }, null, 2));
  if (missing.size) console.warn(`Not found on the server (${missing.size}): ${[...missing].slice(0, 12).join(", ")}${missing.size > 12 ? " …" : ""}`);
  console.log(`${manifest.length} capture(s) in ${args.out}${failed ? `, ${failed} failed` : ""}`);
  return failed ? 1 : 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(error.message ?? error);
} finally {
  await cleanupAsync();
}
process.exit(exitCode);
