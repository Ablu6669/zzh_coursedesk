const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
/* 云函数 login：邮箱验证码发送与校验，签发会话 token */
const cloud = require('@cloudbase/node-sdk');
const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();

function ok(data) { return { ok: true, ...data }; }
function err(msg, code) { return code ? { ok: false, error: msg, code } : { ok: false, error: msg }; }

async function sendMail(to, code, hostOverride, portOverride) {
  const { SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  const SMTP_HOST = hostOverride || process.env.SMTP_HOST;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    /* 未配置 SMTP：把验证码回传给前端展示（体验版环境云日志不可读，这是唯一可行的降级方案）。
       配置好 SMTP_* 环境变量后自动切回邮件发送，不再回传验证码。 */
    console.log('[DEV] 验证码（未配置 SMTP，已回传给调用方）:', to, code);
    return { dev: true, code };
  }
  const nodemailer = require('nodemailer');
  const port = parseInt(portOverride || SMTP_PORT || '465');
  const tp = nodemailer.createTransport({
    host: SMTP_HOST,
    port,
    /* 465 = 直接 SSL；587 / 25 = 先明文连再 STARTTLS 升级（Outlook / Office365 / Gmail 常用 587） */
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: { minVersion: 'TLSv1.2' }
  });
  await tp.verify();
  await tp.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to,
    subject: '课件台 CourseDeck 登录验证码',
    text: '你的登录验证码是 ' + code + '，10 分钟内有效。如非本人操作请忽略本邮件。',
    html: '<div style="font-family:sans-serif"><h3>课件台 CourseDeck</h3><p>你的登录验证码：</p><p style="font-size:28px;letter-spacing:6px;font-weight:bold">' + code + '</p><p>10 分钟内有效。如非本人操作请忽略本邮件。</p></div>'
  });
  return { dev: false };
}

/* ---------- 密码哈希（scrypt，Node 内置 crypto，无需额外依赖） ---------- */
const crypto = require('crypto');
function hashPwd(pwd, salt) {
  return crypto.scryptSync(String(pwd), salt, 64).toString('hex');
}
function newSalt() { return crypto.randomBytes(16).toString('hex'); }
function safeEq(a, b) {
  try {
    const x = Buffer.from(String(a), 'hex'), y = Buffer.from(String(b), 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  } catch (e) { return false; }
}
async function findUser(email) {
  const r = await db.collection('cd_users').where({ email }).limit(1).get();
  return r.data && r.data[0] ? r.data[0] : null;
}
async function issueToken(email) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.collection('cd_sessions').add({ email, token, created: Date.now(), exp: Date.now() + 30 * 24 * 3600 * 1000 });
  return token;
}

/* 注册门槛（可选，防止站点公开后被任意邮箱注册、占用云存储与数据库配额）：
 *   ALLOW_SIGNUP 未设置 / open  → 完全开放（默认，保持原有行为）
 *   ALLOW_SIGNUP=off            → 关闭注册，仅已有账号可登录
 *   ALLOW_SIGNUP=invite         → 需邀请码（配合 INVITE_CODE）
 *   ALLOW_SIGNUP=domain         → 仅允许指定邮箱域名（配合 ALLOW_EMAIL_DOMAINS，逗号分隔，
 *                                 例如 link.cuhk.edu.cn 可限本校学生）
 * 返回 null 表示放行，返回字符串表示拒绝原因。
 */
