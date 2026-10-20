#!/usr/bin/env node
/* 发布到 GitHub
 *   main 分支：源码（已 gitignore 全部密钥）
 *   gh-pages 分支：dist-gh/ 构建产物（用于 GitHub Pages）
 *
 * 用法：
 *   node deploy/publish-gh.js --repo <owner>/<repo> --token <github_pat>
 *   GH_TOKEN=<pat> node deploy/publish-gh.js --repo <owner>/<repo>
 *
 * 说明：token 只用于本次 push 的临时远端地址，不会写入任何文件。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : '';
}
const repo = arg('repo');
const token = arg('token') || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

if (!repo) { console.error('缺少 --repo <owner>/<repo>'); process.exit(1); }
if (!token) { console.error('缺少 --token <pat>（或设 GH_TOKEN 环境变量）'); process.exit(1); }

const run = (cmd, args, opts) => {
  console.log('$ ' + cmd + ' ' + args.map(a => a.includes(token) ? '***' : a).join(' '));
  return execFileSync(cmd, args, Object.assign({ cwd: ROOT, stdio: 'inherit' }, opts || {}));
};

/* 1. 构建产物 */
console.log('\n[1/4] 构建 dist-gh/');
run(process.execPath, [path.join(ROOT, 'deploy', 'build.js')]);

/* 2. 推源码到 main */
console.log('\n[2/4] 推送源码到 main');
const remote = 'https://' + token + '@github.com/' + repo + '.git';
try { run('git', ['remote', 'remove', 'origin']); } catch (e) { /* 原本没有 */ }
run('git', ['remote', 'add', 'origin', remote]);
run('git', ['push', '-u', 'origin', 'main']);

/* 3. 在临时目录准备 gh-pages 分支（.nojekyll 已由 build.js 生成） */
console.log('\n[3/4] 准备 gh-pages 分支');
const tmp = path.join(ROOT, '.gh-pages');
if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'dist-gh'), tmp, { recursive: true });

const runIn = (cmd, args) => {
  console.log('$ (gh-pages) ' + cmd + ' ' + args.join(' '));
  return execFileSync(cmd, args, { cwd: tmp, stdio: 'inherit' });
};
runIn('git', ['init', '-q']);
runIn('git', ['checkout', '-q', '-b', 'gh-pages']);
runIn('git', ['add', '-A']);
runIn('git', ['-c', 'user.name=coursedeck', '-c', 'user.email=coursedeck@local',
  'commit', '-q', '-m', 'deploy: 发布 GitHub Pages 构建产物']);
runIn('git', ['push', '-f', remote, 'gh-pages']);

/* 4. 清理并提示 */
console.log('\n[4/4] 清理临时凭据');
try { run('git', ['remote', 'remove', 'origin']); } catch (e) { /* ignore */ }
fs.rmSync(tmp, { recursive: true, force: true });

const user = repo.split('/')[0];
const name = repo.split('/')[1];
console.log('\n完成。');
console.log('  源码仓库：https://github.com/' + repo);
console.log('  在线站点：https://' + user + '.github.io/' + name + '/');
console.log('  （若 Pages 未开启：仓库 Settings → Pages → Source 选 gh-pages 分支 / root）');
console.log('\n提示：临时远端已移除，token 未落盘。');
