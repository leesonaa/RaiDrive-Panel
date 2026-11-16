'use strict';
// Shared rsync process runner: parses `--info=progress2,name1` output live.

const { spawn } = require('child_process');

const PROGRESS_RE = /^\s*([\d,]+)\s+(\d+)%\s+(\S+)\s+(\S+)/;
const NOISE_RE = /^(sending|receiving|building|sent |total size|created directory)/;

// Resolves {code, errTail}; code is 143 when killed by a signal.
function runRsync(bin, args, { onProgress, onLine, onChild, onClose } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (onChild) onChild(child);
    let buf = '';
    let errTail = '';

    const handleLine = line => {
      const m = line.match(PROGRESS_RE);
      if (m) {
        if (onProgress) onProgress({ bytes: Number(m[1].replace(/,/g, '')), pct: Number(m[2]), rate: m[3], eta: m[4] });
      } else if (line.trim() && !NOISE_RE.test(line)) {
        if (onLine) onLine(line.trim());
      }
    };
    const onData = chunk => {
      buf += chunk.toString();
      const parts = buf.split(/[\r\n]+/);
      buf = parts.pop();
      for (const line of parts) handleLine(line);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', c => {
      errTail = (errTail + c.toString()).slice(-2000);
      onData(c);
    });
    child.on('error', e => reject(new Error(e.code === 'ENOENT' ? `${bin} not found in PATH` : e.message)));
    child.on('close', (code, signal) => {
      if (buf.trim()) handleLine(buf);
      if (onClose) onClose();
      resolve({ code: signal ? 143 : code, errTail });
    });
  });
}

module.exports = { runRsync };
