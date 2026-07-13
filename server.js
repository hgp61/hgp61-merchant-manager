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
const iconv = require('iconv-lite');

// 获取真实客户端 IP（支持代理环境，返回可用于查询归属地的 IPv4 地址）
// X-Forwarded-For: client_ip, proxy1, proxy2, ...  → 取第一个
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let rawIp = '';
  if (xff) {
    rawIp = xff.split(',')[0].trim();
  } else {
    rawIp = req.ip || req.socket.remoteAddress || '';
  }
  if (rawIp.startsWith('::ffff:')) rawIp = rawIp.slice(7);
  if (rawIp === '::1') rawIp = '127.0.0.1';
  return rawIp;
}

// ======================== PostgreSQL 数据持久化 ========================
const DATABASE_URL = process.env.DATABASE_URL;
let pgPool = null;

async function connectDb() {
  if (!DATABASE_URL) return null;
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('SELECT 1');
    console.log('[DB] PostgreSQL 连接成功');
    return pool;
  } catch (err) {
    console.error('[DB] PostgreSQL 连接失败:', err.message);
    return null;
  }
}

async function createTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchants (
      id VARCHAR(32) PRIMARY KEY,
      type VARCHAR(16) NOT NULL,
      merchant_name VARCHAR(128),
      phone VARCHAR(16),
      password VARCHAR(256),
      alipay_uid VARCHAR(32),
      file_name VARCHAR(128),
      app_id VARCHAR(64),
      private_key TEXT,
      alipay_public_key TEXT,
      key_type VARCHAR(16),
      merchant_url VARCHAR(256),
      enabled BOOLEAN DEFAULT true,
      mgr_min_amount NUMERIC,
      mgr_max_amount NUMERIC,
      zip_generated BOOLEAN DEFAULT false,
      created_at TIMESTAMP
    );`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_config (
      id INTEGER PRIMARY KEY,
      password VARCHAR(256) NOT NULL
    );`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_json_data (
      merchant_id VARCHAR(32) NOT NULL,
      data_name VARCHAR(32) NOT NULL,
      data_json JSONB NOT NULL,
      PRIMARY KEY (merchant_id, data_name)
    );`);
}

async function restoreFromDb(pool) {
  // Restore merchants
  const { rows } = await pool.query('SELECT * FROM merchants');
  if (rows.length > 0) {
    const merchants = rows.map(r => ({
      id: r.id,
      type: r.type,
      merchantName: r.merchant_name,
      phone: r.phone,
      password: r.password,
      alipayUid: r.alipay_uid,
      fileName: r.file_name,
      appId: r.app_id,
      privateKey: r.private_key,
      alipayPublicKey: r.alipay_public_key,
      keyType: r.key_type,
      merchantUrl: r.merchant_url,
      enabled: r.enabled,
      mgrMinAmount: r.mgr_min_amount,
      mgrMaxAmount: r.mgr_max_amount,
      zipGenerated: r.zip_generated,
      createdAt: r.created_at
    }));
    fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(merchants, null, 2), 'utf-8');
    console.log('[DB] 已恢复', merchants.length, '个商户');
  }

  // Restore admin config
  const { rows: adminRows } = await pool.query('SELECT * FROM admin_config WHERE id = 1');
  if (adminRows.length > 0) {
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify({ password: adminRows[0].password }, null, 2), 'utf-8');
    console.log('[DB] 已恢复管理员配置');
  }

  // Restore merchant JSON data
  const { rows: dataRows } = await pool.query('SELECT * FROM merchant_json_data');
  for (const row of dataRows) {
    const dir = getMerchantDir(row.merchant_id);
    fs.writeFileSync(path.join(dir, row.data_name + '.json'), JSON.stringify(row.data_json, null, 2), 'utf-8');
  }
  if (dataRows.length > 0) {
    console.log('[DB] 已恢复', dataRows.length, '条商户数据');
  }
}

async function syncMerchantsToDb(pool, list) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM merchants');
    for (const m of list) {
      await client.query(
        `INSERT INTO merchants (id, type, merchant_name, phone, password, alipay_uid, file_name, app_id, private_key, alipay_public_key, key_type, merchant_url, enabled, mgr_min_amount, mgr_max_amount, zip_generated, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           type=EXCLUDED.type, merchant_name=EXCLUDED.merchant_name, phone=EXCLUDED.phone,
           password=EXCLUDED.password, alipay_uid=EXCLUDED.alipay_uid, file_name=EXCLUDED.file_name,
           app_id=EXCLUDED.app_id, private_key=EXCLUDED.private_key, alipay_public_key=EXCLUDED.alipay_public_key,
           key_type=EXCLUDED.key_type, merchant_url=EXCLUDED.merchant_url, enabled=EXCLUDED.enabled,
           mgr_min_amount=EXCLUDED.mgr_min_amount, mgr_max_amount=EXCLUDED.mgr_max_amount,
           zip_generated=EXCLUDED.zip_generated, created_at=EXCLUDED.created_at`,
        [m.id, m.type, m.merchantName || null, m.phone || null, m.password || null,
         m.alipayUid || null, m.fileName || null, m.appId || null, m.privateKey || null,
         m.alipayPublicKey || null, m.keyType || null, m.merchantUrl || null,
         m.enabled !== false, m.mgrMinAmount || null, m.mgrMaxAmount || null,
         m.zipGenerated || false, m.createdAt || null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function syncAdminConfigToDb(pool, cfg) {
  await pool.query(
    `INSERT INTO admin_config (id, password) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password`,
    [cfg.password]
  );
}

async function syncMerchantDataToDb(pool, merchantId, name, data) {
  await pool.query(
    `INSERT INTO merchant_json_data (merchant_id, data_name, data_json) VALUES ($1, $2, $3)
     ON CONFLICT (merchant_id, data_name) DO UPDATE SET data_json = EXCLUDED.data_json`,
    [merchantId, name, JSON.stringify(data)]
  );
}

async function initDb() {
  if (!DATABASE_URL) {
    console.log('[DB] 未配置 DATABASE_URL，使用 JSON 文件存储');
    return;
  }
  pgPool = await connectDb();
  if (!pgPool) return;
  await createTables(pgPool);
  await restoreFromDb(pgPool);
  console.log('[DB] 数据初始化完成');
}

// ======================== 数据写入同步（JSON + PostgreSQL） ========================
function saveMerchantsWithSync(list) {
  fs.writeFileSync(MERCHANTS_FILE, JSON.stringify(list, null, 2), 'utf-8');
  if (pgPool) {
    syncMerchantsToDb(pgPool, list).catch(err => console.error('[DB] 同步 merchants 失败:', err.message));
  }
}

function saveAdminConfigWithSync(cfg) {
  fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  if (pgPool) {
    syncAdminConfigToDb(pgPool, cfg).catch(err => console.error('[DB] 同步 admin config 失败:', err.message));
  }
}

function saveMerchantFileWithSync(id, name, data) {
  fs.writeFileSync(path.join(getMerchantDir(id), name + '.json'), JSON.stringify(data, null, 2), 'utf-8');
  if (pgPool) {
    syncMerchantDataToDb(pgPool, id, name, data).catch(err => console.error('[DB] 同步 merchant data 失败:', err.message));
  }
}


const app = express();
app.set('trust proxy', true); // 支持反向代理（Railway/Heroku 等），req.ip 将返回真实客户端 IP
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// ======================== 路径常量 ========================

const TEMPLATE_DIR = path.join(__dirname, 'template');
const UID_TEMPLATE_DIR = path.join(__dirname, 'uid-template');
const DATA_DIR = path.join(__dirname, 'data');
const MERCHANT_DATA_DIR = path.join(DATA_DIR, 'merchants');
const MERCHANTS_FILE = path.join(DATA_DIR, 'merchants.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');

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
  saveAdminConfigWithSync(cfg);
}

let adminConfig;
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
  saveMerchantFileWithSync(id, name, data);
}

function getMerchantRuntime(id, merchant) {
  // 如果有缓存的运行时且 SDK 已初始化，直接返回
  if (merchantRuntimes.has(id)) {
    const cached = merchantRuntimes.get(id);
    // SDK 已正常初始化 → 直接复用
    if (cached.alipaySdk) return cached;
    // SDK 为 null 但商户没有应用凭证 → 复用缓存（无需重试）
    if (!merchant.appId || !merchant.privateKey) return cached;
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
  if (!merchant.appId || !merchant.privateKey) {
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

// ======================== 多通道组（轮询收款）====================

const GROUPS_DATA_DIR = path.join(DATA_DIR, 'groups');
const groupRuntimes = new Map(); // groupId -> { nextIndex, orders: [...] }

function ensureGroupsDir() {
  if (!fs.existsSync(GROUPS_DATA_DIR)) fs.mkdirSync(GROUPS_DATA_DIR, { recursive: true });
}

function getGroupDir(id) {
  ensureGroupsDir();
  const dir = path.join(GROUPS_DATA_DIR, id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadGroups() {
  try { return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8')); }
  catch { return []; }
}

function saveGroups(list) {
  fs.writeFileSync(GROUPS_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

function genGroupId() {
  return 'G' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function getGroupRuntime(group) {
  if (groupRuntimes.has(group.id)) return groupRuntimes.get(group.id);
  const runtime = {
    nextIndex: 0,        // 下一笔订单应当落到的槽位
    roundCount: 0,       // 已轮转过的笔数（用于展示）
    orders: [],          // 该 group 下所有订单（冗余存储）
    merchantIds: (group.merchants || []).map(m => m.id),
  };
  groupRuntimes.set(group.id, runtime);
  return runtime;
}

function pickNextGroupMerchant(group) {
  const rt = getGroupRuntime(group);
  if (!group.merchants || group.merchants.length === 0) return null;
  const N = group.merchants.length;
  for (let i = 0; i < N; i++) {
    const idx = (rt.nextIndex + i) % N;
    const m = group.merchants[idx];
    if (m && m.enabled !== false) {
      rt.nextIndex = (idx + 1) % N;
      rt.roundCount += 1;
      return { merchant: m, slotIndex: idx };
    }
  }
  return null;
}

function syncGroupRuntimeAfterMerchantChange(groupId) {
  const groups = loadGroups();
  const g = groups.find(x => x.id === groupId);
  if (!g) { groupRuntimes.delete(groupId); return; }
  const rt = groupRuntimes.get(groupId);
  if (rt) {
    rt.merchantIds = g.merchants.map(m => m.id);
    if (rt.nextIndex >= g.merchants.length) rt.nextIndex = 0;
  }
}

// ======================== 自动确认到账（交易查询 + 账单兜底） ========================

/** 正在自动确认的订单（防止重复轮询） */
const autoConfirmJobs = new Map(); // outTradeNo -> { startTime, merchantId, phase }

/**
 * 查询支付宝账单下载URL
 */
async function queryBillDownloadUrl(sdk, billDate, billType) {
  const result = await sdk.exec('alipay.data.dataservice.bill.downloadurl.query', {
    bizContent: { bill_type: billType, bill_date: billDate }
  });
  const resp = result.alipay_data_dataservice_bill_downloadurl_query_response || result;
  if (resp.code !== '10000' || !resp.bill_download_url) {
    throw new Error(`账单API错误: ${resp.msg || resp.sub_msg || resp.code}`);
  }
  return resp.bill_download_url;
}

/**
 * 下载文件（支持重定向）
 */
function downloadFile(url, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 3;
  return new Promise((resolve, reject) => {
    var getter = url.startsWith('https') ? https : http;
    getter.get(url, function(res) {
      if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && maxRedirects > 0) {
        return downloadFile(res.headers.location, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error('下载失败: HTTP ' + res.statusCode));
        return;
      }
      var chunks = [];
      res.on('data', function(chunk) { chunks.push(chunk); });
      res.on('end', function() { resolve(Buffer.concat(chunks)); });
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * 解析CSV行（处理引号包裹的逗号）
 */
function parseCSVLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * 解析账单CSV内容，返回交易记录数组
 */
function parseBillCSV(csvContent) {
  var lines = csvContent.split(/\r?\n/).filter(function(l) { return l.trim(); });
  var records = [];

  // 找到表头行（第一个非#开头的行）
  var headerIdx = 0;
  while (headerIdx < lines.length && lines[headerIdx].charAt(0) === '#') {
    headerIdx++;
  }
  if (headerIdx >= lines.length) return records;

  var headers = parseCSVLine(lines[headerIdx]);

  for (var i = headerIdx + 1; i < lines.length; i++) {
    var line = lines[i];
    if (line.charAt(0) === '#' || !line.trim()) continue;
    var values = parseCSVLine(line);
    if (values.length < 3) continue;
    var row = {};
    for (var j = 0; j < headers.length && j < values.length; j++) {
      row[headers[j]] = values[j];
    }
    records.push(row);
  }

  return records;
}

/**
 * 下载账单ZIP并解析为交易记录
 */
async function downloadAndParseBill(sdk, billDate) {
  // 优先 signcustomer（资金收支账单，包含转账收款记录）
  var downloadUrl;
  try {
    downloadUrl = await queryBillDownloadUrl(sdk, billDate, 'signcustomer');
  } catch (e) {
    console.log('[账单] signcustomer 不可用，尝试 trade: ' + e.message);
    downloadUrl = await queryBillDownloadUrl(sdk, billDate, 'trade');
  }

  var zipBuffer = await downloadFile(downloadUrl);
  var zip = new AdmZip(zipBuffer);
  var entries = zip.getEntries();

  // 支付宝账单ZIP可能包含汇总CSV和明细CSV，跳过汇总文件优先解析明细
  var csvEntry = null;
  for (var i = 0; i < entries.length; i++) {
    var name = entries[i].entryName;
    if (!name.endsWith('.csv')) continue;
    if (name.indexOf('汇总') >= 0 || name.toLowerCase().indexOf('summary') >= 0) continue;
    csvEntry = entries[i];
    break;
  }
  // 如果没有找到明细文件（可能只有一个CSV），则用第一个CSV
  if (!csvEntry) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].entryName.endsWith('.csv')) { csvEntry = entries[i]; break; }
    }
  }
  if (csvEntry) {
    return parseBillCSV(iconv.decode(csvEntry.getData(), 'gbk'));
  }

  return [];
}

/**
 * 在账单记录中匹配订单（按金额+时间）
 * @returns {Object|null} 匹配的记录
 */
function matchBillRecord(records, order) {
  var targetAmount = parseFloat(order.amount).toFixed(2);
  var orderTime = new Date(order.createdAt);

  for (var i = 0; i < records.length; i++) {
    var rec = records[i];

    // 匹配收入金额
    var incomeStr = rec['收入金额'] || rec['商家实收'] || rec['订单金额'] || rec['交易额'] || '';
    var income = parseFloat(incomeStr);
    if (isNaN(income) || income.toFixed(2) !== targetAmount) continue;

    // 匹配时间窗口（订单创建后0~35分钟内）
    var timeStr = rec['创建时间'] || rec['完成时间'] || rec['付款时间'] || rec['交易创建时间'] || '';
    if (timeStr) {
      var txTime = new Date(timeStr.replace(/-/g, '/'));
      if (!isNaN(txTime.getTime())) {
        var diff = txTime.getTime() - orderTime.getTime();
        if (diff < -60 * 1000 || diff > 35 * 60 * 1000) continue;
      }
    }

    // 排除退款/支出类型
    var typeStr = rec['账务类型'] || rec['业务类型'] || '';
    if (typeStr.indexOf('退款') >= 0 || typeStr.indexOf('支出') >= 0) continue;

    return rec;
  }

  return null;
}

/**
 * 启动自动确认到账（混合策略）
 *
 * 当订单变为 pending_confirm 时，系统自动检测支付是否成功：
 *   Phase 1: alipay.trade.query 每10秒查询（当面付模式秒级确认，5分钟）
 *   Phase 2: 账单API 每30秒查询（UID模式兜底，查今天+昨天账单，30分钟）
 *   Phase 3: 账单API 每5分钟慢速兜底（最长2小时，处理账单延迟生成的情况）
 *
 * 确认成功后自动标记 paid，超时则保持 pending_confirm 等待手动确认。
 *
 * @param {string} merchantId - 商户ID
 * @param {Object} rt - 商户运行时（含 alipaySdk）
 * @param {Object} order - 订单对象（引用，匹配成功时直接修改）
 */
function startAutoConfirm(merchantId, rt, order) {
  var outTradeNo = order.outTradeNo;
  if (autoConfirmJobs.has(outTradeNo)) return;
  if (!rt.alipaySdk) return; // 无SDK无法查询

  autoConfirmJobs.set(outTradeNo, { startTime: Date.now(), merchantId, phase: 1 });
  console.log('[自动确认] 启动: ' + outTradeNo + ', ¥' + order.amount);

  // ===== Phase 1: alipay.trade.query 快速查询 =====
  var phase1Attempts = 0;
  var maxPhase1 = 30; // 30 × 10s = 5分钟

  var phase1Timer = setInterval(async function() {
    phase1Attempts++;

    // 检查订单是否已被确认（商户手动确认或其他途径）
    var currentOrder = rt.orders.find(function(o) { return o.outTradeNo === outTradeNo; });
    if (!currentOrder || currentOrder.status === 'paid' || currentOrder.status === 'confirmed' || currentOrder.status === 'refunded') {
      console.log('[自动确认] 订单已处理，停止: ' + outTradeNo);
      clearInterval(phase1Timer);
      autoConfirmJobs.delete(outTradeNo);
      return;
    }

    try {
      var result = await rt.alipaySdk.exec('alipay.trade.query', {
        bizContent: { out_trade_no: outTradeNo }
      });
      var resp = result.alipay_trade_query_response || result;
      var tradeStatus = resp.tradeStatus || resp.trade_status;
      var tradeNo = resp.tradeNo || resp.trade_no;

      if (resp.code === '10000' && (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED')) {
        // ✅ 交易查询确认成功！
        currentOrder.status = 'paid';
        currentOrder.paidAt = new Date().toISOString();
        currentOrder.tradeNo = tradeNo;
        currentOrder.autoConfirmed = true;
        currentOrder.confirmMethod = 'trade_query';
        saveMerchantFile(merchantId, 'orders', rt.orders);

        var cached = rt.cashierOrders.get(outTradeNo);
        if (cached) { cached.status = 'paid'; cached.tradeNo = tradeNo; }

        console.log('[自动确认] ✅ trade.query确认到账: ' + outTradeNo + ', ¥' + currentOrder.amount);
        clearInterval(phase1Timer);
        autoConfirmJobs.delete(outTradeNo);
        return;
      }
      // UID模式订单不在交易系统中，trade.query返回"订单不存在"是正常的，不记录为错误
    } catch (e) {
      // trade.query调用失败（网络问题等），继续尝试
      console.log('[自动确认] P1第' + phase1Attempts + '次trade.query异常: ' + e.message);
    }

    // Phase 1超时 → 进入Phase 2（账单轮询）
    if (phase1Attempts >= maxPhase1) {
      clearInterval(phase1Timer);
      console.log('[自动确认] Phase 1超时，进入账单轮询: ' + outTradeNo);
      autoConfirmJobs.get(outTradeNo).phase = 2;
      startBillPhase(merchantId, rt, outTradeNo);
    }
  }, 10000);
}

/**
 * Phase 2/3: 账单API轮询（UID模式兜底）
 * Phase 2: 每30秒查一次，持续30分钟（60次）
 * Phase 3: 每5分钟查一次，持续最多2小时（24次）
 */
function startBillPhase(merchantId, rt, outTradeNo) {
  var phase2Attempts = 0;
  var maxPhase2 = 60; // 60 × 30s = 30分钟

  var phase2Timer = setInterval(async function() {
    phase2Attempts++;

    var currentOrder = rt.orders.find(function(o) { return o.outTradeNo === outTradeNo; });
    if (!currentOrder || currentOrder.status === 'paid' || currentOrder.status === 'confirmed' || currentOrder.status === 'refunded') {
      clearInterval(phase2Timer);
      autoConfirmJobs.delete(outTradeNo);
      return;
    }

    // 今天的账单日期（可能尚未生成）
    var today = new Date();
    var billDateToday = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    // 昨天的账单（总是完整可用）
    var yesterday = new Date(today.getTime() - 86400000);
    var billDateYesterday = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');

    // 尝试今天的账单
    try {
      var records = await downloadAndParseBill(rt.alipaySdk, billDateToday);
      console.log('[自动确认] 账单P2第' + phase2Attempts + '次(今天): ' + records.length + '条');
      var matched = matchBillRecord(records, currentOrder);
      if (matched) {
        confirmFromBill(currentOrder, matched, merchantId, rt, outTradeNo);
        clearInterval(phase2Timer);
        return;
      }
    } catch (e) {
      // 今天的账单可能还不存在，这是正常情况，不停止轮询
    }

    // 尝试昨天的账单（处理跨日交易）
    try {
      var records2 = await downloadAndParseBill(rt.alipaySdk, billDateYesterday);
      var matched2 = matchBillRecord(records2, currentOrder);
      if (matched2) {
        confirmFromBill(currentOrder, matched2, merchantId, rt, outTradeNo);
        clearInterval(phase2Timer);
        return;
      }
    } catch (e) {
      // 忽略昨天的账单查询失败
    }

    // Phase 2超时 → 进入Phase 3（慢速兜底）
    if (phase2Attempts >= maxPhase2) {
      clearInterval(phase2Timer);
      console.log('[自动确认] Phase 2超时，进入慢速兜底: ' + outTradeNo);
      autoConfirmJobs.get(outTradeNo).phase = 3;
      startSlowBillPhase(merchantId, rt, outTradeNo);
    }
  }, 30000);
}

/**
 * Phase 3: 慢速账单兜底（每5分钟一次，最长2小时）
 * 处理支付宝账单延迟生成（T+1）的情况
 */
function startSlowBillPhase(merchantId, rt, outTradeNo) {
  var phase3Attempts = 0;
  var maxPhase3 = 24; // 24 × 5min = 2小时

  var phase3Timer = setInterval(async function() {
    phase3Attempts++;

    var currentOrder = rt.orders.find(function(o) { return o.outTradeNo === outTradeNo; });
    if (!currentOrder || currentOrder.status === 'paid' || currentOrder.status === 'confirmed' || currentOrder.status === 'refunded') {
      clearInterval(phase3Timer);
      autoConfirmJobs.delete(outTradeNo);
      return;
    }

    // 订单创建超过3小时，停止轮询
    var orderAge = Date.now() - new Date(currentOrder.createdAt).getTime();
    if (orderAge > 3 * 3600000) {
      console.log('[自动确认] 订单超时3小时，停止兜底: ' + outTradeNo + '（保持待确认）');
      clearInterval(phase3Timer);
      autoConfirmJobs.delete(outTradeNo);
      return;
    }

    var today = new Date();
    var billDateToday = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    var yesterday = new Date(today.getTime() - 86400000);
    var billDateYesterday = yesterday.getFullYear() + '-' + String(yesterday.getMonth() + 1).padStart(2, '0') + '-' + String(yesterday.getDate()).padStart(2, '0');

    try {
      var records = await downloadAndParseBill(rt.alipaySdk, billDateToday);
      console.log('[自动确认] 账单P3第' + phase3Attempts + '次(今天): ' + records.length + '条');
      var matched = matchBillRecord(records, currentOrder);
      if (matched) {
        confirmFromBill(currentOrder, matched, merchantId, rt, outTradeNo);
        clearInterval(phase3Timer);
        return;
      }
    } catch (e) { }

    try {
      var records2 = await downloadAndParseBill(rt.alipaySdk, billDateYesterday);
      var matched2 = matchBillRecord(records2, currentOrder);
      if (matched2) {
        confirmFromBill(currentOrder, matched2, merchantId, rt, outTradeNo);
        clearInterval(phase3Timer);
        return;
      }
    } catch (e) { }

    if (phase3Attempts >= maxPhase3) {
      console.log('[自动确认] 慢速兜底超时，停止: ' + outTradeNo + '（保持待确认）');
      clearInterval(phase3Timer);
      autoConfirmJobs.delete(outTradeNo);
    }
  }, 300000); // 5分钟
}

/**
 * 从账单匹配结果确认到账
 */
function confirmFromBill(order, matchedRecord, merchantId, rt, outTradeNo) {
  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.tradeNo = (matchedRecord['支付宝交易号'] || '') + '_BILL_AUTO';
  order.autoConfirmed = true;
  order.confirmMethod = 'bill_match';
  saveMerchantFile(merchantId, 'orders', rt.orders);

  var cached = rt.cashierOrders.get(outTradeNo);
  if (cached) { cached.status = 'paid'; cached.tradeNo = order.tradeNo; }

  console.log('[自动确认] ✅ 账单匹配确认到账: ' + outTradeNo + ', ¥' + order.amount);
  autoConfirmJobs.delete(outTradeNo);
}

// ======================== 工具函数 ========================

function loadMerchants() {
  try { return JSON.parse(fs.readFileSync(MERCHANTS_FILE, 'utf-8')); }
  catch { return []; }
}

function saveMerchants(list) {
  saveMerchantsWithSync(list);
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
  if (config.merchantType) {
    result = result.replace(/merchantType:\s*['"].*?['"],/, `merchantType: '${config.merchantType}',`);
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

function generateFaceDynamicMerchantZip(config) {
  const zip = new AdmZip();
  const templateIndex = fs.readFileSync(path.join(TEMPLATE_DIR, 'index.js'), 'utf-8');
  const injectedIndex = injectConfig(templateIndex, { ...config, merchantType: 'face2face-dynamic' });
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
  // 注入支付宝应用凭证（用于账单API自动确认）
  if (config.appId) {
    result = result.replace(/appId:\s*['"].*?['"],/, `appId: '${config.appId}',`);
  }
  if (config.privateKey) {
    result = result.replace(/privateKey:\s*['"][\s\S]*?['"],/, () => `privateKey: \`${config.privateKey}\`,`);
  }
  if (config.alipayPublicKey) {
    result = result.replace(/alipayPublicKey:\s*['"].*?['"],/, `alipayPublicKey: '${config.alipayPublicKey}',`);
  }
  if (config.keyType) {
    result = result.replace(/keyType:\s*['"].*?['"],/, `keyType: '${config.keyType}',`);
  }
  return result;
}

function generateUidMerchantZip(config) {
  const zip = new AdmZip();
  const templateIndex = fs.readFileSync(path.join(UID_TEMPLATE_DIR, 'index.js'), 'utf-8');
  const injectedIndex = injectUidConfig(templateIndex, config);
  zip.addFile('index.js', Buffer.from(injectedIndex, 'utf-8'));
  ['cashier.html', 'admin.html', 'login.html', 'logo-pay.png', 'package.json'].forEach(f => {
    zip.addFile(f, fs.readFileSync(path.join(UID_TEMPLATE_DIR, f)));
  });
  // 支付跳转页（用户扫码后打开的中间页）
  const payHtml = fs.readFileSync(path.join(UID_TEMPLATE_DIR, 'pay', 'index.html'), 'utf-8');
  zip.addFile('pay/index.html', Buffer.from(payHtml, 'utf-8'));
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
  const { merchantName, phone, appId, privateKey, alipayPublicKey, keyType: reqKeyType, type: reqType } = req.body;
  const faceType = reqType === 'face2face-dynamic' ? 'face2face-dynamic' : 'face2face';
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
    id, type: faceType,
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
    const zipConfig = {
      appId: appId.trim(),
      privateKey: trimmedKey,
      alipayPublicKey: alipayPublicKey.trim(),
      merchantName: alipayMerchantName,
      merchantPhone: phone.trim(),
      merchantPassword: defaultPassword,
      merchantType: faceType,
    };
    const zipBuffer = faceType === 'face2face-dynamic'
      ? generateFaceDynamicMerchantZip(zipConfig)
      : generateMerchantZip(zipConfig);
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

  // 多通道组：若该商户是某个组的槽位，从组中移除
  if (merchant.groupId) {
    const groups = loadGroups();
    const g = groups.find(x => x.id === merchant.groupId);
    if (g) {
      g.merchants = (g.merchants || []).filter(s => s.id !== merchant.id);
      saveGroups(groups);
      syncGroupRuntimeAfterMerchantChange(merchant.groupId);
      console.log(`[GROUP:${merchant.groupId}] 槽位 ${merchant.id} 已从组中移除（商户被单独删除），剩余 ${g.merchants.length} 个`);
    }
  }

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

  // 更新支付宝配置（当面付商户 + UID商户可选凭证）
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

  // UID商户：允许清空支付宝凭证（恢复纯个人转账模式）
  if ((merchant.type === 'uid' || merchant.type === 'uid-simple') && req.body.clearSdk === true) {
    merchant.appId = '';
    merchant.privateKey = '';
    merchant.alipayPublicKey = '';
    merchant.keyType = '';
  }

  saveMerchants(list);

  // 如果更新了支付宝配置（或清空了SDK凭证），清除运行时缓存，下次访问时重新初始化
  if (req.body.appId !== undefined || req.body.privateKey !== undefined || req.body.alipayPublicKey !== undefined || req.body.keyType !== undefined || req.body.clearSdk === true) {
    merchantRuntimes.delete(req.params.id);
    console.log(`[商户:${req.params.id}] 支付宝配置已更新，运行时缓存已清除，下次访问时重新初始化`);
  }

  res.json({ code: 'OK', data: { ...merchant, password: undefined } });
});

// ===== 商户开关（启用/禁用收款） =====
app.put('/api/merchants/:id/toggle', requireAuth, (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });

  merchant.enabled = req.body.enabled !== false; // 默认 true
  saveMerchants(list);
  console.log(`[商户:${req.params.id}] 收款功能: ${merchant.enabled ? '已开启' : '已关闭'}`);

  // 多通道组：同步组内 slot 的 enabled
  if (merchant.groupId) {
    const groups = loadGroups();
    const g = groups.find(x => x.id === merchant.groupId);
    if (g) {
      const slot = (g.merchants || []).find(s => s.id === merchant.id);
      if (slot) { slot.enabled = merchant.enabled; saveGroups(groups); }
    }
  }

  res.json({ code: 'OK', data: { enabled: merchant.enabled } });
});

