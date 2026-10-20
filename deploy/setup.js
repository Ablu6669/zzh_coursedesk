/* 课件台 · 一键部署脚本
 *
 *   node deploy/setup.js          全部执行
 *   node deploy/setup.js cloud    只部署腾讯云 CloudBase
 *   node deploy/setup.js github   只准备 GitHub Pages
 *   node deploy/setup.js dist     只生成本地 dist 产物
 *
 * 前置：把 deploy/config.example.json 复制为 deploy/config.json 并填写。
 * 设计要点：
 *   1. 密钥只存在于 config.json（已 gitignore），生成 cloudbaserc.local.json 供 CLI 使用，不进 Git；
 *   2. 静态托管是公开可访问的，因此只上传 index.html + css/ + js/ 三个产物，
 *      云函数源码、deploy/ 配置绝不上行（否则密钥会泄露）；
 *   3. 每一步幂等，失败后修完可重跑，已存在的集合/函数会被跳过而非报错。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'config.json');
const RC_PATH = path.join(ROOT, 'cloudbaserc.local.json');
const DIST = path.join(ROOT, 'dist');
const GHDIST = path.join(ROOT, 'dist-gh');

/* 命名空间隔离：与其他项目共用同一环境时，集合加 cd_ 前缀、函数加 cd- 前缀、
   静态托管部署到子路径 /coursedeck/，互不干扰 */
const COLLECTIONS = ['cd_users', 'cd_logincodes', 'cd_sessions', 'cd_libs', 'cd_docs', 'cd_annots', 'cd_trans', 'cd_chunks', 'cd_uploads', 'cd_upload_chunks'];
const FUNCTIONS = ['cd-login', 'cd-data', 'cd-ingest', 'cd-ask', 'cd-translate'];
const HOSTING_PATH = '/coursedeck/';

/* ---------- 工具链 ---------- */
function detect() {
  const nodeDir = ['C:\\Users\\asus\\.workbuddy\\binaries\\node\\versions\\22.22.2-3']
    .find(d => fs.existsSync(path.join(d, 'node.exe')));
  const gitDir = ['C:\\Users\\asus\\.workbuddy\\binaries\\PortableGit\\versions\\1.2.0']
    .find(d => fs.existsSync(path.join(d, 'cmd', 'git.exe')));
  if (!nodeDir) die('找不到 node.exe');
  if (!gitDir) die('找不到 git.exe');
  const PATH = [gitDir + '\\usr\\bin', gitDir + '\\cmd', gitDir + '\\bin', nodeDir, process.env.PATH].join(';');
  return { nodeDir, gitDir, env: { ...process.env, PATH } };
}

function die(msg) { console.error('\n[错误] ' + msg + '\n'); process.exit(1); }
function step(n, title) { console.log('\n' + '='.repeat(60) + `\n 第 ${n} 步 · ${title}\n` + '='.repeat(60)); }
function info(s) { console.log('  · ' + s); }
function ok(s) { console.log('  ✓ ' + s); }
function warn(s) { console.log('  ! ' + s); }

let TOOL;
function tcb(args, opts) {
  opts = opts || {};
  const r = spawnSync(path.join(TOOL.nodeDir, 'tcb.cmd'), args, {
    cwd: ROOT, env: TOOL.env, shell: true,
    stdio: opts.capture ? 'pipe' : 'inherit'
  });
  if (opts.capture) return { code: r.status, out: (r.stdout || '').toString() + (r.stderr || '').toString() };
  return { code: r.status, out: '' };
}
function git(args, opts) {
  opts = opts || {};
  const r = spawnSync('git', args, {
    cwd: opts.cwd || ROOT, env: TOOL.env, shell: true,
    stdio: opts.capture ? 'pipe' : 'inherit',
    input: opts.input
  });
  if (opts.capture) return { code: r.status, out: (r.stdout || '').toString() + (r.stderr || '').toString() };
  return { code: r.status, out: '' };
}

