require('dotenv').config();
const path = require('path');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.disable('x-powered-by');
// 相册的图片会以压缩后的 data URL 形式存进数据库，请求体需要放宽
app.use(express.json({ limit: '8mb' }));

// 静态资源目录：用 __dirname 定位，避免 serverless 环境 CWD 不确定
const PUBLIC_DIR = path.join(__dirname, 'public');
// extensions: ['html'] 让 /admin 也能直接访问 admin.html
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// 首页兜底（静态中间件没命中时手动返回，确保 "/" 不会是 Cannot GET /）
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Supabase URL 规范化：容错处理末尾的 /rest/v1/ 或多余的 /
const rawUrl = process.env.SUPABASE_URL || '';
const SUPABASE_URL = rawUrl
  .replace(/\/+$/, '')        // 去掉末尾所有 /
  .replace(/\/rest\/v1$/, ''); // 去掉误加的 /rest/v1

let supabase = null;
if (SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  } catch (e) {
    console.error('Supabase 客户端初始化失败：', e.message);
  }
} else {
  console.error('缺少 SUPABASE_URL / SUPABASE_SERVICE_KEY 环境变量');
}

// 未配置数据库时返回明确的 JSON 错误，而不是让函数整体崩掉
function requireDb(req, res, next) {
  if (!supabase) return res.status(500).json({ error: 'database not configured' });
  next();
}

// 查看密码：未单独配置 VIEW_PASSWORD 时回退用 ADMIN_PASSWORD
function viewPassword() {
  return process.env.VIEW_PASSWORD || process.env.ADMIN_PASSWORD || '';
}

// 时间安全比较，避免按字符逐位比较被计时攻击
function safeEqual(a, b) {
  const s1 = Buffer.from(String(a || ''));
  const s2 = Buffer.from(String(b || ''));
  if (s1.length !== s2.length) return false;
  try {
    return require('crypto').timingSafeEqual(s1, s2);
  } catch (e) {
    return false;
  }
}

// 查看鉴权：请求头带 x-view-password；管理员密码也可直接通过
function requireView(req, res, next) {
  const given = req.headers['x-view-password'];
  const vp = viewPassword();
  const ap = process.env.ADMIN_PASSWORD;
  if (given && ((vp && safeEqual(given, vp)) || (ap && safeEqual(given, ap)))) {
    return next();
  }
  res.status(401).json({ error: 'unauthorized', message: '查看密码错误' });
}

// 管理鉴权：请求头带 x-admin-password 且匹配
function requireAdmin(req, res, next) {
  const given = req.headers['x-admin-password'];
  const ap = process.env.ADMIN_PASSWORD;
  if (given && ap && safeEqual(given, ap)) {
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

// 校验查看密码（前端登录用）
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  const vp = viewPassword();
  const ap = process.env.ADMIN_PASSWORD;
  const ok = password && ((vp && safeEqual(password, vp)) || (ap && safeEqual(password, ap)));
  if (!ok) return res.status(401).json({ error: 'unauthorized', message: '密码错误' });
  res.json({ ok: true });
});

// 查询全部（展示页）—— 需要查看密码
// ?light=1 只返回 id/title/created_at（首页统计用，避免把相册图片全下下来）
app.get('/api/items', requireView, requireDb, async (req, res) => {
  const light = req.query.light === '1';
  const { data, error } = await supabase
    .from('items')
    .select(light ? 'id,title,created_at' : '*')
    .order('id', { ascending: false });
  if (error) return res.status(500).json(error);
  res.json(data);
});

/* ============================================================
   分区内容的「添加 / 修改 / 删除」接口
   —— 数据仍是同一张 items 表，用 title 前缀标记属于哪个分区：
        [相片] <说明标签>               content = 图片（每行一个）
        [日记] <YYYY-MM-DD> @<作者>     content = 话语（同一天可以写多篇，各自独立）
        [时光轴] <YYYY-MM-DD HH:mm>     content = 事件
   —— 添加时的合并规则：相册同标签、时光轴同时间点 → 追加到已有记录；
      日记永远新建（一天可以写多篇）。
      修改走 PUT /api/entries/:id（整体替换，不做追加）；删除走 DELETE /api/items/:id
   ============================================================ */