// ===== 商户管理系统级限额设置 =====
app.put('/api/merchants/:id/mgr-limits', requireAuth, (req, res) => {
  const list = loadMerchants();
  const merchant = list.find(m => m.id === req.params.id);
  if (!merchant) return res.status(404).json({ code: 'FAIL', message: '商户不存在' });

  const parseAmount = (v) => {
    if (v === '' || v === null || v === undefined) return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  };

  merchant.mgrMinAmount = parseAmount(req.body.minAmount);
  merchant.mgrMaxAmount = parseAmount(req.body.maxAmount);
  saveMerchants(list);
  console.log(`[商户:${req.params.id}] 管理限额更新: min=${merchant.mgrMinAmount}, max=${merchant.mgrMaxAmount}`);
  res.json({ code: 'OK', data: { minAmount: merchant.mgrMinAmount, maxAmount: merchant.mgrMaxAmount } });
});

// ======================== 多通道组（轮询收款）API ========================

// 辅助：规范化 & 校验一个 group slot 的配置
function buildGroupSlot(slot, groupPhone) {
  if (!slot || !slot.type) throw new Error('slot 类型缺失');
  const slotType = slot.type;
  if (!['uid', 'uid-simple', 'face2face', 'face2face-dynamic'].includes(slotType)) {
    throw new Error('不支持的进件类型: ' + slotType);
  }
  const merchantName = (slot.merchantName || '').trim();
  const phone = groupPhone;
  const out = {
    type: slotType,
    merchantName: merchantName || '多通道商户',
    phone,
    password: hashPwd('yy123456'),
  };
  if (slotType === 'uid' || slotType === 'uid-simple') {
    const uid = (slot.alipayUid || '').trim();
    if (!/^\d{16}$/.test(uid) || !uid.startsWith('2088')) throw new Error('支付宝 UID 格式错误');
    out.alipayUid = uid;
  } else {
    const appId = (slot.appId || '').trim();
    let priv = (slot.privateKey || '').trim();
    const pub = (slot.alipayPublicKey || '').trim();
    if (!appId) throw new Error('请填写 APPID');
    if (!priv) throw new Error('请填写应用私钥');
    if (!pub) throw new Error('请填写支付宝公钥');
    if (!priv.includes('-----BEGIN') && !priv.includes('-----END')) {
      const kt = (slot.keyType || 'auto').toString().trim().toUpperCase();
      if (kt === 'PKCS1') {
        priv = '-----BEGIN RSA PRIVATE KEY-----\n' + priv + '\n-----END RSA PRIVATE KEY-----';
      } else if (kt === 'PKCS8') {
        priv = '-----BEGIN PRIVATE KEY-----\n' + priv + '\n-----END PRIVATE KEY-----';
      } else {
        priv = priv.startsWith('MII')
          ? '-----BEGIN PRIVATE KEY-----\n' + priv + '\n-----END PRIVATE KEY-----'
          : '-----BEGIN RSA PRIVATE KEY-----\n' + priv + '\n-----END RSA PRIVATE KEY-----';
      }
    }
    priv = priv.replace(/-----BEGIN [A-Z ]+-----(?!\n)/g, '$&\n').replace(/(?<!\n)-----END [A-Z ]+-----/g, '\n$&');
    let kt = (slot.keyType || 'auto').toString().trim().toUpperCase();
    if (kt !== 'PKCS1' && kt !== 'PKCS8') {
      kt = priv.includes('BEGIN PRIVATE KEY') && !priv.includes('BEGIN RSA PRIVATE KEY') ? 'PKCS8' : 'PKCS1';
    }
    out.appId = appId;
    out.privateKey = priv;
    out.alipayPublicKey = pub;
    out.keyType = kt;
  }
  return out;
}

