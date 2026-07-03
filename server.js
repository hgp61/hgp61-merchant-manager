/**
 * ============================================
 *  黑金PAY 商户管理系统
 *  管理端 + 收款后台 + 收银台 — 统一端口
 * ============================================
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const os = require('os');
const AdmZip = require('adm-zip');
const AlipaySdk = require('alipay-sdk').default || require('alipay-sdk');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// ======================== 路径常量 ========================

const TEMPLATE_DIR = path.join(__dirname, 'template');
const UID_TEMPLATE_DIR = path.join(__dirname, 'uid-template');
const DATA_DIR = path.join(__dirname, 'data');
const MERCHANT_DATA_DIR = path.join(DATA_DIR, 'merchants');
const MERCHANTS_FILE = path.join(DATA_DIR, 'merchants.json');

// ======================== 管理员配置 ========================

const ADMIN_CONFIG_FILE = path.join(DATA_DIR, 'admin.json');

function loadAdminConfig() {
  try {
    if (fs.existsSync(ADMIN_CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf-8'));
      return { password: cfg.password || 'yy123456' };
    }
  } catch (e) { console.error('读取管理员配置失败:', e.message); }
  return { password: 'yy123456' };
}

function saveAdminConfig(cfg) {
  fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

let adminConfig = loadAdminConfig();
const ADMIN_USERNAME = 'admin';
const adminSessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

// ======================== 数据目录初始化 ========================

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(MERCHANT_DATA_DIR)) fs.mkdirSync(MERCHANT_DATA_DIR, { recursive: true });
if (!fs.existsSync(MERCHANTS_FILE)) fs.writeFileSync(MERCHANTS_FILE, '[]', 'utf-8');

// ======================== 商户运行时状态 ========================
// 每个商户独立的内存状态，通过 merchantRuntime(id) 懒加载

const merchantRuntimes = new Map(); // id → runtime

function getMerchantDir(id) {
  const dir = path.join(MERCHANT_DATA_DIR, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadMerchantFile(id, name, defaultVal) {
  try {
    const fp = path.join(getMerchantDir(id), name + '.json');
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (e) { /* ignore */ }
  return defaultVal;
}

function saveMerchantFile(id, name, data) {
  fs.writeFileSync(path.join(getMerchantDir(id), name + '.json'), JSON.stringify(data, null, 2), 'utf-8');
}

function getMerchantRuntime(id, merchant) {
  // 如果有缓存的运行时且 SDK 已初始化，直接返回
  if (merchantRuntimes.has(id)) {
    const cached = merchantRuntimes.get(id);
    // SDK 已正常初始化 → 直接复用
    if (cached.alipaySdk) return cached;
    // SDK 为 null 但商户没有当面付配置 → 复用缓存（无需重试）
    if (merchant.type === 'uid' || !merchant.appId || !merchant.privateKey) return cached;
    // SDK 为 null 但商户有当面付配置 → 尝试重新初始化 SDK
    console.log(`[商户:${id}] 🔄 SDK 未初始化，重新尝试（配置可能已更新）...`);
    initAlipaySdk(cached, id, merchant);
    return cached;
  }

  const runtime = {
    alipaySdk: null,
    alipaySdkError: null,
    orders: loadMerchantFile(id, 'orders', []),
    cashierOrders: new Map(),
    security: loadMerchantFile(id, 'security', {
      passwordHash: null,
      skipPassword: false,
      merchantName: merchant.merchantName || '',
      merchantContact: merchant.merchantName || '',
      merchantPhone: merchant.phone || '',
      merchantPassword: 'yy123456',
      failedAttempts: 0,
      failedAttemptDate: '',
      lockDate: '',
    }),
    limits: loadMerchantFile(id, 'limits', {
      minAmount: null, maxAmount: null,
      dayCount: null, dayAmount: null,
      monthCount: null, monthAmount: null,
    }),
    sessions: new Map(),
    allowedPhones: new Set([(merchant.phone || '').trim()].filter(Boolean)),
    merchantNameMap: new Map(),
  };

  // 初始化 merchantNameMap
  if (merchant.phone) {
    runtime.merchantNameMap.set(merchant.phone.trim(), {
      name: merchant.merchantName || '',
      managerUrl: '',
    });
  }

  // 当面付：初始化 SDK
  initAlipaySdk(runtime, id, merchant);

  merchantRuntimes.set(id, runtime);
  return runtime;
}

function initAlipaySdk(runtime, id, merchant) {
  if (merchant.type === 'uid' || !merchant.appId || !merchant.privateKey) {
    console.log(`[商户:${id}] 跳过 AlipaySdk 初始化: type=${merchant.type}, hasAppId=${!!merchant.appId}, hasPrivateKey=${!!merchant.privateKey}`);
    return;
  }

  // 规范化私钥：确保有正确的换行符
  const rawKey = String(merchant.privateKey).trim();
  const normalizedKey = rawKey
    .replace(/-----BEGIN [A-Z ]+-----(?!\n)/g, '$&\n')
    .replace(/(?<!\n)-----END [A-Z ]+-----/g, '\n$&');
  const keyPreview = normalizedKey.substring(0, 40).replace(/\n/g, '\\n');
  const keyPreviewLen = normalizedKey.length;

  const preferredKeyType = merchant.keyType || 'PKCS8';
  const altKeyType = preferredKeyType === 'PKCS8' ? 'PKCS1' : 'PKCS8';

  let initSuccess = false;
  let lastError = null;

  for (const tryKeyType of [preferredKeyType, altKeyType]) {
    try {
      console.log(`[商户:${id}] 尝试 AlipaySdk(keyType=${tryKeyType}): appId=${merchant.appId}, keyLen=${keyPreviewLen}, preview=${keyPreview}...`);
      runtime.alipaySdk = new AlipaySdk({
        appId: String(merchant.appId),
        privateKey: normalizedKey,
        alipayPublicKey: String(merchant.alipayPublicKey || ''),
        gateway: 'https://openapi.alipay.com/gateway.do',
        keyType: tryKeyType,
      });
      console.log(`[商户:${id}] ✅ AlipaySdk 初始化成功 (keyType=${tryKeyType})`);
      runtime.alipaySdkError = null;

      if (tryKeyType !== preferredKeyType) {
        console.log(`[商户:${id}] ⚠️ keyType 已从 ${preferredKeyType} 自动修正为 ${tryKeyType}`);
        const list = loadMerchants();
        const m = list.find(x => x.id === id);
        if (m) { m.keyType = tryKeyType; saveMerchants(list); }
      }
      initSuccess = true;
      break;
    } catch (e) {
      lastError = e.message;
      console.warn(`[商户:${id}] AlipaySdk(keyType=${tryKeyType}) 失败: ${e.message}`);
    }
  }

  if (!initSuccess) {
    console.error(`[商户:${id}] ❌ AlipaySdk 初始化全部失败`);
    runtime.alipaySdk = null;
    runtime.alipaySdkError = `初始化失败（PKCS8+PKCS1 均已尝试）。错误: ${lastError}。请检查：1) appId="${merchant.appId}" 是否正确；2) 私钥是否完整（长度=${keyPreviewLen}）；3) 支付宝公钥是否匹配。`;
  }
}

// ======================== 工具函数 ========================

function loadMerchants() {
  try { return JSON.parse(fs.readFileSync(MERCHANTS_FILE, 'utf-8')); }
  catch { return []; }
}

