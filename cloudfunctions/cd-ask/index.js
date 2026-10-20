const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
/* 云函数 ask：RAG 检索（知识库优先）+ 可选联网搜索 + LLM 生成，返回答案与引用 */
const cloud = require('@cloudbase/node-sdk');
const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

function ok(data) { return { ok: true, ...data }; }
function err(msg) { return { ok: false, error: msg }; }

async function authed(email, token) {
  if (!email || !token) return false;
  const r = await db.collection('cd_sessions').where({ email, token }).limit(1).get();
  return r.data.length > 0 && r.data[0].exp > Date.now();
}

/* 管理员账号：云端 AI（服务端 LLM_KEY）仅管理员可用，可用 ADMIN_EMAILS 环境变量覆盖 */
function isAdmin(email) {
  const list = (process.env.ADMIN_EMAILS || 'abluzz@outlook.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes((email || '').toLowerCase());
}

function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return d / (Math.sqrt(x) * Math.sqrt(y) + 1e-9);
}

function keywordScore(text, q) {
  const t = (text || '').toLowerCase(), qq = q.toLowerCase();
  const terms = qq.split(/[\s,，。？?！!]+/).filter(w => w.length > 0);
  if (/[\u4e00-\u9fff]/.test(qq)) for (let i = 0; i < qq.length - 1; i++) if (/[\u4e00-\u9fff]/.test(qq[i])) terms.push(qq.substr(i, 2));
  let s = 0;
  for (const w of [...new Set(terms)]) if (t.includes(w)) s += w.length >= 2 ? 2 : 1;
  return s;
}

/* LLM Key 合法性检查：未配置或仍是中文占位符时给出可读错误 */
function llmKeyInvalid() {
  const k = process.env.LLM_KEY || '';
  return !k || /[^\x00-\x7F]/.test(k) || k.length < 10;
}

async function llm(messages) {
  if (llmKeyInvalid()) throw new Error('服务端未配置 AI 模型密钥（LLM_KEY），问答暂不可用');
  const base = (process.env.LLM_BASE || 'https://api.hunyuan.cloud.tencent.com/v1').replace(/\/+$/, '');
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.LLM_KEY },
    body: JSON.stringify({ model: process.env.LLM_MODEL || 'hunyuan-turbos-latest', messages, temperature: 0.3, max_tokens: 3072 })
  });
  if (!res.ok) throw new Error('模型接口错误 ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

async function embedOne(text) {
  const base = (process.env.LLM_BASE || 'https://api.hunyuan.cloud.tencent.com/v1').replace(/\/+$/, '');
  const res = await fetch(base + '/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.LLM_KEY },
    body: JSON.stringify({ model: process.env.EMBED_MODEL || 'hunyuan-embedding', input: [text] })
  });
  if (!res.ok) throw new Error('Embedding 接口错误 ' + res.status);
  const j = await res.json();
  return j.data[0].embedding;
}

async function webSearch(q) {
  if (!process.env.SERPER_KEY) return null;
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.SERPER_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: 5 })
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.organic || []).slice(0, 5).map(r => ({ title: r.title, snippet: r.snippet, url: r.link }));
  } catch (e) { return null; }
}

const handle = async (event) => {
  const { email, token, question, docId, docIds, web } = event || {};
  if (!(await authed(email, token))) return err('登录已失效，请重新登录');
  if (!isAdmin(email)) return err('云端 AI 仅管理员账号可用。请在「设置 → AI 模型」中填写你自己的 API Key 后重试');
  if (!question) return err('问题不能为空');

  try {
    /* 1. 检索知识库（docId 单文档 / docIds 整个知识库 / 全部） */
    let where = { email };
    if (docId) where = { email, docId };
    else if (Array.isArray(docIds) && docIds.length === 1) where = { email, docId: docIds[0] };
    let r = await db.collection('cd_chunks').where(where).limit(1000).get();
    let chunks = r.data;
    if (Array.isArray(docIds) && docIds.length > 1) {
      chunks = chunks.filter(c => docIds.includes(c.docId));
    }
    let hits = [];
    if (chunks.length) {
      let qvec = null;
      if (chunks.some(c => c.vec)) { try { qvec = await embedOne(question); } catch (e) { console.error('embed', e.message); } }
      if (qvec) chunks.forEach(c => c._s = c.vec ? cosine(qvec, c.vec) : 0);
      else chunks.forEach(c => c._s = keywordScore(c.text, question));
      hits = chunks.filter(c => c._s > 0.01).sort((a, b) => b._s - a._s).slice(0, 8);
    }

    /* 2. 可选联网搜索 */
    let webResults = null;
    if (web) webResults = await webSearch(question);

    /* 3. 组装上下文 */
    const cites = [];
    const kbParts = hits.map((h, i) => {
      cites.push({ docName: h.docName, page: h.page });
      return '[' + (i + 1) + '] 《' + h.docName + '》第' + h.page + '页：\n' + h.text;
    });
    const webParts = [];
    if (webResults && webResults.length) {
      webResults.forEach((w, i) => {
        cites.push({ web: true, title: w.title, url: w.url });
        webParts.push('[W' + (i + 1) + '] 网络资料《' + w.title + '》：' + w.snippet);
      });
    }

    const sys = '你是港中深学生的课件学习助手。优先依据【课件资料】回答；资料不足以回答时，可参考【网络资料】并用你自己的知识补充，但要明确说明哪些内容来自课件、哪些是补充。' +
      '引用课件内容时标注 [序号]，例如 [1]。若资料完全不相关，直接说明课件中没有相关内容。用简体中文、条理清晰地回答。';
    const user =
      (kbParts.length ? '【课件资料】\n' + kbParts.join('\n\n') + '\n\n' : '【课件资料】无相关内容。\n\n') +
      (webParts.length ? '【网络资料】\n' + webParts.join('\n\n') + '\n\n' : '') +
      '【问题】' + question;

    const answer = await llm([{ role: 'system', content: sys }, { role: 'user', content: user }]);
    return ok({ answer, citations: cites });
  } catch (e) {
    console.error('ask', e);
    return err('回答失败：' + e.message);
  }
};

/* ---------- HTTP 访问服务适配层 ----------
 * 云函数既支持 SDK 调用，也可以通过「HTTP 访问服务」被任意域名跨域调用。
 * HTTP 模式返回标准 {statusCode, headers, body}，并带上 CORS 头，
 * 这样 GitHub Pages 等任意托管域都能直连云函数，不必依赖匿名登录与安全域名白名单。
 */
exports.main = async (event) => {
  const isHttp = !!(event && (event.httpMethod || event.body || event.headers));
  if (isHttp && event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  let payload = event;
  if (isHttp) {
    let body = event.body;
    if (typeof body === 'string') {
      if (event.isBase64Encoded) { try { body = Buffer.from(body, 'base64').toString('utf8'); } catch (e) { /* ignore */ } }
      try { body = JSON.parse(body || '{}'); } catch (e) { body = {}; }
    }
    payload = Object.assign({}, event.queryString || {}, (body && typeof body === 'object') ? body : {});
  }
  try {
    const r = await handle(payload || {});
    if (isHttp) return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(r) };
    return r;
  } catch (e) {
    const errBody = { ok: false, error: String((e && e.message) || e) };
    if (isHttp) return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(errBody) };
    return errBody;
  }
};