app.post('/api/groups', requireAuth, (req, res) => {
  const groupName = (req.body.groupName || '').trim();
  const groupPhone = (req.body.phone || '').trim();
  const slots = Array.isArray(req.body.slots) ? req.body.slots : [];
  if (!groupName) return res.json({ code: 'FAIL', message: '请输入多通道组名称' });
  if (!/^1\d{10}$/.test(groupPhone)) return res.json({ code: 'FAIL', message: '请输入有效的 11 位登录手机号' });
  if (slots.length < 2) return res.json({ code: 'FAIL', message: '多通道进件至少需要 2 个商户' });

  // 校验 + 规范化
  const built = [];
  for (let i = 0; i < slots.length; i++) {
    try {
      built.push(buildGroupSlot(slots[i], groupPhone));
    } catch (e) {
      return res.json({ code: 'FAIL', message: `第 ${i + 1} 个商户: ${e.message}` });
    }
  }

  // 写入底层 merchants.json（每个 slot 作为一个独立 merchant 实体）
  const merchantList = loadMerchants();
  const groupId = genGroupId();
  const now = new Date().toISOString();
  const subMerchants = [];
  for (let i = 0; i < built.length; i++) {
    const slot = built[i];
    const mid = genId();
    const fname = genFileName();
    const merchant = {
      id: mid,
      type: slot.type,
      merchantName: slot.merchantName + '·槽' + (i + 1),
      phone: slot.phone,
      password: slot.password,
      fileName: fname,
      createdAt: now,
      merchantUrl: '',
      groupId: groupId,
      groupSlot: i,
    };
    if (slot.alipayUid) merchant.alipayUid = slot.alipayUid;
    if (slot.appId) {
      merchant.appId = slot.appId;
      merchant.privateKey = slot.privateKey;
      merchant.alipayPublicKey = slot.alipayPublicKey;
      merchant.keyType = slot.keyType;
    }
    // 尝试生成 ZIP（不影响创建）
    try {
      let zipBuf;
      if (slot.type === 'uid' || slot.type === 'uid-simple') {
        zipBuf = generateUidMerchantZip({
          alipayUid: slot.alipayUid, merchantName: slot.merchantName,
          merchantPhone: slot.phone, merchantPassword: 'yy123456', type: slot.type,
        });
      } else if (slot.type === 'face2face-dynamic') {
        zipBuf = generateFaceDynamicMerchantZip({
          appId: slot.appId, privateKey: slot.privateKey, alipayPublicKey: slot.alipayPublicKey,
          keyType: slot.keyType, merchantName: slot.merchantName,
          merchantPhone: slot.phone, merchantPassword: 'yy123456', merchantType: slot.type,
        });
      } else {
        zipBuf = generateMerchantZip({
          appId: slot.appId, privateKey: slot.privateKey, alipayPublicKey: slot.alipayPublicKey,
          keyType: slot.keyType, merchantName: slot.merchantName,
          merchantPhone: slot.phone, merchantPassword: 'yy123456', merchantType: slot.type,
        });
      }
      fs.writeFileSync(path.join(DATA_DIR, `${fname}.zip`), zipBuf);
      merchant.zipGenerated = true;
    } catch (e) {
      merchant.zipGenerated = false;
      merchant.zipError = e.message;
    }
    merchantList.push(merchant);
    subMerchants.push(merchant);
    getMerchantRuntime(mid, merchant);
  }
  saveMerchants(merchantList);

  // 创建 group
  const group = {
    id: groupId,
    name: groupName,
    phone: groupPhone,
    merchants: subMerchants.map(m => ({
      id: m.id, slotIndex: m.groupSlot, type: m.type,
      merchantName: m.merchantName, phone: m.phone, enabled: m.enabled !== false,
      fileName: m.fileName, alipayUid: m.alipayUid || '', appId: m.appId ? m.appId.slice(0,4)+'***' : '',
    })),
    createdAt: now,
  };
  const groups = loadGroups();
  groups.push(group);
  saveGroups(groups);
  getGroupRuntime(group);

  console.log(`[GROUP:${groupId}] 创建多通道组「${groupName}」含 ${subMerchants.length} 个商户`);
  res.json({ code: 'OK', data: group, message: '多通道组创建成功' });
});

