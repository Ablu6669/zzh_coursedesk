/* 全文翻译：按页 LLM 翻译，原文/译文对照，结果云端或本地缓存 */
const Translate = {
  mode: 'both',        // both | dst
  busy: false,

  init() {
    $('#btn-translate-page').addEventListener('click', () => this.run());
    $('#trans-mode-both').addEventListener('click', () => this.setMode('both'));
    $('#trans-mode-dst').addEventListener('click', () => this.setMode('dst'));
  },

  setMode(m) {
    this.mode = m;
    $('#trans-mode-both').classList.toggle('on', m === 'both');
    $('#trans-mode-dst').classList.toggle('on', m === 'dst');
    this.onPageChange();
  },

  onPageChange() {
    if (App.view !== 'reader' || !Reader.doc) return;
    const n = Reader.currentPage;
    $('#trans-page-label').textContent = '第 ' + n + ' 页';
    this.renderCached(n);
  },

  async renderCached(n) {
    const el = $('#trans-lines');
    const cached = await Store.getTranslation(Reader.doc.id, n);
    if (cached && cached.lines) return this.render(cached.lines);
    el.innerHTML = '<div class="trans-status">本页尚未翻译<br>点击上方「翻译本页」</div>';
  },

  render(lines) {
    const el = $('#trans-lines');
    el.innerHTML = lines.map(l => {
      if (this.mode === 'dst') {
        return '<div class="trans-line only-src"><div class="dst">' + escapeHtml(l.dst || l.src) + '</div></div>';
      }
      return '<div class="trans-line"><div class="src">' + escapeHtml(l.src) + '</div><div class="dst">' + escapeHtml(l.dst || '…') + '</div></div>';
    }).join('');
  },

  async run() {
    if (this.busy || !Reader.doc) return;
    const n = Reader.currentPage;
    const lines = await Reader.pageLines(n);
    if (!lines.length) return toast('本页未检测到可翻译文本（可能为扫描件）', 'err');
    this.busy = true;
    const btn = $('#btn-translate-page');
    const old = btn.textContent;
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 翻译中';
    $('#trans-lines').innerHTML = '<div class="trans-status"><span class="spin"></span><br>正在翻译第 ' + n + ' 页…</div>';
    try {
      let result = null;
      if (Store.mode === 'cloud') {
        const r = await Cloud.call('cd-translate', { ...Store.authHeader(), lines });
        result = r.lines;
      } else {
        if (!LLM.ready()) throw new Error('请先到「设置 → AI 模型」中填写你自己的 API Key');
        result = await this.localTranslate(lines);
      }
      if (!result || result.length !== lines.length) throw new Error('译文行数不匹配，请重试');
      const data = lines.map((s, i) => ({ src: s, dst: result[i] }));
      this.render(data);
      await Store.saveTranslation(Reader.doc.id, n, data);
    } catch (e) {
      toast('翻译失败：' + e.message, 'err');
      this.renderCached(n);
    } finally {
      this.busy = false;
      btn.disabled = false; btn.textContent = old;
    }
  },

  async localTranslate(lines) {
    const prompt = '把下面 JSON 数组中的每一行文本翻译成简体中文（已是中文的保持原样，专业术语首次出现时在括号内保留原文）。' +
      '只返回 JSON 数组，长度和顺序与输入完全一致，不要输出其他内容。\n' + JSON.stringify(lines);
    const out = await LLM.chat([{ role: 'user', content: prompt }], { temperature: 0.15, max_tokens: 4096 });
    const arr = parseJsonArray(out);
    if (!Array.isArray(arr)) throw new Error('模型返回格式异常');
    return arr.map(x => (typeof x === 'string' ? x : (x && x.dst) || (x && x.translation) || ''));
  }
};
