# Mods Wildwood

Système de mods du client Wildwood. Chaque mod s'enregistre auprès du
registre central et apparaît automatiquement dans le menu flottant
(onglets **FARM / QUEST / CARD / MISC**), ancré dans `#hud` et calqué
sur le style du stat tracker.

## Sommaire

- [Structure](#structure)
- [Ajouter un mod](#ajouter-un-mod)
- [Patch à re-appliquer après un sync upstream](#patch-à-re-appliquer-après-un-sync-upstream)
- [Mod qui copie `src/` : Auto Kiting](#mod-qui-copie-src--auto-kiting)
- [Déploiement](#déploiement)
- [Conventions](#conventions)

## Structure

```
mods/
├── registry.ts                  # type Mod, REGISTERED_MODS
├── index.ts                     # installAllMods() — point d'entrée unique
├── modmenu.ts                   # panneau flottant, onglets, cartes, switches
├── farm-auto-kiting.ts          # switch du mod Auto Kiting
├── misc-auto-ad.ts              # Auto Ad (reward silencieuse)
├── misc-daily-gems.ts           # Auto Claim Daily Gems
├── farm/                        # copies moddées du runtime auto-farm
│   ├── auto-farm-wiring.ts      # copie de src/game/runtime/auto-farm/
│   └── auto-farm-controller.ts  # copie + injection du bloc evasion()
└── README.md
```

## Ajouter un mod

**Deux fichiers, aucune modification dans `src/`.**

### 1. Créer `mods/<categorie>-<nom>.ts`

```ts
import { REGISTERED_MODS } from "./registry";

const STORAGE_KEY = "wildwood-mod-<id>-enabled";

function isEnabled(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === "true"; }
  catch { return false; }
}

export function register<Nom>Mod(): void {
  REGISTERED_MODS.push({
    id: "<categorie>-<nom>",
    name: "<Nom affiché>",
    category: "FARM" | "QUEST" | "CARD" | "MISC",
    switch: {
      label: "On",
      get: isEnabled,
      set: (value) => {
        try { localStorage.setItem(STORAGE_KEY, String(value)); } catch {}
        if (value) startPolling(); else stopPolling();
      },
    },
    install: () => { if (isEnabled()) startPolling(); },
  });
}
```

Le champ `switch` est optionnel. `install()` est appelé une fois au
chargement (`installAllMods()`), après l'enregistrement de tous les
mods, avant `installModMenu()`.

### 2. Enregistrer dans `mods/index.ts`

```ts
import { register<Nom>Mod } from "./<categorie>-<nom>";

export function installAllMods(): void {
  // ... autres register*
  register<Nom>Mod();
  for (const mod of REGISTERED_MODS) mod.install?.();
  installModMenu();
}
```

**Ne pas toucher à `src/main.ts`** : `installAllMods()` y est déjà
appelé une fois pour toutes (voir section suivante).

## Patch à re-appliquer après un sync upstream

`git pull origin main` (ou `git merge upstream/main`) peut restaurer
`src/main.ts` à sa version d'origine — Git voit les 3 lignes ajoutées
comme un conflit local à résoudre, et un `checkout` manuel les perd.

**Après chaque sync, vérifier que les 3 modifications suivantes sont
présentes dans `src/main.ts`.**

### 1. Import de `installAllMods`

À côté de l'import de `createAutoFarm`, ajouter :

```ts
import { installAllMods } from "../mods";
```

### 2. Appel de `installAllMods()`

Après le dernier `install*()` (typiquement
`installOfflineProgressSetting(...)`), avant les `create*Panel(...)` :

```ts
installAllMods();
```

### 3. Redirection de `createAutoFarm` (mod Auto Kiting uniquement)

Chercher :

```ts
import { createAutoFarm } from "./game/runtime/auto-farm/auto-farm-wiring";
```

Remplacer par :

```ts
import { createAutoFarm } from "../mods/farm/auto-farm-wiring";
```

**Sans cette 3ᵉ ligne**, le mod Auto Kiting s'affiche dans le menu mais
son switch n'a aucun effet (le contrôleur d'origine est utilisé, qui
ne lit pas `isAutoDodgeEnabled()`).

### Vérification rapide

```bash
grep -n "installAllMods\|createAutoFarm" src/main.ts
```

Les trois occurrences doivent apparaître :
- `import { installAllMods } from "../mods";`
- `installAllMods();`
- `import { createAutoFarm } from "../mods/farm/auto-farm-wiring";`

Puis :

```bash
npm run typecheck:coop
npm run build:client
```

## Mod qui copie `src/` : Auto Kiting

Auto Kiting est le seul mod qui a besoin de modifier du code de `src/`.
Plutôt que de patcher `src/game/runtime/auto-farm/` (ce qui créerait
un conflit à chaque sync), on maintient une **copie** dans `mods/farm/` :

- `mods/farm/auto-farm-wiring.ts` — copie de
  `src/game/runtime/auto-farm/auto-farm-wiring.ts`, avec les imports
  réécrits (`../../src/...` au lieu de `../...`).
- `mods/farm/auto-farm-controller.ts` — copie de
  `src/game/runtime/auto-farm/auto-farm-controller.ts`, avec :
  - imports réécrits,
  - ajout du bloc `evasion()` + helpers (`standableNow`, `dangerNow`,
    `aroundBoss`, `reaches`, `steer`, `worthAvoiding`, `kiteWorth`),
  - ajout de la constante locale `DODGE_PAD = 12`,
  - ajout de l'appel `if (isAutoDodgeEnabled()) { const ev = evasion(...); if (ev) return ev; }` dans `movement()`,
  - ajout de l'option `enemyShots` aux options du contrôleur.

**Si `src/game/runtime/auto-farm/` évolue upstream** et que le mod Auto
Kiting se met à mal fonctionner (crash, comportement anormal, kite qui
ne se déclenche plus), la copie a divergé. Pour resynchroniser :

```bash
cp src/game/runtime/auto-farm/auto-farm-wiring.ts mods/farm/auto-farm-wiring.ts
cp src/game/runtime/auto-farm/auto-farm-controller.ts mods/farm/auto-farm-controller.ts
```

Puis ré-appliquer les adaptations manuelles :

1. Dans les deux copies : réécrire tous les imports relatifs (règle :
   `./X` → `../../src/game/runtime/auto-farm/X`, `../X` →
   `../../src/game/runtime/X`, `../../X` → `../../src/game/X`,
   `../../../../shared/X` → `../../shared/X`).
2. Dans `auto-farm-wiring.ts` : ajouter au passage
   `enemyShots: deps.world.enemyShots,` dans les options du contrôleur.
3. Dans `auto-farm-controller.ts` : ré-injecter le bloc `evasion()` et
   l'appel dans `movement()`. Le code exact se trouve dans le dernier
   commit qui touche `mods/farm/auto-farm-controller.ts` (voir
   `git log mods/farm/`).

Si le mod devient trop difficile à maintenir face aux changements
upstream, la sortie de secours est de **désactiver le mod** (retirer
`registerFarmAutoKitingMod()` de `mods/index.ts` et restaurer l'import
`createAutoFarm` vers `./game/runtime/auto-farm/auto-farm-wiring`)
sans rien casser d'autre.

## Déploiement

Le workflow `.github/workflows/pages.yml` se déclenche sur `push` vers
`main`. Il exécute dans l'ordre : `check:release`, `typecheck:coop`,
`typecheck:server`, `build:client`, `test:unit` (4 shards), puis
`deploy` (nécessite `needs: [..., test]`).

Depuis une branche de travail, publier directement sur `main` :

```bash
git push origin <branche>:main
```

Pour les tests : si le job `test` échoue sur des tests préexistants du
fork (indépendants des mods), le job `deploy` sera bloqué. Vérifier
d'abord si `main` était déjà rouge avant :

```bash
gh run list --workflow=pages.yml --branch=main --limit 5
```

Si c'est le cas, ce sont des tests amont cassés — hors scope mods. La
solution propre est de corriger ces tests, ou (à éviter) de patcher
`pages.yml` pour passer `test` en `continue-on-error: true`.

## Conventions

- **IDs** : `<categorie>-<nom>` en kebab-case (ex. `misc-auto-ad`).
- **Clés localStorage** : préfixe `wildwood-mod-<id>-`. Ne jamais
  renommer une clé après première publication (les utilisateurs
  perdraient l'état de leur switch).
- **Toute action de fond** (polling, mutation, appel API) doit être
  gated par `isEnabled()`. `install()` démarre, `switch.set(false)`
  arrête. Pas de fuite d'intervalle.
- **Silencieux par défaut** : pas de `console.log` à chaque tick. Un
  `console.warn` une seule fois si l'API requise est introuvable, puis
  silence.
- **Ne jamais modifier `src/` directement.** Si un accès à du code de
  `src/` est nécessaire, copier le fichier dans `mods/` et adapter les
  imports (voir Auto Kiting).
- **Style visuel** : reprendre les classes du stat tracker
  (`.stat-tracker`, `.stat-tracker-handle`) pour l'ancrage HUD. Pour les
  cartes dans le menu, `modmenu.ts` gère déjà l'apparence.
