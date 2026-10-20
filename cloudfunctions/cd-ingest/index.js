const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
/* 云函数 ingest：接收课件切块，向量化后入库（供 RAG 检索） */
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

/* LLM Key 合法性检查：未配置或仍是中文占位符时给出可读错误 */
function llmKeyInvalid() {
  const k = process.env.LLM_KEY || '';
  return !k || /[^\x00-\x7F]/.test(k) || k.length < 10;
}

async function embed(texts) {
  if (llmKeyInvalid()) throw new Error('服务端未配置 AI 模型密钥（LLM_KEY），暂无法建立检索索引');
  const base = (process.env.LLM_BASE || 'https://api.hunyuan.cloud.tencent.com/v1').replace(/\/+$/, '');
  const out = [];
  for (let i = 0; i < texts.length; i += 16) {
    const batch = texts.slice(i, i + 16);
    const res = await fetch(base + '/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.LLM_KEY },
      body: JSON.stringify({ model: process.env.EMBED_MODEL || 'hunyuan-embedding', input: batch })
    });
    if (!res.ok) throw new Error('Embedding 接口错误 ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    j.data.sort((a, b) => a.index - b.index).forEach(d => out.push(d.embedding));
  }
  return out;
}

const handle = async (event) => {
  const { email, token, docId, docName, chunks } = event || {};
  if (!(await authed(email, token))) return err('登录已失效，请重新登录');
  if (!docId || !Array.isArray(chunks) || !chunks.length) return err('参数不完整');

  try {
    await db.collection('cd_chunks').where({ email, docId }).remove();
    /* 服务端 embedding 仅管理员可用（消耗服务端 TokenHub 配额）；
       普通账号只存文本块，问答时退回关键词检索 */
    let vecs = null;
    if (isAdmin(email)) {
      try { vecs = await embed(chunks.map(c => c.text)); } catch (e) { console.error('embed fail', e.message); }
    }

    const col = db.collection('cd_chunks');
    let n = 0;
    for (let i = 0; i < chunks.length; i++) {
      await col.add({
        id: docId + ':' + i, email, docId, docName: docName || '',
        page: chunks[i].page, text: chunks[i].text,
        vec: vecs ? vecs[i] : null, created: Date.now()
      });
      n++;
    }
    return ok({ count: n, embedded: !!vecs });
  } catch (e) {
    console.error('ingest', e);
    return err('入库失败：' + e.message);
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
