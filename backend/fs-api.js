'use strict';
// Dual-pane file manager backend: browse, mkdir, rename, delete and rsync-based
// copy/move between any two allowed directories (typically a local dir and a RaiDrive mount).
//
// Everything is confined to allowed roots: RaiDrive mount paths, FS_ROOTS, and (in Docker,
// unless FS_ROOTS is set) every volume mapped into the container.
// Paths are checked lexically and again after realpath(), so symlinks cannot escape.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { runRsync } = require('./rsync-run');
const { HttpError, _internal: { isInside } } = require('./sync');

const MAX_ENTRIES = 5000;
const MAX_SOURCES = 500;
const MAX_TASKS_KEPT = 50;
const MTIME_WINDOW = 2;
const CONNECTED = /^(connected|mounted)$/i;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function lstatOrNull(p) {
  try { return await fsp.lstat(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; }
}

async function realpathLoose(abs) {
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const rp = await fsp.realpath(cur);
      return path.join(rp, ...tail.slice().reverse());
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function mountOwner(abs, mounts) {
  return mounts
    .filter(m => m.mountPath && isInside(path.resolve(m.mountPath), abs))
    .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
}

function assertMountUp(abs, mounts) {
  const o = mountOwner(abs, mounts);
  if (o && !CONNECTED.test(o.state || '')) {
    throw new HttpError(409, `mount "${o.label}" is ${o.state || 'unknown'}, not Connected`);
  }
}

function validName(name) {
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[\/\0]/.test(name)) {
    throw new HttpError(400, 'invalid file name');
  }
  return name;
}

function splitExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ''];
}

async function uniqueTarget(dir, name, isDir) {
  const [base, ext] = isDir ? [name, ''] : splitExt(name);
  for (let n = 1; n < 10000; n++) {
    const cand = path.join(dir, `${base} (${n})${ext}`);
    if (!(await lstatOrNull(cand))) return cand;
  }
  throw new HttpError(500, `cannot find a free name for ${name}`);
}

async function walkSize(root, ctl) {
  const st = await lstatOrNull(root);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  const stack = [root];
  while (stack.length) {
    if (ctl && ctl.cancelled) throw new Error('cancelled');
    const dir = stack.pop();
    let ents;
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { total += (await fsp.lstat(p)).size; } catch { /* vanished */ } }
    }
  }
  return total;
}

async function removeEmptyDirs(dir) {
  let ents;
  try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name));
  try { await fsp.rmdir(dir); return true; } catch { return false; }
}

// ── volume auto-detection ────────────────────────────────────
// Inside Docker, every volume the user mapped shows up in /proc/self/mountinfo.
// Treat those as browsable so a mapping like /mnt/disk2/movies:/mnt2 just works,
// while the container's own system paths and the panel's config volumes stay off limits.
const VIRTUAL_FS = new Set(['proc', 'sysfs', 'tmpfs', 'devtmpfs', 'devpts', 'mqueue', 'cgroup', 'cgroup2', 'shm',
  'overlay', 'securityfs', 'debugfs', 'tracefs', 'configfs', 'fusectl', 'pstore', 'bpf', 'nsfs', 'autofs',
  'binfmt_misc', 'hugetlbfs', 'selinuxfs', 'rpc_pipefs']);
const SYSTEM_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/run', '/var', '/usr', '/lib', '/lib64', '/bin',
  '/sbin', '/boot', '/app', '/tmp', '/root'];

function detectVolumes(mountinfo) {
  const out = new Set();
  for (const line of String(mountinfo).split('\n')) {
    const sep = line.indexOf(' - ');
    if (sep === -1) continue;
    const pre = line.slice(0, sep).split(' ');
    const fstype = line.slice(sep + 3).split(' ')[0];
    if (pre.length < 5) continue;
    const mp = pre[4].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    if (mp === '/' || VIRTUAL_FS.has(fstype)) continue;
    if (SYSTEM_PREFIXES.some(p => mp === p || mp.startsWith(p + '/'))) continue;
    out.add(mp);
  }
  return [...out];
}

