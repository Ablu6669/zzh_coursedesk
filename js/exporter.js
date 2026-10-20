/* 导出：pdf-lib 把高亮烧录进 PDF，笔记以编号图钉 + 清单导出 */
const Exporter = {
  hasCJK(s) { return /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(s || ''); },

  hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return PDFLib.rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255);
  },

  /* 笔迹粗细：以页面宽 860px 为基准取相对比例，屏幕显示与 PDF 烧录视觉一致 */
  inkWidth(a, W) {
    const base = Math.max(1, (a.size || 3) * (W / 860));
    return a.tool === 'marker' ? base * 3.4 : base;
  },

  drawInk(pg, a, W, H) {
    const P = a.points || [];
    if (!P.length) return;
    const color = this.hexToRgb(a.color || '#2b2f36');
    const th = this.inkWidth(a, W);
    const op = a.tool === 'marker' ? 0.3 : 1;
    if (P.length === 1) {
      pg.drawCircle({ x: P[0].x * W, y: H - P[0].y * H, size: th / 2, color, opacity: op });
      return;
    }
    const path = P.map((p, i) => (i ? 'L ' : 'M ') + (p.x * W).toFixed(2) + ' ' + (H - p.y * H).toFixed(2)).join(' ');
    const round = PDFLib.LineCapStyle ? PDFLib.LineCapStyle.Round : 1;
    const rjoin = PDFLib.LineJoinStyle ? PDFLib.LineJoinStyle.Round : 1;
    pg.drawSvgPath(path, {
      borderColor: color, borderWidth: th, borderOpacity: op,
      borderLineCap: round, borderLineJoin: rjoin
    });
  },

  /* Office 导出：把笔迹转成覆盖在页面上的 SVG（viewBox 与页面布局尺寸一致，缩放不变形） */
  inkSvg(page, W, H) {
    const inks = Annotate.list.filter(a => a.type === 'ink' && a.page === page);
    if (!inks.length) return '';
    const body = inks.map(a => {
      const P = a.points || [];
      if (!P.length) return '';
      const sw = this.inkWidth(a, W);
      const op = a.tool === 'marker' ? 0.3 : 1;
      if (P.length === 1) {
        return '<circle cx="' + (P[0].x * W).toFixed(1) + '" cy="' + (P[0].y * H).toFixed(1) +
          '" r="' + (sw / 2).toFixed(2) + '" fill="' + a.color + '" opacity="' + op + '"/>';
      }
      const pts = P.map(p => (p.x * W).toFixed(1) + ',' + (p.y * H).toFixed(1)).join(' ');
      return '<polyline points="' + pts + '" fill="none" stroke="' + a.color +
        '" stroke-width="' + sw.toFixed(2) + '" stroke-linecap="round" stroke-linejoin="round" opacity="' + op + '"/>';
    }).join('');
    return '<svg class="ink-svg" viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">' + body + '</svg>';
  },

  async run() {
    if (!Reader.doc) return;
    if (Reader.kind !== 'pdf') return this.runOffice();
    if (!Reader.pdf) return;
    const annots = Annotate.list.slice().sort((a, b) => a.page - b.page);
    if (!annots.length) return toast('还没有任何标注', 'err');
    const btn = $('#btn-export');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 导出中…';
    try {
      const blob = await Store.getFile(Reader.doc.id, Reader.doc);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const doc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = doc.getPages();
      const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
      const notesMd = ['# ' + Reader.doc.name + ' · 标注清单', ''];
      let idx = 0, cjkNotes = false;

      for (const a of annots) {
        const pg = pages[a.page - 1];
        if (!pg) continue;
        const { width: W, height: H } = pg.getSize();
        /* 手写笔迹：整条一次描边，避免分段透明叠加导致接缝发深 */
        if (a.type === 'ink') { this.drawInk(pg, a, W, H); continue; }
        for (const r of (a.rects || [])) {
          pg.drawRectangle({
            x: r.x * W, y: H - (r.y + r.h) * H, width: r.w * W, height: r.h * H,
            color: this.hexToRgb(a.color), opacity: 0.28
          });
        }
        if (a.note && a.note.trim() && a.rects && a.rects.length) {
          idx++;
          const r0 = a.rects[0];
          const cx = Math.min(r0.x * W + 10, W - 40), cy = H - r0.y * H + 6;
          pg.drawCircle({ x: cx, y: cy, size: 8, color: this.hexToRgb('#efc25c') });
          pg.drawText(String(idx), { x: cx - (idx > 9 ? 5 : 3), y: cy - 3, size: 8, font, color: PDFLib.rgb(.2, .16, 0) });
          notesMd.push('**P' + a.page + ' #' + idx + '** ' + a.note.replace(/\n/g, ' '));
          if (!this.hasCJK(a.note)) {
            const lines = this.wrapAscii(a.note, 46);
            lines.forEach((ln, i) => pg.drawText(ln, { x: cx + 12, y: cy - i * 10, size: 8, font, color: PDFLib.rgb(.25, .25, .3) }));
          } else cjkNotes = true;
        }
      }

      const outBytes = await doc.save();
      this.download(new Blob([outBytes], { type: 'application/pdf' }), Reader.doc.name.replace(/\.pdf$/i, '') + '.标注版.pdf');
      if (idx > 0) {
        notesMd.push('', '> 导出时间：' + new Date().toLocaleString('zh-CN'));
        this.download(new Blob(['\ufeff' + notesMd.join('\n')], { type: 'text/markdown' }), Reader.doc.name.replace(/\.pdf$/i, '') + '.笔记.md');
      }
      toast(idx ? ('导出完成：' + idx + ' 条笔记' + (cjkNotes ? '（中文笔记见 .md 清单）' : '')) : '导出完成', 'ok');
    } catch (e) {
      toast('导出失败：' + e.message, 'err');
    } finally {
      btn.disabled = false; btn.innerHTML = '导出标注 PDF';
    }
  },

  /* Office 文档导出：自包含标注稿 HTML（含高亮与笔记，可直接打印为 PDF）+ 笔记 Markdown */
  runOffice() {
    const annots = Annotate.list.slice().sort((a, b) => a.page - b.page);
    if (!annots.length) return toast('还没有任何标注', 'err');
    const base = Reader.doc.name.replace(/\.(pptx|docx)$/i, '');
    const css = 'body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#f2f2ee;margin:0;padding:28px;color:#23272f}' +
      'h1{font-size:20px} .pg-wrap{background:#fdfdfb;border:1px solid #e4e0d4;border-radius:8px;padding:30px 38px;margin:0 auto 18px;max-width:780px;line-height:1.75}' +
      'table{border-collapse:collapse;width:100%}td,th{border:1px solid #d8d4c8;padding:5px 9px}' +
      'img{max-width:100%} .slide-head{font-size:18px;font-weight:700;margin-bottom:12px;padding-bottom:8px;border-bottom:2px solid #e8e4da}' +
      '.pg-label{color:#8a8a80;font-size:12px;margin:0 auto 6px;max-width:780px}.notes{max-width:780px;margin:24px auto;background:#fdfdfb;border:1px solid #e4e0d4;border-radius:8px;padding:22px 30px}' +
      '.page-html{position:relative}.ink-svg{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}' +
      '@media print{.pg-wrap{break-inside:avoid}}';
    let body = '<h1>' + escapeHtml(Reader.doc.name) + ' · 标注稿</h1>';
    for (const p of Reader.pages) {
      const el = p.wrap.querySelector('.page-html');
      if (!el) continue;
      const W = el.offsetWidth || 860, H = el.offsetHeight || 1000;
      body += '<div class="pg-label">第 ' + p.num + ' 页</div><div class="pg-wrap"><div class="page-html">' +
        el.innerHTML + this.inkSvg(p.num, W, H) + '</div></div>';
    }
    const notes = annots.filter(a => a.note && a.note.trim());
    if (notes.length) {
      body += '<div class="notes"><h2>笔记清单</h2>' + notes.map((a, i) =>
        '<p><b>P' + a.page + ' #' + (i + 1) + '</b> ' + (a.excerpt ? '「' + escapeHtml(a.excerpt.slice(0, 60)) + '」 ' : '') + escapeHtml(a.note).replace(/\n/g, '<br>') + '</p>'
      ).join('') + '</div>';
    }
    const html = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>' + escapeHtml(base) + ' 标注稿</title><style>' + css + '</style></head><body>' + body + '</body></html>';
    this.download(new Blob(['\ufeff' + html], { type: 'text/html' }), base + '.标注稿.html');
    if (notes.length) {
      const md = ['# ' + Reader.doc.name + ' · 标注清单', '']
        .concat(notes.map((a, i) => '**P' + a.page + ' #' + (i + 1) + '** ' + (a.excerpt ? '「' + a.excerpt.slice(0, 60) + '」 ' : '') + a.note.replace(/\n/g, ' ')))
        .concat(['', '> 导出时间：' + new Date().toLocaleString('zh-CN')]);
      this.download(new Blob(['\ufeff' + md.join('\n')], { type: 'text/markdown' }), base + '.笔记.md');
    }
    toast('导出完成：标注稿 HTML（浏览器打开后可打印为 PDF）' + (notes.length ? ' + 笔记 .md' : ''), 'ok');
  },

  wrapAscii(text, max) {
    const words = text.split(/\s+/), lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > max) { lines.push(cur.trim()); cur = w; }
      else cur += ' ' + w;
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines.slice(0, 6);
  },

  download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
};
