/* 课件库：多知识库（一门课一个）+ 文件/文件夹导入 + 跨库全文搜索 */
const Library = {
  libs: [],
  currentLib: '',       /* '' = 全部课件 */
  docsCache: [],

  async render() {
    this.docsCache = await Store.listDocs();
    this.renderLibs();
    this.renderDocs();
  },

  /* ---------- 知识库侧栏 ---------- */
  renderLibs() {
    const counts = {};
    for (const d of this.docsCache) if (d.libId) counts[d.libId] = (counts[d.libId] || 0) + 1;
    const unassigned = this.docsCache.filter(d => !d.libId).length;
    let html =
      '<div class="lib-item' + (this.currentLib === '' ? ' active' : '') + '" data-lib="">' +
      '<svg class="lib-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
      '<span class="nm">全部课件</span><span class="cnt">' + this.docsCache.length + '</span></div>';
    for (const lib of this.libs) {
      html += '<div class="lib-item' + (this.currentLib === lib.id ? ' active' : '') + '" data-lib="' + lib.id + '">' +
        '<svg class="lib-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z"/></svg>' +
        '<span class="nm" title="' + escapeHtml(lib.name) + '">' + escapeHtml(lib.name) + '</span>' +
        '<span class="cnt">' + (counts[lib.id] || 0) + '</span>' +
        '<span class="ops"><button data-rename="' + lib.id + '" title="重命名">✎</button><button data-rmlib="' + lib.id + '" title="删除">✕</button></span></div>';
    }
    if (unassigned) {
      html += '<div class="lib-item" style="opacity:.55" data-lib="__none__"><svg class="lib-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h10"/></svg><span class="nm">未分类</span><span class="cnt">' + unassigned + '</span></div>';
    }
    $('#lib-items').innerHTML = html;
  },

  async newLib() {
    const name = await Dlg.prompt('新建知识库', { placeholder: '例如：ENG2001 / 数据结构' });
    if (!name || !name.trim()) return;
    const lib = { id: uid(), name: name.trim(), created: Date.now() };
    await Store.saveLib(lib);
    this.libs.push(lib);
    this.currentLib = lib.id;
    this.render();
    toast('知识库「' + lib.name + '」已创建', 'ok');
  },

  async renameLib(id) {
    const lib = this.libs.find(l => l.id === id);
    if (!lib) return;
    const name = await Dlg.prompt('重命名知识库', { value: lib.name });
    if (!name || !name.trim() || name.trim() === lib.name) return;
    lib.name = name.trim();
    await Store.saveLib(lib);
    this.render();
  },

  async removeLib(id) {
    const lib = this.libs.find(l => l.id === id);
    if (!lib) return;
    const n = this.docsCache.filter(d => d.libId === id).length;
    if (!await Dlg.confirm('删除知识库', '将删除「' + lib.name + '」' + (n ? '及其中的 ' + n + ' 份课件（含标注/翻译/索引）' : '') + '，此操作不可恢复。', '删除')) return;
    for (const d of this.docsCache.filter(d => d.libId === id)) {
      try { await Store.deleteDoc(d.id); } catch (e) { console.error(e); }
    }
    await Store.deleteLib(id);
    this.libs = this.libs.filter(l => l.id !== id);
    if (this.currentLib === id) this.currentLib = '';
    this.render();
    toast('知识库已删除', 'ok');
  },

  async selectLib(id) {
    this.currentLib = id;
    this.render();
  },

  /* ---------- 文档列表 ---------- */
  async renderDocs() {
    const grid = $('#doc-grid');
    const kw = ($('#doc-search').value || '').trim().toLowerCase();
    const lib = this.libs.find(l => l.id === this.currentLib);
    $('#lib-title').textContent = this.currentLib === '' ? '全部课件' : (this.currentLib === '__none__' ? '未分类' : lib.name);

    let docs = this.docsCache.filter(d =>
      this.currentLib === '' ? true :
      this.currentLib === '__none__' ? !d.libId :
      d.libId === this.currentLib
    );

    /* 全文搜索：标题命中优先，其次内容（chunks 关键词） */
    let hits = null;
    if (kw) {
      const byName = docs.filter(d => (d.name || '').toLowerCase().includes(kw));
      const rest = docs.filter(d => !(d.name || '').toLowerCase().includes(kw));
      hits = {};
      for (const d of rest) {
        try {
          const cs = await Store.listChunks(d.id);
          const best = cs.filter(c => (c.text || '').toLowerCase().includes(kw)).sort((a, b) => b.text.length - a.text.length)[0];
          if (best) {
            const i = best.text.toLowerCase().indexOf(kw);
            hits[d.id] = '…' + best.text.slice(Math.max(0, i - 20), i + 60).replace(/\n/g, ' ') + '…（P' + best.page + '）';
          }
        } catch (e) {}
      }
      docs = byName.concat(rest.filter(d => hits[d.id]));
    }

    $('#doc-count').textContent = docs.length ? docs.length + ' 份' + (kw && Object.keys(hits || {}).length ? ' · 含全文命中' : '') : '';
    if (!docs.length) {
      grid.innerHTML = '<div class="empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>' +
        '<div>' + (kw ? '没有匹配的课件' : '这里还没有课件') + '</div>' +
        (kw ? '' : '<div>点击「上传课件」或「导入文件夹」· 支持 PDF / PPTX / DOCX</div>') + '</div>';
      return;
    }
    grid.innerHTML = docs.map(d => (
      '<div class="doc-card" data-id="' + d.id + '">' +
      '<div class="icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 15h6M9 11h2"/></svg></div>' +
      '<div class="name">' + escapeHtml(d.name) + '</div>' +
      '<div class="meta">' + d.pages + ' 页 · ' + fmtSize(d.size) + ' · ' + fmtDate(d.created) + '</div>' +
      (hits && hits[d.id] ? '<div class="hit-snippet">' + escapeHtml(hits[d.id]) + '</div>' : '') +
      '<div class="row"><button class="btn sm primary" data-open="' + d.id + '">打开</button>' +
      '<button class="btn sm ghost" data-del="' + d.id + '">删除</button>' +
      '<span style="margin-left:auto;align-self:center;font-size:11px;color:var(--dim)" data-rag="' + d.id + '"></span></div></div>'
    )).join('');
    for (const d of docs) {
      Store.listChunks(d.id).then(cs => {
        const el = grid.querySelector('[data-rag="' + d.id + '"]');
        if (el) el.textContent = cs.length ? 'AI ✓' : '';
      }).catch(() => {});
    }
  },

  /* ---------- 导入 ---------- */
  async upload(files) {
    if (!files.length) return;
    /* 未选中知识库时自动归入「我的课件」 */
    if (!this.currentLib || this.currentLib === '__none__') {
      let lib = this.libs.find(l => l.name === '我的课件');
      if (!lib) {
        lib = { id: uid(), name: '我的课件', created: Date.now() };
        await Store.saveLib(lib);
        this.libs.push(lib);
      }
      this.currentLib = lib.id;
    }
    const libId = this.currentLib;
    const btn = $('#btn-upload');
    btn.disabled = true;
    let done = 0;
    for (const file of files) {
      const kind = Office.kindOf(file.name);
      if (kind === 'ppt' || kind === 'doc') { toast(file.name + '：旧版格式请先在 Office/WPS 里「另存为」.' + kind + 'x 再上传', 'err'); continue; }
      if (!Office.supported(file.name)) { toast(file.name + '：支持 PDF / PPTX / DOCX', 'err'); continue; }
      try {
        const meta = await this.importOne(file, libId);
        if (meta) done++;
      } catch (e) {
        toast(file.name + ' 解析失败：' + e.message, 'err');
      }
    }
    btn.disabled = false;
    if (done) toast('已导入 ' + done + ' 份课件', 'ok');
    this.render();
  },

  async importOne(file, libId) {
    toast('正在解析 ' + file.name + ' …');
    const buf = await file.arrayBuffer();
    const kind = Office.kindOf(file.name);
    let pages = 0;
    const chunks = [];
    if (kind === 'pdf') {
      const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      pages = pdf.numPages;
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        const lines = Reader.groupLines(tc.items);
        const text = lines.join('\n').replace(/[ \t]+/g, ' ').trim();
        if (!text) continue;
        for (let i = 0; i < text.length; i += 900) chunks.push({ page: p, text: text.slice(i, i + 900) });
      }
    } else {
      /* PPTX / DOCX：Office.parse 统一分页模型，页码与阅读器一致 */
      const parsed = await Office.parse(kind, buf.slice(0));
      pages = parsed.pages.length;
      parsed.pages.forEach((pg, i) => {
        const text = (pg.text || '').replace(/[ \t]+/g, ' ').trim();
        if (!text) return;
        for (let j = 0; j < text.length; j += 900) chunks.push({ page: i + 1, text: text.slice(j, j + 900) });
      });
    }
    const id = uid();
    const meta = { id, name: file.name, kind, pages, size: file.size, created: Date.now(), libId, fileID: '', cloudPath: '' };
    if (Store.mode === 'cloud') meta.cloudPath = 'coursedeck/' + encodeURIComponent(Store.account.email) + '/' + id + '.' + kind;
    meta.fileID = await Store.putFile(id, file, meta.cloudPath) || '';
    /* 云端模式：向量由 cd-ingest 在服务端生成（仅管理员）；本地模式才用本地 Key 预 embedding */
    if (LLM.ready() && Store.mode !== 'cloud') {
      try { const vecs = await LLM.embed(chunks.map(c => c.text)); chunks.forEach((c, i) => c.vec = vecs[i]); }
      catch (e) { toast('向量化失败，问答将使用关键词检索：' + e.message, 'err'); }
    }
    await Store.saveChunks(id, file.name, chunks);
    await Store.saveDocMeta(meta);
    return meta;
  },

  async remove(id) {
    if (!await Dlg.confirm('删除课件', '将删除这份课件及其所有标注、翻译与索引，此操作不可恢复。', '删除')) return;
    try { await Store.deleteDoc(id); toast('已删除', 'ok'); } catch (e) { toast('删除失败：' + e.message, 'err'); }
    this.render();
  }
};