const MARKERS = { album: '相片', diary: '日记', timeline: '时光轴' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// 把请求体组装成 title / content；出错时直接回 400（或 413）并返回 null
function buildEntry(req, res) {
  const { category, label, content, when, author } = req.body || {};

  if (!MARKERS[category]) {
    res.status(400).json({ error: 'bad category', message: '分区类型不对' });
    return null;
  }
  const body = String(content || '').trim();
  if (!body) {
    res.status(400).json({ error: 'content required', message: '内容不能为空' });
    return null;
  }
  if (body.length > 4 * 1024 * 1024) {
    res.status(413).json({ error: 'too large', message: '内容太大了，请少选几张图片' });
    return null;
  }

  if (category === 'album') {
    const l = String(label || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    return { category, title: `[相片] ${l || '照片'}`, content: body };
  }
  if (category === 'diary') {
    const d = String(when || '').trim();
    if (!DATE_RE.test(d)) {
      res.status(400).json({ error: 'bad date', message: '请选择日期（YYYY-MM-DD）' });
      return null;
    }
    const a = String(author || '').replace(/[\r\n[\]]/g, '').trim().slice(0, 24);
    if (!a) {
      res.status(400).json({ error: 'author required', message: '请填写作者' });
      return null;
    }
    return { category, title: `[日记] ${d} @${a}`, content: body };
  }
  const t = String(when || '').trim();
  if (!DATETIME_RE.test(t)) {
    res.status(400).json({ error: 'bad time', message: '请选择时间点（YYYY-MM-DD HH:mm）' });
    return null;
  }
  return { category, title: `[时光轴] ${t}`, content: body };
}

app.post('/api/entries', requireAdmin, requireDb, async (req, res) => {
  const entry = buildEntry(req, res);
  if (!entry) return;

  // 日记：一天可以写多篇 —— 永远新建，不合并到已有记录
  if (entry.category !== 'diary') {
    // 同一个时间点（或同一个相册标签）已存在 → 追加，而不是新建
    const { data: existRows, error: findErr } = await supabase
      .from('items')
      .select('id,content')
      .eq('title', entry.title)
      .limit(1);
    if (findErr) return res.status(500).json(findErr);

    if (existRows && existRows.length) {
      const row = existRows[0];
      const merged = [String(row.content || '').trim(), entry.content].filter(Boolean).join('\n');
      const { error: upErr } = await supabase.from('items').update({ content: merged }).eq('id', row.id);
      if (upErr) return res.status(500).json(upErr);
      return res.json({ ok: true, action: 'appended', id: row.id, title: entry.title });
    }
  }

  const { data, error } = await supabase
    .from('items')
    .insert({ title: entry.title, content: entry.content })
    .select()
    .single();
  if (error) return res.status(500).json(error);
  res.json({ ok: true, action: 'created', id: data.id, title: entry.title });
});

// 修改某条内容（需管理密码）—— 整体替换，不做追加
app.put('/api/entries/:id', requireAdmin, requireDb, async (req, res) => {
  const entry = buildEntry(req, res);
  if (!entry) return;

  const { data, error } = await supabase
    .from('items')
    .update({ title: entry.title, content: entry.content })
    .eq('id', req.params.id)
    .select();
  if (error) return res.status(500).json(error);
  if (!data || !data.length) {
    return res.status(404).json({ error: 'not found', message: '这条内容已经不在了（可能刚被删过）' });
  }
  res.json({ ok: true, action: 'updated', id: data[0].id, title: entry.title });
});

// 新增（需管理密码）
app.post('/api/items', requireAdmin, requireDb, async (req, res) => {
  const { title, content } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const { data, error } = await supabase
    .from('items')
    .insert({ title, content })
    .select()
    .single();
  if (error) return res.status(500).json(error);
  res.json(data);
});

// 删除（需管理密码）
app.delete('/api/items/:id', requireAdmin, requireDb, async (req, res) => {
  const { error } = await supabase
    .from('items')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json(error);
  res.json({ success: true });
});

// 修改（需管理密码）
app.put('/api/items/:id', requireAdmin, requireDb, async (req, res) => {
  const { title, content } = req.body || {};
  const { error } = await supabase
    .from('items')
    .update({ title, content })
    .eq('id', req.params.id);
  if (error) return res.status(500).json(error);
  res.json({ success: true });
});

// 未命中的 /api 路径统一返回 JSON，避免前端拿到 HTML 报错页
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

// 统一错误处理：始终返回 JSON
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'server error' });
});

// 仅在本地开发环境监听端口，Vercel 环境下会自动处理
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('listening on ' + port));
}

// 关键：导出 app 供 Vercel 使用
module.exports = app;