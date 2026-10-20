/* Office 文档解析：PPTX（JSZip 解 XML）与 DOCX（mammoth 转 HTML）
 * 统一产物：{ pages: [{html, text, lines}], outline: [{title, page, depth}] }
 * pptx 一页 = 一张幻灯片；docx 按段落体量分页（约千字一页），保证页码在
 * 阅读器 / 翻译 / 问答引用间一致。
 */
const Office = {
  exts: ['pdf', 'pptx', 'docx'],

  kindOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  },

  supported(name) { return this.exts.includes(this.kindOf(name)); },

  async parse(kind, buf) {
    if (kind === 'pptx') return this.parsePptx(buf);
    if (kind === 'docx') return this.parseDocx(buf);
    throw new Error('不支持的格式：' + kind);
  },

  /* ================= PPTX ================= */
  async parsePptx(buf) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip 未加载（检查网络/CDN）');
    const zip = await JSZip.loadAsync(buf);
    const parser = new DOMParser();

    const slidePaths = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => (+/slide(\d+)\.xml/.exec(a)[1]) - (+/slide(\d+)\.xml/.exec(b)[1]));
    if (!slidePaths.length) throw new Error('PPTX 中没有幻灯片');

    const mediaMime = p => {
      const ext = (/\.([a-z0-9]+)$/i.exec(p) || [])[1] || '';
      return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' }[ext.toLowerCase()] || '';
    };

    const pages = [], outline = [];
    for (let i = 0; i < slidePaths.length; i++) {
      const sp = slidePaths[i];
      const xml = parser.parseFromString(await zip.file(sp).async('text'), 'text/xml');

      /* 图片关系表：rId → dataURL */
      const imgMap = {};
      const relPath = sp.replace('slides/', 'slides/_rels/') + '.rels';
      if (zip.file(relPath)) {
        const rels = parser.parseFromString(await zip.file(relPath).async('text'), 'text/xml');
        const relEls = rels.getElementsByTagName('Relationship');
        for (const r of relEls) {
          const target = r.getAttribute('Target') || '';
          if (!/media\//.test(target)) continue;
          const norm = ('ppt/slides/' + target).replace(/[^/]+\/\.\.\//g, '');
          const mime = mediaMime(norm);
          const f = zip.file(norm);
          if (!mime || !f) continue;
          try {
            const b64 = await f.async('base64');
            if (b64.length < 3 * 1024 * 1024) imgMap[r.getAttribute('Id')] = 'data:' + mime + ';base64,' + b64;
          } catch (e) {}
        }
      }

      /* 形状文本：标题占位符单独识别 */
      let title = '';
      const paras = [];
      const spEls = xml.getElementsByTagName('p:sp');
      for (const s of spEls) {
        const ph = s.getElementsByTagName('p:ph')[0];
        const phType = ph ? (ph.getAttribute('type') || 'body') : 'body';
        const pEls = s.getElementsByTagName('a:p');
        for (const p of pEls) {
          const tEls = p.getElementsByTagName('a:t');
          let txt = '';
          for (const t of tEls) txt += t.textContent || '';
          txt = txt.replace(/\s+/g, ' ').trim();
          if (!txt) continue;
          if ((phType === 'title' || phType === 'ctrTitle') && !title) title = txt;
          else paras.push(txt);
        }
      }

      /* 表格 */
      const tables = [];
      const tblEls = xml.getElementsByTagName('a:tbl');
      for (const tb of tblEls) {
        const rows = [];
        for (const tr of tb.getElementsByTagName('a:tr')) {
          const cells = [];
          for (const tc of tr.getElementsByTagName('a:tc')) {
            let txt = '';
            for (const t of tc.getElementsByTagName('a:t')) txt += t.textContent || '';
            cells.push(txt.trim());
          }
          if (cells.some(Boolean)) rows.push(cells);
        }
        if (rows.length) tables.push(rows);
      }

      /* 图片（按文档顺序） */
      const imgs = [];
      for (const blip of xml.getElementsByTagName('a:blip')) {
        const rid = blip.getAttribute('r:embed');
        if (rid && imgMap[rid] && imgs.length < 6 && !imgs.includes(imgMap[rid])) imgs.push(imgMap[rid]);
      }

      /* 组装 HTML / 纯文本 / 翻译行 */
      const lines = (title ? [title] : []).concat(paras);
      let html = '<div class="slide">';
      html += '<div class="slide-head">' + (title ? escapeHtml(title) : '第 ' + (i + 1) + ' 页') + '</div>';
      if (paras.length) html += paras.map(p => '<p>' + escapeHtml(p) + '</p>').join('');
      for (const rows of tables) {
        html += '<table>' + rows.map(r => '<tr>' + r.map(c => '<td>' + escapeHtml(c) + '</td>').join('') + '</tr>').join('') + '</table>';
      }
      if (imgs.length) html += '<div class="slide-imgs">' + imgs.map(u => '<img src="' + u + '" alt="">').join('') + '</div>';
      if (!paras.length && !tables.length && !imgs.length) html += '<p class="slide-empty">（本页无可提取内容，可能为纯图形/艺术字）</p>';
      html += '</div>';

      const text = lines.join('\n') + (tables.length ? '\n' + tables.map(rs => rs.map(r => r.join(' | ')).join('\n')).join('\n') : '');
      pages.push({ html, text, lines });
      outline.push({ title: title || '第 ' + (i + 1) + ' 页', page: i + 1, depth: 0 });
    }
    return { pages, outline };
  },

  /* ================= DOCX ================= */
  async parseDocx(buf) {
    if (typeof mammoth === 'undefined') throw new Error('mammoth 未加载（检查网络/CDN）');
    const res = await mammoth.convertToHtml({ arrayBuffer: buf });
    const host = document.createElement('div');
    host.innerHTML = res.value || '';
    if (!host.textContent.trim() && !host.querySelector('img')) throw new Error('DOCX 内容为空或解析失败');

    /* 按段落体量分页（约 1100 字/页），保持标题不孤行 */
    const PAGE_CHARS = 1100;
    const pageEls = [];
    let cur = [], curLen = 0;
    for (const node of [...host.children]) {
      const len = (node.textContent || '').trim().length || 1;
      const isHead = /^H[1-6]$/.test(node.tagName);
      if (curLen > 0 && (curLen + len > PAGE_CHARS) && !isHead) {
        pageEls.push(cur); cur = []; curLen = 0;
      }
      cur.push(node); curLen += len;
    }
    if (cur.length || !pageEls.length) pageEls.push(cur);

    const pages = [], outline = [];
    pageEls.forEach((els, i) => {
      const html = '<div class="docx-page">' + els.map(e => e.outerHTML).join('') + '</div>';
      const lines = els.map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      pages.push({ html, text: lines.join('\n'), lines });
      for (const e of els) {
        if (/^H[1-3]$/.test(e.tagName) && (e.textContent || '').trim()) {
          outline.push({ title: e.textContent.trim().slice(0, 40), page: i + 1, depth: +e.tagName[1] - 1 });
        }
      }
    });
    return { pages, outline };
  }
};