function defaultDetect() {
  if (process.env.FS_AUTODETECT === '0') return [];
  const inContainer = fs.existsSync('/.dockerenv') || process.env.FS_AUTODETECT === '1';
  if (!inContainer) return [];
  try { return detectVolumes(fs.readFileSync('/proc/self/mountinfo', 'utf8')); } catch { return []; }
}

function createFsApi({ broadcast, getMounts, roots: baseRoots, detect = null, rsyncBin = 'rsync', perms = require('./perms').createPerms(), upstream = null }) {
  const tasks = new Map();
  const emit = ev => { try { broadcast({ type: 'xfer', ...ev }); } catch { /* no listeners */ } };

  async function mountsLenient() { try { return await getMounts(); } catch { return []; } }
  async function mountsStrict() {
    try { return await getMounts(); } catch (e) { throw new HttpError(503, `cannot read mount list: ${e.message}`); }
  }

  async function allowedRoots(mounts) {
    const list = [];
    const seen = new Set();
    const add = (p, extra) => {
      const abs = path.resolve(p);
      if (seen.has(abs)) return;
      seen.add(abs);
      list.push({ path: abs, ...extra });
    };
    for (const m of mounts) if (m.mountPath) add(m.mountPath, { kind: 'mount', label: m.label, state: m.state });
    for (const r of baseRoots) add(r, { kind: 'dir', label: path.basename(r) || r });
    for (const r of (detect ? detect() : [])) add(r, { kind: 'dir', label: path.basename(r) || r });
    for (const r of list) {
      try { r.real = await fsp.realpath(r.path); } catch { r.real = null; }
    }
    return list;
  }

  async function resolveAllowed(p, roots) {
    if (typeof p !== 'string' || !p || p.includes('\0') || !path.isAbsolute(p)) {
      throw new HttpError(400, 'an absolute path is required');
    }
    const abs = path.resolve(p);
    if (!roots.some(r => isInside(r.path, abs))) {
      const shown = roots.filter(r => r.kind === 'mount' || r.real).map(r => r.path).join(', ') || 'none';
      throw new HttpError(403, `path is outside the allowed roots (allowed: ${shown}). Map the folder into the container; set FS_ROOTS to allow extra paths`);
    }
    let real;
    try { real = await realpathLoose(abs); } catch (e) { throw new HttpError(404, `not accessible: ${e.code || e.message}`); }
    if (!roots.some(r => r.real && isInside(r.real, real))) {
      throw new HttpError(403, 'path resolves outside the allowed roots');
    }
    return abs;
  }

  // ── read ───────────────────────────────────────────────────

  async function getRoots() {
    const mounts = await mountsLenient();
    const roots = await allowedRoots(mounts);
    const out = [];
    for (const r of roots) {
      if (r.kind === 'dir') { // configured/detected but maybe absent, or a bind-mounted file
        const st = r.real ? await fsp.stat(r.real).catch(() => null) : null;
        if (!st || !st.isDirectory()) continue;
      }
      out.push({ path: r.path, label: r.label, kind: r.kind, state: r.state });
    }
    const dirs = out.filter(r => r.kind === 'dir');
    const ms = out.filter(r => r.kind === 'mount');
    const upMount = ms.find(r => CONNECTED.test(r.state || '')) || ms[0];
    const local = (dirs.find(r => r.path === '/data') || dirs[0] || out[0] || {}).path || null;
    return { roots: out, defaults: { local, remote: (upMount || dirs[0] || {}).path || local } };
  }

  async function listDir(p, { refresh = false } = {}) {
    const mounts = await mountsLenient();
    const roots = await allowedRoots(mounts);
    const abs = await resolveAllowed(p, roots);
    assertMountUp(abs, mounts);
    // Manual refresh: ask the upstream (e.g. OpenList) to re-read its storage before listing.
    let upstreamInfo;
    const owner = mountOwner(abs, mounts);
    if (refresh && upstream && owner && upstream.has(owner.label)) {
      try {
        const rel = path.relative(path.resolve(owner.mountPath), abs).split(path.sep).join('/');
        upstreamInfo = await upstream.refresh(owner, rel);
      } catch (e) { upstreamInfo = { error: e.message }; }
    }
    let dirents;
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (e) {
      const status = e.code === 'ENOENT' ? 404 : e.code === 'ENOTDIR' ? 400 : e.code === 'EACCES' ? 403 : 500;
      throw new HttpError(status, `cannot read ${abs}: ${e.code || e.message}`);
    }
    const truncated = dirents.length > MAX_ENTRIES;
    dirents = dirents.slice(0, MAX_ENTRIES);
    const entries = (await mapLimit(dirents, 32, async d => {
      try {
        const full = path.join(abs, d.name);
        const l = await fsp.lstat(full);
        let st = l;
        const link = l.isSymbolicLink();
        if (link) { try { st = await fsp.stat(full); } catch { /* broken link */ } }
        const type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        return { name: d.name, type, link, size: type === 'file' ? st.size : 0, mtime: Math.floor(st.mtimeMs / 1000) };
      } catch { return null; } // vanished mid-listing
    })).filter(Boolean);
    const parentDir = path.dirname(abs);
    const parent = parentDir !== abs && roots.some(r => isInside(r.path, parentDir)) ? parentDir : null;
    return { path: abs, parent, entries, truncated, ...(upstreamInfo ? { upstream: upstreamInfo } : {}) };
  }

  // ── simple writes ──────────────────────────────────────────

  async function prepWrite(p) {
    const mounts = await mountsStrict();
    const roots = await allowedRoots(mounts);
    const abs = await resolveAllowed(p, roots);
    assertMountUp(abs, mounts);
    return { abs, roots };
  }

  async function mkdir(p) {
    const { abs } = await prepWrite(p);
    try { await fsp.mkdir(abs); } catch (e) {
      throw new HttpError(e.code === 'EEXIST' ? 409 : e.code === 'ENOENT' ? 404 : 500, `cannot create ${abs}: ${e.code || e.message}`);
    }
    if (!mountOwner(abs, await mountsStrict())) await perms.applyOne(abs, true);
    return { path: abs };
  }

  async function rename(p, newName) {
    const { abs, roots } = await prepWrite(p);
    validName(newName);
    if (roots.some(r => r.path === abs)) throw new HttpError(400, 'cannot rename a root');
    const target = path.join(path.dirname(abs), newName);
    await resolveAllowed(target, roots);
    if (await lstatOrNull(target)) throw new HttpError(409, `${newName} already exists`);
    try { await fsp.rename(abs, target); } catch (e) { throw new HttpError(500, `cannot rename: ${e.code || e.message}`); }
    return { path: target };
  }

  async function remove(paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_SOURCES) throw new HttpError(400, 'paths required');
    const mounts = await mountsStrict();
    const roots = await allowedRoots(mounts);
    const resolved = [];
    for (const p of paths) {
      const abs = await resolveAllowed(p, roots);
      assertMountUp(abs, mounts);
      if (roots.some(r => r.path === abs)) throw new HttpError(400, `cannot delete a root: ${abs}`);
      resolved.push(abs);
    }
    const errors = [];
    let deleted = 0;
    for (const abs of resolved) {
      try { await fsp.rm(abs, { recursive: true, force: true }); deleted++; } catch (e) { errors.push(`${abs}: ${e.code || e.message}`); }
    }
    return { deleted, errors };
  }

  // ── transfer ───────────────────────────────────────────────

  async function startTransfer({ sources, destDir, op = 'copy', onConflict } = {}) {
    if (op !== 'copy' && op !== 'move') throw new HttpError(400, 'op must be copy or move');
    if (onConflict !== undefined && !['skip', 'overwrite', 'rename'].includes(onConflict)) {
      throw new HttpError(400, 'invalid onConflict');
    }
    if (!Array.isArray(sources) || !sources.length || sources.length > MAX_SOURCES) {
      throw new HttpError(400, `sources must contain 1-${MAX_SOURCES} paths`);
    }
    const mounts = await mountsStrict();
    const roots = await allowedRoots(mounts);
    const dest = await resolveAllowed(destDir, roots);
    assertMountUp(dest, mounts);
    const dstat = await lstatOrNull(dest);
    if (!dstat || !(await fsp.stat(dest)).isDirectory()) throw new HttpError(400, 'destination is not a directory');

    const items = [];
    const names = new Set();
    for (const s of sources) {
      const src = await resolveAllowed(s, roots);
      assertMountUp(src, mounts);
      const st = await lstatOrNull(src);
      if (!st) throw new HttpError(404, `source not found: ${src}`);
      if (roots.some(r => r.path === src)) throw new HttpError(400, `cannot transfer a root: ${src}`);
      const isDir = st.isDirectory();
      if (isDir && isInside(src, dest)) throw new HttpError(400, `cannot copy ${path.basename(src)} into itself`);
      const name = path.basename(src);
      if (names.has(name)) throw new HttpError(400, `duplicate name in selection: ${name}`);
      names.add(name);
      const target = path.join(dest, name);
      if (src === target && op === 'move') throw new HttpError(400, `${name} is already in the destination`);
      items.push({ src, name, isDir, target });
    }

    const conflicts = [];
    for (const it of items) it.exists = await lstatOrNull(it.target);
    for (const it of items) if (it.exists) conflicts.push(it.name);
    if (conflicts.length && !onConflict) {
      const e = new HttpError(409, `${conflicts.length} item(s) already exist in the destination`);
      e.conflicts = conflicts;
      throw e;
    }

    const plan = [];
    const results = [];
    for (const it of items) {
      if (!it.exists) { plan.push({ ...it, fresh: true }); continue; }
      if (onConflict === 'skip') { results.push({ name: it.name, status: 'skipped' }); continue; }
      if (onConflict === 'rename') {
        plan.push({ ...it, target: await uniqueTarget(dest, it.name, it.isDir), fresh: true });
        continue;
      }
      // overwrite onto itself is a no-op
      if (it.src === it.target) { results.push({ name: it.name, status: 'skipped' }); continue; }
      // overwrite: only like-for-like; replacing a file with a folder (or reverse) is never done silently
      if (it.exists.isDirectory() !== it.isDir) {
        results.push({ name: it.name, status: 'failed', error: 'file/folder type mismatch, not overwritten' });
        continue;
      }
      plan.push({ ...it, fresh: false });
    }

    const task = {
      id: crypto.randomBytes(5).toString('hex'), op, destDir: dest, count: plan.length,
      status: 'running', cancelled: false, child: null, doneBytes: 0, totalBytes: 0,
      startedAt: Date.now(), results, names: plan.map(p => p.name),
    };
    tasks.set(task.id, task);
    for (const id of [...tasks.keys()].slice(0, Math.max(0, tasks.size - MAX_TASKS_KEPT))) {
      if (tasks.get(id).status !== 'running') tasks.delete(id);
    }
    if (!plan.length) {
      task.status = results.some(r => r.status === 'failed') ? 'failed' : 'success';
      return { id: task.id, count: 0, done: Promise.resolve(summary(task)) };
    }
    const done = runTransfer(task, plan, mounts).catch(e => {
      task.status = e.message === 'cancelled' ? 'cancelled' : 'failed';
      task.error = e.message;
    }).then(() => {
      emit({ event: 'done', ...summary(task) });
      return summary(task);
    });
    return { id: task.id, count: plan.length, done };
  }

  function summary(t) {
    return {
      id: t.id, op: t.op, destDir: t.destDir, count: t.count, status: t.status, error: t.error,
      doneBytes: t.doneBytes, totalBytes: t.totalBytes, results: t.results, names: t.names,
    };
  }

  async function runTransfer(task, plan, mounts) {
    emit({ event: 'start', ...summary(task) });
    for (const it of plan) it.size = await walkSize(it.src, task);
    task.totalBytes = plan.reduce((a, it) => a + it.size, 0);
    emit({ event: 'progress', id: task.id, doneBytes: 0, totalBytes: task.totalBytes });

    const toMount = !!mountOwner(task.destDir, mounts);
    let lastEmit = 0;
    for (const it of plan) {
      if (task.cancelled) throw new Error('cancelled');

      // Same-filesystem move to a free name is a plain rename.
      if (task.op === 'move' && it.fresh) {
        try {
          await fsp.rename(it.src, it.target);
          task.doneBytes += it.size;
          task.results.push({ name: it.name, status: 'success' });
          continue;
        } catch { /* EXDEV or unsupported (FUSE): fall back to rsync */ }
      }

      // Ownership/mode policy only applies to local destinations; cloud mounts have no uid/gid to set.
      const permArgs = toMount ? ['--no-perms', '--no-owner', '--no-group'] : perms.rsyncArgs();
      const args = [...permArgs, `--modify-window=${MTIME_WINDOW}`,
        '--info=progress2,name1', '--no-inc-recursive', toMount ? '--inplace' : '--partial'];
      if (task.op === 'move') args.push('--remove-source-files');
      if (it.isDir) args.push('-rlt', it.src.replace(/\/+$/, '') + '/', it.target.replace(/\/+$/, '') + '/');
      else args.push('-lt', it.src, it.target);

      const before = task.doneBytes;
      const res = await runRsync(rsyncBin, args, {
        onChild: c => { task.child = c; },
        onClose: () => { task.child = null; },
        onProgress: p => {
          task.doneBytes = before + p.bytes;
          const now = Date.now();
          if (now - lastEmit < 250) return;
          lastEmit = now;
          emit({ event: 'progress', id: task.id, doneBytes: task.doneBytes, totalBytes: task.totalBytes, rate: p.rate, eta: p.eta, current: it.name });
        },
      });
      if (task.cancelled) throw new Error('cancelled');

      if (res.code === 0 || res.code === 24) {
        let ok = true;
        if (task.op === 'move' && it.isDir) {
          await removeEmptyDirs(it.src);
          ok = !(await lstatOrNull(it.src));
        }
        task.results.push(ok ? { name: it.name, status: 'success' }
          : { name: it.name, status: 'partial', error: 'some files remain in the source' });
      } else {
        task.results.push({ name: it.name, status: 'failed', error: `rsync exit ${res.code}: ${res.errTail.trim().split('\n').pop() || ''}` });
      }
      task.doneBytes = before + it.size;
    }
    const bad = task.results.filter(r => r.status === 'failed' || r.status === 'partial');
    task.status = !bad.length ? 'success' : bad.length === task.results.length ? 'failed' : 'partial';
  }

  function cancel(id) {
    const t = tasks.get(id);
    if (!t || t.status !== 'running') throw new HttpError(409, 'transfer is not running');
    t.cancelled = true;
    if (t.child) t.child.kill('SIGTERM');
  }

  function listTasks() { return [...tasks.values()].map(summary); }

  function registerRoutes(app) {
    const wrap = fn => async (req, res) => {
      try {
        res.json({ ok: true, ...(await fn(req)) });
      } catch (e) {
        const body = { ok: false, output: e.message };
        if (e.conflicts) body.conflicts = e.conflicts;
        res.status(e.status || 500).json(body);
      }
    };
    app.get('/api/fs/roots', wrap(() => getRoots()));
    app.get('/api/fs/list', wrap(req => listDir(req.query.path, { refresh: req.query.refresh === '1' })));
    app.post('/api/fs/mkdir', wrap(req => mkdir(req.body?.path)));
    app.post('/api/fs/rename', wrap(req => rename(req.body?.path, req.body?.newName)));
    app.post('/api/fs/delete', wrap(req => remove(req.body?.paths)));
    app.post('/api/fs/transfer', wrap(async req => {
      const { id, count, done } = await startTransfer(req.body || {});
      done.catch(() => {});
      return { id, count };
    }));
    app.post('/api/fs/transfer/:id/cancel', wrap(async req => { cancel(req.params.id); return {}; }));
    app.get('/api/fs/tasks', wrap(async () => ({ tasks: listTasks() })));
  }

  return { getRoots, listDir, mkdir, rename, remove, startTransfer, cancel, listTasks, registerRoutes };
}

function defaultRoots() {
  return (process.env.FS_ROOTS || '/mnt:/data:/media').split(':').map(s => s.trim()).filter(Boolean);
}

module.exports = { createFsApi, defaultRoots, defaultDetect, detectVolumes };