/* ---------- 配置 ---------- */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('\n[错误] 找不到 deploy/config.json');
    console.error('请先执行： copy deploy\\config.example.json deploy\\config.json');
    console.error('然后填写其中的 envId 与各项密钥。\n');
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!cfg.envId || cfg.envId.indexOf('在这里填') === 0) {
    die('config.json 里的 envId 还没填。去 tcb.cloud.tencent.com 开通环境后复制环境 ID。');
  }
  return cfg;
}

/* 生成供 CLI 使用的本地配置（含环境变量，不进 Git） */
function writeLocalRc(cfg) {
  const llm = cfg.llm || {}, smtp = cfg.smtp || {};
  const common = { LLM_BASE: llm.base || '', LLM_KEY: llm.key || '' };
  const envOf = {
    'cd-login': { SMTP_HOST: smtp.host || '', SMTP_PORT: smtp.port || '465', SMTP_USER: smtp.user || '', SMTP_PASS: smtp.pass || '', SMTP_FROM: smtp.from || smtp.user || '' },
    'cd-data': {},
    'cd-ingest': { ...common, EMBED_MODEL: llm.embedModel || 'hunyuan-embedding' },
    'cd-ask': { ...common, LLM_MODEL: llm.model || '', EMBED_MODEL: llm.embedModel || 'hunyuan-embedding', SERPER_KEY: cfg.serperKey || '' },
    'cd-translate': { ...common, LLM_MODEL: llm.model || '' }
  };
  const rc = {
    version: '2.0',
    envId: cfg.envId,
    /* 不放 functionRoot 的话 CLI 会按默认 functions/ 目录找代码，导致部署失败 */
    functionRoot: 'cloudfunctions',
    functionDefaultConfig: { timeout: 60, memorySize: 512 },
    functions: FUNCTIONS.map(n => ({ name: n, envVariables: envOf[n] || {} }))
  };
  fs.writeFileSync(RC_PATH, JSON.stringify(rc, null, 2));
  ok('已生成 cloudbaserc.local.json（含环境变量，已在 .gitignore 中）');
}

/* ---------- 第 N 步 ---------- */
function checkLogin(cfg) {
  step(1, '检查登录状态');
  const r = tcb(['env', 'list'], { capture: true });
  if (r.code === 0 && r.out.includes(cfg.envId)) {
    return ok('已登录，环境 ' + cfg.envId + ' 可见');
  }

  const tc = cfg.tencentCloud || {};
  if (tc.secretId && tc.secretKey) {
    info('正在用 config.json 里的 API 密钥登录（非交互）');
    const l = tcb(['login', '--apiKeyId', tc.secretId, '--apiKey', tc.secretKey, '--json'], { capture: true });
    if (l.code !== 0) {
      die('密钥登录失败：' + l.out.trim().slice(0, 300) +
        '\n\n请确认 SecretId / SecretKey 正确，且该账号有云开发权限。' +
        '\n推荐用仅授予「云开发」权限的子用户密钥，不要用主账号密钥。');
    }
    ok('密钥登录成功');
  } else {
    warn('尚未登录，且 config.json 里没填 API 密钥 —— 改用浏览器授权');
    console.log('\n  即将打开浏览器，请在页面里登录并点「确认授权」。\n  注意：设备码 10 分钟内有效，超时要重跑本脚本。');
    console.log('  想省事的话：把 SecretId / SecretKey 填进 deploy/config.json 的 tencentCloud 字段，即可静默登录。\n');
    const l = tcb(['login']);
    if (l.code !== 0) {
      die('登录失败。推荐改用 API 密钥：控制台 console.cloud.tencent.com/cam/capi 获取 SecretId / SecretKey，\n填进 deploy/config.json 的 tencentCloud 字段后重跑本脚本。');
    }
  }

  const r2 = tcb(['env', 'list'], { capture: true });
  if (r2.code !== 0 || !r2.out.includes(cfg.envId)) {
    die('登录后仍看不到环境 ' + cfg.envId + '。请确认环境已创建，且登录的账号与创建环境的账号一致。');
  }
  ok('已登录，环境 ' + cfg.envId + ' 可见');
}

