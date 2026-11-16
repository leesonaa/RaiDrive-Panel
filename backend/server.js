const express = require('express');
const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createSyncManager } = require('./sync');
const { createFsApi, defaultRoots, defaultDetect } = require('./fs-api');

let cron = null;
try { cron = require('node-cron'); } catch { /* scheduling disabled */ }

const app = express();
const PORT = process.env.PORT || 3030;

// Optional HTTP Basic auth. The panel can read, write and delete files, so set
// PANEL_USER and PANEL_PASSWORD whenever the port is reachable by anyone else.
if (process.env.PANEL_USER && process.env.PANEL_PASSWORD) {
  const sha = s => crypto.createHash('sha256').update(String(s)).digest();
  const wantUser = sha(process.env.PANEL_USER);
  const wantPass = sha(process.env.PANEL_PASSWORD);
  app.use((req, res, next) => {
    const m = (req.headers.authorization || '').match(/^Basic (.+)$/i);
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString();
      const i = decoded.indexOf(':');
      const user = i === -1 ? decoded : decoded.slice(0, i);
      const pass = i === -1 ? '' : decoded.slice(i + 1);
      if (crypto.timingSafeEqual(sha(user), wantUser) & crypto.timingSafeEqual(sha(pass), wantPass)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="RaiDrive Panel"').status(401).send('Authentication required');
  });
}

app.use(express.json());
// Docker layout puts frontend/ next to server.js; a repo checkout has it one level up.
const FRONTEND_DIR = [path.join(__dirname, 'frontend'), path.join(__dirname, '..', 'frontend')]
  .find(d => fs.existsSync(path.join(d, 'index.html'))) || path.join(__dirname, 'frontend');
app.use(express.static(FRONTEND_DIR));

// SSE clients for log streaming
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

function runCli(args, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const cliEnv = { ...process.env, COLUMNS: '320', LINES: '200', TERM: 'dumb', NO_COLOR: '1' };
    if (Array.isArray(args)) {
      const cmd = `raidrivecli ${args.map(a => JSON.stringify(a)).join(' ')}`;
      execFile('raidrivecli', args, { timeout: 30000, env: cliEnv }, (err, stdout, stderr) => {
        const output = (stdout + stderr).trim();
        if (!quiet) broadcast({ type: 'cmd', cmd, output, ok: !err });
        resolve({ ok: !err, output, code: err?.code });
      });
      return;
    }

    const cmd = `raidrivecli ${args}`;
    exec(cmd, { timeout: 30000, env: cliEnv }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      broadcast({ type: 'cmd', cmd, output, ok: !err });
      resolve({ ok: !err, output, code: err?.code });
    });
  });
}

function pushOpt(args, name, value) {
  if (value === undefined || value === null || value === '') return;
  args.push(`${name}=${value}`);
}

// ── GET /api/status ─────────────────────────────────────────
// Output format:
//   Version : 2024.8.15
//   Filesystem driver : fuse 3.16.2(316)
//   Subscription : RaiDrive/Professional/...
//   Total mountpoints : 1
app.get('/api/status', async (req, res) => {
  const result = await runCli('status');
  // Parse into key-value map for frontend
  const kv = {};
  for (const line of result.output.split('\n')) {
    const m = line.match(/^(.+?)\s*:\s*(.+)$/);
    if (m) kv[m[1].trim()] = m[2].trim();
  }
  res.json({ ...result, parsed: kv });
});

// ── GET /api/list ─────────────────────────────────────────
// raidrivecli list --long output (real format from docs):
//   id                                 label   storage   state       local path   remote                  user      created
//  ────────────────────────────────────────────────────────────────────────────────────────────────────────────
//   42c0037ff3b1429a9cbbc4956d821413   sftp    SFTP      Connected   /mnt/sfpt   sftp://192.168.200.40   user1   08/08/2024 16:45:42
app.get('/api/list', async (req, res) => {
  const { connected, storage, sort } = req.query;
  const args = ['list'];
  if (connected === 'true') args.push('--mounted');
  if (storage) args.push('--storage', String(storage));
  if (sort) args.push('--sort', String(sort));

  const result = await runCli(args);
  const mounts = parseList(result.output);
  res.json({ ...result, mounts });
});

