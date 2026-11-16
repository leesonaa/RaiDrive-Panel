'use strict';
// File sync between a RaiDrive mount and a local directory.
//
// raidrivecli has no sync command, so this module drives rsync itself:
//   push    local  -> mount   (rsync, optional --delete)
//   pull    mount  -> local   (rsync, optional --delete)
//   bisync  two-way. rsync cannot do this natively, so the diff is computed here
//           against a manifest of the last agreed state, and rsync only moves the
//           files (--files-from). Deletions propagate only for files that were
//           unchanged since the last sync; modify-vs-delete keeps the modified file.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MODES = new Set(['push', 'pull', 'bisync']);
const CONFLICT_POLICIES = new Set(['newer', 'local', 'remote']);
const MTIME_WINDOW = 2; // seconds; cloud/FUSE backends have coarse mtimes
const DEFAULT_EXCLUDES = ['.DS_Store', 'Thumbs.db', '*.part', '*.tmp'];
const DEFAULT_MAX_DELETE = 200;
const HISTORY_MAX = 20;
const LOG_MAX = 1000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ── helpers ──────────────────────────────────────────────────

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function globToRegExpBody(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return re;
}

// Patterns without a slash match a name at any depth; with a slash (or a leading
// one) they are anchored to the sync root. A matching directory is not descended.
function buildExcluder(patterns) {
  const regs = (patterns || [])
    .map(p => String(p).trim())
    .filter(Boolean)
    .map(p => {
      const anchored = p.startsWith('/');
      const bare = anchored ? p.slice(1) : p;
      const body = globToRegExpBody(bare);
      return new RegExp(anchored || bare.includes('/') ? `^${body}$` : `(^|/)${body}$`);
    });
  return rel => regs.some(r => r.test(rel));
}

function same(a, b) {
  return a.size === b.size && Math.abs(a.mtime - b.mtime) <= MTIME_WINDOW;
}

async function scanTree(root, isExcluded, ctl) {
  const entries = new Map();
  const skipped = [];
  const stack = [''];
  while (stack.length) {
    if (ctl && ctl.cancelled) throw new Error('cancelled');
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let list;
    try {
      list = await fsp.readdir(abs, { withFileTypes: true });
    } catch (e) {
      // An incomplete scan would look like mass deletion, so never continue past it.
      throw new Error(`cannot read directory ${abs}: ${e.code || e.message}`);
    }
    for (const ent of list) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (isExcluded(r)) continue;
      if (ent.isSymbolicLink()) { skipped.push(r); continue; }
      let st;
      try {
        st = await fsp.lstat(path.join(root, r));
      } catch (e) {
        if (e.code === 'ENOENT') continue; // vanished mid-scan
        throw new Error(`cannot stat ${path.join(root, r)}: ${e.code || e.message}`);
      }
      if (st.isDirectory()) {
        entries.set(r, { t: 'd', size: 0, mtime: 0 });
        stack.push(r);
      } else if (st.isFile()) {
        entries.set(r, { t: 'f', size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
      } else {
        skipped.push(r);
      }
    }
  }
  return { entries, skipped };
}

// L, R, P: Map<rel, {t:'f'|'d', size, mtime}> for local, remote and last agreed state.
function planBisync(L, R, P, { conflict = 'newer' } = {}) {
  const plan = {
    toRemote: [], toLocal: [],
    delLocal: [], delRemote: [],
    mkdirLocal: [], mkdirRemote: [],
    rmdirLocal: [], rmdirRemote: [],
    conflicts: [], issues: [],
    keep: new Map(), bytes: 0,
  };
  const all = new Set([...L.keys(), ...R.keys(), ...P.keys()]);

  for (const rel of [...all].sort()) {
    const l = L.get(rel), r = R.get(rel), p = P.get(rel);
    if (!l && !r) continue; // gone on both sides

    if (l && r && l.t !== r.t) {
      plan.issues.push(`file/directory mismatch, skipped: ${rel}`);
      continue;
    }

    if ((l || r).t === 'd') {
      if (l && r) plan.keep.set(rel, l);
      else if (l) (p ? plan.rmdirLocal : plan.mkdirRemote).push(rel);
      else (p ? plan.rmdirRemote : plan.mkdirLocal).push(rel);
      continue;
    }

    const pf = p && p.t === 'f' ? p : null;
    if (l && r) {
      if (same(l, r)) { plan.keep.set(rel, l); continue; }
      const lChanged = !pf || !same(l, pf);
      const rChanged = !pf || !same(r, pf);
      if (lChanged && !rChanged) {
        plan.toRemote.push(rel); plan.bytes += l.size;
      } else if (rChanged && !lChanged) {
        plan.toLocal.push(rel); plan.bytes += r.size;
      } else {
        const winner = conflict === 'local' ? 'local'
          : conflict === 'remote' ? 'remote'
          : (l.mtime >= r.mtime ? 'local' : 'remote');
        plan.conflicts.push({ rel, winner });
        if (winner === 'local') { plan.toRemote.push(rel); plan.bytes += l.size; }
        else { plan.toLocal.push(rel); plan.bytes += r.size; }
      }
    } else if (l) {
      // Only local. Known + unchanged => deleted on the remote side; otherwise new or modified.
      if (pf && same(l, pf)) plan.delLocal.push(rel);
      else { plan.toRemote.push(rel); plan.bytes += l.size; }
    } else {
      if (pf && same(r, pf)) plan.delRemote.push(rel);
      else { plan.toLocal.push(rel); plan.bytes += r.size; }
    }
  }
  return plan;
}

function validateCron(cron, expr) {
  if (!expr) return;
  if (!cron) throw new HttpError(400, 'node-cron is not installed; scheduling is unavailable');
  if (!cron.validate(expr)) throw new HttpError(400, `invalid cron expression: ${expr}`);
}

function toExcludeList(v) {
  if (v === undefined || v === null) return undefined;
  const arr = Array.isArray(v) ? v : String(v).split(/\r?\n/);
  return arr.map(s => String(s).trim()).filter(Boolean).slice(0, 100);
}

function toNonNegInt(v, field, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, `${field} must be a non-negative integer`);
  return n;
}

