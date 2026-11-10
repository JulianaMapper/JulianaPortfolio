/*
 * yoto-auth.js: one shared Yoto sign-in for every page under /tools/yoto*.html
 *
 * Plain script, no build step. Exposes window.YotoAuth.
 *
 * What lives here: the OAuth PKCE flow (public client, no secret), token
 * storage and rotation-safe refresh, sign-in / sign-out, a scope check, and an
 * authenticated api() helper. What does NOT live here: each page's own saved
 * choices (btnShortcuts.*, libSheet.*, yotoAnnounce.*). Those stay put.
 *
 * Everything is stored under ONE namespace ('yotoTools.*'), so signing in on
 * any Yoto page signs you in on all of them (same origin).
 *
 * Every page that signs in must be registered with Yoto as an allowed callback
 * URL, because REDIRECT_URI = location.origin + location.pathname.
 *
 * Loading this file has no side effects: it only defines window.YotoAuth.
 */
(function (root) {
  'use strict';

  // ───────── Config ─────────
  const CLIENT_ID = 'tpc_dMYnaTtH4zXjRp5oWkpoJD';
  const AUTH_URL  = 'https://login.yotoplay.com/authorize';
  const TOKEN_URL = 'https://login.yotoplay.com/oauth/token';
  const API_BASE  = 'https://api.yotoplay.com';
  const AUDIENCE  = 'https://api.yotoplay.com';
  // Union of what every Yoto tool needs, so one sign-in covers them all.
  const SCOPE = 'openid profile offline_access family:devices:view family:devices:manage family:devices:control family:library:view user:content:view user:content:manage';

  const K_TOKENS = 'yotoTools.tokens';
  const K_PKCE   = 'yotoTools.pkce';
  // Per-page auth keys from before the shared sign-in. Ignored, then deleted.
  const LEGACY_KEYS = ['btnShortcuts.tokens', 'btnShortcuts.pkce', 'libSheet.tokens', 'libSheet.pkce'];

  // ───────── Safe storage ─────────
  const store = (area) => ({
    get(k) { try { return root[area].getItem(k); } catch (e) { return null; } },
    set(k, v) { try { root[area].setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { root[area].removeItem(k); } catch (e) { /* ignore */ } }
  });
  const ls = store('localStorage'), ss = store('sessionStorage');
  const getJSON = (s, k) => { try { const v = s.get(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  const setJSON = (s, k, v) => s.set(k, JSON.stringify(v));

  function dropLegacyTokens() {
    LEGACY_KEYS.forEach((k) => { ls.del(k); ss.del(k); });
  }

  // ───────── Errors ─────────
  class ApiError extends Error {
    constructor(kind, status, detail) { super(kind); this.kind = kind; this.status = status; this.detail = detail || ''; }
  }

  function friendly(err) {
    if (err instanceof ApiError) {
      switch (err.kind) {
        case 'signin': return 'Your Yoto sign-in has expired. Please sign in again.';
        case 'forbidden': return 'Yoto says this account is missing a permission. Sign out, then sign in again and approve every permission it asks for.';
        case 'network': return 'Couldn’t reach Yoto. Check your internet connection and try again.';
        case 'rate': return 'Yoto is asking us to slow down. Wait a minute and try again.';
        case 'server': return 'Yoto had a problem on its side (' + err.status + '). Try again in a moment.';
        case 'rejected': return 'Yoto rejected that request (' + err.status + ')' + (err.detail ? ': ' + err.detail : '.');
        case 'notfound': return 'Yoto couldn’t find that. It may have been deleted.';
        default: return err.detail || 'Something went wrong. Please try again.';
      }
    }
    return 'Something went wrong. Please try again.';
  }

  // ───────── PKCE ─────────
  function b64url(bytes) {
    let s = '';
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomString(byteLen) {
    const a = new Uint8Array(byteLen);
    root.crypto.getRandomValues(a);
    return b64url(a);
  }
  async function challengeFor(verifier) {
    const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64url(new Uint8Array(digest));
  }

  // ───────── JWT helpers (read-only; we never trust these for security) ─────────
  function decodeJwt(token) {
    try {
      const part = String(token).split('.')[1];
      if (!part) return null;
      const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  }
  const splitScope = (s) => String(s || '').split(/\s+/).filter(Boolean);

  // What this token was granted. Order of trust: the token response's own
  // `scope` field, then the access token's JWT claims, then (only because the
  // OAuth spec lets a server omit `scope` when it equals what was asked for)
  // the scope we requested at sign-in.
  function scopesFor(data, accessJwt) {
    if (data && typeof data.scope === 'string' && data.scope.trim()) return splitScope(data.scope);
    const c = accessJwt;
    if (c) {
      const out = [];
      if (typeof c.scope === 'string') out.push.apply(out, splitScope(c.scope));
      if (Array.isArray(c.scope)) out.push.apply(out, c.scope.map(String));
      if (Array.isArray(c.permissions)) out.push.apply(out, c.permissions.map(String));
      if (out.length) return Array.from(new Set(out));
    }
    return null;
  }

  function profileFrom(idToken) {
    const c = idToken && decodeJwt(idToken);
    if (!c) return null;
    const name = (c.name || c.nickname || '').toString().trim();
    const email = (c.email || '').toString().trim();
    if (!name && !email) return null;
    return { name, email };
  }

  // ───────── Tokens ─────────
  const loadTokens = () => {
    const t = getJSON(ls, K_TOKENS);
    return t && t.access_token ? t : null;
  };
  function saveTokens(t) { setJSON(ls, K_TOKENS, t); }
  function clearTokens() { ls.del(K_TOKENS); }

  async function postToken(params) {
    let res;
    try {
      res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString()
      });
    } catch (e) { throw new ApiError('network', 0); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok || !data || !data.access_token) {
      const code = data && data.error;
      throw new ApiError(res.status >= 500 ? 'server' : (code === 'invalid_grant' ? 'signin' : 'rejected'), res.status,
        (data && (data.error_description || data.error)) || '');
    }
    return data;
  }

  function storeTokenResponse(data, previous, requestedScope) {
    const jwt = decodeJwt(data.access_token);
    // A refresh never widens or narrows what was granted, so prefer what we already knew over re-deriving it.
    const fromResponse = data.scope && String(data.scope).trim() ? splitScope(data.scope) : null;
    const granted = fromResponse || (previous && previous.scope) || scopesFor(data, jwt) || (requestedScope ? splitScope(requestedScope) : null);
    // Refresh tokens rotate (single use): persist the new one immediately.
    saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token || (previous && previous.refresh_token) || null,
      expires_at: Date.now() + ((data.expires_in || 3600) * 1000),
      scope: granted,
      profile: profileFrom(data.id_token) || (previous && previous.profile) || null
    });
  }

  // Single-flight within this page, and (where the browser has Web Locks)
  // across tabs: two tabs refreshing at once would burn the same single-use
  // refresh token and sign you out. `seenAccess` is the access token the
  // caller found stale; if another tab already replaced it, use theirs.
  let refreshing = null;
  function refreshTokens(seenAccess) {
    if (refreshing) return refreshing;
    const run = async () => {
      const t = loadTokens();
      if (!t || !t.refresh_token) throw new ApiError('signin', 401);
      if (seenAccess && t.access_token !== seenAccess && t.expires_at - Date.now() > 60000) return t;
      try {
        const data = await postToken({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: t.refresh_token });
        storeTokenResponse(data, t, null);
        return loadTokens();
      } catch (e) {
        if (e instanceof ApiError && e.kind !== 'network' && e.kind !== 'server') { clearTokens(); throw new ApiError('signin', 401); }
        throw e;
      }
    };
    const locked = root.navigator && root.navigator.locks && root.navigator.locks.request
      ? root.navigator.locks.request('yotoTools.refresh', run)
      : run();
    refreshing = Promise.resolve(locked).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function accessToken() {
    let t = loadTokens();
    if (!t) throw new ApiError('signin', 401);
    if (t.expires_at - Date.now() < 60000) t = await refreshTokens(t.access_token);
    return t.access_token;
  }

  // ───────── Session info ─────────
  const isConfigured = () => !!CLIENT_ID && CLIENT_ID.indexOf('REPLACE_WITH') !== 0;
  const isSignedIn = () => !!loadTokens();
  function profile() { const t = loadTokens(); return (t && t.profile) || null; }
  // Best name we have for "Signed in as …", or '' when we have nothing.
  function displayName() { const p = profile(); return p ? (p.name || p.email || '') : ''; }
  // Scopes this sign-in holds, or null when we can't tell.
  function grantedScopes() { const t = loadTokens(); return t && Array.isArray(t.scope) ? t.scope : null; }
  // Which of `needed` this sign-in lacks. Empty when fine OR when we can't tell
  // (a real 403 from Yoto is the backstop then). Everything is "missing" if
  // signed out.
  function missingScopes(needed) {
    const list = Array.isArray(needed) ? needed : splitScope(needed);
    if (!loadTokens()) return list.slice();
    const have = grantedScopes();
    if (!have) return [];
    return list.filter((s) => have.indexOf(s) === -1);
  }

  // ───────── Sign in / out ─────────
  // Resolves to null after kicking off the redirect, or { error } if it can't.
  // opts.via: a page in this folder that is registered with Yoto as a callback
  // (e.g. 'yoto.html'). Yoto returns there and that page sends you back here,
  // so a new tool page doesn't need its own callback URL registered.
  async function startSignIn(opts) {
    if (!(root.crypto && root.crypto.subtle)) {
      return { error: 'Your browser can’t do secure sign-in on this page. Try a current version of Chrome, Safari, Edge or Firefox over https.' };
    }
    const verifier = randomString(48), state = randomString(16);
    const via = opts && opts.via ? new URL(opts.via, root.location.href) : null;
    const redirectUri = via && via.origin === root.location.origin
      ? via.origin + via.pathname
      : root.location.origin + root.location.pathname;
    if (!setJSON(ss, K_PKCE, { verifier, state, redirectUri, returnTo: root.location.pathname })) {
      return { error: 'Your browser is blocking storage, which sign-in needs. Allow site data for this page and try again.' };
    }
    const challenge = await challengeFor(verifier);
    const p = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri,
      scope: SCOPE, audience: AUDIENCE, state,
      code_challenge: challenge, code_challenge_method: 'S256'
    });
    root.location.assign(AUTH_URL + '?' + p.toString());
    return null;
  }

  // Call once on page load. null = not a sign-in return; {ok:true} or {error}.
  async function handleRedirect() {
    const q = new URLSearchParams(root.location.search);
    if (!q.has('code') && !q.has('error')) return null;
    const code = q.get('code'), state = q.get('state'), error = q.get('error');
    const desc = q.get('error_description');
    root.history.replaceState(null, '', root.location.pathname);
    const saved = getJSON(ss, K_PKCE);
    ss.del(K_PKCE);
    if (error) {
      return { error: error === 'access_denied' ? 'Sign-in was cancelled.' : 'Yoto sign-in failed' + (desc ? ': ' + desc : '.') };
    }
    if (!saved || !state || state !== saved.state) {
      return { error: 'That sign-in couldn’t be verified (the security check didn’t match). Please try signing in again.' };
    }
    try {
      const data = await postToken({
        grant_type: 'authorization_code', client_id: CLIENT_ID, code,
        redirect_uri: saved.redirectUri || (root.location.origin + root.location.pathname),
        code_verifier: saved.verifier
      });
      storeTokenResponse(data, null, SCOPE);
      dropLegacyTokens();
      return { ok: true, returnTo: saved.returnTo || null };
    } catch (e) { return { error: friendly(e) }; }
  }

  // The page a sign-in started from, when it isn't this one and lives in this
  // folder (so a "via" sign-in can send you back). Otherwise null.
  function returnPath(r) {
    const to = r && r.returnTo;
    if (!to || to === root.location.pathname) return null;
    const here = root.location.pathname.replace(/[^/]*$/, '');
    return to.indexOf(here) === 0 && /^[\w-]+\.html$/.test(to.slice(here.length)) ? to : null;
  }

  function signOut() {
    clearTokens(); ss.del(K_PKCE);
    dropLegacyTokens();
  }

  // ───────── API ─────────
  // api(path, { method, body, trace }) -> parsed JSON ({} for an empty body).
  // `body` is a JSON string. `trace`, if given, is called once per HTTP attempt
  // with { method, path, status, ok, body } (status 0 = never reached Yoto) so a
  // page can show exactly what the API said.
  async function api(path, opts, retried) {
    opts = opts || {};
    const method = opts.method || 'GET';
    const trace = typeof opts.trace === 'function' ? opts.trace : null;
    const token = await accessToken();
    const headers = { 'Authorization': 'Bearer ' + token };
    if (opts.body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(API_BASE + path, { method, headers, body: opts.body });
    } catch (e) {
      if (trace) trace({ method, path, status: 0, ok: false, body: 'network error' });
      throw new ApiError('network', 0);
    }
    const text = await res.text();
    if (trace) trace({ method, path, status: res.status, ok: res.ok, body: text.slice(0, 300) });
    if (res.status === 401) {
      if (!retried) { await refreshTokens(token); return api(path, opts, true); }
      clearTokens();
      throw new ApiError('signin', 401);
    }
    if (res.ok) { try { return text ? JSON.parse(text) : {}; } catch (e) { return {}; } }
    let detail = '';
    try { const j = JSON.parse(text); detail = j.message || j.error || ''; } catch (e) { detail = text.slice(0, 160); }
    if (res.status === 403) throw new ApiError('forbidden', 403, detail);
    if (res.status === 404) throw new ApiError('notfound', 404, detail);
    if (res.status === 429) throw new ApiError('rate', 429, detail);
    if (res.status >= 500) throw new ApiError('server', res.status, detail);
    throw new ApiError('rejected', res.status, detail);
  }

  root.YotoAuth = {
    SCOPE, CLIENT_ID, API_BASE,
    ApiError, friendly,
    isConfigured, isSignedIn, profile, displayName, grantedScopes, missingScopes,
    startSignIn, handleRedirect, returnPath, signOut,
    accessToken, api
  };
})(window);