function saveMerchants(list) {
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
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

function hashMerchantPwd(pwd) {
  return crypto.createHash('sha256').update('heijin_pay_' + pwd + '_security_2024').digest('hex');
}

function hashMerchantPwdUid(pwd) {
  return crypto.createHash('sha256').update('heijin_pay_uid_' + pwd + '_security_2024').digest('hex');
}

function hashSecurityPwd(pwd) {
  return crypto.createHash('sha256').update('heijin_pay_' + pwd + '_security_2024').digest('hex');
}

function hashSecurityPwdUid(pwd) {
  return crypto.createHash('sha256').update('heijin_pay_uid_' + pwd + '_security_2024').digest('hex');
}

function cleanToken(header) {
  if (!header) return '';
  return String(header).replace(/^Bearer\s+/i, '').trim();
}

function requireAuth(req, res, next) {
  const token = cleanToken(req.headers.authorization);
  const session = adminSessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) return next();
  return res.status(401).json({ code: 'UNAUTH', message: '请先登录' });
}

function syncMerchantNameToBackend(merchantUrl, phone, name) {
  if (!merchantUrl || !phone) return;
  const baseUrl = merchantUrl.replace(/\/$/, '');
  const url = baseUrl + '/api/sync-name';
  let parsed;
  try { parsed = new URL(url); } catch (e) {
    console.error(`[sync-name] 无效的 URL: ${merchantUrl}`);
    return;
  }
  const client = parsed.protocol === 'https:' ? https : http;
  const payload = JSON.stringify({ phone, name, managerUrl: 'http://localhost:' + PORT });
  const options = {
    method: 'POST',
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  };
  const req = client.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => console.log(`[sync-name] 已同步到收款后台: phone=${phone}, name=${name}, 响应: ${res.statusCode}`));
  });
  req.on('error', (err) => console.error(`[sync-name] 同步失败: ${merchantUrl}, ${err.message}`));
  req.write(payload);
  req.end();
}

// ======================== ZIP 生成（保留） ========================

