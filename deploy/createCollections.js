/* 用 @cloudbase/manager-node 直接创建集合（绕开 tcb db nosql execute 的 shell 转义问题）
 *   node deploy/createCollections.js
 * 依赖装在 deploy/.tools（独立 node_modules），不污染项目根目录与前端产物。
 */
const path = require('path');
const fs = require('fs');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const COLLECTIONS = ['cd_users', 'cd_logincodes', 'cd_sessions', 'cd_libs',
  'cd_docs', 'cd_annots', 'cd_trans', 'cd_chunks',
  'cd_uploads', 'cd_upload_chunks'];

(async () => {
  const modPath = path.join(__dirname, '.tools', 'node_modules', '@cloudbase', 'manager-node');
  const CloudBase = require(modPath);
  console.log('[debug] module:', typeof CloudBase, CloudBase.name, '->', modPath);
  const app = new CloudBase({
    envId: cfg.envId,
    secretId: cfg.tencentCloud.secretId,
    secretKey: cfg.tencentCloud.secretKey
  });
  const db = app.database;            /* manager-node v2：database 是 getter，不是方法 */
  if (!db || typeof db.createCollectionIfNotExists !== 'function') {
    throw new Error('数据库服务对象异常，可用方法：' + (db ? Object.getOwnPropertyNames(Object.getPrototypeOf(db)).join(', ') : 'null'));
  }
  let ok = 0, exist = 0, fail = 0;
  const failed = [];
  for (const c of COLLECTIONS) {
    try {
      const r = await db.createCollectionIfNotExists(c);
      if (r === true) { ok++; console.log('  ✓ 已创建 ' + c); }
      else { exist++; console.log('  ✓ ' + c + '（已存在，跳过）'); }
    } catch (e) {
      const m = String((e && e.message) || e);
      if (/已存在|exist/i.test(m)) { exist++; console.log('  ✓ ' + c + '（已存在，跳过）'); }
      else { fail++; failed.push(c + ': ' + m.slice(0, 160)); console.log('  ! ' + c + ' 失败：' + m.slice(0, 160)); }
    }
  }
  console.log('\n新建 ' + ok + ' ／已存在 ' + exist + ' ／失败 ' + fail);
  try {
    const list = await db.listCollections();
    const names = (Array.isArray(list) ? list : []).map(x => (x && x.name) || (x && x.collectionName) || String(x));
    const hit = COLLECTIONS.filter(c => names.some(n => String(n).includes(c)));
    console.log('云端现有集合：' + (hit.join('、') || '（读取列表失败，忽略）'));
  } catch (e) { /* 列表读取失败不影响结果 */ }
  if (failed.length) {
    console.log('\n失败明细：\n' + failed.join('\n'));
    console.log('\n若全部失败且提示鉴权，检查子账号是否已授 QcloudTCBFullAccess；');
    console.log('也可到控制台「数据库」页手动新建：' + COLLECTIONS.join('、'));
  }
})().catch(e => {
  console.error('[错误] ' + ((e && e.message) || e));
  process.exit(1);
});
