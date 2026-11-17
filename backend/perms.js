'use strict';
// Ownership / permission policy for files the panel writes to LOCAL (non-RaiDrive) paths.
// Defaults come from PUID / PGID / UMASK env vars; the UI can override and persists to perms.json.
// Nothing configured => disabled => previous behaviour (files owned by the container user).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const PRESETS = {
  unraid:   { uid: 99,   gid: 100,  umask: '000', label: 'Unraid (nobody:users 99:100)' },
  synology: { uid: 1000, gid: 1000, umask: '022', label: '群晖 Synology (1000:1000)' },
};

const isId = v => Number.isInteger(v) && v >= 0 && v <= 4294967294;
const isUmask = s => typeof s === 'string' && /^[0-7]{3,4}$/.test(s);
const toInt = v => (v === '' || v == null ? null : Number(v));

function envConfig(env) {
  const uid = toInt(env.PUID), gid = toInt(env.PGID);
  const umask = env.UMASK != null && env.UMASK !== '' ? String(env.UMASK) : null;
  return { uid: isId(uid) ? uid : null, gid: isId(gid) ? gid : null, umask: isUmask(umask) ? umask : null };
}

function normalize(c) {
  const out = { uid: null, gid: null, umask: null };
  const uid = toInt(c.uid), gid = toInt(c.gid);
  if (uid != null) { if (!isId(uid)) throw new Error('uid must be a non-negative integer'); out.uid = uid; }
  if (gid != null) { if (!isId(gid)) throw new Error('gid must be a non-negative integer'); out.gid = gid; }
  if (c.umask != null && c.umask !== '') {
    if (!isUmask(String(c.umask))) throw new Error('umask must be 3-4 octal digits, e.g. 022');
    out.umask = String(c.umask);
  }
  return out;
}

function createPerms({ file, env = process.env, isRoot = process.getuid ? process.getuid() === 0 : false } = {}) {
  let override = null; // null => use env
  const base = envConfig(env);

  async function init() {
    if (!file) return;
    try { override = normalize(JSON.parse(await fsp.readFile(file, 'utf8'))); }
    catch (e) { if (e.code !== 'ENOENT') console.warn('perms.json ignored:', e.message); }
  }

  const effective = () => override || base;
  const active = c => c.uid != null || c.gid != null || c.umask != null;

  function modes(c) {
    const um = parseInt(c.umask || '022', 8) & 0o777;
    const o = n => n.toString(8).padStart(3, '0');
    return { dir: o(0o777 & ~um), file: o(0o666 & ~um) };
  }

  function get() {
    const c = effective();
    return { ...c, source: override ? 'ui' : (active(base) ? 'env' : 'none'), enabled: active(c), isRoot,
      effectiveModes: active(c) ? modes(c) : null, presets: PRESETS };
  }

  async function set(c) {
    const n = normalize(c || {});
    override = n;
    if (file) {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(n, null, 2));
    }
    return get();
  }

  async function reset() {
    override = null;
    if (file) await fsp.rm(file, { force: true });
    return get();
  }

  // rsync flags to use when the destination is a local path.
  function rsyncArgs() {
    const c = effective();
    if (!active(c)) return ['--no-perms', '--no-owner', '--no-group'];
    const m = modes(c);
    const args = ['-p', `--chmod=D${m.dir},F${m.file}`];
    if (isRoot && (c.uid != null || c.gid != null)) {
      args.push('-o', '-g', `--chown=${c.uid ?? ''}:${c.gid ?? ''}`);
    } else {
      args.push('--no-owner', '--no-group');
    }
    return args;
  }

  async function applyOne(p, isDir) {
    const c = effective();
    if (!active(c)) return;
    const m = modes(c);
    if (isRoot && (c.uid != null || c.gid != null)) {
      await fsp.lchown(p, c.uid ?? -1, c.gid ?? -1).catch(() => {});
    }
    await fsp.chmod(p, parseInt(isDir ? m.dir : m.file, 8)).catch(() => {});
  }

  // mkdir -p that applies the policy to every directory it creates.
  async function mkdirp(dir) {
    const missing = [];
    let cur = path.resolve(dir);
    for (;;) {
      try { await fsp.stat(cur); break; } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        missing.push(cur);
        const up = path.dirname(cur);
        if (up === cur) break;
        cur = up;
      }
    }
    for (const d of missing.reverse()) {
      try { await fsp.mkdir(d); } catch (e) { if (e.code !== 'EEXIST') throw e; continue; }
      await applyOne(d, true);
    }
  }

  return { init, get, set, reset, rsyncArgs, mkdirp, applyOne, _modes: modes };
}

module.exports = { createPerms, PRESETS };
