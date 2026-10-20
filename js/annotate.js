/* 标注：① 划选高亮 + 便签笔记  ② 手写笔迹（画笔 / 荧光笔 / 橡皮）
   两类标注统一存 Store：type = 'hl'（矩形或文本锚点）| 'ink'（归一化笔画） */
const Annotate = {
  list: [],            /* 当前文档全部标注 */
  docId: null,
  _sel: null,          /* {page, rects} 待处理的划选 */
  _noteTarget: null,   /* 正在编辑的标注 id */

  /* ---- 手写工具状态 ---- */
  tool: 'select',      /* select | pen | marker | eraser */
  penSize: 4,          /* 2 细 / 4 中 / 7 粗（基准宽 860px） */
  _drawing: false,
  _cur: null,          /* 正在书写的一笔 {points:[{x,y}]} */
  _curWrap: null,
  _undo: [],

  async load(docId) {
    this.docId = docId;
    try { this.list = await Store.listAnnotations(docId); } catch (e) { this.list = []; toast('标注加载失败：' + e.message, 'err'); }
    this._undo = [];
    this.setTool('select');
    this.renderAll();
    this.renderSideList();
  },

  init() {
    /* 划选监听（仅选择模式生效） */
    document.addEventListener('mouseup', e => {
      if (App.view !== 'reader') return;
      if (this.tool !== 'select') return;
      if (e.target.closest('#sel-popup') || e.target.closest('#note-popup')) return;
      setTimeout(() => this.onSelection(e), 10);
    });
    document.addEventListener('mousedown', e => {
      if (!e.target.closest('#sel-popup') && !e.target.closest('#note-popup')) {
        $('#sel-popup').classList.remove('show');
        $('#note-popup').classList.remove('show');
      }
    });
    /* 高亮色：黑 / 红 / 蓝 / 黄 */
    $('#color-dots').innerHTML = ['#2b2f36', '#e5484d', '#2f6fed', '#ffd43b'].map(c =>
      '<div class="color-dot' + (c === '#ffd43b' ? ' sel' : '') + '" data-color="' + c + '" style="background:' + c + '"></div>').join('');
    $('#color-dots').addEventListener('click', e => {
      const d = e.target.closest('.color-dot'); if (!d) return;
      $('#color-dots').querySelectorAll('.color-dot').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      Reader.color = d.dataset.color;
    });
    /* 划选弹层按钮 */
    $('#sel-popup').addEventListener('click', async e => {
      const d = e.target.closest('.color-dot');
      if (d) {
        $('#sel-popup').classList.remove('show');
        if (this._sel) await this.save(this._sel.page, this._sel.rects, d.dataset.color, '');
        this._sel = null;
        return;
      }
      if (e.target.closest('#sel-note-btn')) {
        const sel = this._sel; if (!sel) return;
        this.openNoteEditor(sel, null, e.clientX, e.clientY);
        return;
      }
      if (e.target.closest('#sel-ai-btn')) {
        const sel = this._sel;
        $('#sel-popup').classList.remove('show');
        if (sel) QA.askAboutSelection(this._selText || '', sel.page);
        this._sel = null;
      }
    });
    /* 笔记弹层 */
    $('#note-save').addEventListener('click', () => this.saveNote());
    $('#note-delete').addEventListener('click', () => this.deleteNote());
    /* 点击 HTML 文档上的高亮 → 打开笔记编辑 */
    $('#pages-scroll').addEventListener('click', e => {
      const m = e.target.closest('mark.hl-html');
      if (!m || this.tool !== 'select') return;
      const a = this.list.find(x => x.id === m.dataset.ann);
      if (a) this.openNoteEditor(null, a, e.clientX, e.clientY);
    });

    /* ---- 手写工具 ---- */
    $('#tool-group').addEventListener('click', e => {
      const b = e.target.closest('.tool-btn'); if (b) this.setTool(b.dataset.tool);
    });
    $('#pen-sizes').addEventListener('click', e => {
      const b = e.target.closest('button[data-size]'); if (!b) return;
      this.penSize = +b.dataset.size;
      $('#pen-sizes').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
    });
    $('#btn-undo').addEventListener('click', () => this.undo());

    const scroll = $('#pages-scroll');
    scroll.addEventListener('pointerdown', e => this.onPointerDown(e));
    scroll.addEventListener('pointermove', e => this.onPointerMove(e));
    scroll.addEventListener('pointerup', e => this.onPointerUp(e));
    scroll.addEventListener('pointercancel', e => this.onPointerUp(e));
    scroll.addEventListener('pointerleave', e => this.onPointerUp(e));

    document.addEventListener('keydown', e => {
      if (App.view !== 'reader') return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const k = (e.key || '').toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); this.undo(); return; }
      const map = { v: 'select', p: 'pen', m: 'marker', e: 'eraser' };
      const t = map[k];
      if (t) { e.preventDefault(); this.setTool(t); }
    });

    this.setTool('select');
  },

  /* ---------------- 工具切换 ---------------- */

  setTool(t) {
    this.tool = t;
    document.querySelectorAll('#tool-group .tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    const scroll = $('#pages-scroll');
    scroll.classList.toggle('inking', t === 'pen' || t === 'marker');
    scroll.classList.toggle('erasing', t === 'eraser');
    const sizes = $('#pen-sizes');
    if (sizes) sizes.style.display = (t === 'pen' || t === 'marker') ? '' : 'none';
    if (t !== 'select') {
      $('#sel-popup').classList.remove('show');
      try { window.getSelection().removeAllRanges(); } catch (e) {}
    }
  },

  /* ---------------- 划选高亮 ---------------- */

  onSelection(e) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) { $('#sel-popup').classList.remove('show'); return; }
    const range = sel.getRangeAt(0);
    const norm = n => n.nodeType === 3 ? n.parentElement : n;
    const startEl = norm(range.startContainer);
    const pageWrap = startEl && startEl.closest && startEl.closest('.page-wrap');
    if (!pageWrap) { $('#sel-popup').classList.remove('show'); return; }

    /* 划选内容需在同一页内 */
    const endEl = norm(range.endContainer);
    const endWrap = endEl && endEl.closest && endEl.closest('.page-wrap');
    if (endWrap !== pageWrap) { toast('跨页划选暂不支持，请分页标注', 'err'); sel.removeAllRanges(); return; }

    const page = +pageWrap.dataset.num;

    /* Office 文档：文本锚点（原文 + 前后文），不依赖坐标 */
    if (pageWrap.classList.contains('html-doc')) {
      const pageEl = pageWrap.querySelector('.page-html');
      if (!pageEl || !pageEl.contains(startEl)) { $('#sel-popup').classList.remove('show'); return; }
      const map = this._textMap(pageEl);
      const off = (c, o) => { const it = map.nodes.find(x => x.node === c); return it ? it.start + o : -1; };
      const s = off(range.startContainer, range.startOffset);
      const en = off(range.endContainer, range.endOffset);
      let exact = (s >= 0 && en >= s) ? map.text.slice(s, en) : sel.toString();
      exact = exact.replace(/\s+/g, ' ').trim();
      if (!exact) return;
      const anchor = s >= 0 && en >= s ? {
        exact: map.text.slice(s, en),
        prefix: map.text.slice(Math.max(0, s - 24), s),
        suffix: map.text.slice(en, en + 24)
      } : { exact, prefix: '', suffix: '' };
      this._sel = { page, rects: [], anchor };
      this._selText = exact;
      const pop = $('#sel-popup');
      pop.classList.add('show');
      pop.style.left = Math.min(e.clientX, window.innerWidth - 230) + 'px';
      pop.style.top = (e.clientY > 120 ? e.clientY - 54 : e.clientY + 16) + 'px';
      return;
    }

    /* PDF：矩形归一化 */
    const box = startEl && startEl.closest && startEl.closest('.canvas-box');
    if (!box) { $('#sel-popup').classList.remove('show'); return; }
    const br = box.getBoundingClientRect();
    const rects = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      rects.push({ x: (r.left - br.left) / br.width, y: (r.top - br.top) / br.height, w: r.width / br.width, h: r.height / br.height });
    }
    if (!rects.length) return;
    rects.sort((a, b) => a.y - b.y);
    this._sel = { page, rects };
    this._selText = sel.toString();

    const pop = $('#sel-popup');
    pop.classList.add('show');
    const px = Math.min(e.clientX, window.innerWidth - 230);
    const py = e.clientY > 120 ? e.clientY - 54 : e.clientY + 16;
    pop.style.left = px + 'px'; pop.style.top = py + 'px';
  },

  openNoteEditor(sel, annot, x, y) {
    this._noteTarget = annot ? annot : { page: sel.page, rects: sel.rects || [], anchor: sel.anchor || null };
    $('#note-text').value = annot ? (annot.note || '') : '';
    $('#sel-popup').classList.remove('show');
    if (sel) window.getSelection().removeAllRanges();
    const pop = $('#note-popup');
    pop.classList.add('show');
    pop.style.left = Math.min(x, window.innerWidth - 270) + 'px';
    pop.style.top = Math.min(y, window.innerHeight - 220) + 'px';
    setTimeout(() => $('#note-text').focus(), 50);
  },

  async save(page, rects, color, note, anchor) {
    const a = {
      id: uid(), docId: this.docId, type: 'hl',
      page, rects: rects || [], color, note,
      anchor: anchor || null,
      excerpt: anchor ? (anchor.exact || '').replace(/\s+/g, ' ').slice(0, 120) : '',
      created: Date.now()
    };
    const saved = await Store.saveAnnotation(a);
    const rec = saved || a;
    this.list.push(rec);
    this.pushUndo({ kind: 'add', annot: rec });
    this.renderPage(page);
    this.renderSideList();
    if (note) toast('笔记已保存', 'ok');
  },

  async saveNote() {
    const t = this._noteTarget; if (!t) return;
    const text = $('#note-text').value.trim();
    $('#note-popup').classList.remove('show');
    if (t.id) {
      const a = this.list.find(x => x.id === t.id);
      if (a) { a.note = text; await Store.saveAnnotation(a); this.renderPage(a.page); this.renderSideList(); toast('笔记已更新', 'ok'); }
      return;
    }
    await this.save(t.page, t.rects, Reader.color, text, t.anchor);
  },

  async deleteNote() {
    const t = this._noteTarget;
    $('#note-popup').classList.remove('show');
    if (!t || !t.id) return;
    await this.deleteAnnotation(t.id);
    toast('标注已删除', 'ok');
  },

  /* ---------------- 手写笔迹 ---------------- */

  /* 笔画坐标基准：PDF 用 canvas-box，Office 用 page-html（均为 CSS 像素） */
  _baseRect(wrap) {
    const box = wrap.querySelector('.canvas-box') || wrap.querySelector('.page-html');
    return box ? box.getBoundingClientRect() : wrap.getBoundingClientRect();
  },

  _w(w) {
    const dpr = window.devicePixelRatio || 1;
    return Math.max(1, (w || 3) * dpr * 0.85);
  },

  onPointerDown(e) {
    if (App.view !== 'reader' || this.tool === 'select') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const wrap = e.target.closest && e.target.closest('.page-wrap');
    if (!wrap || !e.target.closest('#pages-scroll')) return;
    if (e.target.closest('.page-num')) return;
    const page = +wrap.dataset.num;
    const r = this._baseRect(wrap);
    const pt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };

    if (this.tool === 'eraser') {
      this._drawing = true;
      this._curWrap = null;
      this._eraseAt(wrap, pt);
      e.preventDefault();
      return;
    }

    this._drawing = true;
    this._curWrap = wrap;
    this._cur = { id: uid(), type: 'ink', page, tool: this.tool, color: Reader.color, size: this.penSize, points: [pt] };
    const c = this._inkCtx(wrap, r.width, r.height);
    if (c) this._paintDot(c, this._cur, r.width, r.height);
    try { wrap.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  },

  onPointerMove(e) {
    if (!this._drawing) return;
    const wrap = this._curWrap;
    if (!wrap) {
      if (this.tool === 'eraser') {
        const w = e.target.closest && e.target.closest('.page-wrap');
        if (w) this._eraseAt(w, this._pt(e, w));
      }
      return;
    }
    const r = this._baseRect(wrap);
    const pt = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    const P = this._cur.points;
    const last = P[P.length - 1];
    if (Math.hypot((pt.x - last.x) * r.width, (pt.y - last.y) * r.height) < 1.2) return;
    P.push(pt);
    if (P.length > 1500) { this.finishStroke(); this._drawing = false; return; }
    const c = this._inkCtx(wrap, r.width, r.height);
    if (c) this._paintSeg(c, this._cur, r.width, r.height);
  },

  onPointerUp() {
    if (!this._drawing) return;
    this._drawing = false;
    if (this._cur) this.finishStroke();
  },

  async finishStroke() {
    const a = this._cur; this._cur = null; this._curWrap = null;
    if (!a || !a.points || !a.points.length) return;
    const rec = Object.assign({}, a, { docId: this.docId, created: Date.now() });
    /* 先落本地再同步：云端失败不阻塞撤销/继续书写，只提示 */
    this.list.push(rec);
    this.pushUndo({ kind: 'add', annot: rec });
    this.renderSideList();
    try { await Store.saveAnnotation(rec); } catch (e) { toast('笔迹同步失败（已保留在本机）：' + e.message, 'err'); }
  },

  /* 橡皮：优先命中手写笔画（点到线段距离），再命中高亮矩形 / <mark> */
  _eraseAt(wrap, pt) {
    const page = +wrap.dataset.num;
    const r = this._baseRect(wrap);
    const px = pt.x * r.width, py = pt.y * r.height;
    let best = null, bestD = Infinity;
    for (const a of this.list) {
      if (a.page !== page || a.type !== 'ink') continue;
      const P = a.points || [];
      const lw = this._lw(a, r.width);
      for (let i = 1; i < P.length; i++) {
        const d = distToSeg(px, py, P[i - 1].x * r.width, P[i - 1].y * r.height, P[i].x * r.width, P[i].y * r.height);
        if (d < lw / 2 + 6 && d < bestD) { bestD = d; best = a; }
      }
      if (P.length === 1) {
        const d = Math.hypot(px - P[0].x * r.width, py - P[0].y * r.height);
        if (d < lw / 2 + 6 && d < bestD) { bestD = d; best = a; }
      }
    }
    if (best) { this.deleteAnnotation(best.id); return; }
    for (const a of this.list) {
      if (a.page !== page || a.type === 'ink') continue;
      for (const rc of (a.rects || [])) {
        if (px >= rc.x * r.width && px <= (rc.x + rc.w) * r.width && py >= rc.y * r.height && py <= (rc.y + rc.h) * r.height) {
          this.deleteAnnotation(a.id); return;
        }
      }
    }
  },

  _lw(a, W) { return Math.max(1.2, (a.size || 3) * (W / 860)); },

  /* 取得/同步页面笔迹画布，尺寸变化时自动复位 */
  _inkCtx(wrap, W, H) {
    const layer = wrap.querySelector('.annot-layer');
    if (!layer) return null;
    let cv = layer.querySelector('canvas.ink-layer');
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.className = 'ink-layer';
      layer.appendChild(cv);
    }
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw; cv.height = ph;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  },

  _style(ctx, a, W) {
    const lw = this._lw(a, W);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = a.color || '#2b2f36';
    ctx.fillStyle = a.color || '#2b2f36';
    ctx.lineWidth = a.tool === 'marker' ? lw * 3.4 : lw;
    ctx.globalAlpha = a.tool === 'marker' ? 0.3 : 1;
    return lw;
  },

  _paintDot(ctx, a, W, H) {
    const lw = this._style(ctx, a, W);
    const P = a.points;
    ctx.beginPath();
    ctx.arc(P[0].x * W, P[0].y * H, lw / 2, 0, Math.PI * 2);
    ctx.fill();
  },

  /* 绘制最后一段（书写过程中增量渲染，保证流畅） */
  _paintSeg(ctx, a, W, H) {
    const P = a.points, n = P.length;
    if (n < 2) return;
    this._style(ctx, a, W);
    const p = P[n - 2], q = P[n - 1];
    ctx.beginPath();
    ctx.moveTo(p.x * W, p.y * H);
    ctx.lineTo(q.x * W, q.y * H);
    ctx.stroke();
  },

  /* 全量重绘一页笔迹 */
  _paintStroke(ctx, a, W, H) {
    const P = a.points || [];
    if (!P.length) return;
    this._style(ctx, a, W);
    if (P.length === 1) { ctx.beginPath(); ctx.arc(P[0].x * W, P[0].y * H, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath();
    ctx.moveTo(P[0].x * W, P[0].y * H);
    for (let i = 1; i < P.length - 1; i++) {
      const p = P[i], q = P[i + 1];
      ctx.quadraticCurveTo(p.x * W, p.y * H, (p.x + q.x) / 2 * W, (p.y + q.y) / 2 * H);
    }
    const last = P[P.length - 1];
    ctx.lineTo(last.x * W, last.y * H);
    ctx.stroke();
  },

  /* ---------------- 撤销 ---------------- */

  pushUndo(op) { this._undo.push(op); if (this._undo.length > 80) this._undo.shift(); },

  async undo() {
    const op = this._undo.pop();
    if (!op) return toast('没有可撤销的操作', 'err');
    if (op.kind === 'add') {
      const i = this.list.findIndex(x => x.id === op.annot.id);
      if (i >= 0) this.list.splice(i, 1);
      await Store.deleteAnnotation(op.annot.id);
      this.renderPage(op.annot.page);
      this.renderSideList();
      toast('已撤销', 'ok');
    } else {
      await Store.saveAnnotation(op.annot);
      this.list.push(op.annot);
      this.renderPage(op.annot.page);
      this.renderSideList();
      toast('已恢复', 'ok');
    }
  },

  async deleteAnnotation(id, silent) {
    const i = this.list.findIndex(x => x.id === id);
    if (i < 0) return;
    const a = this.list[i];
    await Store.deleteAnnotation(id);
    this.list.splice(i, 1);
    this.pushUndo({ kind: 'del', annot: a });
    this.renderPage(a.page);
    this.renderSideList();
    if (!silent) toast('标注已删除', 'ok');
  },

  hexRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  },

  renderPage(n) {
    if (Reader.kind !== 'pdf') this.renderHtmlPage(n);
    else this.renderPdfPage(n);
    this.renderInk(n);
  },

  renderPdfPage(n) {
    const p = Reader.pages[n - 1];
    if (!p || !p.rendered) return;
    const layer = p.wrap.querySelector('.annot-layer');
    if (!layer) return;
    /* 坐标基准必须与书写时一致：统一用 getBoundingClientRect（clientWidth 在 Office 的 CSS zoom 下会失真） */
    const r = this._baseRect(p.wrap);
    const W = r.width, H = r.height;
    const annots = this.list.filter(a => a.page === n && a.type !== 'ink');
    let html = '';
    annots.forEach(a => {
      for (const r of (a.rects || [])) {
        html += '<div class="hl" style="left:' + (r.x * W) + 'px;top:' + (r.y * H) + 'px;width:' + (r.w * W) + 'px;height:' + (r.h * H) + 'px;background:' + this.hexRgba(a.color, 0.42) + '"></div>';
      }
      if (a.note) {
        const r0 = a.rects[0];
        if (r0) {
          const y = Math.max(2, r0.y * H - 24);
          html += '<div class="note-pin" data-id="' + a.id + '" style="left:' + (r0.x * W) + 'px;top:' + y + 'px"><span>' + ((a.note.length > 12) ? '✎' : escapeHtml(a.note.slice(0, 12))) + '</span></div>';
        }
      }
    });
    let holder = layer.querySelector('.hl-layer');
    if (!holder) { holder = document.createElement('div'); holder.className = 'hl-layer'; layer.appendChild(holder); }
    holder.innerHTML = html;
  },

  renderInk(n) {
    const p = Reader.pages[n - 1];
    if (!p || !p.rendered) return;
    const layer = p.wrap.querySelector('.annot-layer');
    if (!layer) return;
    const r = this._baseRect(p.wrap);
    const W = r.width, H = r.height;
    if (!W || !H) return;
    const ctx = this._inkCtx(p.wrap, W, H);
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    for (const a of this.list) if (a.type === 'ink' && a.page === n) this._paintStroke(ctx, a, W, H);
  },

  /* ---- Office 文档标注：文本锚点重定位 + <mark> 包裹 ---- */

  /* 页面纯文本与文本节点偏移映射（选区定位与锚点重放共用同一套坐标） */
  _textMap(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let text = '';
    const nodes = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      nodes.push({ node: n, start: text.length, end: text.length + n.nodeValue.length });
      text += n.nodeValue;
    }
    return { text, nodes };
  },

  renderHtmlPage(n) {
    const p = Reader.pages[n - 1];
    if (!p || !p.rendered || !Reader.htmlPages) return;
    const el = p.wrap.querySelector('.page-html');
    if (!el) return;
    /* 先还原原始 HTML（去掉旧 mark），再逐条重放锚点 */
    el.innerHTML = Reader.htmlPages[n - 1].html;
    for (const a of this.list.filter(x => x.page === n && x.anchor && x.type !== 'ink')) this._applyAnchor(el, a);
  },

  _applyAnchor(el, a) {
    const map = this._textMap(el);
    const exact = a.anchor.exact;
    if (!exact) return;
    let idx = -1, from = 0;
    while (true) {
      idx = map.text.indexOf(exact, from);
      if (idx < 0) return;
      const pre = map.text.slice(Math.max(0, idx - 24), idx);
      const post = map.text.slice(idx + exact.length, idx + exact.length + 24);
      if ((!a.anchor.prefix || pre.endsWith(a.anchor.prefix)) && (!a.anchor.suffix || post.startsWith(a.anchor.suffix))) break;
      from = idx + 1;
    }
    const start = idx, end = idx + exact.length;
    const color = this.hexRgba(a.color, 0.5);
    for (const item of map.nodes) {
      if (item.end <= start || item.start >= end) continue;
      const node = item.node;
      if (!node.parentNode) continue;
      const s = Math.max(0, start - item.start);
      const eOff = Math.min(node.nodeValue.length, end - item.start);
      if (s >= eOff) continue;
      const mid = node.splitText(s);
      mid.splitText(eOff - s);
      const mark = document.createElement('mark');
      mark.className = 'hl-html' + (a.note ? ' has-note' : '');
      mark.dataset.ann = a.id;
      mark.style.background = color;
      if (a.note) mark.title = a.note;
      mid.parentNode.replaceChild(mark, mid);
      mark.appendChild(mid);
    }
  },

  renderAll() { for (const p of Reader.pages) if (p.rendered) this.renderPage(p.num); },

  renderSideList() {
    const el = $('#annot-list');
    if (!el) return;
    if (!this.list.length) {
      el.innerHTML = '<div style="text-align:center;color:var(--dim);font-size:12px;padding:40px 10px;line-height:2">暂无标注<br>划选文字可高亮，或选「✏️」直接手写<br>两者都支持笔记与导出</div>';
      return;
    }
    el.innerHTML = this.list.slice().sort((a, b) => a.page - b.page || a.created - b.created).map(a => {
      if (a.type === 'ink') {
        return '<div class="annot-item" data-id="' + a.id + '" data-page="' + a.page + '">' +
          '<div class="head"><span class="swatch ink" style="background:' + a.color + '"></span><span class="pg">P' + a.page + '</span>' +
          '<span class="tag">' + (a.tool === 'marker' ? '荧光笔' : '手写') + '</span>' +
          '<button class="del" data-del="' + a.id + '">✕</button></div></div>';
      }
      return '<div class="annot-item" data-id="' + a.id + '" data-page="' + a.page + '">' +
        '<div class="head"><span class="swatch" style="background:' + a.color + '"></span><span class="pg">P' + a.page + '</span>' +
        '<span class="tag">高亮</span>' +
        '<button class="del" data-del="' + a.id + '">✕</button></div>' +
        (a.excerpt ? '<div class="quote">「' + escapeHtml(a.excerpt.slice(0, 60)) + (a.excerpt.length > 60 ? '…' : '') + '」</div>' : '') +
        (a.note ? '<div class="note">' + escapeHtml(a.note) + '</div>' : '') +
        '</div>';
    }).join('');
  }
};

/* 点到线段距离（橡皮命中判定） */
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - x1) * dx + (py - y1) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