function injectConfig(templateIndexJs, config) {
  let result = templateIndexJs;
  result = result.replace(/appId:\s*['"].*?['"],/, `appId: '${config.appId}',`);
  result = result.replace(/privateKey:\s*['"][\s\S]*?['"],/, () => `privateKey: \`${config.privateKey}\`,`);
  result = result.replace(/alipayPublicKey:\s*['"].*?['"],/, `alipayPublicKey: '${config.alipayPublicKey}',`);
  if (config.keyType) {
    result = result.replace(/keyType:\s*['"].*?['"],/, `keyType: '${config.keyType}',`);
  }
  if (config.merchantName) {
    result = result.replace(/merchantName:\s*['"].*?['"],/, `merchantName: '${config.merchantName}',`);
  }
  if (config.merchantPhone) {
    result = result.replace(/merchantPhone:\s*['"].*?['"],/, `merchantPhone: '${config.merchantPhone}',`);
  }
  if (config.merchantPassword) {
    result = result.replace(/merchantPassword:\s*['"].*?['"],/, `merchantPassword: '${config.merchantPassword}',`);
  }
  return result;
}

function generateMerchantZip(config) {
  const zip = new AdmZip();
  const templateIndex = fs.readFileSync(path.join(TEMPLATE_DIR, 'index.js'), 'utf-8');
  const injectedIndex = injectConfig(templateIndex, config);
  zip.addFile('index.js', Buffer.from(injectedIndex, 'utf-8'));
  ['cashier.html', 'admin.html', 'logo-pay.png', 'package.json'].forEach(f => {
    zip.addFile(f, fs.readFileSync(path.join(TEMPLATE_DIR, f)));
  });
  return zip.toBuffer();
}

function injectUidConfig(templateIndexJs, config) {
  let result = templateIndexJs;
  result = result.replace(/alipayUid:\s*['"].*?['"],/, `alipayUid: '${config.alipayUid}',`);
  if (config.type) {
    result = result.replace(/type:\s*['"].*?['"],/, `type: '${config.type}',`);
  }
  if (config.merchantName) {
    result = result.replace(/merchantName:\s*['"].*?['"],/, `merchantName: '${config.merchantName}',`);
  }
  if (config.merchantPhone) {
    result = result.replace(/merchantPhone:\s*['"].*?['"],/, `merchantPhone: '${config.merchantPhone}',`);
  }
  if (config.merchantPassword) {
    result = result.replace(/merchantPassword:\s*['"].*?['"],/, `merchantPassword: '${config.merchantPassword}',`);
  }
  return result;
}

function generateUidMerchantZip(config) {
  const zip = new AdmZip();
  const templateIndex = fs.readFileSync(path.join(UID_TEMPLATE_DIR, 'index.js'), 'utf-8');
  const injectedIndex = injectUidConfig(templateIndex, config);
  zip.addFile('index.js', Buffer.from(injectedIndex, 'utf-8'));
  ['cashier.html', 'admin.html', 'logo-pay.png', 'package.json'].forEach(f => {
    zip.addFile(f, fs.readFileSync(path.join(UID_TEMPLATE_DIR, f)));
  });
  const nodeModulesDir = path.join(UID_TEMPLATE_DIR, 'node_modules');
  if (fs.existsSync(nodeModulesDir)) zip.addLocalFolder(nodeModulesDir, 'node_modules');
  return zip.toBuffer();
}

// ======================== 管理端 API ========================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === adminConfig.password) {
    const token = crypto.randomBytes(16).toString('hex');
    adminSessions.set(token, { createdAt: Date.now(), type: 'admin' });
    return res.json({ code: 'OK', token, message: '登录成功' });
  }
  res.status(400).json({ code: 'FAIL', message: '账号或密码错误' });
});

app.post('/api/admin/check', (req, res) => {
  const token = cleanToken(req.headers.authorization || req.body.token);
  const session = adminSessions.get(token);
  res.json({ code: 'OK', loggedIn: !!(session && Date.now() - session.createdAt < SESSION_TTL) });
});

app.post('/api/admin/logout', (req, res) => {
  adminSessions.delete(cleanToken(req.headers.authorization || req.body.token));
  res.json({ code: 'OK' });
});

app.post('/api/admin/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ code: 'FAIL', message: '请输入原密码和新密码' });
  }
  if (oldPassword !== adminConfig.password) {
    return res.status(400).json({ code: 'FAIL', message: '原密码错误' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ code: 'FAIL', message: '新密码至少6位' });
  }
  adminConfig.password = newPassword;
  saveAdminConfig(adminConfig);
  // 修改密码后清除所有现有 session，强制重新登录
  adminSessions.clear();
  res.json({ code: 'OK', message: '密码已修改，请重新登录' });
});

app.get('/api/merchants', requireAuth, (req, res) => {
  const list = loadMerchants().map(m => ({ ...m, password: undefined }));
  res.json({ code: 'OK', data: list });
});

app.get('/api/stats', requireAuth, (req, res) => {
  const list = loadMerchants();
  const today = new Date().toDateString();
  const todayCount = list.filter(m => new Date(m.createdAt).toDateString() === today).length;
  res.json({ code: 'OK', data: { total: list.length, today: todayCount } });
});

app.post('/api/merchants', requireAuth, (req, res) => {
  const { merchantName, phone, appId, privateKey, alipayPublicKey, keyType: reqKeyType } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone.trim())) {
    return res.json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  if (!appId || !privateKey || !alipayPublicKey) {
    return res.json({ code: 'FAIL', message: '请填写完整的支付宝配置信息' });
  }

  let trimmedKey = privateKey.trim();
  const userKeyType = (reqKeyType || 'auto').trim().toUpperCase();

  // 如果私钥不包含 BEGIN/END 头尾，自动补全
  if (!trimmedKey.includes('-----BEGIN') && !trimmedKey.includes('-----END')) {
    if (userKeyType === 'PKCS1') {
      trimmedKey = '-----BEGIN RSA PRIVATE KEY-----\n' + trimmedKey + '\n-----END RSA PRIVATE KEY-----';
    } else if (userKeyType === 'PKCS8') {
      trimmedKey = '-----BEGIN PRIVATE KEY-----\n' + trimmedKey + '\n-----END PRIVATE KEY-----';
    } else {
      // 自动检测：以 MII 开头默认 PKCS#8（支付宝新版推荐），否则 PKCS#1
      trimmedKey = trimmedKey.startsWith('MII')
        ? '-----BEGIN PRIVATE KEY-----\n' + trimmedKey + '\n-----END PRIVATE KEY-----'
        : '-----BEGIN RSA PRIVATE KEY-----\n' + trimmedKey + '\n-----END RSA PRIVATE KEY-----';
    }
  }
  if (!trimmedKey.includes('BEGIN PRIVATE KEY') && !trimmedKey.includes('BEGIN RSA PRIVATE KEY')) {
    return res.json({ code: 'FAIL', message: '私钥格式不正确' });
  }

  // 判定 keyType：优先使用用户选择，否则自动检测
  let keyType;
  if (userKeyType === 'PKCS1') {
    keyType = 'PKCS1';
  } else if (userKeyType === 'PKCS8') {
    keyType = 'PKCS8';
  } else {
    const isPKCS8 = trimmedKey.includes('BEGIN PRIVATE KEY') && !trimmedKey.includes('BEGIN RSA PRIVATE KEY');
    keyType = isPKCS8 ? 'PKCS8' : 'PKCS1';
  }

  // 规范化私钥：确保 PEM 头尾后有正确换行符（alipay-sdk 期望标准 PEM 格式）
  trimmedKey = trimmedKey
    .replace(/-----BEGIN [A-Z ]+-----(?!\n)/g, '$&\n')
    .replace(/(?<!\n)-----END [A-Z ]+-----/g, '\n$&');

  const id = genId();
  const fileName = genFileName();
  const now = new Date().toISOString();
  const defaultPassword = 'yy123456';
  const alipayMerchantName = (merchantName || '').trim();

  const merchant = {
    id, type: 'face2face',
    merchantName: merchantName || '未命名商户',
    phone: phone.trim(),
    password: hashPwd(defaultPassword),
    appId, privateKey: trimmedKey,
    alipayPublicKey: alipayPublicKey.trim(),
    keyType, fileName,
    createdAt: now,
    merchantUrl: '',
  };

  try {
    const zipBuffer = generateMerchantZip({
      appId: appId.trim(),
      privateKey: trimmedKey,
      alipayPublicKey: alipayPublicKey.trim(),
      merchantName: alipayMerchantName,
      merchantPhone: phone.trim(),
      merchantPassword: defaultPassword,
    });
    fs.writeFileSync(path.join(DATA_DIR, `${fileName}.zip`), zipBuffer);
    merchant.zipGenerated = true;
  } catch (e) {
    merchant.zipGenerated = false;
    merchant.zipError = e.message;
  }

  const list = loadMerchants();
  list.push(merchant);
  saveMerchants(list);

  // 预初始化运行时
  getMerchantRuntime(id, merchant);

  res.json({ code: 'OK', data: { ...merchant, password: undefined }, message: '商户添加成功' });
});

app.post('/api/merchants/uid', requireAuth, (req, res) => {
  const { merchantName, phone, alipayUid, type } = req.body;
  const merchantType = type === 'uid-simple' ? 'uid-simple' : 'uid';
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
    id, type: merchantType,
    merchantName: merchantName || (merchantType === 'uid-simple' ? 'UID简易商户' : 'UID商户'),
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
      type: merchantType,
    });
    fs.writeFileSync(path.join(DATA_DIR, `${fileName}.zip`), zipBuffer);
    merchant.zipGenerated = true;
  } catch (e) {
    merchant.zipGenerated = false;
    merchant.zipError = e.message;
  }

  const list = loadMerchants();
  list.push(merchant);
  saveMerchants(list);

  getMerchantRuntime(id, merchant);

  res.json({ code: 'OK', data: { ...merchant, password: undefined }, message: merchantType === 'uid-simple' ? 'UID 简易支付商户添加成功' : 'UID 商户添加成功' });
});

app.get('/api/merchants/:id', requireAuth, (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });
  res.json({ code: 'OK', data: { ...merchant, password: undefined } });
});

app.get('/api/merchants/:id/download', requireAuth, (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });
  const zipPath = path.join(DATA_DIR, `${merchant.fileName}.zip`);
  if (!fs.existsSync(zipPath)) return res.status(404).json({ code: 'FAIL', message: '文件不存在' });
  res.download(zipPath, `${merchant.fileName}.zip`);
});

app.delete('/api/merchants/:id', requireAuth, (req, res) => {
  const list = loadMerchants();
  const idx = list.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });
  const merchant = list[idx];
  const zipPath = path.join(DATA_DIR, `${merchant.fileName}.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  list.splice(idx, 1);
  saveMerchants(list);
  merchantRuntimes.delete(req.params.id);
  res.json({ code: 'OK', message: '删除成功' });
});

app.put('/api/merchants/:id', requireAuth, (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });

  // 更新基本信息
  if (req.body.merchantName !== undefined) {
    merchant.merchantName = req.body.merchantName;
    // 同步本地运行时
    const rt = merchantRuntimes.get(merchant.id);
    if (rt) {
      rt.security.merchantName = req.body.merchantName;
      saveMerchantFile(merchant.id, 'security', rt.security);
    }
    syncMerchantNameToBackend(merchant.merchantUrl, merchant.phone, merchant.merchantName);
  }
  if (req.body.merchantUrl !== undefined) {
    merchant.merchantUrl = req.body.merchantUrl.trim();
  }

  // 更新支付宝配置（当面付商户）
  if (merchant.type !== 'uid') {
    if (req.body.appId !== undefined) merchant.appId = req.body.appId;
    if (req.body.alipayPublicKey !== undefined) merchant.alipayPublicKey = req.body.alipayPublicKey.trim();
    if (req.body.keyType !== undefined) merchant.keyType = req.body.keyType;

    if (req.body.privateKey !== undefined) {
      let trimmedKey = req.body.privateKey.trim();
      if (trimmedKey) {
        if (!trimmedKey.includes('-----BEGIN') && !trimmedKey.includes('-----END')) {
          const userKeyType = (merchant.keyType || 'auto').trim().toUpperCase();
          if (userKeyType === 'PKCS1') {
            trimmedKey = '-----BEGIN RSA PRIVATE KEY-----\n' + trimmedKey + '\n-----END RSA PRIVATE KEY-----';
          } else if (userKeyType === 'PKCS8') {
            trimmedKey = '-----BEGIN PRIVATE KEY-----\n' + trimmedKey + '\n-----END PRIVATE KEY-----';
          } else {
            trimmedKey = trimmedKey.startsWith('MII')
              ? '-----BEGIN PRIVATE KEY-----\n' + trimmedKey + '\n-----END PRIVATE KEY-----'
              : '-----BEGIN RSA PRIVATE KEY-----\n' + trimmedKey + '\n-----END RSA PRIVATE KEY-----';
          }
        }
        // 确保 PEM 头尾后有正确换行
        trimmedKey = trimmedKey
          .replace(/-----BEGIN [A-Z ]+-----(?!\n)/g, '$&\n')
          .replace(/(?<!\n)-----END [A-Z ]+-----/g, '\n$&');
        merchant.privateKey = trimmedKey;
      }
    }
  }

  saveMerchants(list);

  // 如果更新了支付宝配置，清除运行时缓存，下次访问时重新初始化
  if (req.body.appId !== undefined || req.body.privateKey !== undefined || req.body.alipayPublicKey !== undefined || req.body.keyType !== undefined) {
    merchantRuntimes.delete(req.params.id);
    console.log(`[商户:${req.params.id}] 支付宝配置已更新，运行时缓存已清除，下次访问时重新初始化`);
  }

  res.json({ code: 'OK', data: { ...merchant, password: undefined } });
});

// ===== 一键部署商户收款后台到 GitHub =====
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_USER = 'hgp61';

app.post('/api/merchants/:id/deploy', requireAuth, async (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });

  const merchantName = merchant.merchantName || merchant.phone;
  const repoName = merchantName.replace(/[^\w-]/g, '-').toLowerCase().substring(0, 50) + '-' + Date.now().toString(36);

  try {
    const templateDir = merchant.type === 'uid' ? UID_TEMPLATE_DIR : TEMPLATE_DIR;
    const templateIndex = fs.readFileSync(path.join(templateDir, 'index.js'), 'utf-8');
    const cashierHtml = fs.readFileSync(path.join(templateDir, 'cashier.html'), 'utf-8');
    const adminHtml = fs.readFileSync(path.join(templateDir, 'admin.html'), 'utf-8');
    const logoBuffer = fs.readFileSync(path.join(templateDir, 'logo-pay.png'));
    const packageJson = fs.readFileSync(path.join(templateDir, 'package.json'), 'utf-8');
    const loginHtml = fs.readFileSync(path.join(templateDir, 'login.html'), 'utf-8');

    const config = {
      appId: merchant.appId || '',
      privateKey: merchant.privateKey || '',
      alipayPublicKey: merchant.alipayPublicKey || '',
      keyType: merchant.keyType || 'PKCS8',
      merchantName: merchant.merchantName || '',
      merchantPhone: merchant.phone || '',
      merchantPassword: 'yy123456',
    };

    const injectedIndex = injectConfig(templateIndex, config);

    const createRepoRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify({
        name: repoName,
        description: `${merchantName} 收款后台`,
        private: false,
        auto_init: false,
      }),
    });

    if (!createRepoRes.ok) {
      const errData = await createRepoRes.json();
      if (!(errData.errors && errData.errors.some(e => e.message.includes('already exists')))) {
        throw new Error(`创建GitHub仓库失败: ${errData.message || createRepoRes.status}`);
      }
    }

    const files = [
      { path: 'index.js', content: injectedIndex },
      { path: 'cashier.html', content: cashierHtml },
      { path: 'admin.html', content: adminHtml },
      { path: 'logo-pay.png', content: logoBuffer.toString('base64'), isBase64: true },
      { path: 'package.json', content: packageJson },
      { path: 'login.html', content: loginHtml },
      { path: '.gitignore', content: 'node_modules/\ndata/\n*.log\n' },
      { path: 'README.md', content: `# ${merchantName} 收款后台\n\n部署到 Railway` },
    ];

    for (const file of files) {
      const getRes = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repoName}/contents/${file.path}`, {
        headers: { 'Authorization': `token ${GITHUB_TOKEN}` },
      });
      let sha = null;
      if (getRes.ok) {
        const existingFile = await getRes.json();
        sha = existingFile.sha;
      }
      const content = file.isBase64 ? file.content : Buffer.from(file.content, 'utf-8').toString('base64');
      await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repoName}/contents/${file.path}`, {
        method: 'PUT',
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({ message: `初始化 ${file.path}`, content, ...(sha ? { sha } : {}) }),
      });
    }

    const cashierUrl = `https://${repoName}-production.up.railway.app`;
    merchant.merchantUrl = cashierUrl;
    saveMerchants(list);

    res.json({
      code: 'OK',
      data: {
        merchantName,
        githubRepo: `https://github.com/${GITHUB_USER}/${repoName}`,
        railwayUrl: cashierUrl,
        nextSteps: [
          '1. 打开上方 GitHub 仓库地址',
          '2. 在 Railway 中新建项目，关联此 GitHub 仓库',
          '3. Railway 将自动检测并部署',
          '4. 部署完成后，访问 Railway 提供的域名即可',
        ],
      },
      message: 'GitHub 仓库已创建，请到 Railway 关联仓库进行部署',
    });
  } catch (err) {
    console.error('[deploy] 部署失败:', err);
    res.status(500).json({ code: 'FAIL', message: err.message || '部署失败' });
  }
});

app.post('/api/sync/merchant-name', express.json(), (req, res) => {
  const { phone, name } = req.body;
  if (!phone || !/^1\d{10}$/.test(String(phone).trim())) {
    return res.status(400).json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  const trimmed = String(phone).trim();
  const safeName = String(name || '').trim();
  const list = loadMerchants();
  const merchant = list.find(m => m.phone === trimmed);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '未找到该手机号对应的商户' });
  merchant.merchantName = safeName;
  saveMerchants(list);
  // 同步运行时
  const rt = merchantRuntimes.get(merchant.id);
  if (rt) rt.security.merchantName = safeName;
  res.json({ code: 'OK', message: '商户名称已更新' });
});

// ======================== 商户路由 ========================

// 商户中间件：加载商户信息
app.use('/m/:id', (req, res, next) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).send('商户不存在');
  req.merchant = merchant;
  req.runtime = getMerchantRuntime(merchant.id, merchant);
  next();
});

// 商户中间件：商户登录鉴权（token 存在 req.headers.authorization 中）
function merchantAuth(req, res, next) {
  const token = cleanToken(req.headers.authorization);
  const session = req.runtime.sessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) {
    req.sessionPhone = session.phone || '';
    return next();
  }
  return res.status(401).json({ code: 'UNAUTH', message: '未登录或会话已过期' });
}

function getMerchantNameForSession(req) {
  const phone = req.sessionPhone || '';
  const entry = phone ? req.runtime.merchantNameMap.get(phone.trim()) : null;
  return (entry && entry.name) || req.runtime.security.merchantName || req.merchant.merchantName || '';
}

// 支付宝浏览器检测：支付宝扫码时直接跳 alipays://，不显示中间确认页
app.get('/m/:id/pay', (req, res, next) => {
  handleAlipayRedirect(req, res, next);
});
app.get('/m/:id/pay/', (req, res, next) => {
  handleAlipayRedirect(req, res, next);
});

function handleAlipayRedirect(req, res, next) {
  const ua = (req.get('User-Agent') || '').toLowerCase();
  // 支付宝内置浏览器 UA 包含 AlipayClient / AlipayDefined / AliApp(Alipay)
  if (/alipayclient|alipaydefined|aliapp/i.test(ua)) {
    const m = req.merchant;
    if (m.type !== 'uid') return next();
    const amount = parseFloat(req.query.amount) || 0;
    const memo = req.query.memo || '';
    const uid = req.query.uid || m.alipayUid;
    if (amount && uid) {
      const biz = JSON.stringify({ s: 'money', u: uid, a: amount.toFixed(2), m: memo });
      const ebiz = encodeURIComponent(biz);
      const alipaysUrl = 'alipays://platformapi/startapp?appId=20000123&actionType=scan&biz_data=' + ebiz;
      return res.redirect(302, alipaysUrl);
    }
  }
  next();
}

// 商户静态文件（根据类型选择模板目录）
app.use('/m/:id', (req, res, next) => {
  const templateDir = req.merchant.type === 'uid' ? UID_TEMPLATE_DIR : TEMPLATE_DIR;
  express.static(templateDir)(req, res, next);
});

// ===== 商户登录 API =====

app.post('/m/:id/api/login', express.json(), (req, res) => {
  const { phone, password } = req.body;
  const rt = req.runtime;
  const m = req.merchant;

  if (!phone || !/^1\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  if (!password) {
    return res.status(400).json({ code: 'FAIL', message: '请输入登录密码' });
  }

  const configPhone = (m.phone || '').trim();
  if (phone.trim() !== configPhone && !rt.allowedPhones.has(phone.trim())) {
    return res.status(400).json({ code: 'FAIL', message: '手机号或密码错误' });
  }

  // 先检查是否已通过安全设置修改过密码
  const storedPwd = rt.security.merchantPassword || '';
  if (storedPwd && storedPwd !== 'yy123456') {
    // 已修改过密码，严格校验修改后的密码
    const hashFn = m.type === 'uid' ? hashMerchantPwdUid : hashMerchantPwd;
    if (password === storedPwd || hashFn(password) === hashFn(storedPwd)) {
      const token = crypto.randomBytes(16).toString('hex');
      rt.sessions.set(token, { createdAt: Date.now(), phone: phone.trim() });
      return res.json({ code: 'OK', token, message: '登录成功' });
    }
    return res.status(400).json({ code: 'FAIL', message: '手机号或密码错误' });
  }

  // 尚未修改过密码，接受默认密码 yy123456
  if (password === 'yy123456') {
    const token = crypto.randomBytes(16).toString('hex');
    rt.sessions.set(token, { createdAt: Date.now(), phone: phone.trim() });
    return res.json({ code: 'OK', token, message: '登录成功' });
  }

  const hashFn = m.type === 'uid' ? hashMerchantPwdUid : hashMerchantPwd;
  const inputHash = hashFn(password);
  if (inputHash === hashFn('yy123456')) {
    const token = crypto.randomBytes(16).toString('hex');
    rt.sessions.set(token, { createdAt: Date.now(), phone: phone.trim() });
    return res.json({ code: 'OK', token, message: '登录成功' });
  }

  return res.status(400).json({ code: 'FAIL', message: '手机号或密码错误' });
});

// 管理员免密直接登录 — 商户管理系统调用，无需密码
app.post('/m/:id/api/login/admin', (req, res) => {
  const rt = req.runtime;
  const m = req.merchant;
  const phone = (m.phone || '').trim();
  const token = crypto.randomBytes(24).toString('hex');
  rt.sessions.set(token, {
    createdAt: Date.now(),
    phone,
    isAdmin: true,
  });
  console.log(`[${m.id}] 管理员免密登录 (phone=${phone})`);
  return res.json({ code: 'OK', token, message: '管理员直接登录' });
});

app.post('/m/:id/api/login/check', (req, res) => {
  const token = cleanToken(req.headers.authorization);
  const session = req.runtime.sessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) {
    return res.json({ code: 'OK', phone: session.phone });
  }
  return res.status(401).json({ code: 'UNAUTH', message: '未登录或会话已过期' });
});

app.post('/m/:id/api/login/change-password', express.json(), (req, res) => {
  const token = cleanToken(req.headers.authorization);
  const session = req.runtime.sessions.get(token);
  if (!session || Date.now() - session.createdAt >= SESSION_TTL) {
    return res.status(401).json({ code: 'UNAUTH', message: '请先登录' });
  }

  const { oldPassword, newPassword, confirmPassword } = req.body;
  if (!oldPassword) return res.status(400).json({ code: 'FAIL', message: '请输入原密码' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ code: 'FAIL', message: '新密码长度不能少于6位' });
  if (newPassword !== confirmPassword) return res.status(400).json({ code: 'FAIL', message: '两次输入的新密码不一致' });

  // 验证原密码：取已持久化的密码，回退到默认 yy123456
  const storedPwd = req.runtime.security.merchantPassword || 'yy123456';
  const hashFn = req.merchant.type === 'uid' ? hashMerchantPwdUid : hashMerchantPwd;
  if (oldPassword !== storedPwd && hashFn(oldPassword) !== hashFn(storedPwd)) {
    return res.status(400).json({ code: 'FAIL', message: '原密码错误' });
  }

  // 密码存到 security
  req.runtime.security.merchantPassword = newPassword;
  saveMerchantFile(req.merchant.id, 'security', req.runtime.security);
  res.json({ code: 'OK', message: '密码修改成功' });
});

app.post('/m/:id/api/login/forgot-password', express.json(), (req, res) => {
  const { payPassword, newPassword, confirmPassword } = req.body;
  if (!payPassword || payPassword.length < 6) return res.status(400).json({ code: 'FAIL', message: '请输入有效的支付宝支付密码' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ code: 'FAIL', message: '新密码长度不能少于6位' });
  if (newPassword !== confirmPassword) return res.status(400).json({ code: 'FAIL', message: '两次输入的新密码不一致' });

  req.runtime.security.merchantPassword = newPassword;
  saveMerchantFile(req.merchant.id, 'security', req.runtime.security);
  res.json({ code: 'OK', message: '密码重置成功' });
});

app.get('/m/:id/api/login/status', (req, res) => {
  const token = cleanToken(req.headers.authorization);
  const session = req.runtime.sessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) {
    req.sessionPhone = session.phone;
    return res.json({ code: 'OK', loggedIn: true, phone: session.phone, merchantName: getMerchantNameForSession(req) });
  }
  return res.json({ code: 'OK', loggedIn: false });
});

// ===== 收银台 API =====

// 当面付：生成收款码
app.post('/m/:id/cashier/qrcode', express.json(), async (req, res) => {
  const amount = String(req.body.amount || '').trim();
  const subject = String(req.body.subject || '收款').trim();
  const body = String(req.body.body || subject).trim();
  const m = req.merchant;
  const rt = req.runtime;

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ code: 'ERROR', message: '请输入有效金额' });
  }

  // 限额检查
  const limits = rt.limits;
  const amtNum = parseFloat(amount);
  if (limits.minAmount && amtNum < limits.minAmount) {
    return res.status(400).json({ code: 'ERROR', message: `单笔金额不能低于 ¥${limits.minAmount.toFixed(2)}` });
  }
  if (limits.maxAmount && amtNum > limits.maxAmount) {
    return res.status(400).json({ code: 'ERROR', message: `单笔金额不能超过 ¥${limits.maxAmount.toFixed(2)}` });
  }
  if (limits.dayCount) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayCount = rt.orders.filter(o => (o.status === 'paid' || o.status === 'refunded' || o.status === 'partial_refund') && o.paidAt && new Date(o.paidAt) >= today).length;
    if (todayCount >= limits.dayCount) {
      return res.status(400).json({ code: 'ERROR', message: `今日交易笔数已达上限 (${limits.dayCount}笔)` });
    }
  }

  const outTradeNo = `QR_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (m.type === 'uid' || m.type === 'uid-simple') {
    // ===== UID / UID 简易支付 收银台 =====
    const alipaysUrl = `alipays://platformapi/startapp?appId=20000674&actionType=scan&biz_data=${encodeURIComponent(JSON.stringify({ s: 'money', u: m.alipayUid, a: amtNum.toFixed(2), m: subject }))}`;

    if (m.type === 'uid-simple') {
      // UID 简易支付: 直接返回 alipays:// 链接，前端直接跳转，不生成二维码
      rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode: alipaysUrl, status: 'waiting', createdAt: Date.now() });
      setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

      rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null });
      saveMerchantFile(m.id, 'orders', rt.orders);

      return res.json({
        code: 'OK', out_trade_no: outTradeNo, qr_code: alipaysUrl, qr_image: '',
        amount, subject, use_api: false,
        use_direct_redirect: true,
        message: '正在跳转支付宝...',
      });
    }

    // UID 标准模式: 生成二维码
    let qrContent = alipaysUrl;

    // 如果前端传了 base_url，使用 HTTPS 跳转方式
    const frontendBaseUrl = req.body.base_url || '';
    const effectiveBaseUrl = frontendBaseUrl ? (frontendBaseUrl.replace(/\/$/, '') + '/') : '';
    if (effectiveBaseUrl) {
      qrContent = `${effectiveBaseUrl}m/${m.id}/pay/?amount=${amtNum.toFixed(2)}&uid=${m.alipayUid}&memo=${encodeURIComponent(subject)}`;
    }

    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(qrContent, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    } catch (qrErr) { console.error('二维码生成失败:', qrErr.message); }

    rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode: qrContent, status: 'waiting', createdAt: Date.now() });
    setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

    rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null });
    saveMerchantFile(m.id, 'orders', rt.orders);

    return res.json({
      code: 'OK', out_trade_no: outTradeNo, qr_code: qrContent, qr_image: qrDataUrl,
      amount, subject, use_api: false, message: effectiveBaseUrl ? '请使用支付宝扫码转账' : '⚠️ 未配置跳转地址，二维码可能被支付宝拦截',
    });
  }

  // ===== 当面付 =====
  if (!rt.alipaySdk) {
    return res.status(500).json({
      code: 'SDK_ERROR',
      message: '支付宝SDK未初始化，请检查商户配置',
      detail: rt.alipaySdkError || '商户缺少 appId 或 privateKey，或 keyType 不匹配',
      merchantType: m.type,
      hasAppId: !!m.appId,
      hasPrivateKey: !!m.privateKey,
    });
  }

  try {
    const result = await rt.alipaySdk.exec('alipay.trade.precreate', {
      bizContent: { out_trade_no: outTradeNo, total_amount: amtNum.toFixed(2), subject, body, timeout_express: '30m' },
    });
    const resp = result.alipay_trade_precreate_response || result;
    const qrCode = resp.qrCode || resp.qr_code;

    if (resp.code === '10000' && qrCode) {
      rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode, status: 'waiting', createdAt: Date.now() });
      setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

      rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null });
      saveMerchantFile(m.id, 'orders', rt.orders);

      let qrDataUrl = '';
      try { qrDataUrl = await QRCode.toDataURL(qrCode, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } }); } catch (e) {}

      return res.json({ code: 'OK', out_trade_no: outTradeNo, qr_code: qrCode, qr_image: qrDataUrl, amount, subject, message: '收款码已生成' });
    } else {
      return res.status(500).json({
        code: 'ALIPAY_ERROR', message: '支付宝接口错误',
        detail: JSON.stringify({ code: resp.code, sub_code: resp.subCode || resp.sub_code, msg: resp.msg }),
        alipay_code: resp.code,
      });
    }
  } catch (err) {
    return res.status(500).json({ code: 'ERROR', message: '支付服务异常: ' + err.message });
  }
});