app.get('/api/groups', requireAuth, (req, res) => {
  const groups = loadGroups().map(g => {
    const rt = groupRuntimes.get(g.id);
    return {
      ...g,
      nextIndex: rt ? rt.nextIndex : 0,
      roundCount: rt ? rt.roundCount : 0,
    };
  });
  res.json({ code: 'OK', data: groups });
});

app.get('/api/groups/:id', requireAuth, (req, res) => {
  const groups = loadGroups();
  const g = groups.find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ code: 'FAIL', message: '组不存在' });
  const rt = groupRuntimes.get(g.id);
  res.json({
    code: 'OK',
    data: {
      ...g,
      nextIndex: rt ? rt.nextIndex : 0,
      roundCount: rt ? rt.roundCount : 0,
    },
  });
});

app.delete('/api/groups/:id', requireAuth, (req, res) => {
  const groups = loadGroups();
  const idx = groups.findIndex(g => g.id === req.params.id);
  if (idx === -1) return res.status(404).json({ code: 'FAIL', message: '组不存在' });
  // 级联删除底层商户
  const group = groups[idx];
  const merchantList = loadMerchants();
  const slotIds = new Set((group.merchants || []).map(m => m.id));
  for (const sid of slotIds) {
    const mIdx = merchantList.findIndex(m => m.id === sid);
    if (mIdx !== -1) {
      const m = merchantList[mIdx];
      try { if (m.fileName) { const zp = path.join(DATA_DIR, `${m.fileName}.zip`); if (fs.existsSync(zp)) fs.unlinkSync(zp); } } catch (e) {}
      merchantList.splice(mIdx, 1);
      merchantRuntimes.delete(sid);
    }
  }
  saveMerchants(merchantList);
  groups.splice(idx, 1);
  saveGroups(groups);
  groupRuntimes.delete(req.params.id);
  res.json({ code: 'OK', message: '多通道组已删除' });
});