function normalizeState(state) {
  if (!state) return '';
  const s = String(state).trim();
  if (/^mounted$/i.test(s)) return 'Connected';
  if (/^(unmounted|disconnected)$/i.test(s)) return 'Disconnected';
  if (/^connecting$/i.test(s)) return 'Connecting';
  if (/^disconnecting$/i.test(s)) return 'Disconnecting';
  return s;
}

function parseList(output) {
  const lines = output.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('label') && lower.includes('state')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const header = lines[headerIdx].toLowerCase();
  const fields = [
    { key: 'label', aliases: ['label'] },
    { key: 'mountPath', aliases: ['mount path', 'local path'] },
    { key: 'remote', aliases: ['remote address', 'remote'] },
    { key: 'state', aliases: ['state'] },
  ];

  const positions = [];
  for (const field of fields) {
    let idx = -1;
    for (const alias of field.aliases) {
      idx = header.indexOf(alias);
      if (idx !== -1) break;
    }
    if (idx !== -1) positions.push({ key: field.key, start: idx });
  }
  positions.sort((a, b) => a.start - b.start);
  if (!positions.length) return [];

  const dataLines = [];
  let dataStart = headerIdx + 1;
  while (dataStart < lines.length && /^[\s─\-]+$/.test(lines[dataStart])) dataStart++;
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^total\s+mountpoints\s*:/i.test(line.trim())) continue;
    if (/^no\s+mountpoints?/i.test(line.trim())) continue;
    dataLines.push(line);
  }

  const STATE_SET = new Set(['Connected', 'Disconnected', 'Connecting', 'Disconnecting', 'Mounted', 'Unmounted']);
  const statePos = positions.find(p => p.key === 'state')?.start ?? 0;
  const logicalRows = [];
  let current = [];

  for (const line of dataLines) {
    const stateCell = line.slice(statePos, statePos + 24).trim();
    const looksLikeRowStart = STATE_SET.has(stateCell) || (!current.length && /\S/.test(line));
    if (looksLikeRowStart) {
      if (current.length) logicalRows.push(current);
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) logicalRows.push(current);

  function mergePart(base, part, key) {
    if (!part) return base;
    if (!base) return part;
    const noSpaceKeys = new Set(['mountPath', 'remote']);
    if (noSpaceKeys.has(key)) return base + part;
    if (/^[,./:-]/.test(part) || /[,./:-]$/.test(base)) return base + part;
    return `${base} ${part}`;
  }

  const mounts = [];
  for (const group of logicalRows) {
    const entry = {};
    for (let j = 0; j < positions.length; j++) {
      const start = positions[j].start;
      const end = j + 1 < positions.length ? positions[j + 1].start : undefined;
      const key = positions[j].key;
      let value = '';
      for (const row of group) {
        const part = (end ? row.slice(start, end) : row.slice(start)).trim();
        value = mergePart(value, part, key);
      }
      entry[key] = value.trim();
    }

    if (!entry.label) continue;
    entry.state = normalizeState(entry.state);
    mounts.push(entry);
  }

  return mounts;
}

