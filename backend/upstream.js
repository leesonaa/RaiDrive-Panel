'use strict';
// "Upstream refresh": RaiDrive mounts of a WebDAV front-end such as OpenList/AList only show what that
// front-end has cached. Pressing refresh in the file manager first asks the upstream to re-read its own
// storage (OpenList: POST /api/fs/list {refresh:true}), then lists the mount.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const TYPES = ['openlist'];

function createUpstream({ file, fetchImpl = (...a) => fetch(...a) } = {}) {
  let cfg = {}; // label -> { type, url?, davPrefix?, username?, password?, token? }
  const tokens = new Map(); // label -> login token

  async function init() {
    if (!file) return;
    try { cfg = JSON.parse(await fsp.readFile(file, 'utf8')) || {}; }
    catch (e) { if (e.code !== 'ENOENT') console.warn('upstream.json ignored:', e.message); }
  }
  const save = () => file
    ? fsp.mkdir(path.dirname(file), { recursive: true }).then(() => fsp.writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 }))
    : Promise.resolve();

  const pub = c => c && ({ type: c.type, url: c.url || '', davPrefix: c.davPrefix || '', username: c.username || '',
    hasPassword: !!c.password, hasToken: !!c.token });
  const list = () => Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, pub(v)]));
  const has = label => !!cfg[label];

  async function set(label, body) {
    if (!label) throw new Error('label required');
    if (!TYPES.includes(body.type || 'openlist')) throw new Error('unsupported upstream type');
    const old = cfg[label] || {};
    const url = String(body.url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^/\s]+/i.test(url)) throw new Error('url must start with http:// or https://');
    const davPrefix = String(body.davPrefix ?? '').trim();
    // empty secret fields keep the stored value, so the UI never has to echo them back
    const username = String(body.username || '').trim();
    cfg[label] = { type: 'openlist', url, davPrefix, username,
      password: body.password ? String(body.password) : (old.username === username ? old.password || '' : ''),
      token: body.token ? String(body.token).trim() : old.token || '' };
    tokens.delete(label);
    await save();
    return pub(cfg[label]);
  }
  async function remove(label) { delete cfg[label]; tokens.delete(label); await save(); }

  function resolve(c, mount, rel) {
    const remote = new URL(mount.remote || c.url);
    const base = c.url || remote.origin;
    const dav = (c.davPrefix || '/dav').replace(/\/+$/, '');
    let root = decodeURIComponent(remote.pathname).replace(/\/+$/, '');
    if (root === dav || root.startsWith(dav + '/')) root = root.slice(dav.length);
    return { base, apiPath: ('/' + [root, rel].join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1') };
  }

  async function call(base, route, body, token) {
    const r = await fetchImpl(base + route, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) },
      body: JSON.stringify(body),
    });
    let j; try { j = await r.json(); } catch { throw new Error(`upstream answered HTTP ${r.status}`); }
    return j;
  }

  async function login(label, c, base) {
    if (c.token) return c.token;
    if (tokens.has(label)) return tokens.get(label);
    if (!c.username || !c.password) return '';
    const j = await call(base, '/api/auth/login', { username: c.username, password: c.password });
    if (j.code !== 200 || !j.data?.token) throw new Error(`upstream login failed: ${j.message || j.code}`);
    tokens.set(label, j.data.token);
    return j.data.token;
  }

  // rel: path inside the mount ('' = mount root)
  async function refresh(mount, rel) {
    const c = cfg[mount.label];
    if (!c) return { skipped: true };
    const { base, apiPath } = resolve(c, mount, rel);
    const body = { path: apiPath, password: '', refresh: true, page: 1, per_page: 1 };
    let token = await login(mount.label, c, base);
    let j = await call(base, '/api/fs/list', body, token);
    if (j.code === 401 && !c.token && c.username) { // cached login expired
      tokens.delete(mount.label);
      token = await login(mount.label, c, base);
      j = await call(base, '/api/fs/list', body, token);
    }
    if (j.code !== 200) throw new Error(`upstream refresh failed: ${j.message || j.code}`);
    return { refreshed: true, path: apiPath };
  }

  return { init, list, has, set, remove, refresh, _resolve: resolve };
}

module.exports = { createUpstream };
