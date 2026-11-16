'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { createSyncManager, _internal } = require('../sync');

const T0 = 1_700_000_000; // fixed mtime base (seconds)

async function setup(mountState = 'Connected') {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'rdsync-'));
  const local = path.join(base, 'local');
  const remote = path.join(base, 'mnt', 'cloud', 'dir');
  await fsp.mkdir(local, { recursive: true });
  await fsp.mkdir(remote, { recursive: true });
  const mgr = createSyncManager({
    dataDir: path.join(base, 'data'),
    broadcast: () => {},
    getMounts: async () => [{ label: 'cloud', mountPath: path.join(base, 'mnt', 'cloud'), state: mountState }],
  });
  await mgr.init();
  return { base, local, remote, mgr };
}

async function put(root, rel, content, mtime = T0) {
  const p = path.join(root, rel);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content);
  await fsp.utimes(p, mtime, mtime);
}
const read = (root, rel) => fsp.readFile(path.join(root, rel), 'utf8');
const exists = p => fsp.access(p).then(() => true, () => false);

async function run(mgr, job, opts) {
  const { done } = await mgr.startRun(job.id, opts);
  return done;
}

async function mkJob(ctx, extra = {}) {
  return ctx.mgr.createJob({ name: 't', mode: 'bisync', localPath: ctx.local, remotePath: ctx.remote, ...extra });
}

test('planBisync: classifies changes against last state', () => {
  const f = (size, mtime) => ({ t: 'f', size, mtime });
  const L = new Map([['a', f(1, 100)], ['b', f(2, 200)], ['c', f(3, 100)], ['new', f(4, 100)], ['conf', f(5, 300)]]);
  const R = new Map([['a', f(1, 100)], ['b', f(2, 100)], ['d', f(6, 100)], ['conf', f(7, 400)]]);
  const P = new Map([['a', f(1, 100)], ['b', f(2, 100)], ['c', f(3, 100)], ['d', f(6, 100)], ['conf', f(5, 100)], ['gone', f(1, 1)]]);
  const plan = _internal.planBisync(L, R, P, { conflict: 'newer' });
  assert.deepEqual(plan.toRemote.sort(), ['b', 'new']);
  assert.deepEqual(plan.toLocal, ['conf']); // remote is newer
  assert.deepEqual(plan.delLocal, ['c']);   // deleted remotely, untouched locally
  assert.deepEqual(plan.delRemote, ['d']);  // deleted locally, untouched remotely
  assert.equal(plan.conflicts.length, 1);
});

test('planBisync: modify beats delete', () => {
  const f = (size, mtime) => ({ t: 'f', size, mtime });
  const plan = _internal.planBisync(new Map([['x', f(9, 500)]]), new Map(), new Map([['x', f(1, 100)]]));
  assert.deepEqual(plan.toRemote, ['x']);
  assert.equal(plan.delLocal.length, 0);
});

test('excluder: name patterns match at any depth, anchored ones do not', () => {
  const ex = _internal.buildExcluder(['*.tmp', '/top.txt', 'a/*.log']);
  assert.ok(ex('x.tmp') && ex('d/e/x.tmp'));
  assert.ok(ex('top.txt') && !ex('d/top.txt'));
  assert.ok(ex('a/x.log') && !ex('b/a/x.log'));
});

test('bisync: first run unions both sides and never deletes', async () => {
  const c = await setup();
  await put(c.local, 'only-local.txt', 'L');
  await put(c.remote, 'sub/only-remote.txt', 'R');
  const job = await mkJob(c);
  const r = await run(c.mgr, job);
  assert.equal(r.status, 'success', r.error);
  assert.equal(await read(c.remote, 'only-local.txt'), 'L');
  assert.equal(await read(c.local, 'sub/only-remote.txt'), 'R');
});

test('bisync: edits, new files and deletions propagate after first run', async () => {
  const c = await setup();
  await put(c.local, 'edit.txt', 'v1');
  await put(c.local, 'del-local.txt', 'x');
  await put(c.local, 'del-remote.txt', 'y');
  const job = await mkJob(c);
  assert.equal((await run(c.mgr, job)).status, 'success');

  await put(c.local, 'edit.txt', 'v2-longer', T0 + 100);
  await fsp.rm(path.join(c.local, 'del-local.txt'));
  await fsp.rm(path.join(c.remote, 'del-remote.txt'));
  await put(c.remote, 'fresh.txt', 'new-remote', T0 + 100);

  const r = await run(c.mgr, job);
  assert.equal(r.status, 'success', r.error);
  assert.equal(await read(c.remote, 'edit.txt'), 'v2-longer');
  assert.equal(await exists(path.join(c.remote, 'del-local.txt')), false);
  assert.equal(await exists(path.join(c.local, 'del-remote.txt')), false);
  assert.equal(await read(c.local, 'fresh.txt'), 'new-remote');

  // Settled: a further run does nothing.
  const again = await run(c.mgr, job);
  assert.equal(again.up + again.down + again.deletedLocal + again.deletedRemote, 0);
});

