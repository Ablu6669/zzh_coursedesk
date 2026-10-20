/* 登录：云端=邮箱验证码；本地=免登录 */
const Auth = {
  cooldown: 0,

  async sendCode() {
    const email = $('#login-email').value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('请输入有效邮箱', 'err');
    if (Store.mode !== 'cloud' && !S.data.envId) return toast('未配置云环境 ID，请先到设置中填写，或使用本地模式', 'err');
    const btn = $('#btn-send-code');
    btn.disabled = true;
    let waitMsg = '验证码已发送，请查收邮箱（10 分钟内有效）';
    try {
      if (Store.mode === 'cloud') {
        const r = await Cloud.call('cd-login', { action: 'send', email });
        if (r && r.dev && r.code) waitMsg = '未配置邮件服务，验证码为：' + r.code + '（10 分钟内有效）';
        toast(waitMsg, 'ok');
      } else {
        /* 环境已配置但未登录（云端登录页）：切到云端模式再发 */
        Store.mode = 'cloud';
        /* 走 HTTP 访问服务时无需 SDK 登录态，只有 SDK 模式才要匿名登录 */
        if (!Cloud.httpReady()) Store.app = await Cloud.init();
        const r2 = await Cloud.call('cd-login', { action: 'send', email });
        if (r2 && r2.dev && r2.code) waitMsg = '未配置邮件服务，验证码为：' + r2.code + '（10 分钟内有效）';
        toast(waitMsg, 'ok');
      }
      let left = 60;
      const t = setInterval(() => { btn.textContent = left-- + 's'; if (left <= 0) { clearInterval(t); btn.disabled = false; btn.textContent = '发送验证码'; } }, 1000);
    } catch (e) {
      btn.disabled = false;
      toast('发送失败：' + e.message, 'err');
    }
  },

  /* 密码登录：账号不存在时询问是否直接注册 */
  async pwdLogin() {
    const email = $('#login-email').value.trim();
    const password = $('#login-pwd').value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('请输入有效邮箱', 'err');
    if (!password || password.length < 6) return toast('密码至少 6 位', 'err');
    const btn = $('#btn-pwd-login');
    btn.disabled = true; btn.textContent = '登录中…';
    try {
      let r;
      try {
        r = await Cloud.call('cd-login', { action: 'login', email, password });
      } catch (e) {
        if (e.code !== 'no_user') throw e;
        const yes = await Dlg.confirm('账号不存在', '邮箱 ' + email + ' 还没有注册，要用这个密码创建账号吗？', '创建并登录');
        if (!yes) { btn.disabled = false; btn.textContent = '登 录'; return; }
        r = await Cloud.call('cd-login', { action: 'register', email, password });
        toast('账号已创建，已登录', 'ok');
      }
      this._enter(email, r.token);
    } catch (e) {
      btn.disabled = false; btn.textContent = '登 录';
      toast('登录失败：' + e.message, 'err');
    }
  },

  _enter(email, token) {
    Store.account = { email, token, mode: 'cloud' };
    Store.mode = 'cloud';
    localStorage.setItem('cd_account', JSON.stringify(Store.account));
    App.enter();
  },

  async verify() {
    const email = $('#login-email').value.trim();
    const code = $('#login-code').value.trim();
    if (!email || !code) return toast('请填写邮箱与验证码', 'err');
    try {
      const r = await Cloud.call('cd-login', { action: 'verify', email, code });
      this._enter(email, r.token);
    } catch (e) {
      toast('登录失败：' + e.message, 'err');
    }
  },

  localLogin() {
    Store.account = { email: 'local@demo', token: '', mode: 'local' };
    Store.mode = 'local';
    localStorage.setItem('cd_account', JSON.stringify(Store.account));
    App.enter();
  }
};
