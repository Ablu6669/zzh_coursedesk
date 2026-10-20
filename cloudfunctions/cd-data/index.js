const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Requested-With',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
/* 云函数 data：登录态校验 + 文档/标注/翻译缓存/切块 的 CRUD 与级联删除 */
const cloud = require('@cloudbase/node-sdk');
const app = cloud.init({ env: cloud.SYMBOL_CURRENT_ENV });
const db = app.database();
const _ = db.command;

function ok(data) { return { ok: true, ...data }; }
function err(msg) { return { ok: false, error: msg }; }

async function authed(email, token) {
  if (!email || !token) return false;
  const r = await db.collection('cd_sessions').where({ email, token }).limit(1).get();
  return r.data.length > 0 && r.data[0].exp > Date.now();
}

const handle = async (event) => {
  const { action, email, token } = event || {};
  if (!(await authed(email, token))) return err('登录已失效，请重新登录');
  const docs = db.collection('cd_docs');
  const annots = db.collection('cd_annots');
  const trans = db.collection('cd_trans');
  const chunks = db.collection('cd_chunks');

  try {
    switch (action) {
      case 'listLibs': {
        const r = await db.collection('cd_libs').where({ email }).orderBy('created', 'asc').limit(200).get();
        return ok({ libs: r.data.map(l => ({ id: l.id, name: l.name, created: l.created })) });
      }
      case 'saveLib': {
        const l = event.lib;
        if (!l || !l.id || !l.name) return err('知识库数据不完整');
        const ex = await db.collection('cd_libs').where({ email, id: l.id }).limit(1).get();
        const rec = { id: l.id, name: l.name, created: l.created || Date.now(), email };
        if (ex.data.length) await db.collection('cd_libs').doc(ex.data[0]._id).set(rec);
        else await db.collection('cd_libs').add(rec);
        return ok({});
      }
      case 'deleteLib': {
        await db.collection('cd_libs').where({ email, id: event.id }).remove();
        return ok({});
      }
      case 'listDocs': {
        const r = await docs.where({ email }).orderBy('created', 'desc').limit(500).get();
        return ok({ docs: r.data.map(d => ({ id: d.id, name: d.name, pages: d.pages, size: d.size, created: d.created, libId: d.libId || '', fileID: d.fileID || '' })) });
      }
      case 'saveDoc': {
        const d = event.doc;
        if (!d || !d.id) return err('文档数据不完整');
        const ex = await docs.where({ email, id: d.id }).limit(1).get();
        if (ex.data.length) await docs.doc(ex.data[0]._id).set({ ...d, email });
        else await docs.add({ ...d, email });
        return ok({});
      }
      case 'deleteDoc': {
        const docId = event.docId;
        const ex = await docs.where({ email, id: docId }).limit(1).get();
        if (!ex.data.length) return ok({});
        const meta = ex.data[0];
        await docs.doc(meta._id).remove();
        if (meta.fileID) { try { await app.deleteFile({ fileList: [meta.fileID] }); } catch (e) { console.error('storage del', e.message); } }
        await annots.where({ email, docId }).remove();
        await trans.where({ email, docId }).remove();
        await chunks.where({ email, docId }).remove();
        return ok({});
      }
      case 'listAnnots': {
        const r = await annots.where({ email, docId: event.docId }).limit(2000).get();
        /* 全字段透传：type/points/tool/size（手写笔迹）、anchor/excerpt（文本锚点）都不能丢。
           同时滤掉历史脏数据（旧版丢字段存下来的无类型无矩形无锚点记录） */
        return ok({ annots: r.data
          .filter(a => a.type || (a.rects && a.rects.length) || a.anchor || a.note)
          .map(a => {
            const { _id, email: _e, ...rest } = a;
            return rest;
          }) });
      }
      case 'saveAnnot': {
        const a = event.annot;
        if (!a || !a.id) return err('标注数据不完整');
        const ex = await annots.where({ email, id: a.id }).limit(1).get();
        /* 白名单改为黑名单：只剔 _id，其余字段（type/points/tool/size/anchor/excerpt…）原样存 */
        const rec = { ...a, email };
        delete rec._id;
        if (ex.data.length) await annots.doc(ex.data[0]._id).set(rec);
        else await annots.add(rec);
        return ok({ annot: a });
      }
      case 'delAnnot': {
        await annots.where({ email, id: event.id }).remove();
        return ok({});
      }
      case 'getTrans': {
        const r = await trans.where({ email, key: event.key }).limit(1).get();
        return ok({ trans: r.data.length ? { lines: r.data[0].lines } : null });
      }
      case 'saveTrans': {
        const ex = await trans.where({ email, key: event.key }).limit(1).get();
        const rec = { key: event.key, docId: event.key.split(':')[0], lines: event.lines, email };
        if (ex.data.length) await trans.doc(ex.data[0]._id).set(rec);
        else await trans.add(rec);
        return ok({});
      }
      case 'listChunks': {
        let where = { email };
        if (event.docId) where = { email, docId: event.docId };
        const r = await chunks.where(where).limit(1000).get();
        return ok({ chunks: r.data.map(c => ({ id: c.id, docId: c.docId, docName: c.docName, page: c.page, text: c.text, vec: c.vec || null })) });
      }
      /* ---------- 分块上传（HTTP 服务请求体约 100KB 上限，前端按 45KB 原始字节切块） ---------- */
      case 'uploadBegin': {
        const { docId, name, size, total } = event;
        if (!docId || !name || !total) return err('上传参数不完整');
        const id = 'up_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        await db.collection('cd_uploads').add({ id, email, docId, name, size: size || 0, total, created: Date.now() });
        return ok({ uploadId: id });
      }
      case 'uploadChunk': {
        const { uploadId, seq, d } = event;
        if (!uploadId || typeof seq !== 'number' || typeof d !== 'string') return err('分块参数不完整');
        if (d.length > 90000) return err('分块超过大小限制');
        const sess = await db.collection('cd_uploads').where({ email, id: uploadId }).limit(1).get();
        if (!sess.data.length) return err('上传会话不存在或已过期');
        await db.collection('cd_upload_chunks').add({ email, uploadId, seq, d });
        return ok({ seq });
      }
      case 'uploadFinish': {
        const { uploadId } = event;
        const sessR = await db.collection('cd_uploads').where({ email, id: uploadId }).limit(1).get();
        if (!sessR.data.length) return err('上传会话不存在或已过期');
        const sess = sessR.data[0];
        /* 分页取出全部分块（每页最多 100 条） */
        const col = db.collection('cd_upload_chunks');
        let cursor = 0; const parts = [];
        for (;;) {
          const r = await col.where({ email, uploadId, seq: _.gte(cursor) }).orderBy('seq', 'asc').limit(100).get();
          for (const c of r.data) { parts.push(c.d); cursor = c.seq + 1; }
          if (r.data.length < 100) break;
        }
        if (parts.length < sess.total) return err('分块不完整：收到 ' + parts.length + '/' + sess.total);
        /* 每块原始字节数是 3 的倍数（前端保证），base64 可直接拼接 */
        const buf = Buffer.from(parts.join(''), 'base64');
        const ext = (sess.name.split('.').pop() || 'bin').toLowerCase();
        /* cloudPath 里不能百分号编码邮箱：getTempFileURL 按原始 key 算签名，
           CDN 校签时会把 %40 解码成 @，编码路径与签名不一致会直接 403 */
        const cloudPath = 'coursedeck/' + email + '/' + sess.docId + '.' + ext;
        const up = await app.uploadFile({ cloudPath, fileContent: buf });
        await col.where({ email, uploadId }).remove();
        await db.collection('cd_uploads').doc(sess._id).remove();
        return ok({ fileID: up.fileID, cloudPath, size: buf.length });
      }
      case 'uploadAbort': {
        await db.collection('cd_upload_chunks').where({ email, uploadId: event.uploadId }).remove();
        await db.collection('cd_uploads').where({ email, id: event.uploadId }).remove();
        return ok({});
      }
      case 'fileUrl': {
        if (!event.fileID) return err('缺少 fileID');
        const r = await app.getTempFileURL({ fileList: [event.fileID] });
        const f = r.fileList && r.fileList[0];
        if (!f || !f.tempFileURL) return err('获取文件链接失败：' + JSON.stringify(f || {}));
        return ok({ url: f.tempFileURL });
      }
      default:
        return err('未知操作');
    }
  } catch (e) {
    console.error(action, e);
    return err('服务异常：' + e.message);
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
