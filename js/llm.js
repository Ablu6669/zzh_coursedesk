/* 全局设置 + LLM 直连（OpenAI 兼容协议）+ 联网搜索 */
const S = {
  KEY: 'cd_settings',
  data: {
    envId: '',
    /* HTTP 访问服务域名：部署时注入（GitHub Pages 版），留空则退回 SDK 调用（需环境开启匿名登录） */
    httpBase: '',
    llmBase: 'https://api.hunyuan.cloud.tencent.com/v1',
    llmKey: '',
    llmModel: 'hunyuan-turbos-latest',
    embedModel: 'hunyuan-embedding',
    serperKey: ''
  },
  load() {
    try { Object.assign(this.data, JSON.parse(localStorage.getItem(this.KEY) || '{}')); } catch (e) {}
    /* 部署时可注入默认环境 ID / HTTP 服务域名（GitHub Pages 版），用户手动改过设置则以用户配置为准 */
    if (!this.data.envId && window.__CD_ENV__) this.data.envId = window.__CD_ENV__;
    if (!this.data.httpBase && window.__CD_HTTP_BASE__) this.data.httpBase = window.__CD_HTTP_BASE__;
    return this.data;
  },
  save(obj) { Object.assign(this.data, obj || {}); localStorage.setItem(this.KEY, JSON.stringify(this.data)); }
};
S.load();

/* 管理员账号：云端 AI（服务端配置的 TokenHub Key）仅对管理员开放；
   其他账号需在「设置 → AI 模型」填写自己的 API Key，走本地直连。 */
const ADMIN_EMAILS = ['abluzz@outlook.com'];
function isAdmin() { return !!(typeof Store !== 'undefined' && Store.account && ADMIN_EMAILS.includes((Store.account.email || '').toLowerCase())); }
function aiUseCloud() { return typeof Store !== 'undefined' && Store.mode === 'cloud' && isAdmin(); }

const LLM = {
  ready() { return !!S.data.llmKey; },
  baseUrl() { return (S.data.llmBase || '').replace(/\/+$/, ''); },

  async chat(messages, opts = {}) {
    if (!this.ready()) throw new Error('未配置 AI 模型：请到设置中填写 API Key，或部署云端函数后使用云端模式');
    const res = await fetch(this.baseUrl() + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.data.llmKey },
      body: JSON.stringify({ model: opts.model || S.data.llmModel, messages, temperature: opts.temperature ?? 0.3, max_tokens: opts.max_tokens || 2048 })
    });
    if (!res.ok) throw new Error('模型接口错误 ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  },

  async embed(texts) {
    if (!this.ready()) throw new Error('未配置 AI 模型');
    const out = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const res = await fetch(this.baseUrl() + '/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + S.data.llmKey },
        body: JSON.stringify({ model: S.data.embedModel, input: batch })
      });
      if (!res.ok) throw new Error('Embedding 接口错误 ' + res.status + ': ' + (await res.text()).slice(0, 200));
      const j = await res.json();
      const sorted = j.data.slice().sort((a, b) => a.index - b.index);
      sorted.forEach(d => out.push(d.embedding));
    }
    return out;
  },

  async webSearch(query, num = 5) {
    if (!S.data.serperKey) return null;
    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': S.data.serperKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num })
      });
      if (!res.ok) return null;
      const j = await res.json();
      return (j.organic || []).slice(0, num).map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
    } catch (e) { return null; }
  }
};

function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x) * Math.sqrt(y) + 1e-9);
}

/* 关键词兜底检索（无 embedding 时） */
function keywordScore(text, query) {
  const t = (text || '').toLowerCase(), q = query.toLowerCase();
  const terms = q.split(/[\s,，。？?！!]+/).filter(w => w.length > 0);
  if (/[\u4e00-\u9fff]/.test(q)) for (let i = 0; i < q.length - 1; i++) if (/[\u4e00-\u9fff]/.test(q[i])) terms.push(q.substr(i, 2));
  const uniq = [...new Set(terms)];
  let s = 0;
  for (const w of uniq) if (t.includes(w)) s += w.length >= 2 ? 2 : 1;
  return s;
}

/* 从 LLM 回复中稳健解析 JSON 数组 */
function parseJsonArray(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function fmtSize(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(0) + ' KB'; }
function fmtDate(ts) { const d = new Date(ts); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