function parseLongList(output) {
  const lines = output.split('\n');
  // Find header line (contains 'label' and 'storage')
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/\blabel\b/.test(lines[i]) && /\bstorage\b/.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) return [];

  const header = lines[headerIdx];
  // Compute column start positions from header.
  // Newer raidrivecli uses "mount path / remote address / remote user".
  const cols = [
    { key: 'id', aliases: ['id'] },
    { key: 'label', aliases: ['label'] },
    { key: 'storage', aliases: ['storage'] },
    { key: 'state', aliases: ['state'] },
    { key: 'mountPath', aliases: ['mount path', 'local path'] },
    { key: 'remote', aliases: ['remote address', 'remote'] },
    { key: 'user', aliases: ['remote user', 'user'] },
    { key: 'created', aliases: ['created'] },
  ];

  const positions = [];
  const lowerHeader = header.toLowerCase();
  for (const col of cols) {
    let idx = -1;
    for (const name of col.aliases) {
      idx = lowerHeader.indexOf(name);
      if (idx !== -1) break;
    }
    if (idx !== -1) positions.push({ key: col.key, start: idx });
  }
  positions.sort((a, b) => a.start - b.start);

  const mounts = [];
  const STATE_SET = new Set(['Connected', 'Disconnected', 'Connecting', 'Disconnecting', 'Mounted', 'Unmounted']);
  // Data lines start after the separator line (────)
  let dataStart = headerIdx + 1;
  while (dataStart < lines.length && /^[\s─\-]+$/.test(lines[dataStart])) dataStart++;

  const rowLines = [];
  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^total\s+mountpoints\s*:/i.test(line.trim())) continue;
    if (/^no\s+mountpoints?/i.test(line.trim())) continue;
    rowLines.push(line);
  }

  const idPos = positions.find(p => p.key === 'id')?.start ?? 0;
  const statePos = positions.find(p => p.key === 'state')?.start ?? 0;
  const logicalRows = [];
  let current = [];

  for (const line of rowLines) {
    const idCell = line.slice(idPos, idPos + 40).trim();
    const stateCell = line.slice(statePos, statePos + 24).trim();
    const hasStateMarker = STATE_SET.has(stateCell);
    const looksLikeRowStart = hasStateMarker || (!current.length && /^[0-9a-f]{6,}$/i.test(idCell));

    if (looksLikeRowStart) {
      if (current.length) {
        logicalRows.push(current);
      }
      current = [line];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) logicalRows.push(current);

  function mergePart(base, part, key) {
    if (!part) return base;
    if (!base) return part;
    const noSpaceKeys = new Set(['id', 'mountPath', 'remote', 'created']);
    if (noSpaceKeys.has(key)) return base + part;
    if (/^[,./:-]/.test(part) || /[,./:-]$/.test(base)) return base + part;
    return `${base} ${part}`;
  }

  for (const group of logicalRows) {
    const entry = {};
    for (let j = 0; j < positions.length; j++) {
      const start = positions[j].start;
      const end = j + 1 < positions.length ? positions[j + 1].start : undefined;
      const key = positions[j].key;
      let value = '';

      for (const rowLine of group) {
        const part = (end ? rowLine.slice(start, end) : rowLine.slice(start)).trim();
        value = mergePart(value, part, key);
      }

      entry[key] = value.trim();
    }

    // Normalize common wrapped datetime format: 06/27/202603:27:45 -> 06/27/2026 03:27:45
    if (entry.created) {
      entry.created = entry.created.replace(
        /(\d{2}\/\d{2}\/\d{4})(\d{2}:\d{2}:\d{2})/,
        '$1 $2'
      );
    }

    if (!entry.label) continue;
    if (entry.state && !STATE_SET.has(entry.state)) {
      const m = entry.state.match(/Connected|Disconnected|Connecting|Disconnecting|Mounted|Unmounted/i);
      if (m) {
        entry.state = m[0];
      } else {
        continue;
      }
    }
    entry.state = normalizeState(entry.state);
    mounts.push(entry);
  }

  return mounts;
}

