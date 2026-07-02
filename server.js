const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== 路径常量 =====
const TEMPLATE_DIR = path.join(__dirname, 'template');
const UID_TEMPLATE_DIR = path.join(__dirname, 'uid-template');
const DATA_DIR = path.join(__dirname, 'data');
const MERCHANTS_FILE = path.join(DATA_DIR, 'merchants.json');

// ===== 管理员登录配置 =====
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'yy123456';
const sessions = new Map(); // token -> { createdAt: Number, type: 'admin' }
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小时

// ===== 数据目录初始化 =====
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MERCHANTS_FILE)) fs.writeFileSync(MERCHANTS_FILE, '[]', 'utf-8');

// ===== 工具函数 =====
function loadMerchants() {
  try {
    return JSON.parse(fs.readFileSync(MERCHANTS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveMerchants(list) {
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

// 向收款后台同步商户名称
function syncMerchantNameToBackend(merchantUrl, phone, merchantName) {
  if (!merchantUrl || !phone) return;
  const url = merchantUrl.replace(/\/$/, '') + '/api/sync-name';
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    console.error('[sync-name] 收款后台地址无效:', url);
    return;
  }
  const client = parsed.protocol === 'https:' ? https : http;
  const payload = JSON.stringify({ phone, name: merchantName });
  const options = {
    method: 'POST',
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  const request = client.request(options, (response) => {
    let data = '';
    response.on('data', (chunk) => data += chunk);
    response.on('end', () => {
      console.log(`[sync-name] 同步商户名称到收款后台: ${url}, 响应: ${response.statusCode} ${data.slice(0, 200)}`);
    });
  });
  request.on('error', (err) => {
    console.error(`[sync-name] 同步商户名称到收款后台失败: ${url}, ${err.message}`);
  });
  request.write(payload);
  request.end();
}

function genId() {
  return 'M' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function genFileName() {
  const adjectives = ['swift', 'golden', 'royal', 'prime', 'noble', 'crown', 'elite', 'grand'];
  const nouns = ['pay', 'cash', 'vault', 'fund', 'link', 'gate', 'node', 'hub'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 9000 + 1000);
  return `${adj}-${noun}-${num}`;
}

function hashPwd(pwd) {
  return crypto.createHash('sha256').update('heijin_admin_' + pwd + '_2024').digest('hex');
}

function cleanToken(header) {
  if (!header) return '';
  return String(header).replace(/^Bearer\s+/i, '').trim();
}

function requireAuth(req, res, next) {
  const token = cleanToken(req.headers.authorization);
  const session = sessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) {
    return next();
  }
  return res.status(401).json({ code: 'UNAUTH', message: '请先登录' });
}

// 将支付宝配置注入模板 index.js
function injectConfig(templateIndexJs, config) {
  // 替换 appId（模板中为单引号空值）
  let result = templateIndexJs.replace(
    /appId:\s*['"].*?['"],/,
    `appId: '${config.appId}',`
  );
  // 替换 privateKey（模板中为单引号空值，注入时改用反引号支持多行）
  result = result.replace(
    /privateKey:\s*['"][\s\S]*?['"],/,
    () => `privateKey: \`${config.privateKey}\`,`
  );
  // 替换 alipayPublicKey
  result = result.replace(
    /alipayPublicKey:\s*['"].*?['"],/,
    `alipayPublicKey: '${config.alipayPublicKey}',`
  );
  // 注入商户名称
  if (config.merchantName) {
    result = result.replace(
      /merchantName:\s*['"].*?['"],/,
      `merchantName: '${config.merchantName}',`
    );
  }
  // 注入手机号（收款后台登录账号）
  if (config.merchantPhone) {
    result = result.replace(
      /merchantPhone:\s*['"].*?['"],/,
      `merchantPhone: '${config.merchantPhone}',`
    );
  }
  // 注入默认登录密码（明文，首次登录用）
  if (config.merchantPassword) {
    result = result.replace(
      /merchantPassword:\s*['"].*?['"],/,
      `merchantPassword: '${config.merchantPassword}',`
    );
  }
  return result;
}

// 生成商户 ZIP 包
function generateMerchantZip(config) {
  const zip = new AdmZip();
  const files = ['index.js', 'cashier.html', 'admin.html', 'logo-pay.png', 'package.json'];

  // index.js 需要注入配置
  const templateIndex = fs.readFileSync(path.join(TEMPLATE_DIR, 'index.js'), 'utf-8');
  const injectedIndex = injectConfig(templateIndex, config);
  zip.addFile('index.js', Buffer.from(injectedIndex, 'utf-8'));

  console.log(`[生成ZIP] merchantName=${config.merchantName || '(空)'}, phone=${config.merchantPhone || '(空)'}`);

  // 其他文件直接复制
  files.slice(1).forEach(f => {
    const buf = fs.readFileSync(path.join(TEMPLATE_DIR, f));
    zip.addFile(f, buf);
  });

  return zip.toBuffer();
}

// 将 UID 配置注入 UID 模板 index.js
function injectUidConfig(templateIndexJs, config) {
  let result = templateIndexJs;
  // 替换 alipayUid
  result = result.replace(
    /alipayUid:\s*['"].*?['"],/,
    `alipayUid: '${config.alipayUid}',`
  );
  // 注入商户名称
  if (config.merchantName) {
    result = result.replace(
      /merchantName:\s*['"].*?['"],/,
      `merchantName: '${config.merchantName}',`
    );
  }
  // 注入手机号
  if (config.merchantPhone) {
    result = result.replace(
      /merchantPhone:\s*['"].*?['"],/,
      `merchantPhone: '${config.merchantPhone}',`
    );
  }
  // 注入默认登录密码
  if (config.merchantPassword) {
    result = result.replace(
      /merchantPassword:\s*['"].*?['"],/,
      `merchantPassword: '${config.merchantPassword}',`
    );
  }
  return result;
}

// 生成 UID 商户 ZIP 包
function generateUidMerchantZip(config) {
  const zip = new AdmZip();
  const files = ['index.js', 'cashier.html', 'admin.html', 'logo-pay.png', 'package.json'];

  // index.js 需要注入配置（UID + 商户名 + 手机号 + 密码）
  const templateIndex = fs.readFileSync(path.join(UID_TEMPLATE_DIR, 'index.js'), 'utf-8');
  const injectedIndex = injectUidConfig(templateIndex, config);
  zip.addFile('index.js', Buffer.from(injectedIndex, 'utf-8'));

  console.log(`[生成ZIP-UID] alipayUid=${(config.alipayUid || '').slice(0,4)}****, merchantName=${config.merchantName || '(空)'}, phone=${config.merchantPhone || '(空)'}`);

  // 其他基础文件直接复制
  files.slice(1).forEach(f => {
    const buf = fs.readFileSync(path.join(UID_TEMPLATE_DIR, f));
    zip.addFile(f, buf);
  });

  // 打包 node_modules（UID 模板已装好依赖，无需 npm install）
  const nodeModulesDir = path.join(UID_TEMPLATE_DIR, 'node_modules');
  if (fs.existsSync(nodeModulesDir)) {
    zip.addLocalFolder(nodeModulesDir, 'node_modules');
  }

  return zip.toBuffer();
}

// ===== 管理员登录 API =====

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(token, { createdAt: Date.now(), type: 'admin' });
    return res.json({ code: 'OK', token, message: '登录成功' });
  }
  res.status(400).json({ code: 'FAIL', message: '账号或密码错误' });
});

app.post('/api/admin/check', (req, res) => {
  const token = cleanToken(req.headers.authorization || req.body.token);
  const session = sessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) {
    return res.json({ code: 'OK', loggedIn: true });
  }
  res.json({ code: 'OK', loggedIn: false });
});

app.post('/api/admin/logout', (req, res) => {
  const token = cleanToken(req.headers.authorization || req.body.token);
  sessions.delete(token);
  res.json({ code: 'OK' });
});

// ===== 受保护的 API =====

// 获取商户列表
app.get('/api/merchants', requireAuth, (req, res) => {
  const list = loadMerchants().map(m => ({
    ...m,
    password: undefined, // 不返回密码
  }));
  res.json({ code: 'OK', data: list });
});

// 获取统计数据
app.get('/api/stats', requireAuth, (req, res) => {
  const list = loadMerchants();
  const today = new Date().toDateString();
  const todayCount = list.filter(m => new Date(m.createdAt).toDateString() === today).length;
  res.json({
    code: 'OK',
    data: {
      total: list.length,
      today: todayCount,
    }
  });
});

// 添加商户
app.post('/api/merchants', requireAuth, (req, res) => {
  const { merchantName, phone, appId, privateKey, alipayPublicKey } = req.body;

  if (!phone || !/^1\d{10}$/.test(phone.trim())) {
    return res.json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  if (!appId || !privateKey || !alipayPublicKey) {
    return res.json({ code: 'FAIL', message: '请填写完整的支付宝配置信息' });
  }

  // 处理私钥：如果用户只填了中间部分，自动补全头尾
  let trimmedKey = privateKey.trim();
  if (!trimmedKey.includes('-----BEGIN') && !trimmedKey.includes('-----END')) {
    if (trimmedKey.startsWith('MII')) {
      trimmedKey = '-----BEGIN PRIVATE KEY-----\n' + trimmedKey + '\n-----END PRIVATE KEY-----';
    } else {
      trimmedKey = '-----BEGIN RSA PRIVATE KEY-----\n' + trimmedKey + '\n-----END RSA PRIVATE KEY-----';
    }
  }

  // 验证私钥格式
  if (!trimmedKey.includes('BEGIN PRIVATE KEY') && !trimmedKey.includes('BEGIN RSA PRIVATE KEY')) {
    return res.json({ code: 'FAIL', message: '私钥格式不正确，请粘贴完整的 PEM 格式私钥（含 BEGIN/END 行）' });
  }

  const isPKCS8 = trimmedKey.includes('BEGIN PRIVATE KEY');
  const keyType = isPKCS8 ? 'PKCS8' : 'PKCS1';

  // 格式化私钥
  let formattedKey = trimmedKey;
  if (!formattedKey.startsWith('-----BEGIN')) {
    const match = formattedKey.match(/-----BEGIN[^-]*-----/);
    if (match) formattedKey = formattedKey.substring(match.index);
  }

  const id = genId();
  const fileName = genFileName();
  const now = new Date().toISOString();
  const defaultPassword = 'yy123456';

  const merchant = {
    id,
    type: 'face2face',
    merchantName: merchantName || '未命名商户',
    phone: phone.trim(),
    password: hashPwd(defaultPassword), // 默认登录密码哈希
    appId,
    privateKey: formattedKey,
    alipayPublicKey: alipayPublicKey.trim(),
    keyType,
    fileName,
    createdAt: now,
    merchantUrl: '', // 部署后由管理员配置
  };

  const alipayMerchantName = (merchantName || '').trim();

  try {
    const zipBuffer = generateMerchantZip({
      appId: appId.trim(),
      privateKey: formattedKey,
      alipayPublicKey: alipayPublicKey.trim(),
      merchantName: alipayMerchantName,
      merchantPhone: phone.trim(),
      merchantPassword: defaultPassword,
    });
    const zipPath = path.join(DATA_DIR, `${fileName}.zip`);
    fs.writeFileSync(zipPath, zipBuffer);
    merchant.zipGenerated = true;
  } catch (e) {
    merchant.zipGenerated = false;
    merchant.zipError = e.message;
  }

  const list = loadMerchants();
  list.push(merchant);
  saveMerchants(list);

  res.json({ code: 'OK', data: { ...merchant, password: undefined }, message: '商户添加成功' });
});

// 添加 UID 商户
app.post('/api/merchants/uid', requireAuth, (req, res) => {
  const { merchantName, phone, alipayUid } = req.body;

  if (!phone || !/^1\d{10}$/.test(phone.trim())) {
    return res.json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  if (!alipayUid || !alipayUid.trim()) {
    return res.json({ code: 'FAIL', message: '请填写支付宝 UID' });
  }

  const uid = alipayUid.trim();
  if (!/^\d{16}$/.test(uid)) {
    return res.json({ code: 'FAIL', message: '支付宝 UID 格式不正确，应为 16 位数字' });
  }
  if (!uid.startsWith('2088')) {
    return res.json({ code: 'FAIL', message: '支付宝 UID 格式不正确，应以 2088 开头' });
  }

  const id = genId();
  const fileName = genFileName();
  const now = new Date().toISOString();
  const defaultPassword = 'yy123456';

  const merchant = {
    id,
    type: 'uid',
    merchantName: merchantName || 'UID商户',
    phone: phone.trim(),
    password: hashPwd(defaultPassword),
    alipayUid: uid,
    fileName,
    createdAt: now,
    merchantUrl: '',
  };

  try {
    const zipBuffer = generateUidMerchantZip({
      alipayUid: uid,
      merchantName: merchantName || '',
      merchantPhone: phone.trim(),
      merchantPassword: defaultPassword,
    });
    const zipPath = path.join(DATA_DIR, `${fileName}.zip`);
    fs.writeFileSync(zipPath, zipBuffer);
    merchant.zipGenerated = true;
  } catch (e) {
    merchant.zipGenerated = false;
    merchant.zipError = e.message;
  }

  const list = loadMerchants();
  list.push(merchant);
  saveMerchants(list);

  res.json({ code: 'OK', data: { ...merchant, password: undefined }, message: 'UID 商户添加成功' });
});

// 获取商户详情（受保护）
app.get('/api/merchants/:id', requireAuth, (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });
  const m = { ...merchant, password: undefined };
  res.json({ code: 'OK', data: m });
});

// 下载商户文件（保留后端能力，但前端不再展示）
app.get('/api/merchants/:id/download', requireAuth, (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });

  const zipPath = path.join(DATA_DIR, `${merchant.fileName}.zip`);
  if (!fs.existsSync(zipPath)) return res.status(404).json({ code: 'FAIL', message: '文件不存在' });

  res.download(zipPath, `${merchant.fileName}.zip`);
});

// 删除商户
app.delete('/api/merchants/:id', requireAuth, (req, res) => {
  const list = loadMerchants();
  const idx = list.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });

  const merchant = list[idx];
  const zipPath = path.join(DATA_DIR, `${merchant.fileName}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

  list.splice(idx, 1);
  saveMerchants(list);
  res.json({ code: 'OK', message: '删除成功' });
});

// ===== 向收款后台同步商户名称 =====
function syncMerchantNameToBackend(merchantUrl, phone, name) {
  if (!merchantUrl || !phone) return;
  const baseUrl = merchantUrl.replace(/\/$/, '');
  const url = baseUrl + '/api/sync-name';
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    console.error(`[sync-name] 无效的 URL: ${merchantUrl}`);
    return;
  }
  const client = parsed.protocol === 'https:' ? https : http;
  const payload = JSON.stringify({ phone, name, managerUrl: 'http://localhost:3000' });
  const options = {
    method: 'POST',
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };
  const req = client.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      console.log(`[sync-name] 已同步到收款后台: phone=${phone}, name=${name}, 响应: ${res.statusCode}`);
    });
  });
  req.on('error', (err) => console.error(`[sync-name] 同步失败: ${merchantUrl}, ${err.message}`));
  req.write(payload);
  req.end();
}

// 更新商户（商户名、访问地址）
app.put('/api/merchants/:id', requireAuth, (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });

  if (req.body.merchantName !== undefined) {
    merchant.merchantName = req.body.merchantName;
    // 同步新的商户名到收款后台
    syncMerchantNameToBackend(merchant.merchantUrl, merchant.phone, merchant.merchantName);
  }
  if (req.body.merchantUrl !== undefined) {
    merchant.merchantUrl = req.body.merchantUrl.trim();
  }
  saveMerchants(list);
  res.json({ code: 'OK', data: { ...merchant, password: undefined } });
});

// 收款后台回调：同步商户名称到商户管理系统
app.post('/api/sync/merchant-name', express.json(), (req, res) => {
  const { phone, name } = req.body;
  if (!phone || !/^1\d{10}$/.test(String(phone).trim())) {
    return res.status(400).json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  const trimmed = String(phone).trim();
  const safeName = String(name || '').trim();
  const list = loadMerchants();
  const merchant = list.find(m => m.phone === trimmed);
  if (!merchant) {
    return res.status(404).json({ code: 'FAIL', message: '未找到该手机号对应的商户' });
  }
  merchant.merchantName = safeName;
  saveMerchants(list);
  console.log(`[sync/merchant-name] 已更新商户名称: phone=${trimmed}, name=${safeName}`);
  res.json({ code: 'OK', message: '商户名称已更新', data: { id: merchant.id, merchantName: safeName } });
});

app.listen(PORT, () => {
  console.log(`黑金PAY商户管理系统已启动: http://localhost:${PORT}`);
  console.log(`默认管理员账号：${ADMIN_USERNAME}，密码：${ADMIN_PASSWORD}`);
});
