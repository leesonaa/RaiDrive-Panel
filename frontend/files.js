// Dual-pane file manager: drag files between the two lists to copy/move them.
// Relies on helpers from index.html: api(), esc(), toast(), fmtBytes().
(() => {
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('rdp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, val) { try { localStorage.setItem('rdp.' + k, JSON.stringify(val)); } catch { /* storage unavailable */ } },
  };

  const page = document.getElementById('page-files');
  let inited = false;
  let roots = [];
  let defaults = {};
  let op = LS.get('op', 'copy') === 'move' ? 'move' : 'copy';
  let drag = null;               // {pane, dir, names} while a drag is in flight
  const panes = {};
  const xfers = new Map();

  const joinPath = (d, n) => (d === '/' ? '/' + n : d.replace(/\/+$/, '') + '/' + n);
  const pad = n => String(n).padStart(2, '0');
  const fmtTime = s => {
    if (!s) return '';
    const d = new Date(s * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const bookmarks = () => LS.get('bookmarks', []);
  const effOp = e => (e && e.shiftKey ? (op === 'copy' ? 'move' : 'copy') : op);

  // ── pane ────────────────────────────────────────────────────

  class Pane {
    constructor(id, title, defaultKey) {
      this.id = id; this.title = title; this.defaultKey = defaultKey;
      this.path = ''; this.parent = null; this.entries = []; this.truncated = false;
      this.sel = new Set(); this.anchor = null;
      this.back = []; this.fwd = [];
      this.sortKey = 'name'; this.sortDir = 1; this.filter = '';
      this.build();
    }

    build() {
      const el = document.createElement('div');
      el.className = 'fpane';
      el.innerHTML = `
        <div class="fp-head">
          <span class="fp-title">${esc(this.title)}</span>
          <select class="fp-loc" title="快速跳转"></select>
          <button class="ib" data-act="back" title="后退">‹</button>
          <button class="ib" data-act="fwd" title="前进">›</button>
          <button class="ib" data-act="up" title="上一级">↑</button>
          <span class="sp"></span>
          <button class="ib" data-act="refresh" title="刷新">⟳</button>
          <button class="ib" data-act="home" title="默认位置">⌂</button>
          <button class="ib" data-act="filter" title="过滤">⏷</button>
          <button class="ib" data-act="star" title="收藏当前目录">☆</button>
          <input class="fp-path" spellcheck="false">
        </div>
        <div class="fp-filter" hidden><input placeholder="按名称过滤…"></div>
        <div class="fp-cols">
          <span data-sort="name">名称</span><span class="num" data-sort="size">大小</span><span data-sort="mtime">修改时间</span>
        </div>
        <div class="fp-list" tabindex="0"></div>
        <div class="fp-foot">
          <span class="info"></span><span class="sp"></span>
          <button class="btn btn-ghost" data-act="mkdir">新建文件夹</button>
          <button class="btn btn-ghost" data-act="rename">重命名</button>
          <button class="btn btn-danger" data-act="delete">删除</button>
        </div>`;
      this.el = el;
      this.list = el.querySelector('.fp-list');
      this.pathInput = el.querySelector('.fp-path');
      this.loc = el.querySelector('.fp-loc');
      this.filterWrap = el.querySelector('.fp-filter');
      this.filterInput = this.filterWrap.querySelector('input');
      this.info = el.querySelector('.info');

      el.addEventListener('click', e => {
        setActive(this.id);
        const b = e.target.closest('[data-act]');
        if (b) this.act(b.dataset.act);
        const s = e.target.closest('[data-sort]');
        if (s) this.setSort(s.dataset.sort);
      });
      this.loc.addEventListener('change', () => { const p = this.loc.value; this.loc.selectedIndex = 0; if (p) this.load(p); });
      this.pathInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') this.load(this.pathInput.value.trim());
        if (e.key === 'Escape') { this.pathInput.value = this.path; this.pathInput.blur(); }
      });
      this.filterInput.addEventListener('input', () => {
        this.filter = this.filterInput.value.trim().toLowerCase();
        // Never leave hidden items selected: delete/move act on the selection.
        const vis = new Set(this.visible().map(x => x.name));
        this.sel = new Set([...this.sel].filter(n => vis.has(n)));
        this.render();
      });

      const l = this.list;
      l.addEventListener('click', e => this.onClick(e));
      l.addEventListener('dblclick', e => this.onDblClick(e));
      l.addEventListener('keydown', e => this.onKey(e));
      l.addEventListener('dragstart', e => this.onDragStart(e));
      l.addEventListener('dragend', () => { drag = null; clearDropHints(); });
      l.addEventListener('dragover', e => this.onDragOver(e));
      l.addEventListener('dragleave', e => { if (!l.contains(e.relatedTarget)) this.clearHints(); });
      l.addEventListener('drop', e => this.onDrop(e));
    }

    visible() {
      const f = this.filter;
      const k = this.sortKey, dir = this.sortDir;
      return this.entries
        .filter(x => !f || x.name.toLowerCase().includes(f))
        .sort((a, b) => {
          if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
          let c = 0;
          if (k === 'size') c = a.size - b.size;
          else if (k === 'mtime') c = a.mtime - b.mtime;
          if (!c) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
          return c * dir;
        });
    }

    async load(path, { push = true, silent = false } = {}) {
      if (!path) return false;
      const r = await api('GET', '/fs/list?path=' + encodeURIComponent(path));
      if (!r.ok) {
        if (!silent) toast('❌ ' + r.output, true);
        this.pathInput.value = this.path;
        return false;
      }
      if (push && this.path && this.path !== r.path) { this.back.push(this.path); this.fwd = []; }
      this.path = r.path; this.parent = r.parent;
      this.entries = r.entries; this.truncated = r.truncated;
      this.sel.clear(); this.anchor = null;
      LS.set('path' + this.id, this.path);
      this.render();
      this.list.scrollTop = 0;
      return true;
    }

    reload() { return this.path ? this.load(this.path, { push: false, silent: true }) : Promise.resolve(); }

    render() {
      const rows = this.visible();
      this.pathInput.value = this.path;
      this.list.innerHTML = rows.length ? rows.map(x => `
        <div class="fp-row${this.sel.has(x.name) ? ' sel' : ''}" draggable="true" data-name="${esc(x.name)}" data-type="${x.type}">
          <div class="fp-name"><i>${x.type === 'dir' ? '📁' : x.link ? '🔗' : '📄'}</i><b title="${esc(x.name)}">${esc(x.name)}</b></div>
          <div class="dim num">${x.type === 'file' ? fmtBytes(x.size) : ''}</div>
          <div class="dim">${fmtTime(x.mtime)}</div>
        </div>`).join('') : `<div class="fp-empty">${this.filter ? '没有匹配项' : '空目录'}</div>`;
      this.el.querySelectorAll('[data-sort]').forEach(s => {
        const base = { name: '名称', size: '大小', mtime: '修改时间' }[s.dataset.sort];
        s.textContent = base + (s.dataset.sort === this.sortKey ? (this.sortDir > 0 ? ' ▲' : ' ▼') : '');
      });
      this.el.querySelector('[data-act="back"]').disabled = !this.back.length;
      this.el.querySelector('[data-act="fwd"]').disabled = !this.fwd.length;
      this.el.querySelector('[data-act="up"]').disabled = !this.parent;
      const star = this.el.querySelector('[data-act="star"]');
      const on = bookmarks().includes(this.path);
      star.textContent = on ? '★' : '☆'; star.classList.toggle('on', on);
      this.updateInfo(rows.length);
    }

    updateInfo(n) {
      const total = n ?? this.visible().length;
      this.info.textContent = `${total} 项${this.truncated ? '（仅显示前 5000 项）' : ''}${this.sel.size ? ` · 已选 ${this.sel.size}` : ''}`;
    }

    paint() {
      this.list.querySelectorAll('.fp-row').forEach(r => r.classList.toggle('sel', this.sel.has(r.dataset.name)));
      this.updateInfo();
    }

    fillLocations() {
      const mk = (label, items) => items.length
        ? `<optgroup label="${label}">${items.map(i => `<option value="${esc(i.path)}">${esc(i.text)}</option>`).join('')}</optgroup>` : '';
      const mounts = roots.filter(r => r.kind === 'mount').map(r => ({
        path: r.path, text: `${/^(connected|mounted)$/i.test(r.state || '') ? '' : '⚠ '}${r.label} — ${r.path}` }));
      const dirs = roots.filter(r => r.kind === 'dir').map(r => ({ path: r.path, text: r.path }));
      const marks = bookmarks().map(p => ({ path: p, text: p }));
      this.loc.innerHTML = '<option value="">位置 ▾</option>' + mk('挂载点', mounts) + mk('本地目录', dirs) + mk('收藏', marks);
    }

    setSort(key) {
      if (this.sortKey === key) this.sortDir = -this.sortDir; else { this.sortKey = key; this.sortDir = 1; }
      this.render();
    }

    act(a) {
      switch (a) {
        case 'back': if (this.back.length) { const p = this.back.pop(); this.fwd.push(this.path); this.load(p, { push: false }); } break;
        case 'fwd': if (this.fwd.length) { const p = this.fwd.pop(); this.back.push(this.path); this.load(p, { push: false }); } break;
        case 'up': if (this.parent) this.load(this.parent); break;
        case 'refresh': this.load(this.path, { push: false }); break;
        case 'home': this.load(defaults[this.defaultKey]); break;
        case 'filter':
          this.filterWrap.hidden = !this.filterWrap.hidden;
          if (!this.filterWrap.hidden) this.filterInput.focus(); else { this.filter = ''; this.filterInput.value = ''; this.render(); }
          break;
        case 'star': {
          const b = bookmarks();
          LS.set('bookmarks', b.includes(this.path) ? b.filter(x => x !== this.path) : [...b, this.path]);
          Object.values(panes).forEach(p => { p.fillLocations(); p.render(); });
          break;
        }
        case 'mkdir': this.mkdir(); break;
        case 'rename': this.rename(); break;
        case 'delete': this.remove(); break;
      }
    }

    async mkdir() {
      const name = prompt('新文件夹名称');
      if (!name) return;
      const r = await api('POST', '/fs/mkdir', { path: joinPath(this.path, name.trim()) });
      toast(r.ok ? '✅ 已创建' : '❌ ' + r.output, !r.ok);
      this.reload();
    }
    async rename() {
      if (this.sel.size !== 1) { toast('请先选中一个项目', true); return; }
      const old = [...this.sel][0];
      const name = prompt('新名称', old);
      if (!name || name === old) return;
      const r = await api('POST', '/fs/rename', { path: joinPath(this.path, old), newName: name.trim() });
      toast(r.ok ? '✅ 已重命名' : '❌ ' + r.output, !r.ok);
      this.reload();
    }
    async remove() {
      if (!this.sel.size) { toast('请先选中要删除的项目', true); return; }
      const names = [...this.sel];
      if (!confirm(`永久删除 ${names.length} 项？\n\n${names.slice(0, 8).join('\n')}${names.length > 8 ? '\n…' : ''}\n\n此操作不可恢复。`)) return;
      const r = await api('POST', '/fs/delete', { paths: names.map(n => joinPath(this.path, n)) });
      if (!r.ok) toast('❌ ' + r.output, true);
      else if (r.errors?.length) toast('⚠️ 部分删除失败：' + r.errors[0], true);
      else toast(`🗑️ 已删除 ${r.deleted} 项`);
      this.reload();
    }

    // ── selection / keyboard ──
    onClick(e) {
      const row = e.target.closest('.fp-row');
      setActive(this.id);
      if (!row) { this.sel.clear(); this.paint(); return; }
      const name = row.dataset.name;
      if (e.shiftKey && this.anchor) {
        const names = this.visible().map(x => x.name);
        const a = names.indexOf(this.anchor), b = names.indexOf(name);
        if (a !== -1 && b !== -1) {
          if (!(e.ctrlKey || e.metaKey)) this.sel.clear();
          names.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(n => this.sel.add(n));
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (this.sel.has(name)) this.sel.delete(name); else this.sel.add(name);
        this.anchor = name;
      } else {
        this.sel = new Set([name]); this.anchor = name;
      }
      this.paint();
    }
    onDblClick(e) {
      const row = e.target.closest('.fp-row');
      if (row && row.dataset.type === 'dir') this.load(joinPath(this.path, row.dataset.name));
    }
    onKey(e) {
      if (e.key === 'Delete') { e.preventDefault(); this.remove(); }
      else if (e.key === 'F2') { e.preventDefault(); this.rename(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.visible().forEach(x => this.sel.add(x.name)); this.paint(); }
      else if (e.key === 'Backspace') { e.preventDefault(); this.act('up'); }
      else if (e.key === 'Escape') { this.sel.clear(); this.paint(); }
      else if (e.key === 'Enter' && this.sel.size === 1) {
        const x = this.entries.find(en => en.name === [...this.sel][0]);
        if (x && x.type === 'dir') this.load(joinPath(this.path, x.name));
      }
    }

    // ── drag & drop ──
    onDragStart(e) {
      const row = e.target.closest('.fp-row');
      if (!row) { e.preventDefault(); return; }
      const name = row.dataset.name;
      if (!this.sel.has(name)) { this.sel = new Set([name]); this.anchor = name; this.paint(); }
      drag = { pane: this.id, dir: this.path, names: [...this.sel] };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', drag.names.join('\n'));
    }
    dropTarget(e) {
      const row = e.target.closest('.fp-row');
      if (row && row.dataset.type === 'dir' && !(drag.pane === this.id && drag.names.includes(row.dataset.name))) {
        return { dest: joinPath(this.path, row.dataset.name), row };
      }
      return { dest: this.path, row: null };
    }
    clearHints() {
      this.list.classList.remove('drop-target');
      this.list.querySelectorAll('.drop-target').forEach(r => r.classList.remove('drop-target'));
    }
    onDragOver(e) {
      if (!drag) return;
      const { dest, row } = this.dropTarget(e);
      this.clearHints();
      // Dropping into the folder the items already came from does nothing (copy-duplicate is done via copy+rename dialog).
      if (drag.pane === this.id && dest === drag.dir) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = effOp(e) === 'move' ? 'move' : 'copy';
      (row || this.list).classList.add('drop-target');
    }
    onDrop(e) {
      if (!drag) return;
      e.preventDefault();
      const { dest } = this.dropTarget(e);
      const d = drag;
      drag = null;
      clearDropHints();
      if (d.pane === this.id && dest === d.dir) return;
      doTransfer(d.names.map(n => joinPath(d.dir, n)), dest, effOp(e));
    }
  }

  function clearDropHints() { Object.values(panes).forEach(p => p.clearHints()); }
  function setActive(id) {
    Object.values(panes).forEach(p => p.el.classList.toggle('active-pane', p.id === id));
  }
  const refreshAll = () => Promise.all(Object.values(panes).map(p => p.reload()));

  // ── transfers ───────────────────────────────────────────────

  async function doTransfer(sources, destDir, opName, onConflict) {
    const r = await api('POST', '/fs/transfer', { sources, destDir, op: opName, onConflict });
    if (!r.ok && r.conflicts) {
      const choice = await conflictDialog(r.conflicts, destDir);
      if (choice) doTransfer(sources, destDir, opName, choice);
      return;
    }
    if (!r.ok) { toast('❌ ' + r.output, true); return; }
    if (r.count === 0) { toast('没有需要传输的项目'); refreshAll(); }
  }

  function conflictDialog(names, destDir) {
    return new Promise(resolve => {
      const bg = document.createElement('div');
      bg.className = 'modal-bg';
      bg.innerHTML = `<div class="modal">
        <h3>目标位置已有同名项目</h3>
        <p>${esc(destDir)}</p>
        <p>${names.slice(0, 6).map(esc).join('<br>')}${names.length > 6 ? `<br>…共 ${names.length} 项` : ''}</p>
        <div class="btns">
          <button class="btn btn-ghost" data-c="">取消</button>
          <button class="btn btn-ghost" data-c="skip">跳过</button>
          <button class="btn btn-ghost" data-c="rename">保留两者</button>
          <button class="btn btn-danger" data-c="overwrite">覆盖</button>
        </div></div>`;
      const done = v => { bg.remove(); document.removeEventListener('keydown', onEsc); resolve(v || null); };
      const onEsc = e => { if (e.key === 'Escape') done(null); };
      bg.addEventListener('click', e => {
        if (e.target === bg) done(null);
        const b = e.target.closest('[data-c]');
        if (b) done(b.dataset.c);
      });
      document.addEventListener('keydown', onEsc);
      document.body.appendChild(bg);
    });
  }

  const ST = { success: '完成', partial: '部分失败', failed: '失败', cancelled: '已取消', running: '传输中' };

  function xferRow(id) {
    let x = xfers.get(id);
    if (x) return x;
    const el = document.createElement('div');
    el.className = 'xfer';
    el.innerHTML = `<div class="xfer-top"><span class="xfer-title"></span><span class="xfer-st"></span>
      <button class="btn btn-danger btn-sm" data-cancel>取消</button></div>
      <div class="bar"><i></i></div>`;
    el.querySelector('[data-cancel]').onclick = () => api('POST', `/fs/transfer/${id}/cancel`);
    document.getElementById('xfer-panel').prepend(el);
    x = { el, title: el.querySelector('.xfer-title'), st: el.querySelector('.xfer-st'), bar: el.querySelector('.bar i') };
    xfers.set(id, x);
    return x;
  }

  function onXferEvent(d) {
    if (!inited) return;
    const x = xferRow(d.id);
    if (d.names || d.destDir) {
      const first = (d.names || [])[0] || '';
      x.title.textContent = `${d.op === 'move' ? '移动' : '复制'} ${first}${d.count > 1 ? ` 等 ${d.count} 项` : ''} → ${d.destDir}`;
      x.title.title = x.title.textContent;
    }
    if (d.event === 'start' || d.event === 'progress') {
      const total = d.totalBytes || 0;
      const pct = total ? Math.min(100, Math.round((d.doneBytes || 0) / total * 100)) : 0;
      x.bar.style.width = pct + '%';
      x.st.textContent = total
        ? `${fmtBytes(d.doneBytes || 0)} / ${fmtBytes(total)}${d.rate ? ' · ' + d.rate : ''}${d.eta ? ' · 剩余 ' + d.eta : ''}`
        : ST.running;
    }
    if (d.event === 'done') {
      x.el.querySelector('[data-cancel]').remove();
      x.bar.style.width = '100%';
      const ok = d.status === 'success';
      x.el.classList.add(ok ? 'ok' : 'bad');
      const firstErr = (d.results || []).find(r => r.error);
      x.st.textContent = ST[d.status] || d.status;
      if (!ok && (d.error || firstErr)) x.title.title = d.error || firstErr.error;
      toast(ok ? '✅ 传输完成' : `${d.status === 'cancelled' ? '⏹' : '⚠️'} 传输${ST[d.status] || d.status}${d.error || firstErr ? '：' + (d.error || firstErr.error) : ''}`, d.status === 'failed');
      refreshAll();
      if (ok) setTimeout(() => { x.el.remove(); xfers.delete(d.id); }, 10000);
    }
  }

  // ── page ────────────────────────────────────────────────────

  function toSyncJob() {
    document.querySelector('.nav-item[data-page="sync"]').click();
    openSyncForm();
    document.getElementById('sf-name').value = '同步 ' + (panes.L.path.split('/').pop() || panes.L.path);
    document.getElementById('sf-local').value = panes.L.path;
    document.getElementById('sf-remote').value = panes.R.path;
  }

  function setOp(v) {
    op = v; LS.set('op', v);
    page.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.op === v));
  }

  async function filesInit() {
    if (inited) { refreshAll(); return; }
    inited = true;
    page.innerHTML = `
      <div class="page-header">
        <div><h1>文件管理</h1><p>把文件从一栏拖到另一栏即可传输；拖到文件夹上进入该文件夹；按住 Shift 反转「复制/移动」</p></div>
        <div class="f-toolbar">
          <span class="field-label" style="margin:0">拖动时</span>
          <div class="seg"><button data-op="copy">复制</button><button data-op="move">移动</button></div>
          <button class="btn btn-ghost btn-sm" id="f-to-sync" title="用左右两栏当前目录创建一个同步任务">⇄ 同步这两个目录</button>
        </div>
      </div>
      <div class="f-panes" id="f-panes"></div>
      <div class="xfer-panel" id="xfer-panel"></div>`;
    panes.L = new Pane('L', '本地', 'local');
    panes.R = new Pane('R', '挂载点', 'remote');
    const host = document.getElementById('f-panes');
    host.append(panes.L.el, panes.R.el);
    page.querySelector('.seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setOp(b.dataset.op); });
    document.getElementById('f-to-sync').onclick = toSyncJob;
    setOp(op);
    setActive('L');

    const r = await api('GET', '/fs/roots');
    if (!r.ok) { toast('❌ ' + r.output, true); return; }
    roots = r.roots; defaults = r.defaults || {};
    Object.values(panes).forEach(p => p.fillLocations());
    if (!roots.length) {
      host.innerHTML = '<div class="empty" style="grid-column:1/-1"><div class="emo">📂</div>没有可浏览的目录。请添加并挂载存储，或用环境变量 FS_ROOTS 指定容器内的本地目录。</div>';
      return;
    }
    for (const p of Object.values(panes)) {
      const saved = LS.get('path' + p.id, '');
      if (!(saved && await p.load(saved, { silent: true }))) await p.load(defaults[p.defaultKey], { silent: true });
    }
    const t = await api('GET', '/fs/tasks');
    (t.tasks || []).filter(x => x.status === 'running').forEach(x => onXferEvent({ event: 'progress', ...x }));
  }

  window.filesInit = filesInit;
  window.onXferEvent = onXferEvent;
})();
