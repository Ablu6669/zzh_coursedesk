/* 构建 dist/ 与 dist-gh/
 * 源码版 index.html 通过 <script src="deploy/env.js"> 加载云端配置（env.js 已 gitignore）；
 * 构建时把这行替换为内联配置，产物即可独立部署，不再依赖 deploy/env.js。
 * 用法：node deploy/build.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 从 deploy/env.js 读出云端配置（缺失则构建出「仅本机」版本） */
let ENV = '', HTTP = '';
try {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', 'env.js'), 'utf8');
  ENV = (src.match(/__CD_ENV__\s*=\s*"([^"]*)"/) || [])[1] || '';
  HTTP = (src.match(/__CD_HTTP_BASE__\s*=\s*"([^"]*)"/) || [])[1] || '';
} catch (e) {
  console.warn('[build] 未找到 deploy/env.js，将构建为「仅本机」版本（无云端同步）');
}

const TAG = '<script>window.__CD_ENV__=' + JSON.stringify(ENV) +
  ';window.__CD_HTTP_BASE__=' + JSON.stringify(HTTP) + '</script>';

function build(target) {
  /* 覆盖写入，不整目录删除：
     产物目录重建本身无害，但整目录 rmSync 会触发批量删除保护，这里改为增量覆盖即可。 */
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'index.html'), path.join(target, 'index.html'));
  for (const d of ['css', 'js']) fs.cpSync(path.join(ROOT, d), path.join(target, d), { recursive: true });

  const p = path.join(target, 'index.html');
  let h = fs.readFileSync(p, 'utf8');
  const before = h;
  h = h.replace('<script src="deploy/env.js"></script>', TAG);
  if (h === before) console.warn('[build] 警告：未匹配到 env.js 引用行，检查 index.html 是否被改过');
  fs.writeFileSync(p, h);

  /* 跳过 GitHub Pages 的 Jekyll 处理，避免其忽略部分静态文件 */
  fs.writeFileSync(path.join(target, '.nojekyll'), '');
  console.log('[build] ' + path.basename(target) + ' 已生成' + (ENV ? '（云端：' + ENV + '）' : '（仅本机）'));
}

build(path.join(ROOT, 'dist'));
build(path.join(ROOT, 'dist-gh'));
