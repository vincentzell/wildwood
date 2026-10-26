// ==UserScript==
// @name         Wildwood auto-token
// @namespace    wildwood.local
// @version      1.0
// @description  Injecte le token Wildwood AVANT le boot de l'app (zéro flash login)
// @match        https://vincentzell.github.io/wildwood/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
(() => {
  const ID = 'wss://maincloud.spacetimedb.com/wildwood-coop/auth_token/spacetimeauth_id_token_v1';
  // Pending partagé avec mods/misc-token-injector.ts (rempli via l'UI "📥 Injecter")
  const pending = localStorage.getItem('wildwood-mod-token-injector-pending');
  if (!pending) return;
  let parsed;
  try { parsed = JSON.parse(pending); } catch { return; }
  if (!parsed || typeof parsed !== 'object') return;

  // Vérifie l'expiration du token principal avant d'écrire
  const raw = parsed[ID];
  if (typeof raw === 'string') {
    try {
      const parts = raw.split('.');
      if (parts.length === 3) {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
        const payload = JSON.parse(atob(padded));
        if (payload.exp && payload.exp * 1000 <= Date.now()) {
          console.warn('[wildwood] pending token expiré — affichage login normal');
          return;
        }
      }
    } catch { /* token opaque : tente quand même */ }
  }

  let written = 0;
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && /auth_token\/(spacetimeauth_|legal_consent_|guest_)/.test(k)) {
      localStorage.setItem(k, v);
      written++;
    }
  }
  if (written > 0) console.info('[wildwood] auto-token injecté avant boot:', written, 'clé(s)');
})();
