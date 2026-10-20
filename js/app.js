/* 应用入口：视图切换、设置、全局事件 */
const $ = s => document.querySelector(s);
function toast(msg, cls) {
  const t = document.createElement('div');
  t.className = 'toast ' + (cls || '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, cls === 'err' ? 5200 : 3200);
}

/* 通用对话框：替代原生 prompt/confirm（内置预览 iframe 会屏蔽原生弹窗导致点击无反应） */
const Dlg = {
  _resolve: null,
  _open(title, opts) {
    opts = opts || {};
    $('#dlg-title').textContent = title;
    const desc = $('#dlg-desc'), field = $('#dlg-field'), ok = $('#dlg-ok');
    if (opts.desc) { desc.textContent = opts.desc; desc.style.display = ''; } else desc.style.display = 'none';
    if (opts.input) {
      field.style.display = '';
      const inp = $('#dlg-input');
      inp.value = opts.value || '';
      inp.placeholder = opts.placeholder || '';
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
    } else field.style.display = 'none';
    ok.textContent = opts.okText || '确定';
    ok.className = 'btn ' + (opts.danger ? 'danger' : 'primary');
    $('#dlg-mask').classList.add('show');
    return new Promise(res => { this._resolve = res; });
  },
  _close(val) {
    $('#dlg-mask').classList.remove('show');
    if (this._resolve) { const r = this._resolve; this._resolve = null; r(val); }
  },
  /* 文本输入：resolve 字符串或 null（取消） */
  prompt(title, opts) { return this._open(title, { ...(opts || {}), input: true }); },
  /* 确认：resolve true/false */
  confirm(title, desc, okText) { return this._open(title, { desc, okText: okText || '确定', danger: true }); },
  init() {
    $('#dlg-ok').addEventListener('click', () => {
      const inp = $('#dlg-input');
      this._close($('#dlg-field').style.display === 'none' ? true : inp.value);
    });
    $('#dlg-cancel').addEventListener('click', () => this._close(null));
    $('#dlg-mask').addEventListener('click', e => { if (e.target.id === 'dlg-mask') this._close(null); });
    $('#dlg-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#dlg-ok').click();
      if (e.key === 'Escape') this._close(null);
    });
  }
};

