/* 存储抽象层：云端（CloudBase）与本地（IndexedDB）双模式 */
const Store = {
  mode: 'local',          // 'cloud' | 'local'
  account: null,          // {email, token, mode}
  app: null,              // cloudbase app 实例

  _idb: null,

  async init() {
    await IDB.open();
    const prevEmail = localStorage.getItem('cd_email') || '';
    this.account = JSON.parse(localStorage.getItem('cd_account') || 'null');
    this.mode = this.account ? this.account.mode : 'local';
    /* 换了账号登录就清空本机缓存，避免上一个账号的课件残留在这台设备上 */
    const curEmail = (this.account && this.account.email) || '';
    if (prevEmail && curEmail && prevEmail !== curEmail) {
      await IDB.clearAll();
    }
    if (curEmail) localStorage.setItem('cd_email', curEmail);
    if (this.mode === 'cloud') {
      /* HTTP 访问服务可用时不初始化 SDK（不需要匿名登录），SDK 只在文件上传/下载场景用到 */
      if (Cloud.httpReady()) {
        this.app = null;
      } else {
        try { this.app = await Cloud.init(); }
        catch (e) { toast('云端连接失败，已切换为本机模式：' + e.message, 'err'); this.mode = 'local'; }
      }
    }
  },

  authHeader() { return { email: this.account && this.account.email, token: this.account && this.account.token }; },

  /* ---------- 知识库 ---------- */
  async listLibs() {
    if (this.mode === 'cloud') {
      const r = await Cloud.call('cd-data', { action: 'listLibs', ...this.authHeader() });
      return r.libs || [];
    }
    return (await IDB.all('libs')).sort((a, b) => a.created - b.created);
  },
  async saveLib(lib) {
    if (this.mode === 'cloud') { await Cloud.call('cd-data', { action: 'saveLib', ...this.authHeader(), lib }); return; }
    await IDB.set('libs', lib);
  },
  async deleteLib(id) {
    if (this.mode === 'cloud') { await Cloud.call('cd-data', { action: 'deleteLib', ...this.authHeader(), id }); return; }
    await IDB.del('libs', id);
  },

  /* ---------- 文档元数据 ---------- */
  async listDocs() {
    if (this.mode === 'cloud') {
      const r = await Cloud.call('cd-data', { action: 'listDocs', ...this.authHeader() });
      return r.docs || [];
    }
    return (await IDB.all('meta')).sort((a, b) => b.created - a.created);
  },
  async saveDocMeta(meta) {
    if (this.mode === 'cloud') {
      await Cloud.call('cd-data', { action: 'saveDoc', ...this.authHeader(), doc: meta });
      return;
    }
    await IDB.set('meta', meta);
  },
  async deleteDoc(docId) {
    if (this.mode === 'cloud') {
      await Cloud.call('cd-data', { action: 'deleteDoc', ...this.authHeader(), docId });
    }
    await this._purgeLocal(docId);
  },

  /* 清空本机缓存里的某份课件：云端删除后同样要清，否则本机仍占着空间 */
  async _purgeLocal(docId) {
    await IDB.del('meta', docId).catch(() => {});
    await IDB.del('files', docId).catch(() => {});
    const as = await IDB.all('annots').catch(() => []);
    for (const a of as) if (a.docId === docId) await IDB.del('annots', a.id).catch(() => {});
    const ts = await IDB.all('trans').catch(() => []);
    for (const t of ts) if (t.docId === docId) await IDB.del('trans', t.key).catch(() => {});
    const cs = await IDB.all('chunks').catch(() => []);
    for (const c of cs) if (c.docId === docId) await IDB.del('chunks', c.id).catch(() => {});
  },

  /* ---------- 课件文件（本地始终缓存一份，云端另存一份） ---------- */
  async putFile(docId, blob, cloudPath) {
    await IDB._put('files', docId, blob);
    if (this.mode === 'cloud' && cloudPath) {
      /* HTTP 通道优先：体验版无法配置安全域名白名单，web SDK 上传会被拦截 */
      if (Cloud.httpReady()) return await Cloud.uploadHttp(docId, blob);
      return await Cloud.upload(cloudPath, blob);
    }
    return '';
  },
  async getFile(docId, meta) {
    const local = await IDB.get('files', docId);
    if (local || this.mode !== 'cloud') return local;
    try {
      const url = Cloud.httpReady()
        ? (await Cloud.call('cd-data', { action: 'fileUrl', ...this.authHeader(), fileID: meta.fileID })).url
        : await Cloud.tempUrl(meta.fileID);
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      await IDB._put('files', docId, blob);
      return blob;
    } catch (e) { throw new Error('课件下载失败：' + e.message); }
  },

  /* ---------- 标注 ---------- */
  async listAnnotations(docId) {
    if (this.mode === 'cloud') {
      const r = await Cloud.call('cd-data', { action: 'listAnnots', ...this.authHeader(), docId });
      return r.annots || [];
    }
    return (await IDB.all('annots')).filter(a => a.docId === docId).sort((a, b) => a.page - b.page);
  },
  async saveAnnotation(a) {
    if (this.mode === 'cloud') return (await Cloud.call('cd-data', { action: 'saveAnnot', ...this.authHeader(), annot: a })).annot;
    await IDB.set('annots', a); return a;
  },
  async deleteAnnotation(id) {
    if (this.mode === 'cloud') { await Cloud.call('cd-data', { action: 'delAnnot', ...this.authHeader(), id }); return; }
    await IDB.del('annots', id);
  },

  /* ---------- 翻译缓存 ---------- */
  async getTranslation(docId, page) {
    const key = docId + ':' + page;
    if (this.mode === 'cloud') {
      const r = await Cloud.call('cd-data', { action: 'getTrans', ...this.authHeader(), key });
      return r.trans || null;
    }
    return IDB.get('trans', key);
  },
  async saveTranslation(docId, page, lines) {
    const key = docId + ':' + page;
    if (this.mode === 'cloud') { await Cloud.call('cd-data', { action: 'saveTrans', ...this.authHeader(), key, lines }); return; }
    await IDB.set('trans', { key, docId, page, lines });
  },

  /* ---------- RAG 切块 ---------- */
  async saveChunks(docId, docName, chunks) {
    /* chunks: [{page, text, vec?}] */
    if (this.mode === 'cloud') {
      await Cloud.call('cd-ingest', { ...this.authHeader(), docId, docName, chunks: chunks.map(c => ({ page: c.page, text: c.text })) });
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      await IDB.set('chunks', { id: docId + ':' + i, docId, docName, page: chunks[i].page, text: chunks[i].text, vec: chunks[i].vec || null });
    }
  },
  async listChunks(docId) {
    if (this.mode === 'cloud') {
      const r = await Cloud.call('cd-data', { action: 'listChunks', ...this.authHeader(), docId: docId || '' });
      return r.chunks || [];
    }
    const all = await IDB.all('chunks');
    return docId ? all.filter(c => c.docId === docId) : all;
  },

  logout() {
    localStorage.removeItem('cd_account');
    this.account = null; this.mode = 'local';
  }
};