function createCollections() {
  step(2, '创建数据库集合');
  /* tcb db nosql execute 在 Windows 下参数转义不可靠，改用 manager-node SDK 直调 */
  const r = spawnSync(path.join(TOOL.nodeDir, 'node.exe'), [path.join(__dirname, 'createCollections.js')], {
    cwd: ROOT, env: TOOL.env, stdio: 'inherit'
  });
  if (r.status !== 0) warn('集合创建脚本返回非零状态，请按上面的提示处理');
}

function deployFunctions() {
  step(3, '部署 5 个云函数（约 2–4 分钟）');
  for (const n of FUNCTIONS) {
    const r = tcb(['fn', 'deploy', n, '--config-file', 'cloudbaserc.local.json', '--force'], { capture: true });
    if (r.code === 0) ok('云函数 ' + n);
    else warn('云函数 ' + n + ' 部署异常（退出码 ' + r.code + '）\n' + r.out.trim().slice(0, 400));
  }
}

function addDomains(cfg) {
  step(4, '配置安全域名');
  const list = (cfg.domains || []).filter(Boolean);
  if (!list.length) return warn('config.json 的 domains 为空，跳过（之后可手动加）');
  const r = tcb(['cors', 'add', list.join(','), '--config-file', 'cloudbaserc.local.json'], { capture: true });
  if (r.code === 0) ok('已加入：' + list.join(', '));
  else warn('安全域名设置有误：' + r.out.trim().slice(0, 250));
}

/* 只把前端产物复制到 dist —— 云函数与 deploy/ 绝不上行 */
function buildDist(target, injectEnvId) {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(target, 'index.html'));
  for (const d of ['css', 'js']) {
    fs.cpSync(path.join(ROOT, d), path.join(target, d), { recursive: true });
  }
  if (injectEnvId) {
    /* GitHub Pages 版：预置环境 ID 与 HTTP 服务域名，用户打开即可用云端，无需手动配置 */
    const p = path.join(target, 'index.html');
    let html = fs.readFileSync(p, 'utf8');
    const inject = '<script>window.__CD_ENV__=' + JSON.stringify(injectEnvId) +
      (cfg.httpBase ? ';window.__CD_HTTP_BASE__=' + JSON.stringify(cfg.httpBase.replace(/\/+$/, '')) : '') + '</script>\n';
    html = html.replace('<link rel="stylesheet"', inject + '<link rel="stylesheet"');
    fs.writeFileSync(p, html);
    ok('已向 GitHub 版注入默认环境 ID 与 HTTP 服务域名');
  }
  ok('产物目录 ' + path.relative(ROOT, target) + '（仅 index.html + css/ + js/）');
}

function deployHosting() {
  step(5, '部署静态托管');
  buildDist(DIST, null);
  const r = tcb(['hosting', 'deploy', 'dist', HOSTING_PATH, '--config-file', 'cloudbaserc.local.json'], { capture: true });
  if (r.code === 0) {
    ok('静态托管已部署到子路径 ' + HOSTING_PATH + '（不影响同环境其它项目的根路径）');
    const d = tcb(['hosting', 'detail', '--config-file', 'cloudbaserc.local.json'], { capture: true });
    if (d.out) console.log(d.out.trim().slice(0, 600));
    console.log('\n  默认域名形如 https://' + '你的环境ID' + '.tcloudbaseapp.com');
    console.log('  在控制台「静态网站托管 → 设置」可以看到准确地址。');
  } else {
    warn('静态托管部署失败：' + r.out.trim().slice(0, 400));
  }
}