test('bisync: conflict keeps the newer file and backs up the loser', async () => {
  const c = await setup();
  await put(c.local, 'doc.txt', 'base');
  const job = await mkJob(c);
  await run(c.mgr, job);

  await put(c.local, 'doc.txt', 'local-edit', T0 + 50);
  await put(c.remote, 'doc.txt', 'remote-edit-longer', T0 + 500);
  const r = await run(c.mgr, job);
  assert.equal(r.status, 'success', r.error);
  assert.equal(r.conflicts, 1);
  assert.equal(await read(c.local, 'doc.txt'), 'remote-edit-longer');
  const backups = await fsp.readdir(path.join(c.base, 'data', 'sync-conflicts', job.id), { recursive: true });
  assert.ok(backups.some(p => p.endsWith('doc.txt')));
});

test('bisync: refuses mass deletion and an emptied side unless forced', async () => {
  const c = await setup();
  for (let i = 0; i < 20; i++) await put(c.local, `f${i}.txt`, String(i));
  const job = await mkJob(c);
  assert.equal((await run(c.mgr, job)).status, 'success');

  // Simulate a dropped mount: remote suddenly empty.
  for (const n of await fsp.readdir(c.remote)) await fsp.rm(path.join(c.remote, n), { recursive: true });
  const blocked = await run(c.mgr, job);
  assert.equal(blocked.status, 'failed');
  assert.ok(blocked.safetyAbort);
  assert.equal((await fsp.readdir(c.local)).length, 20, 'local files must survive');

  const forced = await run(c.mgr, job, { force: true });
  assert.equal(forced.status, 'success', forced.error);
});

test('bisync: dry run changes nothing', async () => {
  const c = await setup();
  await put(c.local, 'a.txt', 'a');
  const job = await mkJob(c);
  const r = await run(c.mgr, job, { dryRun: true });
  assert.equal(r.status, 'success');
  assert.equal(r.up, 1);
  assert.equal(await exists(path.join(c.remote, 'a.txt')), false);
});

test('bisync: excluded files are ignored on both sides', async () => {
  const c = await setup();
  await put(c.local, 'keep.txt', 'k');
  await put(c.local, 'skip.tmp', 's');
  const job = await mkJob(c);
  await run(c.mgr, job);
  assert.equal(await exists(path.join(c.remote, 'keep.txt')), true);
  assert.equal(await exists(path.join(c.remote, 'skip.tmp')), false);
});

test('bisync: file names with newlines and spaces survive', async () => {
  const c = await setup();
  await put(c.local, 'we ird\nname.txt', 'ok');
  const job = await mkJob(c);
  const r = await run(c.mgr, job);
  assert.equal(r.status, 'success', r.error);
  assert.equal(await read(c.remote, 'we ird\nname.txt'), 'ok');
});

test('refuses to run when the mount is not Connected', async () => {
  const c = await setup('Disconnected');
  await put(c.local, 'a.txt', 'a');
  const job = await mkJob(c);
  const r = await run(c.mgr, job);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /not Connected/);
});

test('refuses a remote path outside every mount', async () => {
  const c = await setup();
  const other = path.join(c.base, 'elsewhere');
  await fsp.mkdir(other);
  const job = await c.mgr.createJob({ name: 'x', mode: 'push', localPath: c.local, remotePath: other });
  const r = await run(c.mgr, job);
  assert.equal(r.status, 'failed');
  assert.match(r.error, /not inside any RaiDrive mount/);
});

test('push with --delete mirrors; empty source is refused', async () => {
  const c = await setup();
  await put(c.local, 'a.txt', 'a');
  await put(c.remote, 'stale.txt', 's');
  const job = await mkJob(c, { mode: 'push', deleteExtraneous: true });
  const r = await run(c.mgr, job);
  assert.equal(r.status, 'success', r.error);
  assert.equal(await exists(path.join(c.remote, 'stale.txt')), false);
  assert.equal(r.deletedRemote, 1);

  await fsp.rm(path.join(c.local, 'a.txt'));
  const blocked = await run(c.mgr, job);
  assert.equal(blocked.status, 'failed');
  assert.ok(blocked.safetyAbort);
  assert.equal(await read(c.remote, 'a.txt'), 'a');
});

test('pull copies mount -> local', async () => {
  const c = await setup();
  await put(c.remote, 'x/y.txt', 'y');
  const job = await mkJob(c, { mode: 'pull' });
  const r = await run(c.mgr, job);
  assert.equal(r.status, 'success', r.error);
  assert.equal(await read(c.local, 'x/y.txt'), 'y');
});

test('job validation rejects relative and nested paths', async () => {
  const c = await setup();
  await assert.rejects(c.mgr.createJob({ name: 'x', localPath: 'rel', remotePath: c.remote }), /absolute/);
  await assert.rejects(c.mgr.createJob({ name: 'x', localPath: c.local, remotePath: path.join(c.local, 'in') }), /nested/);
  await assert.rejects(c.mgr.createJob({ name: 'x', localPath: '/', remotePath: c.remote }), /root/);
});
