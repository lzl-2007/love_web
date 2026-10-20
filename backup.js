#!/usr/bin/env node
/**
 * ============================================================
 *  爱的小站 · 一键备份 / 恢复
 * ------------------------------------------------------------
 *  备份：双击 backup.bat，或在命令行执行 node backup.js
 *        → 在 备份/ 目录下生成 2026-10-20.json（含全部文字和图片）
 *        → 同时把内嵌图片单独导出到 备份/图片/，可以直接点开看
 *
 *  恢复：node backup.js --restore "备份/2026-10-20.json"
 *        预览差异 → 输入 yes 确认 → 把备份写回数据库
 *        （按 id 对应：数据库里没有的补回来，内容不一样的覆盖回去；
 *          不会删除数据库里比备份更新的记录）
 * ============================================================
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const ROOT = __dirname;
const BACKUP_DIR = path.join(ROOT, '备份');
const IMG_DIR = path.join(BACKUP_DIR, '图片');
const SITE = 'love-web-blond.vercel.app';

/* ---------------- 小工具 ---------------- */

function log(msg) { process.stdout.write(msg + '\n'); }
function line() { log('─'.repeat(46)); }
function die(msg) {
  log('');
  log('✗ ' + msg);
  log('');
  process.exitCode = 1;
}

function pad(n) { return String(n).padStart(2, '0'); }
function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// 文件名安全化（去掉 Windows 不允许的字符）
function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40) || '未命名';
}

/* ---------------- 解析（和网站用的是同一套规则） ---------------- */

const MARK = /^\[(相片|日记|时光轴)\]\s*(.*)$/;
const CAT = { '相片': '相片回忆', '日记': '心情日记', '时光轴': '时光轴' };
const IMG_RE = /(?:https?:\/\/\S+?\.(?:png|jpe?g|gif|webp|avif|svg|bmp)(?:\?\S*)?)|(?:data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+)/gi;

function parseTitle(title) {
  const m = MARK.exec(title || '');
  if (!m) return { category: '（旧内容）', label: '', when: '' };
  return {
    category: CAT[m[1]],
    label: m[1] === '相片' ? (m[2] || '照片') : '',
    when: m[1] === '相片' ? '' : m[2]
  };
}

function splitContent(content) {
  const raw = String(content == null ? '' : content);
  const images = raw.match(IMG_RE) || [];
  let text = raw;
  images.forEach(u => { text = text.split(u).join(''); });
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .replace(/^[\s,，、;；]+/, '')
    .replace(/[\s,，、;；]+$/, '')
    .trim();
  return { images, text };
}

/* ---------------- 连接数据库 ---------------- */

function makeClient() {
  const url = (process.env.SUPABASE_URL || '')
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    die('没找到数据库配置：请确认同目录的 .env 里有 SUPABASE_URL 和 SUPABASE_SERVICE_KEY');
    return null;
  }
  return createClient(url, key);
}

/* ============================================================
   备份
   ============================================================ */