// 槽位启用/禁用
app.put('/api/groups/:id/slots/:slotId/toggle', requireAuth, (req, res) => {
  const groups = loadGroups();
  const g = groups.find(x => x.id === req.params.id);
  if (!g) return res.status(404).json({ code: 'FAIL', message: '组不存在' });
  const slot = g.merchants.find(m => m.id === req.params.slotId);
  if (!slot) return res.status(404).json({ code: 'FAIL', message: '槽位不存在' });
  slot.enabled = req.body.enabled !== false;
  // 同步到 merchants.json
  const merchantList = loadMerchants();
  const m = merchantList.find(x => x.id === slot.id);
  if (m) { m.enabled = slot.enabled; saveMerchants(merchantList); }
  saveGroups(groups);
  res.json({ code: 'OK', data: { enabled: slot.enabled } });
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
    // UID 模板包含 pay/index.html 支付跳转页
    const payHtml = (merchant.type === 'uid' || merchant.type === 'uid-simple')
      ? fs.readFileSync(path.join(UID_TEMPLATE_DIR, 'pay', 'index.html'), 'utf-8')
      : null;

    const config = {
      appId: merchant.appId || '',
      privateKey: merchant.privateKey || '',
      alipayPublicKey: merchant.alipayPublicKey || '',
      keyType: merchant.keyType || 'PKCS8',
      merchantName: merchant.merchantName || '',
      merchantPhone: merchant.phone || '',
      merchantPassword: 'yy123456',
      merchantType: merchant.type || 'face2face',
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
    // UID 模板额外上传 pay/index.html
    if (payHtml) {
      files.push({ path: 'pay/index.html', content: payHtml });
    }

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

// ======================== 多通道组（轮询收款）路由 ========================

// 组中间件：加载组信息 + 找到每个 slot 的底层 merchant
app.use('/g/:groupId', (req, res, next) => {
  const groups = loadGroups();
  const group = groups.find(g => g.id === req.params.groupId);
  if (!group) return res.status(404).send('多通道组不存在');
  // 重新挂载最新的底层 merchant 信息（确保 enabled/限额的最新值生效）
  const allMerchants = loadMerchants();
  const enrichedMerchants = (group.merchants || []).map(s => {
    const m = allMerchants.find(x => x.id === s.id);
    if (m) {
      return { ...s, _merchant: m, _runtime: getMerchantRuntime(m.id, m) };
    }
    return { ...s, _merchant: null, _runtime: null };
  });
  req.group = group;
  req.groupMerchants = enrichedMerchants;
  next();
});

// 静态文件（cashier.html / admin.html / logo / login）按 slot[0] 的类型选模板目录
app.use('/g/:groupId', (req, res, next) => {
  if (req.path.match(/\.(js|css|png|jpg|svg|ico|json|html)$/) || req.path === '/') {
    const firstSlot = (req.groupMerchants || []).find(s => s._merchant);
    if (!firstSlot) return res.status(404).send('组无可用商户');
    const templateDir = (firstSlot.type === 'uid' || firstSlot.type === 'uid-simple') ? UID_TEMPLATE_DIR : TEMPLATE_DIR;
    return express.static(templateDir)(req, res, next);
  }
  next();
});

// 公共：组信息（给收银台前端展示）
app.get('/g/:groupId/api/group-info', (req, res) => {
  const slots = (req.groupMerchants || []).map(s => ({
    id: s.id, type: s.type, merchantName: s._merchant ? s._merchant.merchantName : s.merchantName,
    phone: s._merchant ? s._merchant.phone : s.phone, enabled: s.enabled !== false,
  }));
  res.json({
    code: 'OK',
    data: {
      id: req.group.id,
      name: req.group.name,
      slots,
      slotCount: slots.length,
    }
  });
});

// 公共：组限额（取每个 slot 限额的最大值，再按 mgr-limits 与单笔限额合并）
app.get('/g/:groupId/api/limits', (req, res) => {
  // 取所有 slot 的最严格限额：min 取最大，max 取最小
  let min = null, max = null;
  for (const s of req.groupMerchants) {
    if (!s._runtime) continue;
    const l = s._runtime.limits || {};
    const m = s._merchant || {};
    const candidates = [];
    if (l.minAmount !== null && l.minAmount !== undefined && l.minAmount !== '') candidates.push(parseFloat(l.minAmount));
    if (m.mgrMinAmount !== null && m.mgrMinAmount !== undefined) candidates.push(parseFloat(m.mgrMinAmount));
    const lm = candidates.length ? Math.max(...candidates) : null;
    if (lm !== null && (min === null || lm > min)) min = lm;

    const candidatesMax = [];
    if (l.maxAmount !== null && l.maxAmount !== undefined && l.maxAmount !== '') candidatesMax.push(parseFloat(l.maxAmount));
    if (m.mgrMaxAmount !== null && m.mgrMaxAmount !== undefined) candidatesMax.push(parseFloat(m.mgrMaxAmount));
    const lx = candidatesMax.length ? Math.min(...candidatesMax) : null;
    if (lx !== null && (max === null || lx < max)) max = lx;
  }
  res.json({ code: 'OK', success: true, config: { minAmount: min, maxAmount: max, dayCount: null, dayAmount: null, monthCount: null, monthAmount: null } });
});

// 公共：组配置（cashier.html 读取）
app.get('/g/:groupId/api/config', (req, res) => {
  const first = (req.groupMerchants || []).find(s => s._merchant);
  const m = first ? first._merchant : null;
  const rt = first ? first._runtime : null;
  res.json({
    code: 'OK',
    data: {
      groupId: req.group.id,
      groupName: req.group.name,
      slotCount: (req.groupMerchants || []).length,
      merchantName: req.group.name,
      type: m ? (m.type === 'face' ? 'face2face' : m.type) : 'face2face',
      enabled: true,
    }
  });
});

// 组级登录（用组手机号 + 默认密码 yy123456）
app.post('/g/:groupId/api/login', express.json(), (req, res) => {
  const { phone, password } = req.body;
  const groupPhone = (req.group.phone || '').trim();
  if (!phone || phone.trim() !== groupPhone) {
    return res.status(400).json({ code: 'FAIL', message: '手机号或密码错误' });
  }
  if (!password || password !== 'yy123456') {
    return res.status(400).json({ code: 'FAIL', message: '手机号或密码错误' });
  }
  const token = crypto.randomBytes(16).toString('hex');
  // 使用第一个可用 slot 的 runtime 来存储 session
  const first = (req.groupMerchants || []).find(s => s._merchant && s._runtime);
  if (first && first._runtime) {
    first._runtime.sessions = first._runtime.sessions || new Map();
    first._runtime.sessions.set(token, { createdAt: Date.now() });
  }
  res.json({ code: 'OK', token, message: '登录成功' });
});

// 组级登录状态检查
app.post('/g/:groupId/api/login/check', express.json(), (req, res) => {
  const token = (req.headers.authorization || req.body.token || '').replace(/^Bearer\s+/, '').trim();
  const first = (req.groupMerchants || []).find(s => s._merchant && s._runtime);
  let valid = false;
  if (first && first._runtime && first._runtime.sessions) {
    const session = first._runtime.sessions.get(token);
    valid = !!(session && Date.now() - session.createdAt < 24 * 60 * 60 * 1000);
  }
  res.json({ code: 'OK', loggedIn: valid });
});

// 组级 API 代理：未匹配的 /api/* 请求转发到第一个可用 slot 商户
app.use('/g/:groupId/api', (req, res, next) => {
  // 跳过已定义的组级 API
  if (req.path === '/group-info' || req.path === '/limits' || req.path === '/config' ||
      req.path === '/login' || req.path === '/login/check') {
    return next();
  }
  const first = (req.groupMerchants || []).find(s => s._merchant);
  if (!first) return res.status(404).json({ code: 'FAIL', message: '组无可用商户' });
  // 转发到底层商户的对应 API
  const subPath = req.path.replace(/^\//, '');
  proxyToMerchant(req, res, first._merchant.id, 'api/' + subPath);
});

// 公共：组收银台 — 生成收款码（轮询选下一个 slot）
app.post('/g/:groupId/cashier/qrcode', express.json(), async (req, res) => {
  const amount = String(req.body.amount || '').trim();
  const subject = String(req.body.subject || '收款').trim();
  const body = String(req.body.body || subject).trim();
  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ code: 'ERROR', message: '请输入有效金额' });
  }
  const amtNum = parseFloat(amount);

  // 选下一个可用 slot
  const picked = pickNextGroupMerchant({ id: req.group.id, merchants: req.groupMerchants.filter(s => s._merchant) });
  if (!picked) return res.status(400).json({ code: 'ERROR', message: '组内没有可用商户，请先启用至少一个槽位' });
  const slotMerchant = picked.merchant._merchant;
  const slotRt = picked.merchant._runtime;
  const slotIndex = picked.slotIndex;

  // 限额检查
  const mgrMin = slotMerchant.mgrMinAmount !== null && slotMerchant.mgrMinAmount !== undefined ? parseFloat(slotMerchant.mgrMinAmount) : null;
  const mgrMax = slotMerchant.mgrMaxAmount !== null && slotMerchant.mgrMaxAmount !== undefined ? parseFloat(slotMerchant.mgrMaxAmount) : null;
  const localMin = slotRt.limits.minAmount !== null && slotRt.limits.minAmount !== undefined && slotRt.limits.minAmount !== '' ? parseFloat(slotRt.limits.minAmount) : null;
  const localMax = slotRt.limits.maxAmount !== null && slotRt.limits.maxAmount !== undefined && slotRt.limits.maxAmount !== '' ? parseFloat(slotRt.limits.maxAmount) : null;
  const finalMin = (mgrMin !== null && localMin !== null) ? Math.max(mgrMin, localMin) : (mgrMin !== null ? mgrMin : localMin);
  const finalMax = (mgrMax !== null && localMax !== null) ? Math.min(mgrMax, localMax) : (mgrMax !== null ? mgrMax : localMax);
  if (finalMin !== null && !isNaN(finalMin) && amtNum < finalMin) {
    return res.status(400).json({ code: 'ERROR', message: `单笔金额不能低于 ¥${finalMin.toFixed(2)}（槽 ${slotIndex + 1}）` });
  }
  if (finalMax !== null && !isNaN(finalMax) && amtNum > finalMax) {
    return res.status(400).json({ code: 'ERROR', message: `单笔金额不能超过 ¥${finalMax.toFixed(2)}（槽 ${slotIndex + 1}）` });
  }

  // 关键：复用底层 merchant 的 cashier 逻辑（不重新实现 QR/订单生成）
  // 我们伪造一个 req 对象让现有 handler 重用。
  // 简化：直接用底层 merchant 的 runtime 调同样的代码逻辑。
  // 这里直接调原 handler 的内联实现以保证 100% 兼容。
  const outTradeNo = `QR_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const m = slotMerchant;
  const rt = slotRt;

  // UID 模式（含 SDK 时走 trade.precreate；否则走个人转账链接）
  if (m.type === 'uid' || m.type === 'uid-simple') {
    if (rt.alipaySdk) {
      try {
        const result = await rt.alipaySdk.exec('alipay.trade.precreate', {
          bizContent: { out_trade_no: outTradeNo, total_amount: amtNum.toFixed(2), subject, body, timeout_express: '30m' },
        });
        const resp = result.alipay_trade_precreate_response || result;
        const tradeQrCode = resp.qrCode || resp.qr_code;
        if (resp.code === '10000' && tradeQrCode) {
          rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode: tradeQrCode, status: 'waiting', createdAt: Date.now(), groupId: req.group.id, slotIndex });
          setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);
          rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null, payerIp: getClientIp(req), useTradeApi: true, groupId: req.group.id, slotIndex });
          saveMerchantFile(m.id, 'orders', rt.orders);
          let qrDataUrl = '';
          try { qrDataUrl = await QRCode.toDataURL(tradeQrCode, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } }); } catch (e) {}
          if (m.type === 'uid-simple') {
            return res.json({ code: 'OK', out_trade_no: outTradeNo, qr_code: tradeQrCode, qr_image: '', amount, subject, use_api: true, use_direct_redirect: true, message: '正在跳转支付宝...', slot_index: slotIndex });
          }
          return res.json({ code: 'OK', out_trade_no: outTradeNo, qr_code: tradeQrCode, qr_image: qrDataUrl, amount, subject, use_api: true, message: '收款码已生成（自动确认模式）', slot_index: slotIndex });
        }
      } catch (e) { /* fallthrough */ }
    }
    // 个人转账链接（仅标准 UID）
    if (m.type === 'uid-simple') {
      const alipaysUrl = `alipays://platformapi/startapp?appId=20000674&actionType=scan&biz_data=${encodeURIComponent(JSON.stringify({ s: 'money', u: m.alipayUid, a: amtNum.toFixed(2), m: subject }))}`;
      rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode: alipaysUrl, status: 'waiting', createdAt: Date.now(), groupId: req.group.id, slotIndex });
      setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);
      rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null, payerIp: getClientIp(req), useTradeApi: false, groupId: req.group.id, slotIndex });
      saveMerchantFile(m.id, 'orders', rt.orders);
      return res.json({ code: 'OK', out_trade_no: outTradeNo, qr_code: alipaysUrl, qr_image: '', amount, subject, use_api: false, use_direct_redirect: true, message: '正在跳转支付宝...', slot_index: slotIndex });
    }
    // UID 标准模式生成二维码（用本机 base_url 走 /m/:slotMerchantId/pay/）
    const alipaysUrl = `alipays://platformapi/startapp?appId=20000674&actionType=scan&biz_data=${encodeURIComponent(JSON.stringify({ s: 'money', u: m.alipayUid, a: amtNum.toFixed(2), m: subject }))}`;
    const frontendBaseUrl = req.body.base_url || '';
    const effectiveBaseUrl = frontendBaseUrl ? (frontendBaseUrl.replace(/\/$/, '') + '/') : '';
    let qrContent = alipaysUrl;
    if (effectiveBaseUrl) {
      qrContent = `${effectiveBaseUrl}m/${m.id}/pay/?order=${outTradeNo}&amount=${amtNum.toFixed(2)}&uid=${m.alipayUid}&memo=${encodeURIComponent(subject)}`;
    }
    let qrDataUrl = '';
    try { qrDataUrl = await QRCode.toDataURL(qrContent, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } }); } catch (e) {}
    rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode: qrContent, status: 'waiting', createdAt: Date.now(), groupId: req.group.id, slotIndex });
    setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);
    rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null, payerIp: getClientIp(req), useTradeApi: false, groupId: req.group.id, slotIndex });
    saveMerchantFile(m.id, 'orders', rt.orders);
    return res.json({ code: 'OK', out_trade_no: outTradeNo, qr_code: qrContent, qr_image: qrDataUrl, amount, subject, use_api: false, message: effectiveBaseUrl ? '请使用支付宝扫码转账' : '⚠️ 未配置跳转地址，二维码可能被支付宝拦截', slot_index: slotIndex });
  }

  // 当面付
  if (!rt.alipaySdk) {
    return res.status(500).json({ code: 'SDK_ERROR', message: '槽 ' + (slotIndex + 1) + ' SDK未初始化', detail: rt.alipaySdkError || '缺少 appId/privateKey' });
  }
  try {
    const result = await rt.alipaySdk.exec('alipay.trade.precreate', {
      bizContent: { out_trade_no: outTradeNo, total_amount: amtNum.toFixed(2), subject, body, timeout_express: '30m' },
    });
    const resp = result.alipay_trade_precreate_response || result;
    const qrCode = resp.qrCode || resp.qr_code;
    if (resp.code === '10000' && qrCode) {
      rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode, status: 'waiting', createdAt: Date.now(), groupId: req.group.id, slotIndex });
      setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);
      rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null, payerIp: getClientIp(req), groupId: req.group.id, slotIndex });
      saveMerchantFile(m.id, 'orders', rt.orders);
      let qrDataUrl = '';
      try { qrDataUrl = await QRCode.toDataURL(qrCode, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } }); } catch (e) {}
      return res.json({ code: 'OK', out_trade_no: outTradeNo, qr_code: qrCode, qr_image: qrDataUrl, amount, subject, message: '收款码已生成', slot_index: slotIndex });
    }
    return res.status(500).json({ code: 'ALIPAY_ERROR', message: '支付宝接口错误', detail: JSON.stringify({ code: resp.code, sub_code: resp.subCode || resp.sub_code, msg: resp.msg }) });
  } catch (err) {
    return res.status(500).json({ code: 'ERROR', message: '支付服务异常: ' + err.message });
  }
});