// 查询支付状态
app.get('/m/:id/cashier/check', async (req, res) => {
  const m = req.merchant;
  const rt = req.runtime;
  const outTradeNo = (req.query.out_trade_no || '').trim();
  if (!outTradeNo) return res.status(400).json({ code: 'ERROR', message: '缺少 out_trade_no' });

  // 先查内存
  const localOrder = rt.cashierOrders.get(outTradeNo);
  if (localOrder && localOrder.status === 'paid') {
    return res.json({ code: 'OK', status: 'paid', trade_no: localOrder.tradeNo });
  }

  const adminOrder = rt.orders.find(o => o.outTradeNo === outTradeNo);
  if (!adminOrder) return res.json({ code: 'OK', status: 'waiting', message: '订单不存在' });
  if (adminOrder.status === 'paid') {
    const cOrder = rt.cashierOrders.get(outTradeNo) || {};
    cOrder.status = 'paid'; cOrder.tradeNo = adminOrder.tradeNo || '';
    rt.cashierOrders.set(outTradeNo, cOrder);
    return res.json({ code: 'OK', status: 'paid', trade_no: adminOrder.tradeNo, amount: adminOrder.amount });
  }

  if (m.type === 'uid') {
    return res.json({ code: 'OK', status: 'waiting' });
  }

  // 当面付：查支付宝
  if (!rt.alipaySdk) return res.json({ code: 'SDK_ERROR', message: 'SDK未初始化', detail: rt.alipaySdkError || '缺少 appId/privateKey' });
  try {
    const result = await rt.alipaySdk.exec('alipay.trade.query', { bizContent: { out_trade_no: outTradeNo } });
    const resp = result.alipay_trade_query_response || result;
    const tradeStatus = resp.tradeStatus || resp.trade_status;
    const tradeNo = resp.tradeNo || resp.trade_no;

    if (resp.code === '10000') {
      if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
        adminOrder.status = 'paid';
        adminOrder.paidAt = new Date().toISOString();
        adminOrder.tradeNo = tradeNo;
        saveMerchantFile(m.id, 'orders', rt.orders);
        const cOrder = rt.cashierOrders.get(outTradeNo) || {};
        cOrder.status = 'paid'; cOrder.tradeNo = tradeNo;
        rt.cashierOrders.set(outTradeNo, cOrder);
        return res.json({ code: 'OK', status: 'paid', trade_no: tradeNo, amount: adminOrder.amount });
      }
      // 首次查询到，更新为"支付中"
      if (adminOrder.status === 'generated') {
        adminOrder.status = 'paying';
        saveMerchantFile(m.id, 'orders', rt.orders);
      }
      return res.json({ code: 'OK', status: 'waiting', trade_status: tradeStatus });
    }
    return res.json({ code: 'OK', status: 'waiting' });
  } catch (err) {
    return res.json({ code: 'ERROR', message: err.message });
  }
});

