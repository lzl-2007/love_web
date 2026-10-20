require('dotenv').config();
const path = require('path');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

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

// 简单的管理鉴权：请求头带 x-admin-password 且匹配
function requireAdmin(req, res, next) {
  if (process.env.ADMIN_PASSWORD && req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD) {
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

// 查询全部（展示页）
app.get('/api/items', requireDb, async (req, res) => {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .order('id', { ascending: false });
  if (error) return res.status(500).json(error);
  res.json(data);
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