/* ---------- GitHub Pages ---------- */
function setupGithub(cfg) {
  step(6, '准备 GitHub Pages');
  const gh = cfg.github || {};
  buildDist(GHDIST, cfg.envId);

  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    info('初始化 Git 仓库');
    if (git(['init']).code !== 0) die('git init 失败');
    git(['branch', '-M', 'main']);
  } else ok('Git 仓库已存在');

  const idx = path.join(GHDIST, 'index.html');
  if (!fs.existsSync(idx)) die('dist-gh/index.html 不存在');

  /* 把 GitHub 产物作为 gh-pages 分支内容提交 */
  const ghRepo = path.join(ROOT, '.gh-worktree');
  info('生成 gh-pages 分支内容');
  const branches = git(['branch', '--list'], { capture: true }).out;
  const hasGh = branches.split('\n').some(b => b.replace('*', '').trim() === 'gh-pages');
  if (fs.existsSync(ghRepo)) fs.rmSync(ghRepo, { recursive: true, force: true });
  if (hasGh) git(['worktree', 'remove', '.gh-worktree', '--force'], { capture: true });
  const wt = git(['worktree', 'add', '.gh-worktree', hasGh ? 'gh-pages' : '-b', hasGh ? '' : 'gh-pages'].filter(Boolean), { capture: true });
  if (wt.code !== 0 && !hasGh) {
    git(['worktree', 'add', '.gh-worktree', '-b', 'gh-pages'], { capture: true });
  }
  if (!fs.existsSync(ghRepo)) die('无法创建 gh-pages worktree，请在 GitHub 网页端手动上传 dist-gh 目录内容');

  for (const f of fs.readdirSync(ghRepo)) {
    if (f === '.git') continue;
    fs.rmSync(path.join(ghRepo, f), { recursive: true, force: true });
  }
  fs.cpSync(GHDIST, ghRepo, { recursive: true });

  git(['add', '-A'], { cwd: ghRepo });
  const st = git(['status', '--porcelain'], { cwd: ghRepo, capture: true });
  if (!st.out.trim()) info('gh-pages 内容无变化，跳过提交');
  else {
    const cm = git(['commit', '-m', 'Deploy CourseDeck to GitHub Pages'], { cwd: ghRepo, capture: true });
    if (cm.code === 0) ok('已提交到 gh-pages 分支');
    else warn('提交失败（可能未配置 git 身份）：' + cm.out.slice(0, 200));
  }

  const remotes = git(['remote', '-v'], { capture: true }).out;
  if (!remotes.includes('origin')) {
    console.log('\n  还没有 GitHub 远程仓库。请按下面两步操作：');
    console.log('    1) 打开 https://github.com/new  新建仓库：' + (gh.repo || 'coursedeck') + '（Public，不要勾选任何初始化选项）');
    console.log('    2) 创建后执行：');
    console.log('       git remote add origin https://github.com/' + (gh.user || '你的用户名') + '/' + (gh.repo || 'coursedeck') + '.git');
    console.log('       git push -u origin main');
    console.log('       git push -u origin gh-pages');
    console.log('  然后在仓库 Settings → Pages → Source 选 gh-pages 分支 / root。');
    console.log('  最后把 https://' + (gh.user || '用户名') + '.github.io/' + (gh.repo || 'coursedeck') + ' 加入 CloudBase 安全域名。');
  } else {
    info('已有 origin，可直接推送：git push origin main && git push origin gh-pages');
  }
}

/* ---------- 主流程 ---------- */
const target = (process.argv[2] || 'all').toLowerCase();
TOOL = detect();
const cfg = loadConfig();
writeLocalRc(cfg);

if (target === 'cloud' || target === 'all') {
  checkLogin(cfg);
  createCollections();
  deployFunctions();
  addDomains(cfg);
  deployHosting();
}
if (target === 'github' || target === 'all') {
  setupGithub(cfg);
}
if (target === 'dist') {
  buildDist(DIST, null);
  buildDist(GHDIST, cfg.envId);
}

console.log('\n完成。\n');