// 支付宝异步通知（当面付）
app.post('/m/:id/cashier/notify', express.urlencoded({ extended: false }), async (req, res) => {
  const rt = req.runtime;
  const outTradeNo = req.body.out_trade_no;
  const tradeStatus = req.body.trade_status;

  if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
    const cOrder = rt.cashierOrders.get(outTradeNo) || {};
    cOrder.status = 'paid';
    cOrder.tradeNo = req.body.trade_no;
    rt.cashierOrders.set(outTradeNo, cOrder);

    const adminOrder = rt.orders.find(o => o.outTradeNo === outTradeNo);
    if (adminOrder) {
      adminOrder.status = 'paid';
      adminOrder.paidAt = new Date().toISOString();
      adminOrder.tradeNo = req.body.trade_no;
      saveMerchantFile(req.merchant.id, 'orders', rt.orders);
    }
  }
  res.send('success');
});

// UID 手动确认到账
app.post('/m/:id/cashier/confirm', express.json(), async (req, res) => {
  const rt = req.runtime;
  const { outTradeNo } = req.body;
  if (!outTradeNo) return res.status(400).json({ code: 'ERROR', message: '缺少订单号' });

  const order = rt.orders.find(o => o.outTradeNo === outTradeNo);
  if (!order) return res.status(404).json({ code: 'ERROR', message: '订单不存在' });
  if (order.status === 'paid' || order.status === 'confirmed') {
    return res.status(400).json({ code: 'ERROR', message: '该订单已确认到账' });
  }

  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.tradeNo = 'MANUAL_' + Date.now();
  saveMerchantFile(req.merchant.id, 'orders', rt.orders);

  const cOrder = rt.cashierOrders.get(outTradeNo);
  if (cOrder) { cOrder.status = 'paid'; cOrder.tradeNo = order.tradeNo; rt.cashierOrders.set(outTradeNo, cOrder); }

  res.json({ code: 'OK', message: '已确认到账', out_trade_no: outTradeNo });
});