function signupGate(email, invite) {
  const mode = (process.env.ALLOW_SIGNUP || 'open').trim().toLowerCase();
  if (mode === 'off') return '当前未开放注册';
  if (mode === 'invite') {
    const c = (process.env.INVITE_CODE || '').trim();
    if (!c) return '服务端未配置邀请码，注册暂不可用';
    if (String(invite || '').trim() !== c) return '邀请码不正确';
    return null;
  }
  if (mode === 'domain') {
    const ds = (process.env.ALLOW_EMAIL_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const dom = (String(email).split('@')[1] || '').toLowerCase();
    if (!ds.length) return '服务端未配置允许的邮箱域名，注册暂不可用';
    if (!ds.includes(dom)) return '当前仅允许 ' + ds.join(' / ') + ' 邮箱注册';
    return null;
  }
  return null;
}

const handle = async (event) => {
  const { action, email, code, password, invite } = event || {};
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('邮箱格式不正确');

  /* 注册：邮箱 + 密码 */
  if (action === 'register' || action === 'signup') {
    if (!password || String(password).length < 6) return err('密码至少 6 位');
    const denied = signupGate(email, invite);
    if (denied) return err(denied, 'signup_denied');
    const exist = await findUser(email);
    if (exist) return err('该邮箱已注册，请直接登录');
    const salt = newSalt();
    await db.collection('cd_users').add({
      email, salt, hash: hashPwd(password, salt), created: Date.now(), provider: 'password'
    });
    return ok({ token: await issueToken(email), registered: true });
  }

  /* 登录：邮箱 + 密码 */
  if (action === 'login' || action === 'pwd') {
    if (!password) return err('请输入密码');
    const u = await findUser(email);
    if (!u) return err('账号不存在', 'no_user');
    if (!u.salt || !u.hash) return err('该账号未设置密码，请用验证码登录后设置');
    if (!safeEq(u.hash, hashPwd(password, u.salt))) return err('密码错误');
    return ok({ token: await issueToken(email) });
  }

  /* 找回密码：用邮件验证码设置新密码（需配置 SMTP 才能收到码） */
  if (action === 'reset') {
    if (!code || !password || String(password).length < 6) return err('请填写验证码与新密码（至少 6 位）');
    const col = db.collection('cd_logincodes');
    const r = await col.where({ email, code, used: false }).orderBy('created', 'desc').limit(1).get();
    if (!r.data.length) return err('验证码错误');
    const rec = r.data[0];
    if (Date.now() - rec.created > 10 * 60 * 1000) return err('验证码已过期');
    await col.doc(rec._id).update({ used: true });
    const salt = newSalt();
    const u = await findUser(email);
    if (u) await db.collection('cd_users').doc(u._id).update({ salt, hash: hashPwd(password, salt) });
    else await db.collection('cd_users').add({ email, salt, hash: hashPwd(password, salt), created: Date.now(), provider: 'password' });
    return ok({ token: await issueToken(email) });
  }

  /* 已登录用户设置/修改密码 */
  if (action === 'setpwd') {
    if (!password || String(password).length < 6) return err('新密码至少 6 位');
    const u = await findUser(email);
    const salt = newSalt();
    if (u && u.salt && u.hash) {
      if (!code && u.hash) {
        /* 修改密码需先用旧验证码 / 旧密码校验，这里要求传 code（验证码） */
        if (!code) return err('修改密码请先获取验证码');
        const col = db.collection('cd_logincodes');
        const r = await col.where({ email, code, used: false }).orderBy('created', 'desc').limit(1).get();
        if (!r.data.length) return err('验证码错误');
        await col.doc(r.data[0]._id).update({ used: true });
      }
      await db.collection('cd_users').doc(u._id).update({ salt, hash: hashPwd(password, salt) });
    } else if (u) {
      await db.collection('cd_users').doc(u._id).update({ salt, hash: hashPwd(password, salt) });
    } else {
      await db.collection('cd_users').add({ email, salt, hash: hashPwd(password, salt), created: Date.now(), provider: 'password' });
    }
    return ok({ token: await issueToken(email) });
  }

  /* 自检：验证 SMTP 配置是否可用（发一封测试邮件）。
     可带 host/port 覆盖参数做连通性排查（账号密码仍取服务端配置，不信任外部传入）。 */
  if (action === 'smtptest') {
    const host = (event.host && /^[a-zA-Z0-9.\-]+$/.test(event.host)) ? event.host : null;
    const port = (event.port && /^\d{2,5}$/.test(String(event.port))) ? parseInt(event.port) : null;
    try {
      const r = await sendMail(email, String(Math.floor(100000 + Math.random() * 900000)), host, port);
      if (r.dev) return err('服务端未配置 SMTP 环境变量');
      return ok({ sent: true });
    } catch (e) {
      return err((host ? '[' + host + ':' + (port || '默认') + '] ' : '') + 'SMTP 连接/发送失败：' + e.message);
    }
  }

  if (action === 'send') {
    /* 60 秒冷却 */
    const col = db.collection('cd_logincodes');
    const last = await col.where({ email }).orderBy('created', 'desc').limit(1).get();
    if (last.data.length && Date.now() - last.data[0].created < 60000) return err('发送太频繁，请 1 分钟后再试');

    const ncode = String(Math.floor(100000 + Math.random() * 900000));
    await col.add({ email, code: ncode, created: Date.now(), used: false });
    try {
      const r = await sendMail(email, ncode);
      return ok(r.dev ? { dev: true, code: r.code } : { dev: false });
    } catch (e) {
      return err('邮件发送失败：' + e.message);
    }
  }

  if (action === 'verify') {
    if (!code) return err('请输入验证码');
    const col = db.collection('cd_logincodes');
    const r = await col.where({ email, code, used: false }).orderBy('created', 'desc').limit(1).get();
    if (!r.data.length) return err('验证码错误');
    const rec = r.data[0];
    if (Date.now() - rec.created > 10 * 60 * 1000) return err('验证码已过期，请重新获取');
    await col.doc(rec._id).update({ used: true });

    /* 用户与会话 */
    const users = await db.collection('cd_users').where({ email }).limit(1).get();
    if (!users.data.length) await db.collection('cd_users').add({ email, created: Date.now(), provider: 'code' });
    const u0 = users.data[0];
    return ok({ token: await issueToken(email), hasPassword: !!(u0 && u0.hash) });
  }

  return err('未知操作');
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
