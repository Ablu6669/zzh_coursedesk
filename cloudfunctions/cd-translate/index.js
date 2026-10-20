const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
/* 云函数 translate：逐行翻译（JSON 数组进 / JSON 数组出） */
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

/* LLM Key 合法性检查：未配置或仍是中文占位符时给出可读错误，
   避免 Node fetch 因 Header 含非 Latin-1 字符抛 ByteString 天书 */
function llmKeyInvalid() {
  const k = process.env.LLM_KEY || '';
  return !k || /[^\x00-\x7F]/.test(k) || k.length < 10;
}

function parseJsonArray(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/[\[{][\s\S]*[\]}]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

const handle = async (event) => {
  const { email, token, lines } = event || {};
  if (!(await authed(email, token))) return err('登录已失效，请重新登录');
  if (!isAdmin(email)) return err('云端 AI 仅管理员账号可用。请在「设置 → AI 模型」中填写你自己的 API Key 后重试');
  if (!Array.isArray(lines) || !lines.length) return err('参数不完整');
  if (llmKeyInvalid()) return err('服务端未配置 AI 模型密钥（LLM_KEY），翻译暂不可用');

  try {
    const base = (process.env.LLM_BASE || 'https://api.hunyuan.cloud.tencent.com/v1').replace(/\/+$/, '');
    const prompt = '把下面 JSON 数组中的每一行文本翻译成简体中文（已是中文的保持原样，专业术语首次出现时在括号内保留原文）。' +
      '只返回 JSON 数组，长度和顺序与输入完全一致，不要输出其他内容。\n' + JSON.stringify(lines);
    const res = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.LLM_KEY },
      body: JSON.stringify({ model: process.env.LLM_MODEL || 'hunyuan-turbos-latest', messages: [{ role: 'user', content: prompt }], temperature: 0.15, max_tokens: 4096 })
    });
    if (!res.ok) return err('模型接口错误 ' + res.status + ': ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    const arr = parseJsonArray(content);
    if (!Array.isArray(arr)) return err('模型返回格式异常，请重试');
    const out = arr.map(x => (typeof x === 'string' ? x : (x && x.dst) || (x && x.translation) || ''));
    if (out.length !== lines.length) return err('译文行数不匹配，请重试');
    return ok({ lines: out });
  } catch (e) {
    console.error('translate', e);
    return err('翻译失败：' + e.message);
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