// 公共：组收银台 — 订单状态查询（路由到对应 slot，通过内部 HTTP 转发）
app.get('/g/:groupId/cashier/check', (req, res) => {
  const outTradeNo = (req.query.out_trade_no || '').trim();
  if (!outTradeNo) return res.status(400).json({ code: 'ERROR', message: '缺少 out_trade_no' });
  for (const s of req.groupMerchants) {
    if (!s._runtime) continue;
    if (s._runtime.orders.find(o => o.outTradeNo === outTradeNo)) {
      return proxyToMerchant(req, res, s._merchant.id, 'cashier/check');
    }
  }
  return res.json({ code: 'OK', status: 'waiting', message: '订单不存在或已被清理' });
});

// 公共：组收银台 — 异步通知（路由到对应 slot）
app.post('/g/:groupId/cashier/notify', (req, res) => {
  const outTradeNo = req.body.out_trade_no;
  for (const s of req.groupMerchants) {
    if (!s._runtime) continue;
    if (s._runtime.orders.find(o => o.outTradeNo === outTradeNo)) {
      return proxyToMerchant(req, res, s._merchant.id, 'cashier/notify', 'POST');
    }
  }
  res.send('success');
});

// 公共：组收银台 — 用户报告支付完成
app.post('/g/:groupId/cashier/report-paid', (req, res) => {
  const outTradeNo = (req.body.outTradeNo || '').trim();
  if (!outTradeNo) return res.status(400).json({ code: 'ERROR', message: '缺少订单号' });
  for (const s of req.groupMerchants) {
    if (!s._runtime) continue;
    if (s._runtime.orders.find(o => o.outTradeNo === outTradeNo)) {
      return proxyToMerchant(req, res, s._merchant.id, 'cashier/report-paid', 'POST');
    }
  }
  return res.json({ code: 'OK', message: '订单不存在' });
});

