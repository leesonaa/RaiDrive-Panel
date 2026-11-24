'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { createUpstream } = require('../upstream');
const { createFsApi } = require('../fs-api');

function fake(handler) {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    const body = JSON.parse(opt.body);
    calls.push({ url, body, auth: opt.headers.Authorization });
    const j = handler(url, body, opt.headers.Authorization);
    return { status: 200, json: async () => j };
  };
  return { calls, fetchImpl };
}
const mount = { label: 'ol', mountPath: '/mnt/ol', remote: 'http://10.0.0.9:5244/dav' };

test('resolve: strips /dav, joins sub path, honours a sub-root remote', () => {
  const u = createUpstream();
  assert.deepEqual(u._resolve({}, mount, ''), { base: 'http://10.0.0.9:5244', apiPath: '/' });
  assert.equal(u._resolve({}, mount, 'a/b').apiPath, '/a/b');
  assert.equal(u._resolve({}, { ...mount, remote: 'http://h:1/dav/movies' }, 'x').apiPath, '/movies/x');
  assert.equal(u._resolve({ url: 'https://ol.example.com' }, mount, '').base, 'https://ol.example.com');
});

test('refresh: logs in once, sends refresh:true, relogs on 401, surfaces errors', async () => {
  let logins = 0, expired = false;
  const f = fake((url, body, auth) => {
    if (url.endsWith('/api/auth/login')) { logins++; return { code: 200, data: { token: 'T' + logins } }; }
    if (expired) { expired = false; return { code: 401, message: 'expired' }; }
    if (body.path === '/bad') return { code: 500, message: 'storage not found' };
    return { code: 200 };
  });
  const u = createUpstream({ fetchImpl: f.fetchImpl });
  assert.deepEqual(await u.refresh(mount, 'x'), { skipped: true });
  await u.set('ol', { username: 'admin', password: 'pw' });
  assert.equal(u.list().ol.hasPassword, true);
  assert.equal(JSON.stringify(u.list()).includes('pw'), false, 'secrets never listed');
  await u.refresh(mount, 'x'); await u.refresh(mount, 'y');
  assert.equal(logins, 1);
  const list = f.calls.filter(c => c.url.endsWith('/api/fs/list'));
  assert.equal(list[0].body.refresh, true);
  assert.equal(list[0].auth, 'T1');
  expired = true;
  await u.refresh(mount, 'z');
  assert.equal(logins, 2);
  await assert.rejects(u.refresh(mount, 'bad'), /storage not found/);
});

test('set: persists with 0600, empty password keeps stored one, validates url', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rdup-'));
  const file = path.join(dir, 'upstream.json');
  const u = createUpstream({ file });
  await assert.rejects(u.set('ol', { url: 'ftp://x' }), /http/);
  await u.set('ol', { username: 'a', password: 'secret', url: 'http://h:5244/' });
  await u.set('ol', { username: 'a', password: '' });
  const u2 = createUpstream({ file }); await u2.init();
  assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).ol.password, 'secret');
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  await u2.remove('ol');
  assert.equal(u2.has('ol'), false);
});

test('file manager: ?refresh calls the upstream for mount paths only, failures do not block listing', async () => {
  const base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'rdup2-')));
  const mnt = path.join(base, 'ol'), local = path.join(base, 'local');
  await fsp.mkdir(path.join(mnt, 'sub'), { recursive: true }); await fsp.mkdir(local);
  const seen = [];
  const upstream = { has: l => l === 'ol', refresh: async (m, rel) => { seen.push(rel); if (rel === 'boom') throw new Error('nope'); return { refreshed: true }; } };
  const api = createFsApi({ roots: [local], upstream, broadcast() {}, getMounts: async () => [{ label: 'ol', mountPath: mnt, state: 'Connected' }] });
  assert.equal((await api.listDir(path.join(mnt, 'sub'))).upstream, undefined);
  assert.deepEqual(seen, []);
  assert.equal((await api.listDir(path.join(mnt, 'sub'), { refresh: true })).upstream.refreshed, true);
  await api.listDir(mnt, { refresh: true });
  await fsp.mkdir(path.join(mnt, 'boom'));
  const r = await api.listDir(path.join(mnt, 'boom'), { refresh: true });
  assert.equal(r.upstream.error, 'nope');
  await api.listDir(local, { refresh: true });
  assert.deepEqual(seen, ['sub', '', 'boom']);
});