async function backup() {
  line();
  log('  爱的小站 · 数据备份');
  line();

  const supabase = makeClient();
  if (!supabase) return;

  log('· 正在读取数据…');
  const { data: rows, error } = await supabase
    .from('items')
    .select('*')
    .order('id', { ascending: true });
  if (error) return die('读取失败：' + (error.message || JSON.stringify(error)));

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dateTag = dayStamp();
  let imgSeq = 0;
  let imgCount = 0;
  let imgBytes = 0;

  const items = (rows || []).map(r => {
    const p = parseTitle(r.title);
    const c = splitContent(r.content);

    const images = c.images.map(u => {
      if (/^data:image\//i.test(u)) {
        // 内嵌图片 → 解出来单独存一份，方便直接看
        const m = /^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(u);
        if (!m) return { 类型: '内嵌图片', 说明: '（格式无法解析）' };
        const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
        imgSeq++;
        const name = `${dateTag}_${safeName(p.label || r.title || '图片')}_${imgSeq}.${ext}`;
        try {
          const buf = Buffer.from(m[2], 'base64');
          fs.mkdirSync(IMG_DIR, { recursive: true });
          fs.writeFileSync(path.join(IMG_DIR, name), buf);
          imgCount++;
          imgBytes += buf.length;
          return { 类型: '内嵌图片', 文件: '图片/' + name, 大小: humanSize(buf.length) };
        } catch (e) {
          return { 类型: '内嵌图片', 说明: '（图片写盘失败：' + e.message + '）' };
        }
      }
      return { 类型: '外链图片', 地址: u };
    });

    return {
      编号: r.id,
      标题: r.title,
      分区: p.category,
      标签: p.label,
      时间点: p.when,
      正文: c.text,
      图片: images,
      创建时间: r.created_at,
      // ↓ 恢复时用的原始字段，别手动改
      id: r.id,
      title: r.title,
      content: r.content,
      created_at: r.created_at
    };
  });

  // 人类可读的速览（不含图片数据，很小）
  const overview = items.map(i => ({
    编号: i.编号,
    分区: i.分区,
    标签或时间: i.标签 || i.时间点 || '',
    正文: i.正文 ? i.正文.slice(0, 60) + (i.正文.length > 60 ? '…' : '') : '',
    图片数: i.图片.length
  }));

  const payload = {
    说明: {
      这是什么: '爱的小站（' + SITE + '）的全部数据备份，可以直接用记事本打开阅读',
      分区怎么看: '分区 / 标签 / 时间点 / 正文 / 图片 都是为了方便阅读',
      恢复怎么做: 'node backup.js --restore "备份/本文件.json"',
      原始字段: 'id / title / content / created_at 是恢复时真正使用的字段，请不要改',
      内嵌图片: '相册里的图片以 base64 存在 content 里，同时已单独导出到 备份/图片/ 目录，可直接查看',
      提醒: '这个文件含私人内容，请放在安全的地方，不要上传到公开仓库'
    },
    meta: {
      站点: SITE,
      数据库: (process.env.SUPABASE_URL || '').replace(/\/+$/, '').replace(/\/rest\/v1$/, ''),
      表名: 'items',
      备份时间: nowStamp(),
      记录条数: items.length,
      图片张数: imgCount,
      图片总大小: humanSize(imgBytes),
      导出软件: 'backup.js'
    },
    overview,
    items
  };

  // 文件名：2026-10-20.json；同一天再备份就加时间后缀，不覆盖旧的
  let file = path.join(BACKUP_DIR, `${dateTag}.json`);
  if (fs.existsSync(file)) {
    const d = new Date();
    file = path.join(BACKUP_DIR, `${dateTag}_${pad(d.getHours())}${pad(d.getMinutes())}.json`);
    let n = 2;
    while (fs.existsSync(file)) {
      file = path.join(BACKUP_DIR, `${dateTag}_${pad(d.getHours())}${pad(d.getMinutes())}_${n++}.json`);
    }
  }

  const text = JSON.stringify(payload, null, 2);
  fs.writeFileSync(file, text, 'utf8');

  // 分区统计
  const stat = {};
  items.forEach(i => { stat[i.分区] = (stat[i.分区] || 0) + 1; });
  const statLine = Object.keys(stat).map(k => `${k} ${stat[k]} 条`).join(' / ') || '（暂无内容）';

  log('');
  log('✓ 读取成功：' + items.length + ' 条记录');
  log('  ' + statLine);
  log('✓ 导出图片：' + imgCount + ' 张（' + humanSize(imgBytes) + '）');
  log('✓ 备份文件：' + file);
  log('  大小：' + humanSize(Buffer.byteLength(text, 'utf8')));
  log('');
  log('恢复方法：node backup.js --restore "' + path.relative(ROOT, file) + '"');
  log('图片可以直接在「备份\\图片」里打开看');
  line();

  // 双击运行时，帮主人把文件夹打开
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
    try {
      require('child_process').exec('explorer "' + BACKUP_DIR + '"');
    } catch (e) { /* 打不开就算了 */ }
  }
}

