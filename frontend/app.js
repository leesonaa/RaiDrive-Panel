// ── Service classification ────────────────────────────────────
const S3_SVCS     = new Set(['s3','minio','aws','cloudflare','backblaze','digitalocean','wasabi','alibaba','azure','gcp','ibm','idrive','oracle','tencent','ncp','nhn','cloudian']);
const PROTO_SVCS  = new Set(['sftp','ftp','webdav']);
const OAUTH_SVCS  = new Set(['googledrive','onedrive','dropbox','mega','pcloud','yandex','mailru','googlephotos','googleworkspace','onedrivebusiness','sharepoint','box','dropboxbusiness']);

const ICONS = {
  googledrive:'🟡',onedrive:'🔵',dropbox:'🔷',mega:'🔴',pcloud:'🟢',yandex:'🟠',mailru:'✉️',googlephotos:'📷',
  googleworkspace:'🏢',onedrivebusiness:'💼',sharepoint:'📋',dropboxbusiness:'📦',box:'📫',
  aws:'🟨',s3:'☁️',azure:'🔷',gcp:'🌐',cloudflare:'🟠',backblaze:'🅱️',minio:'🟣',wasabi:'💧',digitalocean:'🌊',
  sftp:'🔒',ftp:'📡',webdav:'🔗',
};

// ── Navigation ────────────────────────────────────────────────
function goPage(page) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + page));
  try { history.replaceState(null, '', '#' + page); } catch {}
  const nb = document.querySelector(`.nav-item[data-page="${page}"] span`);
  if (nb) document.getElementById('crumb-now').textContent = nb.textContent;
  window.scrollTo(0, 0);
  if (page === 'dashboard') initDash();
  if (page === 'mounts')    fetchMounts();
  if (page === 'sync')      fetchSync();
  if (page === 'settings')  { fetchPerms(); markTheme(); }
  if (page === 'files' && window.filesInit) filesInit();
}
document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => goPage(btn.dataset.page)));

// ── Theme (auto / light / dark) ───────────────────────────────
const THEME_ICON = {
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
};
const osDark = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(mode) {
  try { localStorage.setItem('theme', mode); } catch {}
  const dark = mode === 'dark' || (mode === 'auto' && osDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.mode = mode;
  document.getElementById('theme-btn').innerHTML = THEME_ICON[dark ? 'dark' : 'light'];
  markTheme();
}
function markTheme() {
  const mode = document.documentElement.dataset.mode || 'auto';
  document.querySelectorAll('[data-theme-mode]').forEach(b => {
    b.classList.toggle('btn-primary', b.dataset.themeMode === mode);
    b.classList.toggle('btn-ghost', b.dataset.themeMode !== mode);
  });
}
document.getElementById('theme-btn').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});
document.querySelectorAll('[data-theme-mode]').forEach(b => b.addEventListener('click', () => applyTheme(b.dataset.themeMode)));
osDark.addEventListener('change', () => { if ((document.documentElement.dataset.mode || 'auto') === 'auto') applyTheme('auto'); });