const App = {
  view: 'login',

  show(v) {
    this.view = v;
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    $('#view-' + v).classList.add('active');
    if (v === 'library') $('#crumb').textContent = (Library.currentLib && Library.libs.find(l => l.id === Library.currentLib)) ? Library.libs.find(l => l.id === Library.currentLib).name : '我的课件库';
    Panel.syncExpandBtn();
  },

  enter() {
    $('#topbar').style.display = 'flex';
    this.renderSyncChip();
    this.renderSyncBar();
    $('#btn-logout').style.display = '';
    this.show('library');
    Library.render();
    QA.updateProviderLabel();
  },

  /* 顶栏徽章：一眼看清数据存在哪 */
  renderSyncChip() {
    const chip = $('#account-chip');
    if (!chip) return;
    if (Store.mode === 'cloud') {
      chip.className = 'chip cloud';
      chip.title = '云端模式：课件、标注、译文、索引都在云端，任意设备登录同一邮箱即可继续';
      chip.innerHTML = '<span class="dot"></span><span class="who">多设备同步 · ' + escapeHtml(Store.account.email) + '</span>';
    } else {
      chip.className = 'chip local';
      chip.title = '本地模式：数据只在这台设备的浏览器里，换个设备看不到';
      chip.innerHTML = '<span class="dot"></span><span class="who">仅本机</span>';
    }
  },

  /* 文库顶部状态条：把「现在是不是在同步」讲明白 */
  renderSyncBar() {
    const bar = $('#sync-bar');
    if (!bar) return;
    if (Store.mode === 'cloud') {
      bar.className = 'sync-bar cloud';
      bar.style.display = 'flex';
      bar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>' +
        '<span>云端同步已开启 · ' + escapeHtml(Store.account.email) + ' — 课件、标注、译文、索引都存在云端，换台设备登录同一邮箱即可继续</span>';
    } else {
      bar.className = 'sync-bar local';
      bar.style.display = 'flex';
      bar.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>' +
        '<span>正在「仅本机」运行：课件存在这台设备的浏览器里，换设备或清缓存就看不到了。接上云端后可在手机 / 平板 / 电脑之间同步。</span>' +
        '<div class="spacer"></div><button type="button" id="sync-bar-setup">配置云端同步</button>';
    }
  },

  /* 云端连通性自检：
     优先走 HTTP 访问服务（不需要匿名登录、不受安全域名白名单限制）；
     没配 httpBase 时退回 SDK 调用（要求环境已开启匿名登录）。 */
  async testCloud() {
    const btn = $('#btn-test-cloud'), hint = $('#cloud-hint');
    const envId = $('#set-env').value.trim();
    const httpBase = ($('#set-httpbase') ? $('#set-httpbase').value.trim() : '').replace(/\/+$/, '');
    if (!envId && !httpBase) { hint.className = 'hint err'; hint.textContent = '请先填写云环境 ID 或 HTTP 服务域名。'; return; }
    btn.disabled = true; btn.textContent = '测试中…';
    hint.className = 'hint'; hint.textContent = '正在连接…';
    try {
      if (httpBase) {
        const r = await fetch(httpBase + '/cd/data', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'listLibs', email: 'ping@ping', token: 'ping' })
        });
        if (!r.ok) throw new Error('HTTP ' + r.status + '：' + (await r.text()).slice(0, 120));
        const j = await r.json();
        if (j && 'ok' in j) {
          hint.className = 'hint ok';
          hint.textContent = '连接正常（HTTP 访问服务）：cd-data 云函数可达。保存设置后回到登录页用邮箱登录，即可启用多设备同步。';
        } else throw new Error('返回内容异常：' + JSON.stringify(j).slice(0, 120));
      } else {
        if (typeof cloudbase === 'undefined') throw new Error('CloudBase SDK 未加载，请检查网络后刷新页面');
        const app = cloudbase.init({ env: envId });
        const auth = app.auth({ persistence: 'local' });
        if (!(await auth.hasLoginState())) await auth.signInAnonymously();
        const rr = await app.callFunction({ name: 'cd-data', data: { action: 'listLibs', email: 'ping@ping', token: 'ping' } });
        const res = rr && rr.result;
        if (res && typeof res === 'object' && ('ok' in res)) {
          hint.className = 'hint ok';
          hint.textContent = '连接正常（SDK）：cd-data 云函数已部署。保存设置后回到登录页用邮箱登录，即可启用多设备同步。';
        } else throw new Error('云函数返回异常：' + JSON.stringify(res).slice(0, 120));
      }
    } catch (e) {
      hint.className = 'hint err';
      hint.textContent = '连接失败：' + e.message + (httpBase ? '' : ' — 若提示匿名登录被禁用，请在控制台「登录授权」里开启匿名登录，或改用 HTTP 访问服务域名');
    } finally {
      btn.disabled = false; btn.textContent = '测试连接';
    }
  },

  async boot() {
    await Store.init();
    Library.libs = await Store.listLibs().catch(() => []);

    /* 登录 */
    $('#btn-send-code').addEventListener('click', () => Auth.sendCode());
    $('#btn-verify').addEventListener('click', () => Auth.verify());
    $('#login-code').addEventListener('keydown', e => { if (e.key === 'Enter') Auth.verify(); });
    $('#btn-pwd-login').addEventListener('click', () => Auth.pwdLogin());
    $('#login-pwd').addEventListener('keydown', e => { if (e.key === 'Enter') Auth.pwdLogin(); });
    $('#btn-local-mode').addEventListener('click', () => Auth.localLogin());
    /* 登录方式切换：密码 / 验证码 */
    document.querySelectorAll('.ltab').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.ltab').forEach(x => x.classList.toggle('active', x === b));
        const t = b.dataset.tab;
        $('#pane-pwd').hidden = (t !== 'pwd');
        $('#pane-code').hidden = (t !== 'code');
      });
    });

    /* 知识库侧栏 */
    $('#btn-new-lib').addEventListener('click', () => Library.newLib());
    $('#lib-items').addEventListener('click', e => {
      const rn = e.target.closest('[data-rename]');
      const rm = e.target.closest('[data-rmlib]');
      if (rn) return Library.renameLib(rn.dataset.rename);
      if (rm) return Library.removeLib(rm.dataset.rmlib);
      const item = e.target.closest('.lib-item');
      if (item) Library.selectLib(item.dataset.lib);
    });

    /* 文库 */
    $('#btn-upload').addEventListener('click', () => $('#file-input').click());
    $('#file-input').addEventListener('change', e => { Library.upload([...e.target.files]); e.target.value = ''; });
    $('#btn-import-folder').addEventListener('click', () => $('#folder-input').click());
    $('#folder-input').addEventListener('change', e => {
      const files = [...e.target.files].filter(f => /\.(pdf|pptx|docx)$/i.test(f.name));
      if (!files.length) return toast('该文件夹内没有 PDF / PPTX / DOCX 文件', 'err');
      Library.upload(files);
      e.target.value = '';
    });
    $('#doc-search').addEventListener('input', () => Library.renderDocs());
    $('#doc-grid').addEventListener('click', e => {
      const open = e.target.closest('[data-open]');
      const del = e.target.closest('[data-del]');
      if (open) {
        const d = Library.docsCache.find(x => x.id === open.dataset.open);
        if (d) Reader.open(d).catch(err => toast('打开失败：' + err.message, 'err'));
      } else if (del) Library.remove(del.dataset.del);
    });

    /* 阅读器 */
    $('#btn-back').addEventListener('click', () => Reader.back());
    $('#page-input').addEventListener('change', e => Reader.goto(parseInt(e.target.value) || 1));
    $('#zoom-in').addEventListener('click', () => Reader.setZoom(0.15));
    $('#zoom-out').addEventListener('click', () => Reader.setZoom(-0.15));
    $('#btn-export').addEventListener('click', () => Exporter.run());
    $('#outline-list').addEventListener('click', e => {
      const it = e.target.closest('.outline-item');
      if (it && +it.dataset.pg) {
        Reader.goto(+it.dataset.pg);
        document.querySelectorAll('.outline-item').forEach(x => x.classList.remove('cur'));
        it.classList.add('cur');
      }
    });

    /* 侧栏 tab */
    document.querySelectorAll('.panel-tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.panel-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.tab-body').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('#tab-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'annot') Annotate.renderSideList();
      if (t.dataset.tab === 'translate') Translate.onPageChange();
    }));

    /* 工具台：收起 / 展开 / 拖宽 */
    Panel.init();

    /* 同步状态条上的「配置云端同步」 */
    $('#sync-bar').addEventListener('click', e => {
      if (e.target.id === 'sync-bar-setup') this.openSettings();
    });

    /* 退出 / 设置 */
    $('#btn-logout').addEventListener('click', () => { Store.logout(); location.reload(); });
    $('#btn-settings').addEventListener('click', () => this.openSettings());
    $('#btn-test-cloud').addEventListener('click', () => this.testCloud());
    $('#settings-cancel').addEventListener('click', () => $('#settings-mask').classList.remove('show'));
    $('#settings-mask').addEventListener('click', e => { if (e.target.id === 'settings-mask') $('#settings-mask').classList.remove('show'); });
    $('#settings-save').addEventListener('click', () => {
      S.save({
        envId: $('#set-env').value.trim(),
        httpBase: ($('#set-httpbase') ? $('#set-httpbase').value.trim() : '').replace(/\/+$/, ''),
        llmBase: $('#set-llmbase').value.trim() || S.data.llmBase,
        llmKey: $('#set-llmkey').value.trim(),
        llmModel: $('#set-llmmodel').value.trim() || S.data.llmModel,
        embedModel: $('#set-embedmodel').value.trim() || S.data.embedModel,
        serperKey: $('#set-serper').value.trim()
      });
      $('#settings-mask').classList.remove('show');
      toast('设置已保存' + (S.data.envId ? '（切换云端需重新登录）' : ''), 'ok');
      QA.updateProviderLabel();
    });

    Annotate.init();
    Translate.init();
    QA.init();
    Dlg.init();

    /* 已登录则直接进入 */
    if (Store.account) this.enter();
    else {
      $('#login-hint').textContent = S.data.envId
        ? '云环境 ' + S.data.envId + ' 已配置：登录后课件、标注、译文全部存云端，换设备登录同一邮箱即可继续。'
        : '尚未接入云端，现在是「仅本机」模式（换设备看不到）。点右上角齿轮接入腾讯云，或先进本地模式体验。';
    }
  },

  openSettings() {
    $('#set-env').value = S.data.envId;
    if ($('#set-httpbase')) $('#set-httpbase').value = S.data.httpBase || '';
    $('#set-llmbase').value = S.data.llmBase;
    $('#set-llmkey').value = S.data.llmKey;
    $('#set-llmmodel').value = S.data.llmModel;
    $('#set-embedmodel').value = S.data.embedModel;
    $('#set-serper').value = S.data.serperKey;
    /* 分区显隐：云端配置仅管理员（或未登录时的初始化）可见；
       管理员用服务端已配好的 AI，普通账号填自己的 Key 走本地直连 */
    const admin = typeof isAdmin === 'function' && isAdmin();
    $('#sec-cloud').style.display = (admin || !Store.account) ? '' : 'none';
    $('#sec-ai-local').style.display = admin ? 'none' : '';
    $('#sec-admin-note').style.display = admin ? '' : 'none';
    $('#settings-mask').classList.add('show');
  }
};

