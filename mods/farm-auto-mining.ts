#!/usr/bin/env node
// patch.cjs — enregistre farm-auto-mining dans mods/index.ts
// Ne touche QUE mods/index.ts. Idempotent.
// Usage : node patch.cjs

"use strict";
const fs = require("fs");
const path = require("path");

const INDEX = path.join(__dirname, "mods", "index.ts");

function die(m)  { console.error("✘ " + m); process.exit(1); }
function ok(m)   { console.log("✔ " + m); }
function skip(m) { console.log("• " + m); }

if (!fs.existsSync(INDEX)) die("Introuvable : " + INDEX);

let src = fs.readFileSync(INDEX, "utf8");
const hasCRLF = src.includes("\r\n");
if (hasCRLF) src = src.replace(/\r\n/g, "\n");

const IMPORT_LINE = 'import { registerAutoMiningMod } from "./farm-auto-mining";';
const CALL_BODY   = 'registerAutoMiningMod();';

let changed = 0;

// ── 1. Import (après la dernière ligne d'import) ────────────────
if (src.includes(IMPORT_LINE)) {
  skip("Import déjà présent");
} else {
  let lastImportEnd = -1;
  const re = /^import [^\n]+;$/gm;
  let m;
  while ((m = re.exec(src)) !== null) lastImportEnd = m.index + m[0].length;
  if (lastImportEnd === -1) die("Aucun import trouvé — fichier inattendu");
  src = src.slice(0, lastImportEnd) + "\n" + IMPORT_LINE + src.slice(lastImportEnd);
  ok("Import ajouté");
  changed++;
}

// ── 2. Appel dans installAllMods() ─────────────────────────────
if (src.includes(CALL_BODY)) {
  skip("Appel déjà présent");
} else {
  const woodRe = /^([ \t]*)registerAutoWoodMod\(\);[ \t]*$/m;
  const wm = src.match(woodRe);

  if (wm) {
    const indent = wm[1];
    src = src.replace(woodRe, wm[0] + "\n" + indent + CALL_BODY);
    ok("Appel ajouté après registerAutoWoodMod()");
    changed++;
  } else {
    const fnRe = /export function installAllMods\(\): void \{/;
    const fnMatch = src.match(fnRe);
    if (!fnMatch) die("installAllMods introuvable et pas d'ancre registerAutoWoodMod");

    const fnStart = fnMatch.index + fnMatch[0].length - 1;
    let depth = 0, fnEnd = -1;
    for (let i = fnStart; i < src.length; i++) {
      const c = src[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { fnEnd = i; break; } }
    }
    if (fnEnd === -1) die("Fin de installAllMods non trouvée");

    const body = src.slice(fnStart + 1, fnEnd);
    const callRe = /^([ \t]*)register\w+Mod\(\);/gm;
    let lastCall = null, cm;
    while ((cm = callRe.exec(body)) !== null) lastCall = cm;
    if (!lastCall) die("Aucun registerXxxMod() dans installAllMods");

    const indent = lastCall[1];
    const insertAt = fnStart + 1 + lastCall.index + lastCall[0].length;
    src = src.slice(0, insertAt) + "\n" + indent + CALL_BODY + src.slice(insertAt);
    ok("Appel ajouté après le dernier registerXxxMod() de installAllMods");
    changed++;
  }
}

if (changed === 0) {
  skip("Rien à faire — mining déjà enregistré");
  process.exit(0);
}

if (hasCRLF) src = src.replace(/\n/g, "\r\n");
fs.copyFileSync(INDEX, INDEX + ".bak");
fs.writeFileSync(INDEX, src, "utf8");

console.log("");
console.log("✅ Patché : " + INDEX);
console.log("   Backup : " + INDEX + ".bak");
console.log("");
console.log("Suivant :");
console.log("  npm run typecheck:coop");
console.log("  git --no-pager diff mods/index.ts");