/* AI 问答：RAG（课件库检索，带页码引用）+ 可选联网搜索 */
const QA = {
  doc: null,
  busy: false,

  setDoc(meta) {
    this.doc = meta;
    this.updateProviderLabel();
  },

  updateProviderLabel() {
    const el = $('#qa-provider-label');
    if (aiUseCloud()) el.textContent = '云端 AI（管理员）';
    else if (LLM.ready()) el.textContent = '本地直连 AI';
    else el.textContent = '未配置 AI（设置）';
    $('#qa-web-row').style.display = (S.data.serperKey || aiUseCloud()) ? '' : 'none';
  },

  init() {
    $('#btn-ask').addEventListener('click', () => this.ask());
    $('#qa-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.ask(); }
    });
    /* 范围互斥：仅本文档 / 本知识库 */
    $('#qa-this-doc').addEventListener('change', e => { if (e.target.checked) $('#qa-lib').checked = false; });
    $('#qa-lib').addEventListener('change', e => { if (e.target.checked) $('#qa-this-doc').checked = false; });
    /* 快捷指令 */
    document.querySelectorAll('.qa-chip').forEach(c => c.addEventListener('click', () => {
      const act = c.dataset.act;
      if (act === 'summarize') this.runQuick('请总结这份课件的核心内容，按主题分点列出，标注对应页码。');
      else if (act === 'page') this.runQuick('请概括第 ' + Reader.currentPage + ' 页的主要内容，分点列出。', true);
      else if (act === 'concepts') this.runQuick('请列出这份课件中的关键概念和术语，并用一句话解释每个概念。');
      else if (act === 'quiz') this.runQuick('请根据这份课件内容出 5 道自测题（含答案与出处页码），帮助我复习。');
    }));
  },

  runQuick(q, thisDocOnly) {
    if (!Reader.doc) return;
    if (thisDocOnly) $('#qa-this-doc').checked = true;
    $('#qa-input').value = q;
    this.ask();
  },

  /* 划词问 AI：带上下文跳到问答面板 */
  askAboutSelection(text, page) {
    document.querySelectorAll('.panel-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-body').forEach(x => x.classList.remove('active'));
    document.querySelector('.panel-tab[data-tab="qa"]').classList.add('active');
    $('#tab-qa').classList.add('active');
    if (Panel) Panel.collapse(false);
    $('#qa-input').value = '关于第 ' + page + ' 页「' + (text.length > 80 ? text.slice(0, 80) + '…' : text) + '」：';
    $('#qa-input').focus();
    toast('已引用选中内容，输入你的问题后回车');
  },

  addMsg(cls, html) {
    $('#qa-empty') && $('#qa-empty').remove();
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    if (cls === 'ai') div.innerHTML = html; else div.textContent = html;
    $('#qa-msgs').appendChild(div);
    $('#qa-msgs').scrollTop = 1e9;
    return div;
  },

  citeChips(cites) {
    if (!cites || !cites.length) return '';
    return '<div class="cites">' + cites.map((c, i) => {
      if (c.web) return '<span class="cite-chip web" title="' + escapeHtml(c.title) + '"><a href="' + escapeHtml(c.url) + '" target="_blank">🌐 ' + escapeHtml((c.title || c.url).slice(0, 28)) + '</a></span>';
      return '<span class="cite-chip" data-goto="' + c.page + '" title="跳转到原文">📄 ' + escapeHtml(c.docName.slice(0, 18)) + ' P' + c.page + '</span>';
    }).join('') + '</div>';
  },

  /* 计算检索范围：仅本文档 / 本知识库 / 全部 */
  async scopeDocIds() {
    if ($('#qa-this-doc').checked && this.doc) return [this.doc.id];
    if ($('#qa-lib').checked && Library.currentLib) {
      const docs = (Library.docsCache && Library.docsCache.length) ? Library.docsCache : await Store.listDocs();
      const ids = docs.filter(d => d.libId === Library.currentLib).map(d => d.id);
      if (ids.length) return ids;
    }
    return null; /* 全部 */
  },

  async ask() {
    if (this.busy) return;
    const q = $('#qa-input').value.trim();
    if (!q) return;
    if (!aiUseCloud() && !LLM.ready()) return toast('请先到「设置 → AI 模型」中填写你自己的 API Key', 'err');
    $('#qa-input').value = '';
    this.addMsg('user', q);
    const holder = this.addMsg('ai', '<span class="spin"></span> 正在检索课件…');
    this.busy = true;
    try {
      const docIds = await this.scopeDocIds();
      let answer, cites;
      if (Store.mode === 'cloud') {
        const r = await Cloud.call('cd-ask', {
          ...Store.authHeader(),
          question: q,
          docId: (docIds && docIds.length === 1) ? docIds[0] : '',
          docIds: docIds || [],
          web: $('#qa-web').checked
        });
        answer = r.answer; cites = r.citations || [];
      } else {
        const r = await this.localAsk(q, docIds, $('#qa-web').checked, holder);
        answer = r.answer; cites = r.citations || [];
      }
      holder.innerHTML = escapeHtml(answer).replace(/\n/g, '<br>') + this.citeChips(cites);
    } catch (e) {
      holder.innerHTML = '<span style="color:#f0a3a3">回答失败：' + escapeHtml(e.message) + '</span>';
    } finally {
      this.busy = false;
      $('#qa-msgs').scrollTop = 1e9;
      this.updateProviderLabel();
    }
  },

  async retrieve(question, docIds) {
    let chunks = await Store.listChunks('');
    if (docIds && docIds.length) chunks = chunks.filter(c => docIds.includes(c.docId));
    if (!chunks.length) return { hits: [] };
    let qvec = null;
    try { if (LLM.ready() && chunks.some(c => c.vec && c.vec.length)) qvec = (await LLM.embed([question]))[0]; } catch (e) {}
    if (qvec) {
      chunks.forEach(c => c._s = (c.vec && c.vec.length) ? cosine(qvec, c.vec) : 0);
    } else {
      chunks.forEach(c => c._s = keywordScore(c.text, question));
    }
    const hits = chunks.filter(c => c._s > 0.01).sort((a, b) => b._s - a._s).slice(0, 8);
    return { hits };
  },

  async localAsk(question, docIds, web, holder) {
    holder.innerHTML = '<span class="spin"></span> 正在检索课件…';
    const { hits } = await this.retrieve(question, docIds);
    let webResults = null;
    if (web && S.data.serperKey) {
      holder.innerHTML = '<span class="spin"></span> 联网搜索中…';
      webResults = await LLM.webSearch(question);
    }
    const ctxParts = [];
    const cites = [];
    hits.forEach((h, i) => {
      ctxParts.push('[' + (i + 1) + '] 《' + h.docName + '》第' + h.page + '页：\n' + h.text);
      cites.push({ docName: h.docName, page: h.page });
    });
    if (webResults && webResults.length) {
      webResults.forEach((r, i) => {
        ctxParts.push('[W' + (i + 1) + '] 网络资料《' + r.title + '》：' + r.snippet);
        cites.push({ web: true, title: r.title, url: r.url });
      });
    }
    holder.innerHTML = '<span class="spin"></span> 正在生成回答…';

    const sys = '你是港中深学生的课件学习助手。优先依据【课件资料】回答；资料不足以回答时，可参考【网络资料】并用你自己的知识补充，但要明确说明哪些内容来自课件、哪些是补充。' +
      '引用课件内容时标注 [序号]，例如 [1]。若资料完全不相关，直接说明课件中没有相关内容。用简体中文、条理清晰地回答。';
    const user = (hits.length ? '【课件资料】\n' + ctxParts.filter(p => !p.startsWith('[W')).join('\n\n') + '\n\n' : '') +
      (webResults && webResults.length ? '【网络资料】\n' + ctxParts.filter(p => p.startsWith('[W')).join('\n\n') + '\n\n' : '') +
      (hits.length ? '' : '【课件资料】无相关内容。\n\n') + '【问题】' + question;

    const answer = await LLM.chat([
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ], { temperature: 0.3, max_tokens: 3072 });
    return { answer, citations: cites };
  }
};

/* 引用跳转（事件委托） */
document.addEventListener('click', e => {
  const c = e.target.closest('.cite-chip[data-goto]');
  if (c) Reader.goto(+c.dataset.goto);
  const item = e.target.closest('.annot-item');
  if (item && !e.target.closest('.del')) Reader.goto(+item.dataset.page);
  if (e.target.closest('.del')) {
    const id = e.target.closest('.del').dataset.del;
    Annotate.deleteAnnotation(id).then(() => toast('标注已删除', 'ok'));
  }
});