/* 右侧工具台：拖拽调宽 + 收起/展开（状态记忆） */
const Panel = {
  MIN: 300, MAX: 560,
  init() {
    const w = parseInt(localStorage.getItem('cd_panel_w') || '');
    if (w >= this.MIN && w <= this.MAX) $('#side-panel').style.width = w + 'px';
    this.collapse(localStorage.getItem('cd_panel_col') === '1', true);
    $('#panel-collapse').addEventListener('click', () => this.collapse(true));
    $('#panel-expand').addEventListener('click', () => this.collapse(false));

    const handle = $('#panel-handle');
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const panel = $('#side-panel');
      const startX = e.clientX, startW = panel.offsetWidth;
      panel.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const move = ev => {
        const w = Math.min(this.MAX, Math.max(this.MIN, startW + (startX - ev.clientX)));
        panel.style.width = w + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        panel.classList.remove('resizing');
        localStorage.setItem('cd_panel_w', String(Math.round(panel.offsetWidth)));
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  },

  collapse(on, silent) {
    $('#side-panel').classList.toggle('collapsed', !!on);
    localStorage.setItem('cd_panel_col', on ? '1' : '0');
    this.syncExpandBtn();
  },

  syncExpandBtn() {
    const btn = $('#panel-expand');
    if (!btn) return;
    btn.classList.toggle('show', App.view === 'reader' && $('#side-panel').classList.contains('collapsed'));
  }
};

window.addEventListener('DOMContentLoaded', () => App.boot());