/* ============================================================
   恢复
   ============================================================ */

async function restore(fileArg) {
  line();
  log('  爱的小站 · 从备份恢复');
  line();

  if (!fileArg) return die('请指定备份文件，例如：node backup.js --restore "备份/2026-10-20.json"');
  const file = path.isAbsolute(fileArg) ? fileArg : path.join(ROOT, fileArg);
  if (!fs.existsSync(file)) return die('找不到备份文件：' + file);

  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return die('备份文件读不出来（不是合法 JSON）：' + e.message);
  }
  const items = Array.isArray(json.items) ? json.items : [];
  if (!items.length) return die('这个备份里没有记录');

  const supabase = makeClient();
  if (!supabase) return;

  const { data: cur, error } = await supabase.from('items').select('id,title,content');
  if (error) return die('读取当前数据失败：' + (error.message || JSON.stringify(error)));

  const byId = new Map((cur || []).map(r => [r.id, r]));
  const toInsert = [];
  const toUpdate = [];
  items.forEach(it => {
    const e = byId.get(it.id);
    if (!e) toInsert.push(it);
    else if (e.title !== it.title || String(e.content || '') !== String(it.content || '')) toUpdate.push(it);
  });

  log('· 备份文件：' + path.relative(ROOT, file));
  log('· 备份时间：' + ((json.meta && json.meta.备份时间) || '未知'));
  log('· 当前数据库：' + (cur || []).length + ' 条，备份文件：' + items.length + ' 条');
  log('');
  log('将要执行：');
  log('  · 补回缺失记录：' + toInsert.length + ' 条  ' + (toInsert.map(i => i.id).join(', ') || '无'));
  log('  · 覆盖已有记录：' + toUpdate.length + ' 条  ' + (toUpdate.map(i => i.id).join(', ') || '无'));
  log('  （不会删除数据库里比备份新的记录）');
  log('');

  if (!toInsert.length && !toUpdate.length) {
    log('✓ 数据库和备份完全一致，不用恢复。');
    line();
    return;
  }

  const ok = await ask('确认要恢复吗？输入 yes 后回车继续：');
  if (ok.trim().toLowerCase() !== 'yes') {
    log('已取消，什么都没改。');
    line();
    return;
  }

  let done = 0;
  for (const it of toInsert) {
    const { error: e } = await supabase.from('items').insert({ title: it.title, content: it.content });
    if (e) { log('  ✗ 补回 #' + it.id + ' 失败：' + (e.message || JSON.stringify(e))); }
    else { done++; log('  ✓ 补回：' + it.title); }
  }
  for (const it of toUpdate) {
    const { error: e } = await supabase.from('items').update({ title: it.title, content: it.content }).eq('id', it.id);
    if (e) { log('  ✗ 覆盖 #' + it.id + ' 失败：' + (e.message || JSON.stringify(e))); }
    else { done++; log('  ✓ 覆盖：# ' + it.id + ' ' + it.title); }
  }

  log('');
  log('✓ 恢复完成，共处理 ' + done + ' 条。');
  log('（补回的记录会拿到新的编号，内容不受影响）');
  line();
}

function ask(q) {
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans || ''); });
  });
}

/* ---------------- 入口 ---------------- */

(async function main() {
  const argv = process.argv.slice(2);
  const ri = argv.findIndex(a => a === '--restore' || a === '-r');

  if (argv.includes('--help') || argv.includes('-h')) {
    log('用法：');
    log('  node backup.js                        备份到 备份/日期.json');
    log('  node backup.js --restore <文件>       从备份恢复');
    log('  node backup.js --no-open              备份后不自动打开文件夹');
    return;
  }

  try {
    if (ri >= 0) await restore(argv[ri + 1]);
    else await backup();
  } catch (e) {
    die('出错了：' + (e && e.message ? e.message : e));
  }
})();