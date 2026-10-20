/* 阅读器：PDF（pdf.js 懒渲染）与 Office 文档（PPTX/DOCX → HTML 页）统一阅读模型 */
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const Reader = {
  doc: null,          /* 文档元数据 */
  kind: 'pdf',        /* pdf | pptx | docx */
  pdf: null,          /* pdfjs document */
  htmlPages: null,    /* Office: [{html, text, lines}] */
  outlineData: null,  /* Office: 大纲 */
  numPages: 0,
  scale: 1.15,
  pages: [],          /* {num, el, wrap, rendered, textItems} */
  observer: null,
  currentPage: 1,
  color: '#ffd43b',

  async open(meta) {
    this.doc = meta;
    this.kind = meta.kind || Office.kindOf(meta.name) || 'pdf';
    const blob = await Store.getFile(meta.id, meta);
    if (!blob) throw new Error('找不到课件文件（可能已被清理）');
    const buf = await blob.arrayBuffer();

    this.pages = [];
    this.currentPage = 1;
    $('#reader-title').textContent = meta.name;
    $('#page-input').value = 1;

    const scroll = $('#pages-scroll');
    scroll.innerHTML = '';
    if (this.observer) { this.observer.disconnect(); this.observer = null; }

    if (this.kind === 'pdf') {
      this.htmlPages = null;
      this.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      this.numPages = this.pdf.numPages;
      this.observer = new IntersectionObserver(es => {
        es.forEach(e => { if (e.isIntersecting) this.renderPage(+e.target.dataset.num); });
      }, { root: scroll, rootMargin: '600px 0px' });
      for (let n = 1; n <= this.numPages; n++) {
        const wrap = document.createElement('div');
        wrap.className = 'page-wrap';
        wrap.dataset.num = n;
        wrap.innerHTML = '<div class="canvas-box"><div class="page-placeholder"></div></div><div class="page-num">' + n + ' / ' + this.numPages + '</div>';
        scroll.appendChild(wrap);
        this.pages.push({ num: n, wrap, rendered: false, textItems: null });
        this.observer.observe(wrap);
      }
    } else {
      /* Office：一次性解析并渲染全部页 */
      this.pdf = null;
      const parsed = await Office.parse(this.kind, buf);
      this.htmlPages = parsed.pages;
      this.outlineData = parsed.outline;
      this.numPages = parsed.pages.length;
      for (let n = 1; n <= this.numPages; n++) {
        const wrap = document.createElement('div');
        wrap.className = 'page-wrap html-doc';
        wrap.dataset.num = n;
        wrap.innerHTML = '<div class="page-html">' + parsed.pages[n - 1].html + '</div><div class="annot-layer"></div><div class="page-num">' + n + ' / ' + this.numPages + '</div>';
        scroll.appendChild(wrap);
        this.pages.push({ num: n, wrap, rendered: true, textItems: null });
      }
      this.applyHtmlZoom();
    }

    $('#page-total').textContent = this.numPages;
    this.updateZoomLabel();

    /* 当前页跟踪 */
    scroll.onscroll = () => {
      const mid = scroll.scrollTop + scroll.clientHeight / 2;
      let cur = this.currentPage;
      for (const p of this.pages) {
        const top = p.wrap.offsetTop;
        if (top <= mid) cur = p.num; else break;
      }
      if (cur !== this.currentPage) {
        this.currentPage = cur;
        $('#page-input').value = cur;
        if (this.kind === 'pdf') Annotate.renderAll();
        Translate.onPageChange();
      }
    };

    App.show('reader');
    $('#crumb').textContent = meta.name;
    Annotate.load(meta.id);
    Translate.onPageChange();
    QA.setDoc(meta);
    this.buildOutline();
    $('#btn-export').innerHTML = this.kind === 'pdf' ? '导出标注 PDF' : '导出标注稿';
  },

  /* 目录大纲：PDF 用内置 outline；Office 用幻灯片标题 / Word 标题 */
  async buildOutline() {
    const list = $('#outline-list');
    if (this.kind !== 'pdf') {
      const ol = this.outlineData || [];
      const meaningful = ol.filter(o => o.title && !/^第 \d+ 页$/.test(o.title));
      if (!meaningful.length) {
        list.innerHTML = '<div class="outline-empty">未检测到标题结构<br>可使用 AI 问答直接提问</div>';
        return;
      }
      list.innerHTML = ol.map(o =>
        '<button class="outline-item" data-pg="' + o.page + '" style="padding-left:' + (10 + (o.depth || 0) * 14) + 'px">' + escapeHtml(o.title) + '</button>'
      ).join('');
      return;
    }
    let ol = null;
    try { ol = await this.pdf.getOutline(); } catch (e) {}
    if (!ol || !ol.length) { list.innerHTML = '<div class="outline-empty">此 PDF 没有内置目录<br>可使用 AI 问答直接提问</div>'; return; }
    const flat = [];
    const walk = async (items, depth) => {
      for (const it of items) {
        let page = 0;
        try {
          if (it.dest) {
            let dest = it.dest;
            if (typeof dest === 'string') dest = await this.pdf.getDestination(dest);
            if (dest && dest[0] && typeof dest[0] === 'object') page = (await this.pdf.getPageIndex(dest[0])) + 1;
          }
        } catch (e) {}
        flat.push({ title: it.title || '(无标题)', page, depth });
        if (it.items && it.items.length) await walk(it.items, depth + 1);
      }
    };
    await walk(ol, 0);
    this.outline = flat;
    list.innerHTML = flat.map(o =>
      '<button class="outline-item" data-pg="' + o.page + '" style="padding-left:' + (10 + o.depth * 14) + 'px' + (o.page ? '' : ';opacity:.45') + '">' + escapeHtml(o.title) + '</button>'
    ).join('');
  },

  async renderPage(n) {
    const p = this.pages[n - 1];
    if (!p || p.rendered) return;
    p.rendered = true;
    const page = await this.pdf.getPage(n);
    const viewport = page.getViewport({ scale: this.scale });
    const box = p.wrap.querySelector('.canvas-box');
    box.innerHTML = '';

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    box.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    /* 文本层（支持划选）。pdf.js 3.x 的 span 定位全部依赖 --scale-factor，
       必须设在容器或祖先上，否则文本全部堆在左上角 → 划选完全失效 */
    box.style.setProperty('--scale-factor', viewport.scale);
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    tl.style.width = viewport.width + 'px';
    tl.style.height = viewport.height + 'px';
    box.appendChild(tl);
    const tc = await page.getTextContent();
    p.textItems = tc.items;
    await pdfjsLib.renderTextLayer({ textContent: tc, container: tl, viewport }).promise;
    const eoc = document.createElement('div');
    eoc.className = 'endOfContent';
    tl.appendChild(eoc);

    /* 标注层 */
    const al = document.createElement('div');
    al.className = 'annot-layer';
    box.appendChild(al);

    p.wrap.style.width = Math.floor(viewport.width) + 'px';
    Annotate.renderPage(n);
  },

  /* Office 文档缩放：CSS zoom 不影响文本锚点，无需重绘标注 */
  applyHtmlZoom() {
    document.querySelectorAll('#pages-scroll .page-html').forEach(el => {
      el.style.zoom = this.scale;
    });
    /* 页宽随 zoom 变化 → 笔迹画布尺寸需同步重绘 */
    if (window.Annotate && Annotate.docId) Annotate.renderAll();
  },

  async rerenderAll() {
    if (this.kind !== 'pdf') { this.applyHtmlZoom(); return; }
    for (const p of this.pages) {
      p.rendered = false;
      const box = p.wrap.querySelector('.canvas-box');
      if (box) box.innerHTML = '<div class="page-placeholder"></div>';
    }
    this.observer.disconnect();
    for (const p of this.pages) this.observer.observe(p.wrap);
    /* 优先渲染当前页 */
    this.renderPage(this.currentPage);
    const cur = this.pages[this.currentPage - 1];
    if (cur) $('#pages-scroll').scrollTop = cur.wrap.offsetTop - 20;
  },

  setZoom(delta) {
    const z = Math.round((this.scale + delta) * 100) / 100;
    this.scale = Math.min(3, Math.max(0.5, z));
    this.updateZoomLabel();
    this.rerenderAll();
  },
  updateZoomLabel() { $('#zoom-label').textContent = Math.round(this.scale * 100) + '%'; },

  goto(n) {
    n = Math.min(this.numPages, Math.max(1, n | 0));
    const p = this.pages[n - 1];
    if (p) {
      if (this.kind === 'pdf') this.renderPage(n);
      $('#pages-scroll').scrollTop = p.wrap.offsetTop - 20;
    }
    this.currentPage = n;
    $('#page-input').value = n;
  },

  /* 将 pdf.js 文本项按行分组（同一 y 坐标归为一行），供翻译与 RAG 使用 */
  groupLines(items) {
    const rows = [];
    for (const it of items) {
      if (!it.str || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      const row = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (row) { row.items.push({ x, str: it.str }); row.y = (row.y + y) / 2; }
      else rows.push({ y, items: [{ x, str: it.str }] });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.str).join('').trim()).filter(Boolean);
  },

  async pageLines(n) {
    if (this.kind !== 'pdf') {
      const pg = this.htmlPages && this.htmlPages[n - 1];
      return pg ? pg.lines.filter(l => l.trim()) : [];
    }
    const p = this.pages[n - 1];
    if (!p) return [];
    if (!p.textItems) {
      const page = await this.pdf.getPage(n);
      p.textItems = (await page.getTextContent()).items;
    }
    return this.groupLines(p.textItems);
  },

  back() {
    if (this.observer) this.observer.disconnect();
    this.pdf = null;
    this.htmlPages = null;
    this.outlineData = null;
    App.show('library');
    Library.render();
  }
};
