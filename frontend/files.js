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
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Windows-style clipboard for copy/cut/paste between folders (and panes).
  let clip = null;               // {dir, names, op: 'copy' | 'move'}
  const isCut = (pane, name) => !!clip && clip.op === 'move' && clip.dir === pane.path && clip.names.includes(name);
  function refreshCut() {
    Object.values(panes).forEach(p => p.list.querySelectorAll('.fp-row')
      .forEach(r => r.classList.toggle('cut', isCut(p, r.dataset.name))));
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall through to the legacy path */ }
    // Plain-http origins (typical for a LAN panel) have no navigator.clipboard.
    const prev = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    if (prev && prev.focus) prev.focus();
    return ok;
  }

  // ── context menu ──
  let menu = null;
  function closeMenu() {
    if (!menu) return;
    menu.ac.abort();
    menu.el.remove();
    menu = null;
  }

  function showMenu(x, y, items) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'ctx-menu';
    el.setAttribute('role', 'menu');
    const ac = new AbortController();
    const live = [];             // enabled entries, in order
    let fi = -1;
    const setFocus = i => {
      fi = i;
      live.forEach((l, k) => l.el.classList.toggle('focus', k === i));
    };
    for (const it of items) {
      if (it === 'sep') {
        const sp = document.createElement('div');
        sp.className = 'ctx-sep';
        el.appendChild(sp);
        continue;
      }
      const b = document.createElement('div');
      b.className = 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '');
      b.setAttribute('role', 'menuitem');
      b.innerHTML = `<span>${esc(it.label)}</span>${it.hint ? `<span class="k">${esc(it.hint)}</span>` : ''}`;
      if (it.title) b.title = it.title;
      if (!it.disabled) {
        const entry = { el: b, it };
        live.push(entry);
        b.addEventListener('mouseenter', () => setFocus(live.indexOf(entry)));
        b.addEventListener('click', () => { closeMenu(); it.run(); });
      }
      el.appendChild(b);
    }
    el.style.left = '0px'; el.style.top = '0px'; el.style.visibility = 'hidden';
    document.body.appendChild(el);
    const w = el.offsetWidth, h = el.offsetHeight;
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 4)) + 'px';
    el.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 4)) + 'px';
    el.style.visibility = '';
    menu = { el, ac };

    const sig = { signal: ac.signal, capture: true };
    document.addEventListener('mousedown', e => { if (!el.contains(e.target)) closeMenu(); }, sig);
    document.addEventListener('contextmenu', e => { if (el.contains(e.target)) e.preventDefault(); else closeMenu(); }, sig);
    document.addEventListener('scroll', e => { if (!el.contains(e.target)) closeMenu(); }, sig);
    window.addEventListener('blur', closeMenu, { signal: ac.signal });
    window.addEventListener('resize', closeMenu, { signal: ac.signal });
    document.addEventListener('keydown', e => {
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === 'Escape' || e.key === 'Tab') { stop(); closeMenu(); }
      else if (e.key === 'ArrowDown') { stop(); if (live.length) setFocus((fi + 1) % live.length); }
      else if (e.key === 'ArrowUp') { stop(); if (live.length) setFocus(fi <= 0 ? live.length - 1 : fi - 1); }
      else if (e.key === 'Enter' || e.key === ' ') {
        stop();
        if (fi >= 0) { const { it } = live[fi]; closeMenu(); it.run(); }
      }
    }, sig);
  }

  // ── pane ────────────────────────────────────────────────────


  // ── modern look: coloured type icons, breadcrumbs, selection bar ──
  const SVG = (d, extra = '') => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const IC = {
    back: SVG('<path d="M15 18l-6-6 6-6"/>'), fwd: SVG('<path d="M9 18l6-6-6-6"/>'), up: SVG('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    refresh: SVG('<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>'),
    home: SVG('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
    filter: SVG('<path d="M3 5h18l-7 8v6l-4 2v-8z"/>'),
    star: SVG('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>'),
    close: SVG('<path d="M18 6L6 18M6 6l12 12"/>'),
    pencil: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  };
  const EXT = {
    video: 'mkv mp4 avi mov wmv flv ts m2ts rmvb webm iso m4v', audio: 'mp3 flac wav aac m4a ogg wma ape',
    image: 'jpg jpeg png gif webp bmp heic svg tif tiff', archive: 'zip rar 7z tar gz bz2 xz tgz dmg pkg apk',
    doc: 'pdf doc docx xls xlsx ppt pptx txt md epub rtf csv', sub: 'srt ass ssa vtt sub idx',
    code: 'js ts json py sh yml yaml xml html css c cpp go java rs toml ini conf log',
  };
  const KIND = {}; for (const [k, v] of Object.entries(EXT)) v.split(' ').forEach(e => { KIND[e] = k; });
  const KIND_COLOR = { video: '#a78bfa', audio: '#f472b6', image: '#4ade80', archive: '#fb923c', doc: '#60a5fa', sub: '#22d3ee', code: '#2dd4bf', file: '#8b949e' };
  function fileIcon(x) {
    if (x.type === 'dir') return `<svg class="ico" viewBox="0 0 24 24" width="20" height="20"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.6 0 1.2.3 1.6.8L12 6.4h6.5A2.5 2.5 0 0 1 21 8.9v8.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" fill="#e3b341" opacity=".95"/><path d="M3 9.5h18" stroke="#00000030" stroke-width="1"/></svg>`;
    if (x.link) return `<svg class="ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#8b949e" stroke-width="2" stroke-linecap="round"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>`;
    const ext = (x.name.split('.').pop() || '').toLowerCase();
    const c = KIND_COLOR[(x.name.includes('.') && KIND[ext]) || 'file'];
    return `<svg class="ico" viewBox="0 0 24 24" width="20" height="20"><path d="M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" fill="${c}" opacity=".9"/><path d="M14 3v5h5" fill="#ffffff55"/></svg>`;
  }

  class Pane {
    constructor(id, title, defaultKey) {
      this.id = id; this.title = title; this.defaultKey = defaultKey;
      this.path = ''; this.parent = null; this.entries = []; this.truncated = false;
      this.sel = new Set(); this.anchor = null;
      this.back = []; this.fwd = [];
      this.sortKey = 'name'; this.sortDir = 1; this.filter = '';
      this.marquee = null; this.suppressClick = false; this.visCount = 0;
      this.build();
    }

    build() {
      const el = document.createElement('div');
      el.className = 'fpane';
      el.innerHTML = `
        <div class="fp-head">
          <span class="fp-title">${esc(this.title)}</span>
          <select class="fp-loc" title="快速跳转"></select>
          <button class="ib" data-act="back" title="后退">${IC.back}</button>
          <button class="ib" data-act="fwd" title="前进">${IC.fwd}</button>
          <button class="ib" data-act="up" title="上一级">${IC.up}</button>
          <span class="sp"></span>
          <button class="ib" data-act="refresh" title="刷新">${IC.refresh}</button>
          <button class="ib" data-act="home" title="默认位置">${IC.home}</button>
          <button class="ib" data-act="filter" title="过滤">${IC.filter}</button>
          <button class="ib" data-act="star" title="收藏当前目录">${IC.star}</button>
          <div class="fp-pathbar"><div class="fp-crumbs" title="点击空白处可直接输入路径"></div><button class="ib" data-act="editpath" title="输入路径">${IC.pencil}</button><input class="fp-path" spellcheck="false" hidden></div>
        </div>
        <div class="fp-filter" hidden><input placeholder="按名称过滤…"></div>
        <div class="fp-cols">
          <span data-sort="name">名称</span><span class="num" data-sort="size">大小</span><span data-sort="mtime">修改时间</span>
        </div>
        <div class="fp-list" tabindex="0"></div>
        <div class="fp-selbar" hidden>
          <b class="n"></b>
          <button class="btn btn-ghost" data-sel="copy">复制到另一栏</button>
          <button class="btn btn-ghost" data-sel="move">移动到另一栏</button>
          <button class="btn btn-danger" data-sel="del">删除</button>
          <button class="ib" data-sel="clear" title="取消选择">${IC.close}</button>
        </div>
        <div class="fp-foot">
          <span class="info"></span><span class="sp"></span>
          <button class="btn btn-ghost" data-act="mkdir">新建文件夹</button>
          <button class="btn btn-ghost" data-act="rename">重命名</button>
          <button class="btn btn-danger" data-act="delete">删除</button>
        </div>`;
      this.el = el;
      this.list = el.querySelector('.fp-list');
      this.pathInput = el.querySelector('.fp-path');
      this.crumbs = el.querySelector('.fp-crumbs');
      this.selbar = el.querySelector('.fp-selbar');
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
        if (e.key === 'Enter') { this.load(this.pathInput.value.trim()); this.editPath(false); }
        if (e.key === 'Escape') { this.editPath(false); }
      });
      this.pathInput.addEventListener('blur', () => this.editPath(false));
      this.crumbs.addEventListener('click', e => {
        const c = e.target.closest('[data-p]');
        if (c) { if (!c.classList.contains('off')) this.load(c.dataset.p); } else this.editPath(true);
      });
      this.selbar.addEventListener('click', e => {
        const b = e.target.closest('[data-sel]'); if (!b || !this.sel.size) return;
        const names = [...this.sel], here = n => joinPath(this.path, n);
        const other = this === panes.L ? panes.R : panes.L;
        if (b.dataset.sel === 'clear') { this.sel.clear(); this.paint(); }
        else if (b.dataset.sel === 'del') this.remove();
        else if (other.path) doTransfer(names.map(here), other.path, b.dataset.sel);
        else toast('另一栏没有打开目录', true);
      });
      this.filterInput.addEventListener('input', () => {
        this.filter = this.filterInput.value.trim().toLowerCase();
        // Never leave hidden items selected: delete/move act on the selection.
        const vis = new Set(this.visible().map(x => x.name));
        this.sel = new Set([...this.sel].filter(n => vis.has(n)));
        this.render();
      });

      const l = this.list;
      l.addEventListener('mousedown', e => this.onMouseDown(e));
      l.addEventListener('contextmenu', e => this.onContext(e));
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

    editPath(on) {
      this.pathInput.hidden = !on; this.crumbs.parentElement.classList.toggle('editing', on);
      if (on) { this.pathInput.value = this.path; this.pathInput.focus(); this.pathInput.select(); }
    }

    renderCrumbs() {
      const root = roots.filter(r => this.path === r.path || this.path.startsWith(r.path.replace(/\/+$/, '') + '/'))
        .sort((a, b) => b.path.length - a.path.length)[0];
      const parts = this.path.split('/').filter(Boolean);
      let acc = '', html = '';
      parts.forEach((seg, i) => {
        acc += '/' + seg;
        const off = !root || acc.length < root.path.length;
        html += `${i ? '<i class="sep">/</i>' : ''}<span class="crumb${off ? ' off' : ''}${i === parts.length - 1 ? ' cur' : ''}" data-p="${esc(acc)}">${esc(seg)}</span>`;
      });
      this.crumbs.innerHTML = html || '<span class="crumb off">/</span>';
      this.crumbs.scrollLeft = this.crumbs.scrollWidth;
    }

    reload() { return this.path ? this.load(this.path, { push: false, silent: true }) : Promise.resolve(); }

    render() {
      if (this.marquee) this.marquee.cancel();
      const rows = this.visible();
      this.visCount = rows.length;
      this.pathInput.value = this.path;
      this.renderCrumbs();
      this.list.innerHTML = rows.length ? rows.map(x => `
        <div class="fp-row${this.sel.has(x.name) ? ' sel' : ''}${isCut(this, x.name) ? ' cut' : ''}" draggable="true" data-name="${esc(x.name)}" data-type="${x.type}">
          <div class="fp-name"><i>${fileIcon(x)}</i><b title="${esc(x.name)}">${esc(x.name)}</b></div>
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
      star.classList.toggle('on', on); star.querySelector('svg').setAttribute('fill', on ? 'currentColor' : 'none');
      this.updateInfo(rows.length);
    }

    updateInfo(n) {
      const total = n ?? this.visCount;
      this.info.textContent = `${total} 项${this.truncated ? '（仅显示前 5000 项）' : ''}${this.sel.size ? ` · 已选 ${this.sel.size}` : ''}`;
      this.selbar.hidden = !this.sel.size;
      this.selbar.querySelector('.n').textContent = `已选 ${this.sel.size} 项`;
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
        case 'editpath': this.editPath(true); break;
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
      if (this.suppressClick) { this.suppressClick = false; return; } // the click that ends a rubber-band drag
      const row = e.target.closest('.fp-row');
      setActive(this.id);
      if (!row) {
        if (!(e.ctrlKey || e.metaKey || e.shiftKey)) { this.sel.clear(); this.paint(); }
        return;
      }
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
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); this.selectAll(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); this.clipSet('copy'); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { e.preventDefault(); this.clipSet('move'); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); this.paste(this.path); }
      else if (e.key === 'Backspace') { e.preventDefault(); this.act('up'); }
      else if (e.key === 'Escape') { this.sel.clear(); this.paint(); }
      else if (e.key === 'Enter' && this.sel.size === 1) {
        const x = this.entries.find(en => en.name === [...this.sel][0]);
        if (x && x.type === 'dir') this.load(joinPath(this.path, x.name));
      }
    }

    selectAll() { this.visible().forEach(x => this.sel.add(x.name)); this.paint(); }
    invert() {
      const next = new Set();
      this.visible().forEach(x => { if (!this.sel.has(x.name)) next.add(x.name); });
      this.sel = next;
      this.paint();
    }

    // ── rubber-band selection ──
    // Press on empty space (or on the size/date cells of an unselected row) and drag.
    // Grabbing an item's icon/name, or any part of an already-selected row, drags the files instead.
    onMouseDown(e) {
      if (e.button !== 0) return;
      const list = this.list;
      if (e.target === list && (e.offsetX >= list.clientWidth || e.offsetY >= list.clientHeight)) return; // scrollbar
      const row = e.target.closest('.fp-row');
      if (row && (e.target.closest('.fp-name i, .fp-name b') || this.sel.has(row.dataset.name))) return;
      e.preventDefault();          // no text selection, no native drag
      list.focus();
      setActive(this.id);
      if (row) row.draggable = false;
      this.startMarquee(e, row);
    }

    startMarquee(e, row) {
      const list = this.list;
      const toggle = e.ctrlKey || e.metaKey;
      const additive = toggle || e.shiftKey;
      const base = additive ? new Set(this.sel) : new Set();
      const m = { cx: e.clientX, cy: e.clientY, active: false, raf: 0, box: null, rows: null, cancel: null };
      const pt = () => {           // pointer in list content coordinates, clamped to the content
        const r = list.getBoundingClientRect();
        return [clamp(m.cx - r.left + list.scrollLeft, 0, list.scrollWidth),
                clamp(m.cy - r.top + list.scrollTop, 0, list.scrollHeight)];
      };
      const [sx, sy] = pt();

      const update = () => {
        const [x, y] = pt();
        const L = Math.min(sx, x), T = Math.min(sy, y), W = Math.abs(x - sx), H = Math.abs(y - sy);
        m.box.style.cssText = `left:${L}px;top:${T}px;width:${W}px;height:${H}px`;
        const hit = new Set();
        for (const r of m.rows) if (r.bottom > T && r.top < T + H) hit.add(r.name);
        let next;
        if (toggle) { next = new Set(base); for (const n of hit) if (!next.delete(n)) next.add(n); }
        else if (additive) next = new Set([...base, ...hit]);
        else next = hit;
        for (const r of m.rows) {
          const on = next.has(r.name);
          if (on !== r.on) { r.on = on; r.el.classList.toggle('sel', on); }
        }
        this.sel = next;
      };

      const tick = () => {         // scroll while the pointer is near the top/bottom edge
        if (!m.active) return;
        const r = list.getBoundingClientRect(), edge = 28;
        let dy = 0;
        if (m.cy < r.top + edge) dy = -Math.ceil((r.top + edge - m.cy) / 4) - 2;
        else if (m.cy > r.bottom - edge) dy = Math.ceil((m.cy - (r.bottom - edge)) / 4) + 2;
        if (dy) { list.scrollTop += clamp(dy, -40, 40); update(); }
        m.raf = requestAnimationFrame(tick);
      };

      const activate = () => {
        m.active = true;
        m.box = document.createElement('div');
        m.box.className = 'marquee';
        list.appendChild(m.box);
        m.rows = [...list.querySelectorAll('.fp-row')].map(el => ({
          el, name: el.dataset.name, top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight,
          on: this.sel.has(el.dataset.name),
        }));
        tick();
      };

      const onMove = ev => {
        if (!(ev.buttons & 1)) { finish(false); return; }     // button released outside the window
        m.cx = ev.clientX; m.cy = ev.clientY;
        if (!m.active) {
          if (Math.abs(ev.clientX - e.clientX) < 4 && Math.abs(ev.clientY - e.clientY) < 4) return;
          activate();
        }
        update();
      };
      const onUp = () => finish(false);
      const finish = cancelled => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        cancelAnimationFrame(m.raf);
        if (row) row.draggable = true;
        if (m.box) m.box.remove();
        const was = m.active;
        m.active = false;
        if (this.marquee === m) this.marquee = null;
        if (was && !cancelled) {
          this.anchor = [...this.sel][0] ?? null;
          this.updateInfo();
          this.suppressClick = true;                 // swallow the click that follows mouseup
          setTimeout(() => { this.suppressClick = false; }, 0);
        }
      };
      m.cancel = () => finish(true);
      this.marquee = m;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    }

    // ── context menu & clipboard ──
    onContext(e) {
      e.preventDefault();
      if (this.marquee) return;
      setActive(this.id);
      this.list.focus();
      const row = e.target.closest('.fp-row');
      if (row) {
        const name = row.dataset.name;
        // Like Explorer: right-clicking inside the selection keeps it, outside selects just that item.
        if (!this.sel.has(name)) { this.sel = new Set([name]); this.anchor = name; this.paint(); }
      } else if (this.sel.size) {
        this.sel.clear(); this.paint();
      }
      showMenu(e.clientX, e.clientY, this.menuItems());
    }

    menuItems() {
      const names = [...this.sel];
      const here = n => joinPath(this.path, n);
      const other = panes[this.id === 'L' ? 'R' : 'L'];
      if (!names.length) {
        return [
          { label: '粘贴', hint: 'Ctrl+V', disabled: !clip, run: () => this.paste(this.path) },
          'sep',
          { label: '新建文件夹', run: () => this.mkdir() },
          { label: '刷新', run: () => this.load(this.path, { push: false }) },
          'sep',
          { label: '全选', hint: 'Ctrl+A', run: () => this.selectAll() },
          { label: '反选', run: () => this.invert() },
          'sep',
          { label: '复制当前路径', run: () => this.copyPaths([this.path]) },
        ];
      }
      const one = names.length === 1 ? this.entries.find(x => x.name === names[0]) : null;
      const isDir = !!one && one.type === 'dir';
      const items = [];
      if (isDir) items.push({ label: '打开', hint: 'Enter', run: () => this.load(here(one.name)) }, 'sep');
      items.push(
        { label: '复制到另一栏', title: other.path, disabled: !other.path,
          run: () => doTransfer(names.map(here), other.path, 'copy') },
        { label: '移动到另一栏', title: other.path, disabled: !other.path || other.path === this.path,
          run: () => doTransfer(names.map(here), other.path, 'move') },
        'sep',
        { label: '复制', hint: 'Ctrl+C', run: () => this.clipSet('copy') },
        { label: '剪切', hint: 'Ctrl+X', run: () => this.clipSet('move') },
      );
      if (isDir) items.push({ label: '粘贴到此文件夹', disabled: !clip, run: () => this.paste(here(one.name)) });
      items.push(
        'sep',
        { label: '重命名', hint: 'F2', disabled: names.length !== 1, run: () => this.rename() },
        { label: '删除', hint: 'Del', danger: true, run: () => this.remove() },
        'sep',
        { label: names.length > 1 ? '复制路径（多项）' : '复制路径', run: () => this.copyPaths(names.map(here)) },
      );
      return items;
    }

    clipSet(op) {
      if (!this.sel.size) { toast('请先选中项目', true); return; }
      clip = { dir: this.path, names: [...this.sel], op };
      refreshCut();
      toast(`${op === 'move' ? '✂️ 已剪切' : '📋 已复制'} ${clip.names.length} 项，到目标位置右键或按 Ctrl+V 粘贴`);
    }

    async paste(dest) {
      if (!clip) { toast('剪贴板为空', true); return; }
      if (!dest) return;
      const c = clip;
      if (c.op === 'move' && c.dir === dest) { toast('已经在该位置'); return; }
      const started = await doTransfer(c.names.map(n => joinPath(c.dir, n)), dest, c.op);
      if (started && c.op === 'move' && clip === c) { clip = null; refreshCut(); }
    }

    async copyPaths(paths) {
      const ok = await copyText(paths.join('\n'));
      toast(ok ? '📋 已复制路径' : '❌ 无法写入剪贴板', !ok);
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

  // Resolves true once a transfer was accepted by the server, false if it was refused or cancelled.
  async function doTransfer(sources, destDir, opName, onConflict) {
    const r = await api('POST', '/fs/transfer', { sources, destDir, op: opName, onConflict });
    if (!r.ok && r.conflicts) {
      const choice = await conflictDialog(r.conflicts, destDir);
      return choice ? doTransfer(sources, destDir, opName, choice) : false;
    }
    if (!r.ok) { toast('❌ ' + r.output, true); return false; }
    if (r.count === 0) { toast('没有需要传输的项目'); refreshAll(); }
    return true;
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
      // Finished rows clean themselves up; failures linger longer and can be dismissed.
      const drop = () => { x.el.remove(); xfers.delete(d.id); };
      if (!ok && d.status !== 'cancelled') {
        const b = document.createElement('button');
        b.className = 'btn btn-ghost btn-sm'; b.textContent = '×'; b.title = '关闭'; b.onclick = drop;
        x.el.querySelector('.xfer-top').appendChild(b);
      }
      setTimeout(drop, ok ? 10000 : d.status === 'cancelled' ? 3000 : 30000);
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
      host.innerHTML = '<div class="empty" style="grid-column:1/-1">没有可浏览的目录。请添加并挂载存储，或用环境变量 FS_ROOTS 指定容器内的本地目录。</div>';
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