// ===== 订单 API =====

app.get('/m/:id/api/orders', (req, res) => {
  const list = [...req.runtime.orders].reverse();
  res.json({ code: 'OK', data: list, total: list.length });
});

app.post('/m/:id/api/orders', express.json(), async (req, res) => {
  const rt = req.runtime;
  const { outTradeNo, status } = req.body;
  const order = rt.orders.find(o => o.outTradeNo === outTradeNo);
  if (order) {
    order.status = status;
    if (status === 'paid') order.paidAt = new Date().toISOString();
    saveMerchantFile(req.merchant.id, 'orders', rt.orders);
  }
  res.json({ code: 'OK' });
});

// ===== 退款 API =====

app.post('/m/:id/api/refund', express.json(), async (req, res) => {
  const m = req.merchant;
  const rt = req.runtime;
  const { outTradeNo, refundAmount } = req.body;
  if (!outTradeNo) return res.status(400).json({ code: 'ERROR', message: '缺少订单号' });

  const order = rt.orders.find(o => o.outTradeNo === outTradeNo);
  if (!order) return res.status(404).json({ code: 'ERROR', message: '订单不存在' });
  if (order.status !== 'paid') return res.status(400).json({ code: 'ERROR', message: '仅已支付的订单可以退款' });
  if (order.refund) return res.status(400).json({ code: 'ERROR', message: '该订单已退款' });

  // 检查当天是否已锁定（即使免密退款也不能退款）
  const today = new Date().toISOString().slice(0, 10);
  if (rt.security.lockDate === today) {
    return res.status(403).json({ code: 'LOCKED', message: '今日退款验证已锁定，无法退款' });
  }

  const amount = refundAmount ? parseFloat(refundAmount).toFixed(2) : order.amount;
  const amountNum = parseFloat(amount);
  const orderAmountNum = parseFloat(order.amount);
  if (amountNum <= 0 || amountNum > orderAmountNum) {
    return res.status(400).json({ code: 'ERROR', message: `退款金额无效` });
  }

  const outRequestNo = `RF_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (m.type === 'uid') {
    // UID：本地退款
    order.refund = { refundNo: 'LOCAL_' + outRequestNo, refundAmount: amount, refundedAt: new Date().toISOString(), outRequestNo, note: '本地退款' };
    order.status = amountNum >= orderAmountNum ? 'refunded' : 'partial_refund';
    saveMerchantFile(m.id, 'orders', rt.orders);
    return res.json({ code: 'OK', message: '退款已标记', refund_amount: amount });
  }

  // 当面付：调用支付宝退款
  if (!rt.alipaySdk) return res.status(500).json({ code: 'ERROR', message: 'SDK未初始化' });
  try {
    const result = await rt.alipaySdk.exec('alipay.trade.refund', {
      bizContent: { out_trade_no: outTradeNo, refund_amount: amount, out_request_no: outRequestNo },
    });
    const resp = result.alipay_trade_refund_response || result;

    if (resp.code === '10000') {
      order.refund = { refundNo: resp.tradeNo || resp.trade_no || '', refundAmount: amount, refundedAt: new Date().toISOString(), outRequestNo };
      order.status = amountNum >= orderAmountNum ? 'refunded' : 'partial_refund';
      saveMerchantFile(m.id, 'orders', rt.orders);
      return res.json({ code: 'OK', message: '退款成功', refund_amount: amount });
    } else {
      return res.status(500).json({ code: 'ALIPAY_ERROR', message: resp.subMsg || resp.sub_msg || resp.msg || '退款失败' });
    }
  } catch (err) {
    return res.status(500).json({ code: 'ERROR', message: '退款异常: ' + err.message });
  }
});

// ===== 安全设置 API =====

app.get('/m/:id/api/security', (req, res) => {
  const token = cleanToken(req.headers.authorization);
  const session = req.runtime.sessions.get(token);
  const phone = (session && Date.now() - session.createdAt < SESSION_TTL) ? session.phone : '';
  const sec = req.runtime.security;
  const today = new Date().toISOString().slice(0, 10);
  const locked = sec.lockDate === today;
  res.json({
    code: 'OK',
    data: {
      hasPassword: !!sec.passwordHash,
      skipPassword: sec.skipPassword,
      locked: locked,
      failedAttempts: sec.failedAttempts || 0,
      merchantName: getMerchantNameForSession(req),
      merchantContact: sec.merchantContact || '',
      merchantPhone: phone || sec.merchantPhone || '',
    },
  });
});

app.post('/m/:id/api/security/merchant-name', express.json(), async (req, res) => {
  const rt = req.runtime;
  const name = String(req.body.name || '').trim();
  rt.security.merchantName = name;
  // 同步到管理系统
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.merchant.id);
  if (merchant) { merchant.merchantName = name; saveMerchants(list); }
  saveMerchantFile(req.merchant.id, 'security', rt.security);
  res.json({ code: 'OK', merchantName: name });
});

app.post('/m/:id/api/security/merchant-info', express.json(), async (req, res) => {
  const rt = req.runtime;
  const contact = String(req.body.merchantContact || '').trim();
  const phone = String(req.body.merchantPhone || '').trim();
  rt.security.merchantContact = contact;
  rt.security.merchantPhone = phone;
  saveMerchantFile(req.merchant.id, 'security', rt.security);
  res.json({ code: 'OK', merchantContact: contact, merchantPhone: phone });
});

app.post('/m/:id/api/security/password', express.json(), async (req, res) => {
  const rt = req.runtime;
  const { oldPassword, newPassword, confirmPassword } = req.body;
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ code: 'ERROR', message: '新密码长度不能少于4位' });
  if (newPassword !== confirmPassword) return res.status(400).json({ code: 'ERROR', message: '两次输入的密码不一致' });

  if (rt.security.passwordHash) {
    if (!oldPassword) return res.status(400).json({ code: 'ERROR', message: '请输入原密码' });
    const hashFn = req.merchant.type === 'uid' ? hashSecurityPwdUid : hashSecurityPwd;
    if (hashFn(oldPassword) !== rt.security.passwordHash) return res.status(400).json({ code: 'ERROR', message: '原密码错误' });
  }

  const hashFn = req.merchant.type === 'uid' ? hashSecurityPwdUid : hashSecurityPwd;
  rt.security.passwordHash = hashFn(newPassword);
  saveMerchantFile(req.merchant.id, 'security', rt.security);
  res.json({ code: 'OK', message: oldPassword ? '密码已修改' : '安全密码已设置' });
});

app.post('/m/:id/api/security/verify', express.json(), (req, res) => {
  const rt = req.runtime;
  const { password } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  const sec = rt.security;

  // 检查当天是否已锁定
  if (sec.lockDate === today) {
    return res.status(403).json({ code: 'LOCKED', verified: false, message: '今日退款验证已锁定，请明天再试' });
  }

  if (!sec.passwordHash) return res.json({ code: 'OK', verified: true, message: '未设置安全密码' });
  if (!password) return res.status(400).json({ code: 'ERROR', message: '请输入安全密码' });

  const hashFn = req.merchant.type === 'uid' ? hashSecurityPwdUid : hashSecurityPwd;

  if (hashFn(password) === sec.passwordHash) {
    // 密码正确：重置连续输错计数
    sec.failedAttempts = 0;
    sec.failedAttemptDate = '';
    saveMerchantFile(req.merchant.id, 'security', sec);
    return res.json({ code: 'OK', verified: true, message: '验证通过' });
  }

  // 密码错误：检查日期并重置
  if (sec.failedAttemptDate !== today) {
    sec.failedAttempts = 0;
    sec.failedAttemptDate = today;
  }
  sec.failedAttempts++;

  const remaining = 3 - sec.failedAttempts;
  if (sec.failedAttempts >= 3) {
    sec.lockDate = today;
    saveMerchantFile(req.merchant.id, 'security', sec);
    return res.status(403).json({ code: 'LOCKED', verified: false, failedAttempts: sec.failedAttempts, message: '连续输错3次，今日退款已锁定，请明天再试' });
  }

  saveMerchantFile(req.merchant.id, 'security', sec);
  return res.status(400).json({ code: 'ERROR', verified: false, failedAttempts: sec.failedAttempts, remaining: remaining, message: '密码错误，还剩 ' + remaining + ' 次机会' });
});

app.post('/m/:id/api/security/skip', express.json(), async (req, res) => {
  const rt = req.runtime;
  const { password, enable } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  const sec = rt.security;

  if (sec.lockDate === today) {
    return res.status(403).json({ code: 'LOCKED', message: '今日退款验证已锁定，无法修改免密退款设置' });
  }
  if (!sec.passwordHash) return res.status(400).json({ code: 'ERROR', message: '请先设置二级安全密码' });
  const hashFn = req.merchant.type === 'uid' ? hashSecurityPwdUid : hashSecurityPwd;
  if (!password || hashFn(password) !== sec.passwordHash) {
    // 记录输错
    if (sec.failedAttemptDate !== today) {
      sec.failedAttempts = 0;
      sec.failedAttemptDate = today;
    }
    sec.failedAttempts++;
    if (sec.failedAttempts >= 3) {
      sec.lockDate = today;
      saveMerchantFile(req.merchant.id, 'security', sec);
      return res.status(403).json({ code: 'LOCKED', message: '连续输错3次，今日退款已锁定，请明天再试' });
    }
    saveMerchantFile(req.merchant.id, 'security', sec);
    return res.status(400).json({ code: 'ERROR', message: '安全密码错误' });
  }
  // 密码正确：重置输错计数
  sec.failedAttempts = 0;
  sec.failedAttemptDate = '';
  sec.skipPassword = !!enable;
  saveMerchantFile(req.merchant.id, 'security', sec);
  res.json({ code: 'OK', skipPassword: sec.skipPassword, message: `免密退款已${sec.skipPassword ? '开启' : '关闭'}` });
});

app.post('/m/:id/api/security/reset-by-paypwd', express.json(), async (req, res) => {
  const rt = req.runtime;
  const { payPassword, newPassword, confirmPassword } = req.body;
  if (!payPassword || payPassword.length < 6) return res.status(400).json({ code: 'ERROR', message: '请输入有效的支付宝支付密码' });
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ code: 'ERROR', message: '新密码长度不能少于4位' });
  if (newPassword !== confirmPassword) return res.status(400).json({ code: 'ERROR', message: '两次输入的新密码不一致' });
  const hashFn = req.merchant.type === 'uid' ? hashSecurityPwdUid : hashSecurityPwd;
  rt.security.passwordHash = hashFn(newPassword);
  saveMerchantFile(req.merchant.id, 'security', rt.security);
  res.json({ code: 'OK', message: '安全密码已重置' });
});

// ===== 限额 API =====

app.get('/m/:id/api/limits', (req, res) => {
  res.json({ code: 'OK', success: true, config: req.runtime.limits });
});

app.post('/m/:id/api/limits', express.json(), async (req, res) => {
  const rt = req.runtime;
  const body = req.body;
  rt.limits = {
    minAmount: body.minAmount !== '' && body.minAmount !== undefined ? parseFloat(body.minAmount) : null,
    maxAmount: body.maxAmount !== '' && body.maxAmount !== undefined ? parseFloat(body.maxAmount) : null,
    dayCount: body.dayCount !== '' && body.dayCount !== undefined ? parseInt(body.dayCount) : null,
    dayAmount: body.dayAmount !== '' && body.dayAmount !== undefined ? parseFloat(body.dayAmount) : null,
    monthCount: body.monthCount !== '' && body.monthCount !== undefined ? parseInt(body.monthCount) : null,
    monthAmount: body.monthAmount !== '' && body.monthAmount !== undefined ? parseFloat(body.monthAmount) : null,
  };
  saveMerchantFile(req.merchant.id, 'limits', rt.limits);
  res.json({ code: 'OK', success: true });
});

  // ===== UID 跳转页 =====
  // 无需路由处理器：静态文件中间件会自动 serve uid-template/pay/index.html
  // QR 码 URL 使用 /m/:id/pay/?amount=... 即可正确访问

  // ===== UID 专属 API =====

app.get('/m/:id/api/network-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  res.json({ code: 'OK', data: { ips, port: PORT } });
});

app.get('/m/:id/api/config', (req, res) => {
  const m = req.merchant;
  const uidMasked = m.alipayUid ? m.alipayUid.slice(0, 4) + '****' + m.alipayUid.slice(-4) : '未配置';
  res.json({ code: 'OK', data: { alipayUid: uidMasked, hasUid: !!m.alipayUid, hasPaymentApi: false, merchantName: m.merchantName || '未配置' } });
});

// ======================== 启动服务 ========================

// 预加载所有已有商户的运行时
const existingMerchants = loadMerchants();
for (const m of existingMerchants) {
  getMerchantRuntime(m.id, m);
}

// 管理端静态文件
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log('');
  console.log('========================================');
  console.log('  黑金PAY 商户管理系统（统一端口）');
  console.log(`  管理端: http://localhost:${PORT}`);
  console.log(`  默认管理员: ${ADMIN_USERNAME} / ${adminConfig.password}`);
  console.log('========================================');
  console.log('');
  console.log('  商户入口（例）:');
  for (const m of existingMerchants) {
    console.log(`  http://localhost:${PORT}/m/${m.id}/login.html  ← ${m.merchantName}`);
    console.log(`  http://localhost:${PORT}/m/${m.id}/cashier.html`);
  }
  if (existingMerchants.length === 0) {
    console.log('  (暂无商户，请先在管理端添加)');
  }
  console.log('');
});