// ── GET /api/show/:label ─────────────────────────────────
// Output: [Basic Configurations] block + [SFTP/WebDAV/... Configurations] block
// Each line: "description (--flag): value"
app.get('/api/show/:label', async (req, res) => {
  // Array form: the label is user input and must never reach a shell.
  const result = await runCli(['show', req.params.label]);
  // Parse into structured sections
  const sections = {};
  let currentSection = 'General';
  for (const line of result.output.split('\n')) {
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) { currentSection = sectionMatch[1]; sections[currentSection] = {}; continue; }
    const kvMatch = line.match(/^(.+?)\s*\(([^)]+)\)\s*:\s*(.*)$/);
    if (kvMatch) {
      if (!sections[currentSection]) sections[currentSection] = {};
      sections[currentSection][kvMatch[1].trim()] = { flag: kvMatch[2].trim(), value: kvMatch[3].trim() };
    }
  }
  res.json({ ...result, sections });
});

// ── POST /api/add ─────────────────────────────────────────
// Handles all service types with correct argument patterns
app.post('/api/add', async (req, res) => {
  const {
    service, label, mountPath, readOnly, publicAccess,
    bandwidthDown, bandwidthUp,
    // Protocol services (sftp/ftp/webdav)
    address, username, password, privateKeyFile,
    altAddress, charset, tls, httpTimeout,
    // S3-compatible services (s3/minio/aws/cloudflare/backblaze/...)
    bucket, endpoint, accessKeyId, secretAccessKey,
    region,
  } = req.body;

  if (!service) return res.status(400).json({ ok: false, output: 'service is required' });

  const PROTOCOL_SERVICES = ['sftp', 'ftp', 'webdav'];
  const S3_SERVICES = ['s3', 'minio', 'aws', 'cloudflare', 'backblaze', 'digitalocean',
                       'alibaba', 'azure', 'gcp', 'ibm', 'idrive', 'wasabi', 'oracle',
                       'tencent', 'ncp', 'nhn', 'cloudian'];

  const args = ['add', service];

  if (PROTOCOL_SERVICES.includes(service)) {
    // Pattern: raidrivecli add sftp sftp://user@host/path [options]
    if (!address) return res.status(400).json({ ok: false, output: 'address is required for ' + service });
    args.push(address);
    pushOpt(args, '--username', username);
    // Use --password=<value> to avoid raidrivecli treating @xxx as response file.
    pushOpt(args, '--password', password);
    pushOpt(args, '--private-key-file', privateKeyFile);
    pushOpt(args, '--alt-address', altAddress);
    pushOpt(args, '--charset', charset);
    pushOpt(args, '--tls', tls);
    pushOpt(args, '--http-timeout', httpTimeout);
    // FTP-specific
    if (service === 'ftp' && req.body.transferPassive === false) args.push('--no-transfer-passive');
  } else if (S3_SERVICES.includes(service)) {
    // Pattern: raidrivecli add s3 --bucket <b> --endpoint <url> --access-key-id <k>
    pushOpt(args, '--bucket', bucket);
    pushOpt(args, '--endpoint', endpoint);
    pushOpt(args, '--access-key-id', accessKeyId);
    pushOpt(args, '--secret-access-key', secretAccessKey);
    pushOpt(args, '--region', region);
  }
  // OAuth services (googledrive, onedrive, etc.) — just: raidrivecli add googledrive
  // Will trigger browser auth which may fail in headless Docker

  // Common options
  pushOpt(args, '--label', label);
  pushOpt(args, '--mount-path', mountPath);
  if (readOnly) args.push('--read-only');
  if (publicAccess) args.push('--public');
  pushOpt(args, '--bandwidth-download', bandwidthDown);
  pushOpt(args, '--bandwidth-upload', bandwidthUp);

  const result = await runCli(args);
  res.json(result);
});

// ── POST /api/mount ──────────────────────────────────────
app.post('/api/mount', async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ ok: false, output: 'label is required' });
  const r = await runCli(['mount', label]);
  invalidateMounts();
  res.json(r);
});

// ── POST /api/unmount ────────────────────────────────────
app.post('/api/unmount', async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ ok: false, output: 'label is required' });
  const r = await runCli(['unmount', label, '-y']);
  invalidateMounts();
  res.json(r);
});