// 公共：组收银台 — 手动确认到账
app.post('/g/:groupId/cashier/confirm', (req, res) => {
  const outTradeNo = (req.body.outTradeNo || '').trim();
  if (!outTradeNo) return res.status(400).json({ code: 'ERROR', message: '缺少订单号' });
  for (const s of req.groupMerchants) {
    if (!s._runtime) continue;
    if (s._runtime.orders.find(o => o.outTradeNo === outTradeNo)) {
      return proxyToMerchant(req, res, s._merchant.id, 'cashier/confirm', 'POST');
    }
  }
  return res.json({ code: 'OK', message: '订单不存在' });
});

// 内部 HTTP 转发：把请求原样转发到 /m/:id/...
function proxyToMerchant(req, res, merchantId, subPath, method) {
  if (!method) method = req.method;
  const lib = (req.protocol || 'http').startsWith('https') ? require('https') : require('http');
  const port = req.socket ? req.socket.localPort : PORT;
  const headers = Object.assign({}, req.headers, { host: 'localhost:' + port });
  delete headers['content-length']; // 让 req 重新计算
  // 保留 query string（GET 请求的 ?xxx=yyy）
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const opts = {
    hostname: '127.0.0.1',
    port: port,
    path: '/m/' + merchantId + '/' + subPath + search,
    method: method,
    headers: headers,
  };
  const proxyReq = lib.request(opts, (proxyRes) => {
    res.status(proxyRes.statusCode || 200);
    if (proxyRes.headers['content-type']) res.setHeader('content-type', proxyRes.headers['content-type']);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    console.error('[proxy] 转发到 /m/' + merchantId + '/' + subPath + ' 失败:', e.message);
    if (!res.headersSent) res.status(502).json({ code: 'PROXY_ERR', message: '内部转发失败: ' + e.message });
  });
  if (req.body && method !== 'GET' && method !== 'HEAD') {
    const body = (typeof req.body === 'string') ? req.body : JSON.stringify(req.body);
    proxyReq.setHeader('content-length', Buffer.byteLength(body));
    proxyReq.write(body);
  }
  proxyReq.end();
}

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

// 支付跳转页：统一由 pay/index.html 静态页面处理
// 页内 JavaScript 负责 alipays:// 跳转 + 用户返回时回传支付完成通知
app.get('/m/:id/pay', (req, res, next) => {
  next();
});
app.get('/m/:id/pay/', (req, res, next) => {
  next();
});