/* ---------- CloudBase 封装 ---------- */
const Cloud = {
  /* SDK 从腾讯官方 CDN 加载，慢的时候等它一会儿（最多 5 秒） */
  async _waitSdk() {
    for (let i = 0; i < 50; i++) {
      if (typeof cloudbase !== 'undefined') return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('CloudBase SDK 未加载（检查网络能否访问 imgcache.qq.com，或稍后重试）');
  },
  async init() {
    await this._waitSdk();
    const app = cloudbase.init({ env: S.data.envId });
    const auth = app.auth({ persistence: 'local' });
    const state = await auth.hasLoginState();
    if (!state) {
      /* 匿名登录：新版 SDK 是 auth.signInAnonymously()，
         1.x full 版是 auth.anonymousAuthProvider().signIn()，两者都试一下 */
      if (typeof auth.signInAnonymously === 'function') {
        await auth.signInAnonymously();
      } else if (typeof auth.anonymousAuthProvider === 'function') {
        await auth.anonymousAuthProvider().signIn();
      } else {
        throw new Error('当前 CloudBase SDK 不支持匿名登录');
      }
    }
    return app;
  },
  /* HTTP 访问服务的路径映射：SDK 函数名 → HTTP path。
     用 HTTP 通道的好处：不依赖环境的匿名登录开关、不受安全域名白名单限制，
     GitHub Pages / 任意域名托管的前端都能直连云函数。 */
  HTTP_PATH: { 'cd-login': 'cd/login', 'cd-data': 'cd/data', 'cd-ingest': 'cd/ingest', 'cd-ask': 'cd/ask', 'cd-translate': 'cd/translate' },

  httpReady() { return !!(S.data.httpBase && this.HTTP_PATH); },

  async call(name, data) {
    if (this.httpReady()) {
      const url = S.data.httpBase.replace(/\/+$/, '') + '/' + this.HTTP_PATH[name];
      if (!this.HTTP_PATH[name]) throw new Error('未映射的云函数：' + name);
      let res, text;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data || {})
        });
        text = await res.text();
      } catch (e) {
        throw new Error('云端连接失败（HTTP）：' + e.message);
      }
      if (!res.ok) throw new Error('云端返回 ' + res.status + '：' + text.slice(0, 180));
      let j;
      try { j = JSON.parse(text); } catch (e) { throw new Error('云端返回非 JSON：' + text.slice(0, 180)); }
      if (!j || !j.ok) {
        const e = new Error((j && j.error) || '云函数调用失败');
        if (j && j.code) e.code = j.code;
        throw e;
      }
      return j;
    }
    if (!Store.app) Store.app = await Cloud.init();
    const r0 = await Store.app.callFunction({ name, data });
    const r = r0 && r0.result;
    if (!r || !r.ok) {
      const e = new Error((r && r.error) || '云函数调用失败');
      if (r && r.code) e.code = r.code;
      throw e;
    }
    return r;
  },
  /* 通过云函数分块上传：HTTP 服务单请求约 100KB 上限，
     每块取 63000 字节（3 的倍数，base64 可直接拼接，编码后约 82KB < 上限），
     6 路并发上传分块（串行上传大文件需数分钟，并发后约快 5-6 倍） */
  async uploadHttp(docId, blob) {
    const CHUNK = 63000;
    const CONCURRENCY = 6;
    const total = Math.ceil(blob.size / CHUNK);
    const name = blob.name || (docId + '.bin');
    const begin = await this.call('cd-data', {
      action: 'uploadBegin', ...Store.authHeader(), docId, name, size: blob.size, total
    });
    const uploadId = begin.uploadId;
    try {
      let next = 0, done = 0;
      const worker = async () => {
        while (next < total) {
          const seq = next++;
          const slice = blob.slice(seq * CHUNK, Math.min(blob.size, (seq + 1) * CHUNK));
          const buf = await slice.arrayBuffer();
          await this.call('cd-data', {
            action: 'uploadChunk', ...Store.authHeader(), uploadId, seq, d: Cloud._b64(buf)
          });
          done++;
          if (typeof Store.onUploadProgress === 'function') Store.onUploadProgress(docId, done, total);
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
      const fin = await this.call('cd-data', { action: 'uploadFinish', ...Store.authHeader(), uploadId });
      return fin.fileID;
    } catch (e) {
      try { await this.call('cd-data', { action: 'uploadAbort', ...Store.authHeader(), uploadId }); } catch (e2) { /* 忽略清理失败 */ }
      throw e;
    }
  },
  _b64(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  async upload(cloudPath, file) {
    if (!Store.app) Store.app = await Cloud.init();
    const r = await Store.app.uploadFile({ cloudPath, filePath: file });
    return r.fileID;
  },
  async tempUrl(fileID) {
    if (!Store.app) Store.app = await Cloud.init();
    /* 1.x SDK：getTempFileURL({ fileList: [fileID] }) → { fileList: [{ tempFileURL }] }
       新版：getTempFileURL([fileID]) → [{ tempFileURL }]。两种签名都兼容。 */
    let r;
    try { r = await Store.app.getTempFileURL({ fileList: [fileID] }); } catch (e) {
      r = await Store.app.getTempFileURL([fileID]);
    }
    const item = (r && r.fileList && r.fileList[0]) || (r && r[0]);
    if (item && item.tempFileURL) return item.tempFileURL;
    if (item && item.download_url) return item.download_url;
    throw new Error('获取文件链接失败：' + JSON.stringify(item || r));
  }
};

/* ---------- IndexedDB ---------- */
const IDB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('coursedeck', 2);
      r.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('annots')) d.createObjectStore('annots', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('trans')) d.createObjectStore('trans', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('chunks')) d.createObjectStore('chunks', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('libs')) d.createObjectStore('libs', { keyPath: 'id' });
      };
      r.onsuccess = () => { IDB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  _st(s, mode) { return IDB.db.transaction(s, mode).objectStore(s); },
  _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  get(s, k) { return IDB._req(IDB._st(s, 'readonly').get(k)); },
  set(s, v) { return IDB._req(IDB._st(s, 'readwrite').put(v)); },
  _put(s, k, v) { return IDB._req(IDB._st(s, 'readwrite').put(v, k)); },
  del(s, k) { return IDB._req(IDB._st(s, 'readwrite').delete(k)); },
  all(s) { return IDB._req(IDB._st(s, 'readonly').getAll()); },
  async clear(s) {
    try { return await IDB._req(IDB._st(s, 'readwrite').clear()); } catch (e) { /* 表不存在则跳过 */ }
  },
  async clearAll() {
    for (const n of ['files', 'meta', 'annots', 'trans', 'chunks', 'libs']) await IDB.clear(n);
  }
};