// ── DELETE /api/remove ───────────────────────────────────
app.delete('/api/remove', async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ ok: false, output: 'label is required' });

  // Try direct remove first. If it fails because mounted/in-use, unmount then retry.
  let result = await runCli(['remove', label, '-y']);
  if (!result.ok) {
    const out = (result.output || '').toLowerCase();
    if (/mounted|in use|busy|disconnect|unmount/.test(out)) {
      const unmountResult = await runCli(['unmount', label, '-y']);
      const removeRetry = await runCli(['remove', label, '-y']);
      result = {
        ok: removeRetry.ok,
        code: removeRetry.code,
        output: [
          '[remove] first attempt failed',
          result.output || '',
          '',
          '[unmount] auto unmount result',
          unmountResult.output || '',
          '',
          '[remove] retry result',
          removeRetry.output || '',
        ].join('\n').trim(),
      };
    }
  }

  res.json(result);
});

// ── POST /api/signin / signout ───────────────────────────
app.post('/api/signin',  async (req, res) => res.json(await runCli('signin')));
app.post('/api/signout', async (req, res) => res.json(await runCli('signout')));

// ── GET /api/logs (SSE) ──────────────────────────────────
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'connected', msg: 'Log stream connected' })}\n\n`);

  const logDir = '/var/log/raidrive';
  let tailProc = null;
  if (fs.existsSync(logDir)) {
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
    if (files.length) {
      tailProc = spawn('tail', ['-f', '-n', '50', path.join(logDir, files[0])]);
      tailProc.stdout.on('data', d =>
        res.write(`data: ${JSON.stringify({ type: 'log', msg: d.toString() })}\n\n`));
    }
  }

  req.on('close', () => { sseClients.delete(res); tailProc?.kill(); });
});

// ── GET /api/daemon-logs ─────────────────────────────────
app.get('/api/daemon-logs', (req, res) => {
  const logDir = '/var/log/raidrive';
  try {
    if (!fs.existsSync(logDir)) return res.json({ ok: true, output: 'No log directory' });
    const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log')).sort().reverse();
    if (!files.length) return res.json({ ok: true, output: 'No log files' });
    const content = fs.readFileSync(path.join(logDir, files[0]), 'utf8');
    res.json({ ok: true, output: content.split('\n').slice(-200).join('\n') });
  } catch(e) {
    res.json({ ok: false, output: e.message });
  }
});

// ── File manager (see fs-api.js) ─────────────────────────
let mountsCache = { t: 0, v: null };
async function getMountsCached() {
  if (mountsCache.v && Date.now() - mountsCache.t < 3000) return mountsCache.v;
  const r = await runCli(['list'], { quiet: true });
  if (!r.ok) throw new Error(r.output || 'raidrivecli list failed');
  mountsCache = { t: Date.now(), v: parseList(r.output) };
  return mountsCache.v;
}
const invalidateMounts = () => { mountsCache.t = 0; };
// An explicit FS_ROOTS is a strict allowlist; without it, volumes mapped into the container are detected.
createFsApi({
  broadcast, getMounts: getMountsCached, roots: defaultRoots(),
  detect: process.env.FS_ROOTS ? null : defaultDetect,
}).registerRoutes(app);

// ── File sync (see sync.js) ──────────────────────────────
const sync = createSyncManager({
  dataDir: process.env.SYNC_DATA_DIR || '/etc/raidrive/panel',
  broadcast,
  cron,
  getMounts: async () => {
    const r = await runCli(['list']);
    if (!r.ok) throw new Error(r.output || 'raidrivecli list failed');
    return parseList(r.output);
  },
});
sync.registerRoutes(app);

sync.init()
  .catch(e => console.error('[sync] init failed:', e.message))
  .finally(() => app.listen(PORT, () => console.log(`RaiDrive Panel on :${PORT}`)));
