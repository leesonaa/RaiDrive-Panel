const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3030;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// SSE clients for log streaming
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => res.write(msg));
}

function runCli(args) {
  return new Promise((resolve) => {
    const cmd = `raidrivecli ${args}`;
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      const output = (stdout + stderr).trim();
      broadcast({ type: 'cmd', cmd, output, ok: !err });
      resolve({ ok: !err, output, code: err?.code });
    });
  });
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
  let args = 'list --long';
  if (connected === 'true') args += ' --connected';
  if (storage) args += ` --storage ${storage}`;
  if (sort)    args += ` --sort ${sort}`;

  const result = await runCli(args);
  const mounts = parseLongList(result.output);
  res.json({ ...result, mounts });
});

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
  // Compute column start positions from header
  const cols = ['id', 'label', 'storage', 'state', 'local path', 'remote', 'user', 'created'];
  const positions = [];
  for (const col of cols) {
    const idx = header.toLowerCase().indexOf(col);
    if (idx !== -1) positions.push({ col, start: idx });
  }
  positions.sort((a, b) => a.start - b.start);

  const mounts = [];
  // Data lines start after the separator line (────)
  let dataStart = headerIdx + 1;
  while (dataStart < lines.length && /^[\s─\-]+$/.test(lines[dataStart])) dataStart++;

  for (let i = dataStart; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const entry = {};
    for (let j = 0; j < positions.length; j++) {
      const start = positions[j].start;
      const end   = j + 1 < positions.length ? positions[j + 1].start : undefined;
      entry[positions[j].col] = (end ? line.slice(start, end) : line.slice(start)).trim();
    }
    if (entry.label) mounts.push(entry);
  }
  return mounts;
}

// ── GET /api/show/:label ─────────────────────────────────
// Output: [Basic Configurations] block + [SFTP/WebDAV/... Configurations] block
// Each line: "description (--flag): value"
app.get('/api/show/:label', async (req, res) => {
  const result = await runCli(`show "${req.params.label}"`);
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
    altAddress, charset, tls,
    // S3-compatible services (s3/minio/aws/cloudflare/backblaze/...)
    bucket, endpoint, accessKeyId, secretAccessKey,
    region,
  } = req.body;

  if (!service) return res.status(400).json({ ok: false, output: 'service is required' });

  const PROTOCOL_SERVICES = ['sftp', 'ftp', 'webdav'];
  const S3_SERVICES = ['s3', 'minio', 'aws', 'cloudflare', 'backblaze', 'digitalocean',
                       'alibaba', 'azure', 'gcp', 'ibm', 'idrive', 'wasabi', 'oracle',
                       'tencent', 'ncp', 'nhn', 'cloudian'];

  let args = `add ${service}`;

  if (PROTOCOL_SERVICES.includes(service)) {
    // Pattern: raidrivecli add sftp sftp://user@host/path [options]
    if (!address) return res.status(400).json({ ok: false, output: 'address is required for ' + service });
    args += ` ${address}`;
    if (username)      args += ` -u "${username}"`;
    if (password)      args += ` -p "${password}"`;
    if (privateKeyFile) args += ` --private-key-file "${privateKeyFile}"`;
    if (altAddress)    args += ` --alt-address "${altAddress}"`;
    if (charset)       args += ` --charset ${charset}`;
    if (tls)           args += ` --tls ${tls}`;
    // FTP-specific
    if (service === 'ftp' && req.body.transferPassive === false) args += ' --no-transfer-passive';
  } else if (S3_SERVICES.includes(service)) {
    // Pattern: raidrivecli add s3 --bucket <b> --endpoint <url> --access-key-id <k>
    if (bucket)         args += ` --bucket "${bucket}"`;
    if (endpoint)       args += ` --endpoint "${endpoint}"`;
    if (accessKeyId)    args += ` --access-key-id "${accessKeyId}"`;
    if (secretAccessKey) args += ` --secret-access-key "${secretAccessKey}"`;
    if (region)         args += ` --region "${region}"`;
  }
  // OAuth services (googledrive, onedrive, etc.) — just: raidrivecli add googledrive
  // Will trigger browser auth which may fail in headless Docker

  // Common options
  if (label)         args += ` --label "${label}"`;
  if (mountPath)     args += ` --mount-path "${mountPath}"`;
  if (readOnly)      args += ' --read-only';
  if (publicAccess)  args += ' --public';
  if (bandwidthDown) args += ` --bandwidth-download ${bandwidthDown}`;
  if (bandwidthUp)   args += ` --bandwidth-upload ${bandwidthUp}`;

  const result = await runCli(args);
  res.json(result);
});

// ── POST /api/mount ──────────────────────────────────────
app.post('/api/mount', async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ ok: false, output: 'label is required' });
  res.json(await runCli(`mount "${label}"`));
});

// ── POST /api/unmount ────────────────────────────────────
app.post('/api/unmount', async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ ok: false, output: 'label is required' });
  res.json(await runCli(`unmount "${label}"`));
});

// ── DELETE /api/remove ───────────────────────────────────
app.delete('/api/remove', async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ ok: false, output: 'label is required' });
  res.json(await runCli(`remove "${label}"`));
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

app.listen(PORT, () => console.log(`RaiDrive Panel on :${PORT}`));
