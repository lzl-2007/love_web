require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 简单的管理鉴权：请求头带 x-admin-password 且匹配
function requireAdmin(req, res, next) {
  if (req.headers['x-admin-password'] === process.env.ADMIN_PASSWORD) {
    return next();
  }
  res.status(401).json({ error: 'unauthorized' });
}

// 查询全部（展示页）
app.get('/api/items', async (req, res) => {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .order('id', { ascending: false });
  if (error) return res.status(500).json(error);
  res.json(data);
});

// 新增（需管理密码）
app.post('/api/items', requireAdmin, async (req, res) => {
  const { title, content } = req.body;
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
app.delete('/api/items/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase
    .from('items')
    .delete()
    .eq('id', req.params.id);
  if (error) return res.status(500).json(error);
  res.json({ success: true });
});

// 修改（需管理密码）
app.put('/api/items/:id', requireAdmin, async (req, res) => {
  const { title, content } = req.body;
  const { error } = await supabase
    .from('items')
    .update({ title, content })
    .eq('id', req.params.id);
  if (error) return res.status(500).json(error);
  res.json({ success: true });
});

// 仅在本地开发环境监听端口，Vercel 环境下会自动处理
if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('listening on ' + port));
}

// 关键：导出 app 供 Vercel 使用
module.exports = app;