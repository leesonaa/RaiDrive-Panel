'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { createPerms } = require('../perms');
const { createFsApi } = require('../fs-api');

const root = process.getuid && process.getuid() === 0;
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'rdperm-')).then(fsp.realpath);

test('env defaults, validation, ui override persists, reset', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'perms.json');
  const p = createPerms({ file, env: { PUID: '99', PGID: '100', UMASK: '000' }, isRoot: true });
  await p.init();
  assert.deepEqual([p.get().uid, p.get().gid, p.get().source], [99, 100, 'env']);
  assert.deepEqual(p.get().effectiveModes, { dir: '777', file: '666' });
  await assert.rejects(p.set({ uid: -1 }), /uid/);
  await assert.rejects(p.set({ umask: '999' }), /umask/);
  await p.set({ uid: 1000, gid: 1000, umask: '022' });
  const p2 = createPerms({ file, env: {}, isRoot: true });
  await p2.init();
  assert.deepEqual([p2.get().uid, p2.get().source, p2.get().effectiveModes.file], [1000, 'ui', '644']);
  await p2.reset();
  assert.equal(p2.get().enabled, false);
  assert.deepEqual(p2.rsyncArgs(), ['--no-perms', '--no-owner', '--no-group']);
});

test('rsync args: owner flags only for root', () => {
  const a = createPerms({ env: { PUID: '99', PGID: '100', UMASK: '022' }, isRoot: true }).rsyncArgs();
  assert.ok(a.includes('--chown=99:100') && a.includes('--chmod=D755,F644'));
  const b = createPerms({ env: { PUID: '99', PGID: '100' }, isRoot: false }).rsyncArgs();
  assert.ok(!b.some(x => x.startsWith('--chown')) && b.includes('--no-owner'));
});

test('mkdirp applies mode to every directory it creates', async () => {
  const dir = await tmp();
  const p = createPerms({ env: { UMASK: '027' }, isRoot: false });
  await p.mkdirp(path.join(dir, 'a', 'b'));
  assert.equal((await fsp.stat(path.join(dir, 'a', 'b'))).mode & 0o777, 0o750);
  assert.equal((await fsp.stat(path.join(dir, 'a'))).mode & 0o777, 0o750);
});

test('transfer: local destination gets configured owner+mode, mount destination does not', { skip: !root }, async () => {
  const base = await tmp();
  const [src, local, mount] = ['src', 'local', 'mnt/cloud'].map(d => path.join(base, d));
  for (const d of [src, local, mount]) await fsp.mkdir(d, { recursive: true });
  await fsp.mkdir(path.join(src, 'dir'));
  await fsp.writeFile(path.join(src, 'dir', 'f.txt'), 'x');
  await fsp.writeFile(path.join(src, 'a.txt'), 'a');
  const perms = createPerms({ env: { PUID: '99', PGID: '100', UMASK: '000' }, isRoot: true });
  const api = createFsApi({ roots: [src, local], perms, broadcast() {}, getMounts: async () => [{ label: 'c', mountPath: mount, state: 'Connected' }] });
  const run = async body => (await (await api.startTransfer(body)).done);
  assert.equal((await run({ sources: [path.join(src, 'dir'), path.join(src, 'a.txt')], destDir: local })).status, 'success');
  for (const f of ['a.txt', 'dir', 'dir/f.txt']) {
    const st = await fsp.stat(path.join(local, f));
    assert.deepEqual([st.uid, st.gid], [99, 100], f);
  }
  assert.equal((await fsp.stat(path.join(local, 'a.txt'))).mode & 0o777, 0o666);
  assert.equal((await fsp.stat(path.join(local, 'dir'))).mode & 0o777, 0o777);
  await api.mkdir(path.join(local, 'newdir'));
  assert.equal((await fsp.stat(path.join(local, 'newdir'))).uid, 99);
  await run({ sources: [path.join(src, 'a.txt')], destDir: mount });
  assert.equal((await fsp.stat(path.join(mount, 'a.txt'))).uid, 0, 'mount destinations are left alone');
});
