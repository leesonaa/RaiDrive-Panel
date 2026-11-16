'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { createFsApi } = require('../fs-api');

async function setup(state = 'Connected') {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'rdfs-')));
  const local = path.join(base, 'data');
  const mount = path.join(base, 'mnt', 'cloud');
  const outside = path.join(base, 'outside');
  for (const d of [local, mount, outside]) await fsp.mkdir(d, { recursive: true });
  const events = [];
  const api = createFsApi({
    roots: [local],
    broadcast: e => events.push(e),
    getMounts: async () => [{ label: 'cloud', mountPath: mount, state }],
  });
  return { base, local, mount, outside, api, events };
}

const put = async (p, c = 'x', mtime) => {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, c);
  if (mtime) await fsp.utimes(p, mtime, mtime);
};
const read = p => fsp.readFile(p, 'utf8');
const exists = p => fsp.access(p).then(() => true, () => false);
const xfer = async (api, body) => { const r = await api.startTransfer(body); return { ...r, result: await r.done }; };

test('roots: mounts and existing dirs, with sensible defaults', async () => {
  const c = await setup();
  const r = await c.api.getRoots();
  assert.deepEqual(r.roots.map(x => x.kind).sort(), ['dir', 'mount']);
  assert.equal(r.defaults.local, c.local);
  assert.equal(r.defaults.remote, c.mount);
});

test('list: entries with type/size and parent confined to roots', async () => {
  const c = await setup();
  await put(path.join(c.local, 'a.txt'), 'hello');
  await fsp.mkdir(path.join(c.local, 'sub'));
  const r = await c.api.listDir(c.local);
  const byName = Object.fromEntries(r.entries.map(e => [e.name, e]));
  assert.equal(byName['a.txt'].type, 'file');
  assert.equal(byName['a.txt'].size, 5);
  assert.equal(byName['sub'].type, 'dir');
  assert.equal(r.parent, null, 'a root has no navigable parent');
  assert.equal((await c.api.listDir(path.join(c.local, 'sub'))).parent, c.local);
});

test('list: refuses paths outside roots, .. tricks and symlink escapes', async () => {
  const c = await setup();
  await put(path.join(c.outside, 'secret.txt'), 's');
  await fsp.symlink(c.outside, path.join(c.local, 'escape'));
  await assert.rejects(c.api.listDir(c.outside), /outside the allowed roots/);
  await assert.rejects(c.api.listDir(path.join(c.local, '..', 'outside')), /outside the allowed roots/);
  await assert.rejects(c.api.listDir(path.join(c.local, 'escape')), /resolves outside/);
  await assert.rejects(c.api.listDir('relative/path'), /absolute/);
  await assert.rejects(c.api.listDir('/etc'), /outside/);
});

test('list: a Disconnected mount is refused instead of shown empty', async () => {
  const c = await setup('Disconnected');
  await assert.rejects(c.api.listDir(c.mount), /not Connected/);
});

test('copy: file and directory into a mount, source kept', async () => {
  const c = await setup();
  await put(path.join(c.local, 'f.txt'), 'file');
  await put(path.join(c.local, 'dir', 'inner', 'g.txt'), 'inner');
  const { result } = await xfer(c.api, { sources: [path.join(c.local, 'f.txt'), path.join(c.local, 'dir')], destDir: c.mount });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(await read(path.join(c.mount, 'f.txt')), 'file');
  assert.equal(await read(path.join(c.mount, 'dir', 'inner', 'g.txt')), 'inner');
  assert.ok(await exists(path.join(c.local, 'f.txt')));
});

test('move: source removed afterwards, including emptied directories', async () => {
  const c = await setup();
  await put(path.join(c.local, 'dir', 'a', 'x.txt'), 'x');
  await put(path.join(c.local, 'm.txt'), 'm');
  const { result } = await xfer(c.api, { op: 'move', sources: [path.join(c.local, 'dir'), path.join(c.local, 'm.txt')], destDir: c.mount });
  assert.equal(result.status, 'success', JSON.stringify(result));
  assert.equal(await read(path.join(c.mount, 'dir', 'a', 'x.txt')), 'x');
  assert.equal(await exists(path.join(c.local, 'dir')), false);
  assert.equal(await exists(path.join(c.local, 'm.txt')), false);
});