function validateAbsPath(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} is required`);
  if (v.includes('\0')) throw new HttpError(400, `${field} is invalid`);
  if (!path.isAbsolute(v)) throw new HttpError(400, `${field} must be an absolute path`);
  const resolved = path.resolve(v);
  if (resolved === path.parse(resolved).root) throw new HttpError(400, `${field} must not be the filesystem root`);
  return resolved;
}

// ── manager ──────────────────────────────────────────────────

function createSyncManager({ dataDir, broadcast, getMounts, rsyncBin = 'rsync', cron = null }) {
  const jobsFile = path.join(dataDir, 'sync-jobs.json');
  const stateDir = path.join(dataDir, 'sync-state');
  const conflictDir = path.join(dataDir, 'sync-conflicts');
  const tmpDir = path.join(dataDir, 'sync-tmp');

  let jobs = [];
  const running = new Map();   // jobId -> ctl
  const lastLogs = new Map();  // jobId -> lines of the most recent run
  const timers = new Map();    // jobId -> cron task
  let persistChain = Promise.resolve();

  const emit = ev => { try { broadcast({ type: 'sync', ...ev }); } catch { /* no listeners */ } };

  async function init() {
    await fsp.mkdir(dataDir, { recursive: true });
    try {
      jobs = JSON.parse(await fsp.readFile(jobsFile, 'utf8'));
      if (!Array.isArray(jobs)) jobs = [];
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[sync] cannot read jobs file:', e.message);
      jobs = [];
    }
    for (const j of jobs) schedule(j);
  }

  function persist() {
    persistChain = persistChain.then(async () => {
      const tmp = `${jobsFile}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(jobs, null, 2));
      await fsp.rename(tmp, jobsFile);
    }).catch(e => console.error('[sync] persist failed:', e.message));
    return persistChain;
  }

  function schedule(job) {
    const old = timers.get(job.id);
    if (old) { old.stop(); timers.delete(job.id); }
    if (!job.enabled || !job.schedule || !cron) return;
    if (!cron.validate(job.schedule)) return;
    const task = cron.schedule(job.schedule, () => {
      startRun(job.id, { trigger: 'cron' }).then(r => r.done).catch(e => {
        if (e.status !== 409) console.error(`[sync] scheduled run of ${job.name} failed:`, e.message);
      });
    }, process.env.TZ ? { timezone: process.env.TZ } : {});
    timers.set(job.id, task);
  }

  function view(job) {
    const ctl = running.get(job.id);
    return { ...job, running: !!ctl, progress: ctl ? ctl.progress : null };
  }

  function sanitize(body, existing) {
    const b = body || {};
    const merged = { ...(existing || {}), ...b };
    const name = String(merged.name || '').trim();
    if (!name || name.length > 64) throw new HttpError(400, 'name is required (max 64 chars)');
    const mode = merged.mode || 'bisync';
    if (!MODES.has(mode)) throw new HttpError(400, `mode must be one of ${[...MODES].join(', ')}`);
    const localPath = validateAbsPath(merged.localPath, 'localPath');
    const remotePath = validateAbsPath(merged.remotePath, 'remotePath');
    if (isInside(localPath, remotePath) || isInside(remotePath, localPath)) {
      throw new HttpError(400, 'localPath and remotePath must not be the same or nested in each other');
    }
    const conflict = merged.conflict || 'newer';
    if (!CONFLICT_POLICIES.has(conflict)) throw new HttpError(400, 'invalid conflict policy');
    const schedule = String(merged.schedule || '').trim();
    validateCron(cron, schedule);
    const excludes = toExcludeList(merged.excludes) ?? DEFAULT_EXCLUDES.slice();
    return {
      name, mode, localPath, remotePath, conflict, schedule, excludes,
      deleteExtraneous: !!merged.deleteExtraneous,
      enabled: merged.enabled === undefined ? true : !!merged.enabled,
      bwlimit: toNonNegInt(merged.bwlimit, 'bwlimit', 0),
      maxDelete: toNonNegInt(merged.maxDelete, 'maxDelete', DEFAULT_MAX_DELETE),
    };
  }

  async function createJob(body) {
    const fields = sanitize(body);
    const job = {
      id: crypto.randomBytes(6).toString('hex'),
      ...fields,
      createdAt: new Date().toISOString(),
      history: [],
    };
    jobs.push(job);
    schedule(job);
    await persist();
    return view(job);
  }

  async function updateJob(id, body) {
    const job = jobs.find(j => j.id === id);
    if (!job) throw new HttpError(404, 'job not found');
    if (running.has(id)) throw new HttpError(409, 'job is running');
    const fields = sanitize(body, job);
    // Changing paths or mode invalidates the recorded two-way state.
    if (fields.localPath !== job.localPath || fields.remotePath !== job.remotePath || fields.mode !== job.mode) {
      await fsp.rm(path.join(stateDir, `${id}.json`), { force: true });
    }
    Object.assign(job, fields);
    schedule(job);
    await persist();
    return view(job);
  }

  async function deleteJob(id) {
    const idx = jobs.findIndex(j => j.id === id);
    if (idx === -1) throw new HttpError(404, 'job not found');
    if (running.has(id)) throw new HttpError(409, 'job is running');
    const old = timers.get(id);
    if (old) { old.stop(); timers.delete(id); }
    jobs.splice(idx, 1);
    lastLogs.delete(id);
    await fsp.rm(path.join(stateDir, `${id}.json`), { force: true });
    await fsp.rm(path.join(conflictDir, id), { recursive: true, force: true });
    await persist();
  }

  function listJobs() { return jobs.map(view); }
  function getLog(id) {
    const ctl = running.get(id);
    return ctl ? ctl.log : (lastLogs.get(id) || []);
  }

  function cancel(id) {
    const ctl = running.get(id);
    if (!ctl) throw new HttpError(409, 'job is not running');
    ctl.cancelled = true;
    if (ctl.child) ctl.child.kill('SIGTERM');
  }

  // ── run ────────────────────────────────────────────────────

  async function startRun(id, { dryRun = false, force = false, trigger = 'manual' } = {}) {
    const job = jobs.find(j => j.id === id);
    if (!job) throw new HttpError(404, 'job not found');
    if (running.has(id)) throw new HttpError(409, 'job is already running');

    const ctl = {
      runId: crypto.randomBytes(4).toString('hex'),
      cancelled: false, child: null, progress: null, log: [], lastProgressAt: 0,
    };
    running.set(id, ctl);
    lastLogs.set(id, ctl.log);

    ctl.say = (msg, level = 'info') => {
      const line = { ts: Date.now(), level, msg };
      ctl.log.push(line);
      if (ctl.log.length > LOG_MAX) ctl.log.splice(0, ctl.log.length - LOG_MAX);
      emit({ event: 'log', jobId: id, ...line });
    };
    ctl.setProgress = (p, force2 = false) => {
      ctl.progress = p;
      const t = Date.now();
      if (!force2 && t - ctl.lastProgressAt < 250) return;
      ctl.lastProgressAt = t;
      emit({ event: 'progress', jobId: id, progress: p });
    };

    emit({ event: 'status', jobId: id, state: 'running' });
    ctl.say(`${dryRun ? '[dry-run] ' : ''}start ${job.mode} (${trigger}): ${job.localPath} <-> ${job.remotePath}`);

    const done = (async () => {
      const run = {
        runId: ctl.runId, trigger, dryRun, mode: job.mode,
        startedAt: new Date().toISOString(), status: 'failed',
        up: 0, down: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, bytes: 0,
      };
      try {
        await assertReady(job);
        const result = job.mode === 'bisync'
          ? await runBisync(job, ctl, { dryRun, force })
          : await runOneWay(job, ctl, { dryRun, force });
        Object.assign(run, result);
        run.status = ctl.cancelled ? 'cancelled' : (result.partial ? 'partial' : 'success');
      } catch (e) {
        run.status = ctl.cancelled || e.message === 'cancelled' ? 'cancelled' : 'failed';
        run.error = e.message;
        if (e.safety) run.safetyAbort = true;
        ctl.say(run.status === 'cancelled' ? 'cancelled' : `error: ${e.message}`, 'error');
      } finally {
        run.endedAt = new Date().toISOString();
        running.delete(id);
        if (!dryRun) {
          job.lastRun = run;
          job.history = [run, ...(job.history || [])].slice(0, HISTORY_MAX);
          await persist();
        }
        ctl.say(`finished: ${run.status}`, run.status === 'success' ? 'info' : 'warn');
        emit({ event: 'status', jobId: id, state: run.status, run });
      }
      return run;
    })();

    return { runId: ctl.runId, done };
  }

  async function assertReady(job) {
    const local = path.resolve(job.localPath);
    const remote = path.resolve(job.remotePath);
    for (const [p, what] of [[local, 'local'], [remote, 'remote']]) {
      let st;
      try { st = await fsp.stat(p); } catch (e) { throw new Error(`${what} path ${p} is not accessible: ${e.code || e.message}`); }
      if (!st.isDirectory()) throw new Error(`${what} path ${p} is not a directory`);
    }
    let mounts;
    try { mounts = await getMounts(); } catch (e) { throw new Error(`cannot read mount list: ${e.message}`); }
    const owner = mounts
      .filter(m => m.mountPath && isInside(path.resolve(m.mountPath), remote))
      .sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
    if (!owner) throw new Error(`remote path ${remote} is not inside any RaiDrive mount point`);
    if (!/^(connected|mounted)$/i.test(owner.state || '')) {
      throw new Error(`mount "${owner.label}" is ${owner.state || 'unknown'}, not Connected`);
    }
  }

  function safetyError(msg) {
    const e = new Error(`[safety] ${msg} (use "force run" to override)`);
    e.safety = true;
    return e;
  }

  // rsync wrapper. Resolves with the exit code; progress lines are parsed live.
  function runRsync(args, ctl, phase, onName) {
    return new Promise((resolve, reject) => {
      const child = spawn(rsyncBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      ctl.child = child;
      let buf = '';
      let errTail = '';
      const onData = chunk => {
        buf += chunk.toString();
        const parts = buf.split(/[\r\n]+/);
        buf = parts.pop();
        for (const line of parts) handleLine(line);
      };
      const handleLine = line => {
        const m = line.match(/^\s*([\d,]+)\s+(\d+)%\s+(\S+)\s+(\S+)/);
        if (m) {
          ctl.setProgress({ phase, bytes: Number(m[1].replace(/,/g, '')), pct: Number(m[2]), rate: m[3], eta: m[4] });
        } else if (line.trim() && !/^(sending|receiving|building|sent |total size|created directory)/.test(line)) {
          if (onName) onName(line.trim());
          ctl.say(line.trim());
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', c => {
        errTail = (errTail + c.toString()).slice(-2000);
        onData(c);
      });
      child.on('error', e => reject(new Error(e.code === 'ENOENT' ? `${rsyncBin} not found in PATH` : e.message)));
      child.on('close', (code, signal) => {
        if (buf.trim()) handleLine(buf);
        ctl.child = null;
        ctl.setProgress(null, true);
        resolve({ code: signal ? 143 : code, errTail });
      });
    });
  }

  function baseRsyncArgs(job, destIsRemote, dryRun) {
    const args = ['-lt', '--no-perms', '--no-owner', '--no-group',
      `--modify-window=${MTIME_WINDOW}`, '--info=progress2,name1', '--no-inc-recursive'];
    // Renaming temp files on cloud FUSE mounts is slow or unsupported; write in place there.
    args.push(destIsRemote ? '--inplace' : '--partial');
    if (job.bwlimit) args.push(`--bwlimit=${job.bwlimit}`);
    if (dryRun) args.push('-n');
    return args;
  }

  const withSlash = p => p.replace(/\/+$/, '') + '/';

  function interpretRsyncExit(res, ctl) {
    if (ctl.cancelled) throw new Error('cancelled');
    if (res.code === 0) return false;
    if (res.code === 24) { ctl.say('some source files vanished during transfer', 'warn'); return false; }
    if (res.code === 23 || res.code === 25) {
      if (res.code === 25) throw safetyError('rsync stopped: delete limit (maxDelete) reached');
      ctl.say('some files could not be transferred (rsync exit 23)', 'warn');
      return true;
    }
    throw new Error(`rsync exited with code ${res.code}: ${res.errTail.trim().split('\n').pop() || 'no output'}`);
  }

  async function runOneWay(job, ctl, { dryRun, force }) {
    const push = job.mode === 'push';
    const src = path.resolve(push ? job.localPath : job.remotePath);
    const dst = path.resolve(push ? job.remotePath : job.localPath);
    const args = ['-r', ...baseRsyncArgs(job, push, dryRun)];
    for (const p of job.excludes || []) args.push(`--exclude=${p}`);
    if (job.deleteExtraneous) {
      // An empty/unreadable source (e.g. a dropped mount) would otherwise wipe the destination.
      const probe = await fsp.readdir(src);
      if (!probe.length && !force) throw safetyError(`source ${src} is empty; refusing to delete from destination`);
      args.push('--delete');
      if (!force && job.maxDelete) args.push(`--max-delete=${job.maxDelete}`);
    }
    args.push(withSlash(src), withSlash(dst));
    ctl.say(`rsync ${args.join(' ')}`);

    let deleted = 0, files = 0;
    const onName = line => {
      if (line.startsWith('deleting ')) deleted++;
      else if (!line.endsWith('/')) files++; // directories are listed with a trailing slash
    };
    const partial = interpretRsyncExit(await runRsync(args, ctl, push ? 'upload' : 'download', onName), ctl);
    return {
      up: push ? files : 0, down: push ? 0 : files,
      deletedLocal: push ? 0 : deleted, deletedRemote: push ? deleted : 0,
      partial,
    };
  }

  async function loadState(id) {
    try {
      const obj = JSON.parse(await fsp.readFile(path.join(stateDir, `${id}.json`), 'utf8'));
      return new Map(Object.entries(obj.files || {}));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw new Error(`cannot read sync state: ${e.message}`);
    }
  }

  async function saveState(id, map) {
    await fsp.mkdir(stateDir, { recursive: true });
    const file = path.join(stateDir, `${id}.json`);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ savedAt: new Date().toISOString(), files: Object.fromEntries(map) }));
    await fsp.rename(tmp, file);
  }

  async function transferList(job, ctl, list, from, to, toRemote) {
    if (!list.length) return false;
    await fsp.mkdir(tmpDir, { recursive: true });
    const listFile = path.join(tmpDir, `${ctl.runId}-${toRemote ? 'up' : 'down'}.lst`);
    await fsp.writeFile(listFile, list.join('\0') + '\0');
    try {
      const args = [...baseRsyncArgs(job, toRemote, false), `--files-from=${listFile}`, '--from0', withSlash(from), withSlash(to)];
      ctl.say(`${toRemote ? 'upload' : 'download'} ${list.length} file(s)`);
      return interpretRsyncExit(await runRsync(args, ctl, toRemote ? 'upload' : 'download'), ctl);
    } finally {
      await fsp.rm(listFile, { force: true });
    }
  }

  async function runBisync(job, ctl, { dryRun, force }) {
    const local = path.resolve(job.localPath);
    const remote = path.resolve(job.remotePath);
    const excluded = buildExcluder(job.excludes);

    ctl.say('scanning local...');
    const L = await scanTree(local, excluded, ctl);
    ctl.say(`local: ${L.entries.size} entries`);
    ctl.say('scanning remote...');
    const R = await scanTree(remote, excluded, ctl);
    ctl.say(`remote: ${R.entries.size} entries`);
    for (const s of [...L.skipped, ...R.skipped].slice(0, 20)) ctl.say(`skipped (symlink/special): ${s}`, 'warn');

    const prev = await loadState(job.id);
    const P = prev || new Map();
    if (!prev) ctl.say('no previous state: first run, nothing will be deleted');

    // Canary: a side that was populated and is now empty is far more likely a dropped
    // mount or wrong path than a deliberate wipe.
    const trackedFiles = [...P.values()].filter(e => e.t === 'f').length;
    if (!force && trackedFiles > 0) {
      for (const [side, scan, other] of [['local', L, R], ['remote', R, L]]) {
        if (!scan.entries.size && other.entries.size) {
          throw safetyError(`${side} side is empty but ${trackedFiles} files were tracked at last sync`);
        }
      }
    }

    const plan = planBisync(L.entries, R.entries, P, { conflict: job.conflict });
    for (const i of plan.issues) ctl.say(i, 'warn');

    const deletions = plan.delLocal.length + plan.delRemote.length;
    ctl.say(`plan: upload ${plan.toRemote.length}, download ${plan.toLocal.length}, ` +
      `delete local ${plan.delLocal.length}, delete remote ${plan.delRemote.length}, conflicts ${plan.conflicts.length}`);
    if (!force) {
      if (job.maxDelete && deletions > job.maxDelete) {
        throw safetyError(`${deletions} deletions planned, above the limit of ${job.maxDelete}`);
      }
      if (deletions >= 10 && deletions > trackedFiles * 0.5) {
        throw safetyError(`${deletions} deletions planned, more than half of the ${trackedFiles} tracked files`);
      }
    }

    const summary = {
      up: plan.toRemote.length, down: plan.toLocal.length,
      deletedLocal: plan.delLocal.length, deletedRemote: plan.delRemote.length,
      conflicts: plan.conflicts.length, bytes: plan.bytes, partial: false,
    };

    if (dryRun) {
      const show = (label, arr) => arr.slice(0, 200).forEach(r => ctl.say(`${label} ${r}`));
      show('would upload  ', plan.toRemote);
      show('would download', plan.toLocal);
      show('would delete local ', plan.delLocal);
      show('would delete remote', plan.delRemote);
      plan.conflicts.forEach(c => ctl.say(`conflict ${c.rel}: ${c.winner} wins`, 'warn'));
      return summary;
    }

    // Back up the losing side of every conflict before it is overwritten.
    if (plan.conflicts.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = path.join(conflictDir, job.id, stamp);
      for (const c of plan.conflicts) {
        const loserRoot = c.winner === 'local' ? remote : local;
        const dest = path.join(dir, c.winner === 'local' ? 'remote' : 'local', c.rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(path.join(loserRoot, c.rel), dest);
        ctl.say(`conflict ${c.rel}: ${c.winner} wins, other copy saved to ${dest}`, 'warn');
      }
    }

    for (const d of plan.mkdirRemote) await fsp.mkdir(path.join(remote, d), { recursive: true });
    for (const d of plan.mkdirLocal) await fsp.mkdir(path.join(local, d), { recursive: true });

    let partial = false;
    partial = (await transferList(job, ctl, plan.toRemote, local, remote, true)) || partial;
    partial = (await transferList(job, ctl, plan.toLocal, remote, local, false)) || partial;

    const failedDeletes = new Set();
    for (const [list, root] of [[plan.delLocal, local], [plan.delRemote, remote]]) {
      for (const rel of list) {
        if (ctl.cancelled) throw new Error('cancelled');
        try {
          await fsp.rm(path.join(root, rel), { force: true });
          ctl.say(`deleted ${root === local ? 'local' : 'remote'} ${rel}`);
        } catch (e) {
          failedDeletes.add(rel); partial = true;
          ctl.say(`cannot delete ${rel}: ${e.code || e.message}`, 'warn');
        }
      }
    }
    // Deepest first; a directory that still holds new files is simply left alone.
    const depth = s => s.split('/').length;
    for (const [list, root] of [[plan.rmdirLocal, local], [plan.rmdirRemote, remote]]) {
      for (const rel of [...list].sort((a, b) => depth(b) - depth(a))) {
        try { await fsp.rmdir(path.join(root, rel)); } catch { /* not empty or already gone */ }
      }
    }

    // Record the new agreed state. Only paths verified identical on both sides are
    // recorded; anything else keeps its old entry (or none) so it is retried next run.
    const next = new Map(plan.keep);
    const touched = [...plan.toRemote, ...plan.toLocal, ...plan.mkdirLocal, ...plan.mkdirRemote];
    for (const rel of touched) {
      const [l, r] = await Promise.all([statEntry(path.join(local, rel)), statEntry(path.join(remote, rel))]);
      if (l && r && l.t === r.t && (l.t === 'd' || same(l, r))) next.set(rel, l);
      else { partial = true; if (P.has(rel)) next.set(rel, P.get(rel)); }
    }
    for (const rel of failedDeletes) if (P.has(rel)) next.set(rel, P.get(rel));
    await saveState(job.id, next);

    summary.partial = partial;
    return summary;
  }

  async function statEntry(p) {
    try {
      const st = await fsp.lstat(p);
      if (st.isDirectory()) return { t: 'd', size: 0, mtime: 0 };
      if (st.isFile()) return { t: 'f', size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
      return null;
    } catch { return null; }
  }

  function registerRoutes(app) {
    const wrap = fn => async (req, res) => {
      try {
        res.json({ ok: true, ...(await fn(req)) });
      } catch (e) {
        res.status(e.status || 500).json({ ok: false, output: e.message });
      }
    };
    app.get('/api/sync/jobs', wrap(async () => ({ jobs: listJobs(), cron: !!cron })));
    app.post('/api/sync/jobs', wrap(async req => ({ job: await createJob(req.body) })));
    app.put('/api/sync/jobs/:id', wrap(async req => ({ job: await updateJob(req.params.id, req.body) })));
    app.delete('/api/sync/jobs/:id', wrap(async req => { await deleteJob(req.params.id); return {}; }));
    app.post('/api/sync/jobs/:id/run', wrap(async req => {
      const { dryRun, force } = req.body || {};
      const { runId, done } = await startRun(req.params.id, { dryRun: !!dryRun, force: !!force });
      done.catch(() => {});
      return { runId };
    }));
    app.post('/api/sync/jobs/:id/cancel', wrap(async req => { cancel(req.params.id); return {}; }));
    app.get('/api/sync/jobs/:id/log', wrap(async req => ({ log: getLog(req.params.id) })));
  }

  return { init, listJobs, createJob, updateJob, deleteJob, startRun, cancel, getLog, registerRoutes };
}

module.exports = {
  createSyncManager, HttpError,
  _internal: { scanTree, planBisync, buildExcluder, same, isInside },
};