// ── API ───────────────────────────────────────────────────────
async function api(method, path, body) {
  const r = await fetch('/api' + path, {
    method, headers: {'Content-Type':'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

function isConnectedState(state) {
  const s = String(state || '').toLowerCase();
  return s === 'connected' || s === 'mounted';
}


// ── File permissions ──────────────────────────────────────────
function renderPerms(p) {
  const set = (id, val) => { document.getElementById(id).value = val == null ? '' : val; };
  set('perm-uid', p.uid); set('perm-gid', p.gid); set('perm-umask', p.umask);
  const box = document.getElementById('perm-presets');
  box.innerHTML = '';
  for (const [k, pr] of Object.entries(p.presets || {})) {
    const b = document.createElement('button');
    b.className = 'btn btn-ghost'; b.textContent = pr.label;
    b.onclick = () => { set('perm-uid', pr.uid); set('perm-gid', pr.gid); set('perm-umask', pr.umask); };
    box.appendChild(b);
  }
  const m = p.effectiveModes;
  const src = {env: '来自环境变量 PUID/PGID/UMASK', ui: '来自此处保存的设置', none: '未配置'}[p.source];
  document.getElementById('perm-info').textContent =
    (p.enabled ? `当前生效：属主 ${p.uid ?? '不变'}:${p.gid ?? '不变'}，文件 ${m.file}，文件夹 ${m.dir}（${src}）。` : `当前未启用（${src}）。`) +
    (p.enabled && !p.isRoot ? ' 容器未以 root 运行，无法更改属主，只应用权限位。' : '') +
    ' UMASK 对照：000 得到 666/777，022 得到 644/755，002 得到 664/775。';
}
async function fetchPerms() { try { renderPerms(await api('GET', '/perms')); } catch {} }
async function savePerms() {
  const g = id => document.getElementById(id).value.trim();
  const r = await api('PUT', '/perms', { uid: g('perm-uid'), gid: g('perm-gid'), umask: g('perm-umask') });
  if (r.error) { toast('❌ ' + r.error, true); return; }
  renderPerms(r); toast('✅ 权限设置已保存');
}
async function resetPerms() { renderPerms(await api('DELETE', '/perms')); toast('已恢复默认'); }

// ── Dashboard ─────────────────────────────────────────────────
async function initDash(fresh) {
  const q = fresh === true ? '?fresh=1' : '';
  // Status
  const st = await api('GET', '/status' + q);
  document.getElementById('status-out').textContent = st.output || '(无输出)';
  const dot  = document.getElementById('ddot');
  const dtxt = document.getElementById('dtext');
  if (st.ok) { dot.className='dot green'; dtxt.textContent='守护进程运行中'; }
  else        { dot.className='dot red';   dtxt.textContent='守护进程异常';   }
  if (st.parsed) {
    document.getElementById('s-ver').textContent = st.parsed['Version'] || '—';
  }
  // List
  const ls = await api('GET', '/list' + q);
  const m = ls.mounts || [];
  document.getElementById('s-total').textContent = m.length;
  const conn = m.filter(x => isConnectedState(x.state)).length;
  document.getElementById('s-conn').textContent  = conn;
  document.getElementById('s-disc').textContent  = m.length - conn;
  renderMountList('dash-mounts', m, false);
}

// ── Mounts page ───────────────────────────────────────────────
async function fetchMounts(fresh) {
  const storage = document.getElementById('filter-storage')?.value;
  const qs = [storage ? `storage=${storage}` : '', fresh === true ? 'fresh=1' : ''].filter(Boolean).join('&');
  const url = '/list' + (qs ? '?' + qs : '');
  const ls = await api('GET', url);
  renderMountList('mounts-list', ls.mounts || [], true);
  document.getElementById('detail-panel').style.display = 'none';
}

function renderMountList(targetId, mounts, showDetail) {
  const el = document.getElementById(targetId);
  if (!mounts.length) {
    el.innerHTML = '<div class="empty">还没有挂载点。<button class="link" onclick="goPage(\'add\')">添加存储</button></div>';
    return;
  }
  el.innerHTML = '<div class="mount-head"><span>存储连接</span><span>服务类型</span><span>本地挂载路径</span><span>状态</span><span></span></div>'
    + mounts.map(m => mountCardHTML(m, showDetail)).join('');
}

function tileHTML(svc, m = {}) {
  let cls = PROTO_SVCS.has(svc) ? 'p' : S3_SVCS.has(svc) ? 's' : OAUTH_SVCS.has(svc) ? 'o' : '';
  if (!svc) { const sch = String(m.remote || '').match(/^(\w+):\/\//); svc = sch ? ({ http: 'webdav', https: 'webdav' })[sch[1]] || sch[1] : ''; }
  const cls2 = PROTO_SVCS.has(svc) ? 'p' : cls;
  const txt = ({ googledrive: 'GD', onedrive: 'OD', webdav: 'DAV', sftp: 'SF', ftp: 'FTP', s3: 'S3', minio: 'Mi', dropbox: 'Db' })[svc]
    || (svc || (m.label || '?')).slice(0, 2).toUpperCase();
  return `<div class="mount-icon ${cls2}" aria-hidden="true">${esc(txt)}</div>`;
}

function mountCardHTML(m, showDetail) {
  const svc     = (m.storage || '').toLowerCase();
  const isConn  = isConnectedState(m.state);
  const badge   = isConn
    ? `<span class="badge connected">已连接</span>`
    : `<span class="badge disconnected">未连接</span>`;
  const mountBtn = isConn
    ? `<button class="btn btn-danger btn-sm" onclick="doUnmount('${esc(m.label)}')">卸载</button>`
    : `<button class="btn btn-success btn-sm" onclick="doMount('${esc(m.label)}')">挂载</button>`;
  const moreBtn = showDetail
    ? `<button class="btn btn-ghost btn-sm" onclick="doShow('${esc(m.label)}')">详情</button>
       <button class="btn btn-danger btn-sm" onclick="doRemove('${esc(m.label)}')">删除</button>`
    : '';
  return `<div class="mount-card">
    <div class="mount-main">
      ${tileHTML(svc, m)}
      <div class="mount-info">
        <div class="mount-label">${esc(m.label)}</div>
        <div class="mount-remote" title="${esc(m.remote || '')}">${esc(m.remote || '')}</div>
      </div>
    </div>
    <div class="mount-svc">${esc(m.storage || (String(m.remote || '').match(/^(\w+):\/\//) || [])[1] || '')}</div>
    <div class="mount-path" title="${esc(m.mountPath || '')}">${esc(m.mountPath || '')}</div>
    <div>${badge}</div>
    <div class="mount-actions">${mountBtn}${moreBtn}</div>
  </div>`;
}

async function doMount(label) {
  toast(`挂载 ${label}...`);
  const r = await api('POST', '/mount', {label});
  toast(r.ok ? `✅ ${label} 已挂载` : `❌ ${r.output}`, !r.ok);
  fetchMounts();
}
async function doUnmount(label) {
  toast(`卸载 ${label}...`);
  const r = await api('POST', '/unmount', {label});
  toast(r.ok ? `✅ ${label} 已卸载` : `❌ ${r.output}`, !r.ok);
  fetchMounts();
}
async function doRemove(label) {
  if (!confirm(`确认删除 "${label}"？`)) return;
  const r = await api('DELETE', '/remove', {label});
  toast(r.ok ? `🗑️ ${label} 已删除` : `❌ ${r.output}`, !r.ok);
  fetchMounts();
}
async function doShow(label) {
  const r = await api('GET', `/show/${encodeURIComponent(label)}`);
  const panel = document.getElementById('detail-panel');
  document.getElementById('detail-label').textContent = label;
  const body = document.getElementById('detail-body');
  if (!r.ok || !r.sections || !Object.keys(r.sections).length) {
    body.innerHTML = `<div class="terminal">${esc(r.output)}</div>`;
  } else {
    body.innerHTML = Object.entries(r.sections).map(([sec, rows]) => `
      <div class="detail-section">
        <div class="detail-section-title">${esc(sec)}</div>
        ${Object.entries(rows).map(([k, v]) => `
          <div class="detail-row">
            <div class="detail-key">${esc(k)}</div>
            <div class="detail-flag">${esc(v.flag)}</div>
            <div class="detail-val ${v.value.includes('***') ? 'masked' : ''}">${esc(v.value || '—')}</div>
          </div>`).join('')}
      </div>`).join('');
  }
  panel.style.display = 'block';
  panel.scrollIntoView({behavior:'smooth'});
}

// ── Add form ──────────────────────────────────────────────────
function onSvcChange() {
  const svc = document.getElementById('add-service').value;
  document.querySelectorAll('.service-group').forEach(g => g.classList.remove('active'));
  if (PROTO_SVCS.has(svc))  document.getElementById('grp-protocol').classList.add('active');
  if (S3_SVCS.has(svc))     document.getElementById('grp-s3').classList.add('active');
  if (OAUTH_SVCS.has(svc))  document.getElementById('grp-oauth').classList.add('active');
  // SFTP-specific extras
  document.getElementById('sftp-extra').style.display   = svc === 'sftp' ? 'block' : 'none';
  document.getElementById('webdav-extra').style.display = (svc === 'webdav' || svc === 'ftp') ? 'block' : 'none';
}

async function doAdd() {
  const btn = document.getElementById('btn-add');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 添加中...';
  const svc = document.getElementById('add-service').value;

  const body = {
    service:       svc,
    label:         v('add-label'),
    mountPath:     v('add-mountpath'),
    readOnly:      document.getElementById('add-readonly').checked,
    publicAccess:  document.getElementById('add-public').checked,
    bandwidthDown: v('add-bwdown') || null,
    bandwidthUp:   v('add-bwup')   || null,
  };
  if (PROTO_SVCS.has(svc)) {
    body.address  = v('add-address');
    body.username = v('add-username');
    body.password = v('add-password');
    body.altAddress = v('add-alt');
    body.charset  = v('add-charset');
    body.tls      = v('add-tls');
    body.httpTimeout = v('add-timeout');
    body.privateKeyFile = v('add-keyfile');
  }
  if (S3_SVCS.has(svc)) {
    body.bucket          = v('add-bucket');
    body.endpoint        = v('add-endpoint');
    body.accessKeyId     = v('add-akid');
    body.secretAccessKey = v('add-sak');
    body.region          = v('add-region');
  }

  const r = await api('POST', '/add', body);
  document.getElementById('add-result').style.display = 'block';
  const out = document.getElementById('add-out');
  out.textContent = r.output || '(无输出)';
  out.className   = 'terminal' + (r.ok ? '' : '');
  toast(r.ok ? '✅ 存储添加成功' : '❌ 添加失败，查看结果', !r.ok);
  btn.disabled = false;
  btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg> 添加并挂载';
}

function v(id) { return document.getElementById(id)?.value?.trim() || ''; }

// ── Signin ────────────────────────────────────────────────────
async function doSignin() {
  const r = await api('POST', '/signin');
  document.getElementById('signin-terminal').textContent = r.output;
  document.getElementById('signin-out').style.display = 'block';
  toast(r.ok ? '✅ 已发起登录' : '⚠️ ' + r.output, !r.ok);
}
async function doSignout() {
  const r = await api('POST', '/signout');
  document.getElementById('signin-terminal').textContent = r.output;
  document.getElementById('signin-out').style.display = 'block';
  toast(r.ok ? '✅ 已退出' : '⚠️ ' + r.output, !r.ok);
}

// ── Logs ──────────────────────────────────────────────────────
const logbox = document.getElementById('logbox');
const LV = { debug: 0, info: 1, warn: 2, warning: 2, error: 3, err: 3, fatal: 3, critical: 3 };
const LV_LABEL = { 0: '调试', 1: '信息', 2: '警告', 3: '错误' };
const LOG_MAX = 1500;
// Daemon chatter: every raidrivecli call connects/logs in/disconnects from the daemon.
const NOISE_RE = /CLIENT (CONNECTED|DISCONNECTED|LOGIN SUCCESS)/i;
const hhmmss = d => d.toTimeString().slice(0, 8);

function logRow({ time, level = 1, src = '', kind = 'sys', noise = false, html, text }) {
  const d = document.createElement('div');
  d.className = `lg lv-${['debug','info','warn','error'][level]} k-${kind}` + (noise ? ' noise' : '');
  d.dataset.lv = level; d.dataset.kind = kind;
  d.innerHTML = `<span class="t">${esc(time || hhmmss(new Date()))}</span><span class="lv">${LV_LABEL[level]}</span><span class="src">${esc(src)}</span><span class="m"></span>`;
  const m = d.querySelector('.m');
  if (html) m.innerHTML = html; else m.textContent = text;
  d.dataset.text = (m.textContent || '').toLowerCase();
  logbox.appendChild(d);
  while (logbox.childElementCount > LOG_MAX) logbox.firstChild.remove();
  if (!matchLog(d)) d.classList.add('hide');
  if (document.getElementById('lg-follow').checked) logbox.scrollTop = logbox.scrollHeight;
  updateLogCount();
}
function appendLog(cls, txt) { logRow({ text: txt, kind: 'sys', level: cls === 'err-line' ? 3 : 1 }); } // legacy helper

// "[06:32:02] 2026-11-24 06:32:02.004 [INFO] CS : CLIENT CONNECTED : 8 : 1/10"
const DAEMON_RE = /^(?:\[\d\d:\d\d:\d\d\]\s*)?(?:\d{4}-\d\d-\d\d\s+)?(\d\d:\d\d:\d\d)(?:\.\d+)?\s*\[(\w+)\]\s*(.*)$/;
function addDaemonLine(line) {
  line = line.replace(/\r/g, '').trim();
  if (!line) return;
  const m = line.match(DAEMON_RE);
  if (!m) { logRow({ text: line, kind: 'daemon', level: /error|fail/i.test(line) ? 3 : 1, src: '守护进程' }); return; }
  let [, time, lvl, rest] = m;
  const level = LV[lvl.toLowerCase()] ?? 1;
  let src = '守护进程';
  const sm = rest.match(/^([A-Za-z][\w.]*)\s*:\s+(.*)$/);
  if (sm) { src = sm[1]; rest = sm[2]; }
  rest = rest.replace(/\s*:\s*$/, '').replace(/\s+:\s+/g, ' · ');
  logRow({ time, level, src, kind: 'daemon', text: rest, noise: NOISE_RE.test(line) });
}
function addCmdEntry(d) {
  const lines = (d.output || '').split('\n').filter(l => l.trim());
  const body = lines.length
    ? `<details${d.ok ? '' : ' open'}><summary><span class="cmdc">${esc(d.cmd)}</span> <span class="${d.ok ? 'okb' : 'badb'}">${d.ok ? '✓ 成功' : '✗ 失败'}</span> <span style="color:var(--muted)">${lines.length > 1 ? `(${lines.length} 行输出)` : ''}</span>${lines.length === 1 && d.ok ? ' — ' + esc(lines[0]) : ''}</summary>${lines.length > 1 || !d.ok ? `<pre>${esc(d.output)}</pre>` : ''}</details>`
    : `<span class="cmdc">${esc(d.cmd)}</span> <span class="${d.ok ? 'okb' : 'badb'}">${d.ok ? '✓ 成功' : '✗ 失败'}</span>`;
  logRow({ kind: 'cmd', src: '面板命令', level: d.ok ? 1 : 3, html: body });
  // the summary text is searchable too
}
function matchLog(d) {
  if (+d.dataset.lv < +document.getElementById('lg-level').value) return false;
  const k = document.getElementById('lg-kind').value;
  if (k && d.dataset.kind !== k) return false;
  const q = document.getElementById('lg-q').value.trim().toLowerCase();
  return !q || d.dataset.text.includes(q);
}
function applyLogFilter() {
  logbox.classList.toggle('no-noise', !document.getElementById('lg-noise').checked);
  for (const d of logbox.children) d.classList.toggle('hide', !matchLog(d));
  updateLogCount();
}
function updateLogCount() {
  const showNoise = document.getElementById('lg-noise').checked;
  let shown = 0, hiddenNoise = 0;
  for (const d of logbox.children) {
    if (d.classList.contains('hide')) continue;
    if (d.classList.contains('noise') && !showNoise) { hiddenNoise++; continue; }
    shown++;
  }
  document.getElementById('lg-cnt').textContent = `${shown} 条` + (hiddenNoise ? ` · 已隐藏 ${hiddenNoise} 条连接记录` : '');
}
function clearLog() { logbox.innerHTML = ''; logRow({ kind: 'sys', text: '日志已清空' }); }
async function loadDaemonLog() {
  const r = await api('GET', '/daemon-logs');
  logRow({ kind: 'sys', text: '──── 以下为守护进程日志(最近 200 行)────' });
  r.output.split('\n').forEach(addDaemonLine);
}
logRow({ kind: 'sys', text: '等待日志…' });
const es = new EventSource('/api/logs');
es.onmessage = e => {
  const d = JSON.parse(e.data);
  if (d.type === 'cmd') addCmdEntry(d);
  if (d.type === 'log') d.msg.split('\n').forEach(addDaemonLine);
  if (d.type === 'sync') onSyncEvent(d);
  if (d.type === 'xfer' && window.onXferEvent) onXferEvent(d);
};

// ── Sync ──────────────────────────────────────────────────────
let syncJobs = [];
let syncLogJob = null;
const MODE_LABEL = { bisync: '双向 ⇄', push: '本地 → 挂载点', pull: '挂载点 → 本地' };
const RUN_LABEL  = { success: '成功', partial: '部分失败', failed: '失败', cancelled: '已取消' };

async function fetchSync() {
  const r = await api('GET', '/sync/jobs');
  if (!r.ok) { toast('❌ ' + r.output, true); return; }
  syncJobs = r.jobs;
  document.getElementById('sf-cron-hint').style.display = r.cron ? '' : 'none';
  renderSync();
  // Offer connected mount paths when typing the remote directory.
  const ls = await api('GET', '/list');
  document.getElementById('sf-mounts').innerHTML = (ls.mounts || [])
    .filter(m => isConnectedState(m.state) && m.mountPath)
    .map(m => `<option value="${esc(m.mountPath)}">${esc(m.label)}</option>`).join('');
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const u = ['KB','MB','GB','TB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(1) + ' ' + u[i];
}

function lastRunText(j) {
  const r = j.lastRun;
  if (!r) return '尚未运行';
  const parts = [`${RUN_LABEL[r.status] || r.status}`, new Date(r.endedAt).toLocaleString()];
  if (r.up || r.down) parts.push(`↑${r.up} ↓${r.down}`);
  if (r.deletedLocal || r.deletedRemote) parts.push(`删除 本地${r.deletedLocal}/远端${r.deletedRemote}`);
  if (r.conflicts) parts.push(`冲突 ${r.conflicts}`);
  if (r.error) parts.push(r.error);
  return parts.join(' · ');
}

function renderSync() {
  const el = document.getElementById('sync-list');
  if (!syncJobs.length) {
    el.innerHTML = '<div class="empty">还没有同步任务。<button class="link" onclick="openSyncForm()">新建任务</button></div>';
    return;
  }
  el.innerHTML = syncJobs.map(j => {
    const st = j.lastRun?.status;
    const badge = j.running ? '<span class="badge connected">运行中</span>'
      : st === 'failed' ? '<span class="badge disconnected">失败</span>'
      : st === 'partial' ? '<span class="badge warn">部分失败</span>'
      : '';
    const actions = j.running
      ? `<button class="btn btn-danger btn-sm" onclick="syncCancel('${j.id}')">取消</button>`
      : `<button class="btn btn-success btn-sm" onclick="syncRun('${j.id}')">运行</button>
         <button class="btn btn-ghost btn-sm" onclick="syncRun('${j.id}',{dryRun:true})">试运行</button>
         ${j.lastRun?.safetyAbort ? `<button class="btn btn-danger btn-sm" onclick="syncRun('${j.id}',{force:true})">强制运行</button>` : ''}
         <button class="btn btn-ghost btn-sm" onclick="openSyncForm('${j.id}')">编辑</button>
         <button class="btn btn-danger btn-sm" onclick="syncDelete('${j.id}')">删除</button>`;
    return `<div class="sync-card" id="sync-${j.id}">
      <div class="sync-top">
        <div class="mount-info">
          <div class="mount-label">${esc(j.name)}</div>
          <div class="sync-paths">${esc(j.localPath)} ${j.mode === 'pull' ? '←' : j.mode === 'push' ? '→' : '⇄'} ${esc(j.remotePath)}</div>
        </div>
        <span class="badge svc">${MODE_LABEL[j.mode]}</span>
        ${j.schedule ? `<span class="badge svc" title="${j.enabled ? '' : '定时已停用'}">${j.enabled ? '⏱' : '⏸'} ${esc(j.schedule)}</span>` : ''}
        ${badge}
        <div class="mount-actions">${actions}
          <button class="btn btn-ghost btn-sm" onclick="showSyncLog('${j.id}')">日志</button></div>
      </div>
      <div class="bar" style="display:${j.running ? 'block' : 'none'}"><i id="sync-bar-${j.id}"></i></div>
      <div class="sync-prog-text" id="sync-ptxt-${j.id}" style="display:${j.running ? 'block' : 'none'}">准备中...</div>
      <div class="sync-last">${esc(lastRunText(j))}</div>
    </div>`;
  }).join('');
  syncJobs.filter(j => j.running && j.progress).forEach(j => applySyncProgress(j.id, j.progress));
}

function applySyncProgress(id, p) {
  const bar = document.getElementById('sync-bar-' + id);
  const txt = document.getElementById('sync-ptxt-' + id);
  if (!bar || !txt) return;
  if (!p) return;
  bar.style.width = p.pct + '%';
  txt.textContent = `${p.phase === 'upload' ? '上传' : '下载'} ${p.pct}% · ${fmtBytes(p.bytes)} · ${p.rate} · 剩余 ${p.eta}`;
}

function onSyncEvent(d) {
  if (d.event === 'progress') applySyncProgress(d.jobId, d.progress);
  if (d.event === 'log' && d.jobId === syncLogJob) appendSyncLog(d);
  if (d.event === 'status') {
    if (d.state !== 'running') {
      const j = syncJobs.find(x => x.id === d.jobId);
      const name = j ? j.name : d.jobId;
      toast(d.state === 'success' ? `✅ ${name} 同步完成` : `${d.state === 'cancelled' ? '⏹' : '⚠️'} ${name}：${RUN_LABEL[d.state] || d.state}${d.run?.error ? ' — ' + d.run.error : ''}`, d.state === 'failed');
    }
    if (document.getElementById('page-sync').classList.contains('active')) fetchSync();
  }
}

async function syncRun(id, opts = {}) {
  if (opts.force && !confirm('强制运行会跳过删除数量与空目录保护，确认继续？')) return;
  const r = await api('POST', `/sync/jobs/${id}/run`, opts);
  if (!r.ok) { toast('❌ ' + r.output, true); return; }
  showSyncLog(id);
  fetchSync();
}
async function syncCancel(id) {
  const r = await api('POST', `/sync/jobs/${id}/cancel`);
  if (!r.ok) toast('❌ ' + r.output, true);
}
async function syncDelete(id) {
  const j = syncJobs.find(x => x.id === id);
  if (!confirm(`删除同步任务 "${j?.name}"？（不会删除任何文件，但会丢失双向同步的状态记录）`)) return;
  const r = await api('DELETE', `/sync/jobs/${id}`);
  toast(r.ok ? '🗑️ 任务已删除' : '❌ ' + r.output, !r.ok);
  if (syncLogJob === id) document.getElementById('sync-log-wrap').style.display = 'none';
  fetchSync();
}

function appendSyncLog(l) {
  const box = document.getElementById('sync-log');
  const d = document.createElement('div');
  const lv = LV[String(l.level || 'info').toLowerCase()] ?? 1;
  d.className = `lg lv-${['debug','info','warn','error'][lv]}`;
  d.innerHTML = `<span class="t">${esc(new Date(l.ts).toTimeString().slice(0, 8))}</span><span class="lv">${LV_LABEL[lv]}</span><span class="src">同步</span><span class="m"></span>`;
  d.querySelector('.m').textContent = l.msg;
  box.appendChild(d);
  while (box.childElementCount > 1000) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
async function showSyncLog(id) {
  syncLogJob = id;
  const j = syncJobs.find(x => x.id === id);
  document.getElementById('sync-log-name').textContent = j ? j.name : id;
  document.getElementById('sync-log-wrap').style.display = 'block';
  document.getElementById('sync-log').innerHTML = '';
  const r = await api('GET', `/sync/jobs/${id}/log`);
  (r.log || []).forEach(appendSyncLog);
}

function onSyncModeChange() {
  const m = document.getElementById('sf-mode').value;
  document.getElementById('sf-conflict-wrap').style.display = m === 'bisync' ? '' : 'none';
  document.getElementById('sf-del-wrap').style.display = m === 'bisync' ? 'none' : '';
}
function openSyncForm(id) {
  const j = id ? syncJobs.find(x => x.id === id) : null;
  document.getElementById('sync-form-title').textContent = j ? '编辑同步任务' : '新建同步任务';
  const set = (k, val) => { document.getElementById(k).value = val ?? ''; };
  set('sf-id', j?.id); set('sf-name', j?.name);
  set('sf-mode', j?.mode || 'bisync');
  set('sf-local', j?.localPath); set('sf-remote', j?.remotePath);
  set('sf-conflict', j?.conflict || 'newer');
  set('sf-schedule', j?.schedule);
  set('sf-bw', j?.bwlimit || ''); set('sf-maxdel', j?.maxDelete ?? 200);
  set('sf-excludes', (j?.excludes || ['.DS_Store', 'Thumbs.db', '*.part', '*.tmp']).join('\n'));
  document.getElementById('sf-delete').checked = !!j?.deleteExtraneous;
  document.getElementById('sf-enabled').checked = j ? !!j.enabled : true;
  onSyncModeChange();
  document.getElementById('sync-form-wrap').style.display = 'block';
  document.getElementById('sync-form-wrap').scrollIntoView({behavior:'smooth'});
}
function closeSyncForm() { document.getElementById('sync-form-wrap').style.display = 'none'; }

async function saveSyncJob() {
  const id = v('sf-id');
  const body = {
    name: v('sf-name'), mode: v('sf-mode'),
    localPath: v('sf-local'), remotePath: v('sf-remote'),
    conflict: v('sf-conflict'), schedule: v('sf-schedule'),
    bwlimit: v('sf-bw') || 0, maxDelete: v('sf-maxdel') || 0,
    excludes: document.getElementById('sf-excludes').value,
    deleteExtraneous: document.getElementById('sf-delete').checked,
    enabled: document.getElementById('sf-enabled').checked,
  };
  const r = id ? await api('PUT', `/sync/jobs/${id}`, body) : await api('POST', '/sync/jobs', body);
  if (!r.ok) { toast('❌ ' + r.output, true); return; }
  toast('✅ 已保存');
  closeSyncForm();
  fetchSync();
}

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, isErr=false) {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + (isErr ? 'err' : 'ok');
  t.textContent = String(msg).replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, '');
  c.appendChild(t);
  setTimeout(() => t.remove(), isErr ? 6000 : 3500);
}

// ── Helpers ───────────────────────────────────────────────────
function esc(s) {
  return String(s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Init ──────────────────────────────────────────────────────
onSvcChange();
applyTheme(document.documentElement.dataset.mode || 'auto');
// files.js loads after this file, so route once everything is parsed.
window.addEventListener('DOMContentLoaded', () => {
  const startPage = (location.hash || '').slice(1);
  initDash();   // also feeds the daemon indicator in the top bar
  if (startPage && document.getElementById('page-' + startPage) && startPage !== 'dashboard') goPage(startPage);
});