test('conflict: 409 with the names, then skip / overwrite / rename', async () => {
  const c = await setup();
  const src = path.join(c.local, 'doc.txt');
  await put(src, 'new-content', 2000000000);
  await put(path.join(c.mount, 'doc.txt'), 'old', 1600000000);

  await assert.rejects(c.api.startTransfer({ sources: [src], destDir: c.mount }), e => {
    assert.equal(e.status, 409);
    assert.deepEqual(e.conflicts, ['doc.txt']);
    return true;
  });

  const skipped = await xfer(c.api, { sources: [src], destDir: c.mount, onConflict: 'skip' });
  assert.equal(skipped.count, 0);
  assert.equal(await read(path.join(c.mount, 'doc.txt')), 'old');

  const renamed = await xfer(c.api, { sources: [src], destDir: c.mount, onConflict: 'rename' });
  assert.equal(renamed.result.status, 'success');
  assert.equal(await read(path.join(c.mount, 'doc (1).txt')), 'new-content');
  assert.equal(await read(path.join(c.mount, 'doc.txt')), 'old');

  const over = await xfer(c.api, { sources: [src], destDir: c.mount, onConflict: 'overwrite' });
  assert.equal(over.result.status, 'success');
  assert.equal(await read(path.join(c.mount, 'doc.txt')), 'new-content');
});

test('conflict: overwrite never swaps a file for a folder', async () => {
  const c = await setup();
  await put(path.join(c.local, 'thing'), 'i am a file');
  await put(path.join(c.mount, 'thing', 'keep.txt'), 'keep');
  const { result } = await xfer(c.api, { sources: [path.join(c.local, 'thing')], destDir: c.mount, onConflict: 'overwrite' });
  assert.equal(result.status, 'failed');
  assert.equal(await read(path.join(c.mount, 'thing', 'keep.txt')), 'keep');
});

test('copy into the same folder offers rename, and a folder cannot go into itself', async () => {
  const c = await setup();
  await put(path.join(c.local, 'a.txt'), 'a');
  await put(path.join(c.local, 'dir', 'x.txt'), 'x');
  const r = await xfer(c.api, { sources: [path.join(c.local, 'a.txt')], destDir: c.local, onConflict: 'rename' });
  assert.equal(r.result.status, 'success');
  assert.equal(await read(path.join(c.local, 'a (1).txt')), 'a');
  await assert.rejects(c.api.startTransfer({ sources: [path.join(c.local, 'dir')], destDir: path.join(c.local, 'dir') }), /into itself/);
  await assert.rejects(c.api.startTransfer({ op: 'move', sources: [path.join(c.local, 'a.txt')], destDir: c.local }), /already in the destination/);
});

test('transfer: validates op, escapes, roots and disconnected mounts', async () => {
  const c = await setup();
  await put(path.join(c.local, 'a.txt'), 'a');
  await put(path.join(c.outside, 'o.txt'), 'o');
  await assert.rejects(c.api.startTransfer({ op: 'zap', sources: [path.join(c.local, 'a.txt')], destDir: c.mount }), /op must be/);
  await assert.rejects(c.api.startTransfer({ sources: [path.join(c.outside, 'o.txt')], destDir: c.mount }), /outside/);
  await assert.rejects(c.api.startTransfer({ sources: [path.join(c.local, 'a.txt')], destDir: c.outside }), /outside/);
  await assert.rejects(c.api.startTransfer({ sources: [c.local], destDir: c.mount }), /root/);
  const down = await setup('Disconnected');
  await put(path.join(down.local, 'a.txt'), 'a');
  await assert.rejects(down.api.startTransfer({ sources: [path.join(down.local, 'a.txt')], destDir: down.mount }), /not Connected/);
});