// 商户静态文件（根据类型选择模板目录）
app.use('/m/:id', (req, res, next) => {
  const templateDir = (req.merchant.type === 'uid' || req.merchant.type === 'uid-simple') ? UID_TEMPLATE_DIR : TEMPLATE_DIR;
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

  // 商户收款开关检查
  if (m.enabled === false) {
    return res.status(403).json({ code: 'ERROR', message: '该商户已关闭收款功能，请联系管理员开启' });
  }

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ code: 'ERROR', message: '请输入有效金额' });
  }

  // 限额检查：管理系统的限额优先于收款后台设置的限额
  const amtNum = parseFloat(amount);

  // 管理系统级限额（优先级最高）
  const mgrMin = m.mgrMinAmount !== undefined && m.mgrMinAmount !== null ? parseFloat(m.mgrMinAmount) : null;
  const mgrMax = m.mgrMaxAmount !== undefined && m.mgrMaxAmount !== null ? parseFloat(m.mgrMaxAmount) : null;

  // 收款后台设置的限额
  const limits = rt.limits;
  const localMin = limits.minAmount !== null && limits.minAmount !== undefined && limits.minAmount !== '' ? parseFloat(limits.minAmount) : null;
  const localMax = limits.maxAmount !== null && limits.maxAmount !== undefined && limits.maxAmount !== '' ? parseFloat(limits.maxAmount) : null;

  // 合并：管理系统限额优先（取更严格的值）
  const effectiveMin = mgrMin !== null ? mgrMin : localMin;
  const effectiveMax = mgrMax !== null ? mgrMax : localMax;

  // 如果两个都设置了，取更严格的（min 取更大的，max 取更小的）
  const finalMin = (mgrMin !== null && localMin !== null) ? Math.max(mgrMin, localMin) : effectiveMin;
  const finalMax = (mgrMax !== null && localMax !== null) ? Math.min(mgrMax, localMax) : effectiveMax;

  if (finalMin !== null && !isNaN(finalMin) && amtNum < finalMin) {
    return res.status(400).json({ code: 'ERROR', message: `单笔金额不能低于 ¥${finalMin.toFixed(2)}` });
  }
  if (finalMax !== null && !isNaN(finalMax) && amtNum > finalMax) {
    return res.status(400).json({ code: 'ERROR', message: `单笔金额不能超过 ¥${finalMax.toFixed(2)}` });
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

    // 如果 UID 商户配置了支付宝应用凭证（有 alipaySdk），使用当面付 API 创建正式交易订单
    // 这样 trade.query 可以实时查询支付状态，实现秒级自动确认
    if (rt.alipaySdk) {
      try {
        const result = await rt.alipaySdk.exec('alipay.trade.precreate', {
          bizContent: { out_trade_no: outTradeNo, total_amount: amtNum.toFixed(2), subject, body, timeout_express: '30m' },
        });
        const resp = result.alipay_trade_precreate_response || result;
        const tradeQrCode = resp.qrCode || resp.qr_code;

        if (resp.code === '10000' && tradeQrCode) {
          rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode: tradeQrCode, status: 'waiting', createdAt: Date.now() });
          setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

          rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null, payerIp: getClientIp(req), useTradeApi: true });
          saveMerchantFile(m.id, 'orders', rt.orders);

          let qrDataUrl = '';
          try { qrDataUrl = await QRCode.toDataURL(tradeQrCode, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } }); } catch (e) {}

          if (m.type === 'uid-simple') {
            return res.json({
              code: 'OK', out_trade_no: outTradeNo, qr_code: tradeQrCode, qr_image: '',
              amount, subject, use_api: true,
              use_direct_redirect: true,
              message: '正在跳转支付宝...',
            });
          }

          return res.json({ code: 'OK', out_trade_no: outTradeNo, qr_code: tradeQrCode, qr_image: qrDataUrl, amount, subject, use_api: true, message: '收款码已生成（自动确认模式）' });
        } else {
          // trade.precreate 失败，回退到个人转账模式
          console.log('[UID+SDK] trade.precreate 失败，回退到个人转账: ' + JSON.stringify({ code: resp.code, msg: resp.msg || resp.sub_msg }));
        }
      } catch (err) {
        // trade.precreate 异常，回退到个人转账模式
        console.log('[UID+SDK] trade.precreate 异常，回退到个人转账: ' + err.message);
      }
    }

    // 无 SDK 或 trade.precreate 失败：使用个人转账 URL（需手动确认到账）
    const alipaysUrl = `alipays://platformapi/startapp?appId=20000674&actionType=scan&biz_data=${encodeURIComponent(JSON.stringify({ s: 'money', u: m.alipayUid, a: amtNum.toFixed(2), m: subject }))}`;

    if (m.type === 'uid-simple') {
      // UID 简易支付: 直接返回 alipays:// 链接，前端直接跳转，不生成二维码
      rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode: alipaysUrl, status: 'waiting', createdAt: Date.now() });
      setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

      rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null, payerIp: getClientIp(req), useTradeApi: false });
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
      qrContent = `${effectiveBaseUrl}m/${m.id}/pay/?order=${outTradeNo}&amount=${amtNum.toFixed(2)}&uid=${m.alipayUid}&memo=${encodeURIComponent(subject)}`;
    }

    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(qrContent, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    } catch (qrErr) { console.error('二维码生成失败:', qrErr.message); }

    rt.cashierOrders.set(outTradeNo, { amount, subject, body, qrCode: qrContent, status: 'waiting', createdAt: Date.now() });
    setTimeout(() => rt.cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

    rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null, payerIp: getClientIp(req), useTradeApi: false });
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

      rt.orders.push({ outTradeNo, amount: amtNum.toFixed(2), subject, status: 'generated', createdAt: new Date().toISOString(), paidAt: null, payerIp: getClientIp(req) });
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

  if (m.type === 'uid' || m.type === 'uid-simple') {
    // UID商户有SDK且订单用trade API创建 → 实时查询支付宝
    if (rt.alipaySdk && adminOrder.useTradeApi) {
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
            adminOrder.autoConfirmed = true;
            adminOrder.confirmMethod = 'trade_query';
            saveMerchantFile(m.id, 'orders', rt.orders);
            const cOrder = rt.cashierOrders.get(outTradeNo) || {};
            cOrder.status = 'paid'; cOrder.tradeNo = tradeNo;
            rt.cashierOrders.set(outTradeNo, cOrder);
            // 停止自动确认任务（如果正在运行）
            if (autoConfirmJobs.has(outTradeNo)) autoConfirmJobs.delete(outTradeNo);
            return res.json({ code: 'OK', status: 'paid', trade_no: tradeNo, amount: adminOrder.amount });
          }
          // 首次查询到，更新为"支付中"
          if (adminOrder.status === 'generated') {
            adminOrder.status = 'paying';
            saveMerchantFile(m.id, 'orders', rt.orders);
          }
          return res.json({ code: 'OK', status: 'waiting', trade_status: tradeStatus });
        }
        // 订单不存在（TRADE_NOT_EXIST），可能是还没在支付宝创建
        return res.json({ code: 'OK', status: adminOrder.status === 'generated' ? 'waiting' : adminOrder.status });
      } catch (err) {
        // trade.query 异常，回退到本地状态查询
        console.log('[UID+SDK] check trade.query异常: ' + err.message);
      }
    }

    // 用户已报告支付完成（从支付宝返回），待确认
    if (adminOrder.status === 'pending_confirm') {
      var job = autoConfirmJobs.get(outTradeNo);
      return res.json({ code: 'OK', status: 'pending_confirm', amount: adminOrder.amount, auto_confirming: !!job, phase: job ? job.phase : 0 });
    }
    // 首次查询到，更新为"支付中"
    if (adminOrder.status === 'generated') {
      adminOrder.status = 'paying';
      saveMerchantFile(m.id, 'orders', rt.orders);
    }
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

// UID 客户端报告支付完成（用户从支付宝返回时触发）
app.post('/m/:id/cashier/report-paid', express.json(), async (req, res) => {
  const m = req.merchant;
  const rt = req.runtime;
  const { outTradeNo } = req.body;
  if (!outTradeNo) return res.status(400).json({ code: 'ERROR', message: '缺少订单号' });

  const order = rt.orders.find(o => o.outTradeNo === outTradeNo);
  if (!order) return res.status(404).json({ code: 'ERROR', message: '订单不存在' });

  // 已支付或已退款的订单不再更新
  if (['paid', 'confirmed', 'refunded', 'partial_refund'].includes(order.status)) {
    return res.json({ code: 'OK', message: '订单已处理', status: order.status });
  }

  // 标记为"待确认到账"（用户已从支付宝返回，可能已完成支付）
  if (['generated', 'paying', 'waiting'].includes(order.status)) {
    order.status = 'pending_confirm';
    order.reportedAt = new Date().toISOString();
    saveMerchantFile(m.id, 'orders', rt.orders);
    console.log(`>>> [UID] 用户报告支付完成（待确认）: ${outTradeNo}, 金额: ¥${order.amount}`);

    // 如果商户有支付宝SDK，启动自动确认（交易查询+账单兜底）
    if (rt.alipaySdk) {
      startAutoConfirm(m.id, rt, order);
    }
  }

  res.json({ code: 'OK', message: '已收到支付报告', status: order.status });
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
      type: req.merchant.type || 'face',
      alipayUid: req.merchant.alipayUid || '',
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
  const rt = req.runtime;
  const uidMasked = m.alipayUid ? m.alipayUid.slice(0, 4) + '****' + m.alipayUid.slice(-4) : '未配置';
  res.json({
    code: 'OK',
    data: {
      alipayUid: uidMasked,
      hasUid: !!m.alipayUid,
      hasPaymentApi: !!rt.alipaySdk,
      hasSdk: !!rt.alipaySdk,
      useTradeApi: (m.type === 'uid' || m.type === 'uid-simple') && !!rt.alipaySdk,
      merchantName: m.merchantName || '未配置',
      type: (m.type === 'face' ? 'face2face' : (m.type || 'face2face')),
      uid: m.alipayUid || '',
      enabled: m.enabled !== false, // 默认 true
      mgrMinAmount: m.mgrMinAmount !== undefined ? m.mgrMinAmount : null,
      mgrMaxAmount: m.mgrMaxAmount !== undefined ? m.mgrMaxAmount : null,
    }
  });
});

// ======================== 启动服务 ========================

// 管理端静态文件
app.use(express.static(path.join(__dirname, 'public')));

async function start() {
  await initDb();
  adminConfig = loadAdminConfig();

  // 预加载所有已有商户的运行时（在 initDb 恢复数据后执行）
  const existingMerchants = loadMerchants();
  for (const m of existingMerchants) {
    getMerchantRuntime(m.id, m);
  }

  // 预加载所有多通道组的运行时
  const existingGroups = loadGroups();
  for (const g of existingGroups) {
    getGroupRuntime(g);
  }

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
}

start();