test('transfer emits start, progress and done events', async () => {
  const c = await setup();
  await put(path.join(c.local, 'a.txt'), 'a'.repeat(1000));
  const { id, result } = await xfer(c.api, { sources: [path.join(c.local, 'a.txt')], destDir: c.mount });
  const mine = c.events.filter(e => e.type === 'xfer' && e.id === id).map(e => e.event);
  assert.equal(mine[0], 'start');
  assert.equal(mine[mine.length - 1], 'done');
  assert.equal(result.totalBytes, 1000);
});

test('mkdir, rename and delete respect roots and existing names', async () => {
  const c = await setup();
  await c.api.mkdir(path.join(c.local, 'new'));
  await assert.rejects(c.api.mkdir(path.join(c.local, 'new')), /cannot create/);
  await put(path.join(c.local, 'a.txt'), 'a');
  await put(path.join(c.local, 'b.txt'), 'b');
  await assert.rejects(c.api.rename(path.join(c.local, 'a.txt'), 'b.txt'), /already exists/);
  await assert.rejects(c.api.rename(path.join(c.local, 'a.txt'), '../evil'), /invalid file name/);
  await c.api.rename(path.join(c.local, 'a.txt'), 'c.txt');
  assert.ok(await exists(path.join(c.local, 'c.txt')));
  await assert.rejects(c.api.remove([c.local]), /cannot delete a root/);
  await assert.rejects(c.api.remove([path.join(c.outside, 'x')]), /outside/);
  const r = await c.api.remove([path.join(c.local, 'c.txt'), path.join(c.local, 'new')]);
  assert.equal(r.deleted, 2);
  assert.equal(await exists(path.join(c.local, 'c.txt')), false);
});

test('detectVolumes: mapped volumes yes, container system paths no', () => {
  const { detectVolumes } = require('../fs-api');
  const info = [
    '1 0 0:50 / / rw - overlay overlay rw',
    '2 1 0:5 / /proc rw - proc proc rw',
    '3 1 0:6 / /dev rw - tmpfs tmpfs rw',
    '4 1 8:1 /disk1/raidrive /mnt rw shared:1 - ext4 /dev/sda1 rw',
    '5 1 8:2 /moviedata /mnt2 rw shared:2 - xfs /dev/sdb1 rw',
    '6 1 8:1 /appdata/config /etc/raidrive rw - ext4 /dev/sda1 rw',
    '7 1 8:1 /appdata/logs /var/log/raidrive rw - ext4 /dev/sda1 rw',
    '8 1 8:1 /x/hosts /etc/hosts rw - ext4 /dev/sda1 rw',
    '9 1 8:3 /my\\040files /data/my\\040files rw - btrfs /dev/sdc1 rw',
    '10 1 0:60 / /mnt/cloud rw - fuse.raidrive raidrive rw',
  ].join('\n');
  assert.deepEqual(detectVolumes(info).sort(), ['/data/my files', '/mnt', '/mnt/cloud', '/mnt2']);
});

test('detected volumes are browsable; the error names the allowed roots', async () => {
  const c = await setup();
  const extra = path.join(c.base, 'mnt2');
  await fsp.mkdir(extra);
  await put(path.join(extra, 'movie.mkv'), 'm');
  const plain = createFsApi({ roots: [c.local], broadcast() {}, getMounts: async () => [] });
  await assert.rejects(plain.listDir(extra), e => /outside the allowed roots/.test(e.message) && e.message.includes(c.local));
  const detecting = createFsApi({ roots: [c.local], detect: () => [extra, path.join(c.base, 'not-here')], broadcast() {}, getMounts: async () => [] });
  assert.equal((await detecting.listDir(extra)).entries[0].name, 'movie.mkv');
  const roots = (await detecting.getRoots()).roots.map(r => r.path);
  assert.ok(roots.includes(extra) && !roots.some(p => p.endsWith('not-here')));
});
