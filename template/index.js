/**
 * ============================================
 *  黑金PAY 收银台（支付宝加密支付）
 * ============================================
 *
 * 使用方式：
 *   1. npm install
 *   2. 填写下方 CONFIG 中的支付宝配置
 *   3. node index.js
 *   4. 打开浏览器访问 http://localhost:3001/cashier.html
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { AlipaySdk } = require('alipay-sdk');
const QRCode = require('qrcode');

// PostgreSQL 支持（Railway 部署时通过 DATABASE_URL 自动启用）
let pgPool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
  });
  console.log('>>> [DB] PostgreSQL 已启用');
}

const app = express();
const PORT = process.env.PORT || 3001;

// 静态文件服务
app.use(express.static(__dirname));

// 允许商户管理系统跨域调用登录 API
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ======================== 【配置区 — 请填入你的支付宝信息】 ========================

const CONFIG = {
  alipay: {
    // 支付宝应用ID（从开放平台获取）
    appId: '2021000123456789',

    // 应用私钥（整段粘贴，包含 BEGIN/END 行）
    // PKCS#8 格式开头：-----BEGIN PRIVATE KEY-----
    // PKCS#1 格式开头：-----BEGIN RSA PRIVATE KEY-----
    privateKey: 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDtest',

    // 支付宝公钥（整段粘贴，包含 BEGIN/END 行）
    alipayPublicKey: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest',

    // 支付宝网关（通常无需修改）
    gateway: 'https://openapi.alipay.com/gateway.do',

    // 私钥格式: PKCS1 / PKCS8（由商户管理系统注入）
    keyType: 'PKCS8',
  },

  // 支付宝商户名（由商户管理系统注入，用于后台默认显示）
  merchantName: '测试商户',

  // 商户登录手机号（由商户管理系统注入，用于后台登录验证）
  merchantPhone: '18888888888',

  // 商户登录密码（由商户管理系统注入，默认 yy123456）
  merchantPassword: 'yy123456',
};

// 允许登录的手机号集合（支持商户管理系统动态同步新增手机号）
const allowedPhones = new Set();
if (CONFIG.merchantPhone) {
  allowedPhones.add(CONFIG.merchantPhone.trim());
}

// 商户名称映射（phone -> { name, managerUrl }）
// 支持多商户共享一个收款后台实例时，按当前登录手机号隔离显示各自的商户名
const merchantNameMap = new Map();
if (CONFIG.merchantPhone && CONFIG.merchantName) {
  merchantNameMap.set(CONFIG.merchantPhone.trim(), {
    name: CONFIG.merchantName,
    managerUrl: ''
  });
}

// 从请求 token 获取当前登录手机号
function getSessionPhone(req) {
  const token = cleanToken(req.headers.authorization);
  const session = merchantSessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) {
    return session.phone || '';
  }
  return '';
}

// 获取指定手机号对应的商户名称，回退到全局配置
function getMerchantNameByPhone(phone) {
  const entry = phone ? merchantNameMap.get(phone.trim()) : null;
  return (entry && entry.name) || securityConfig.merchantName || CONFIG.merchantName || '';
}

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24小时
const merchantSessions = new Map(); // token -> { createdAt, phone }

// 商户密码哈希（与商户管理系统一致）
function hashMerchantPwd(pwd) {
  return crypto.createHash('sha256').update('heijin_pay_' + pwd + '_security_2024').digest('hex');
}

// 清理过期 token
function cleanToken(authHeader) {
  if (!authHeader) return '';
  return authHeader.replace(/^Bearer\s+/i, '').trim();
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of merchantSessions) {
    if (now - session.createdAt > SESSION_TTL) {
      merchantSessions.delete(token);
    }
  }
}
setInterval(cleanExpiredSessions, 10 * 60 * 1000); // 每10分钟清理一次

// ======================== 【创建支付宝客户端】 ========================

let alipaySdk = null;
let alipaySdkError = null;

function createAlipaySdk() {
  const cfg = CONFIG.alipay;
  // 规范化私钥：确保 PEM 头尾后有换行
  const rawKey = String(cfg.privateKey || '').trim();
  const normalizedKey = rawKey
    .replace(/-----BEGIN [A-Z ]+-----(?!\n)/g, '$&\n')
    .replace(/(?<!\n)-----END [A-Z ]+-----/g, '\n$&');

  const preferredKeyType = cfg.keyType || 'PKCS8';
  const altKeyType = preferredKeyType === 'PKCS8' ? 'PKCS1' : 'PKCS8';

  console.log(`>>> [支付宝] 初始化 SDK: appId=${cfg.appId}, keyType=${preferredKeyType}, keyLen=${normalizedKey.length}`);

  let lastError = null;
  for (const tryKeyType of [preferredKeyType, altKeyType]) {
    try {
      alipaySdk = new AlipaySdk({
        appId: cfg.appId,
        privateKey: normalizedKey,
        alipayPublicKey: cfg.alipayPublicKey,
        gateway: cfg.gateway,
        keyType: tryKeyType,
      });
      alipaySdkError = null;
      console.log(`>>> [支付宝] ✅ SDK 初始化成功 (keyType=${tryKeyType})`);
      return null;
    } catch (e) {
      lastError = e.message;
      console.warn(`>>> [支付宝] SDK(keyType=${tryKeyType}) 失败: ${e.message}`);
      alipaySdk = null;
    }
  }

  alipaySdkError = 'SDK 初始化失败（PKCS8+PKCS1 均已尝试）: ' + lastError + '。请检查：1) appId 是否正确；2) 私钥格式是否匹配 keyType；3) 支付宝公钥是否正确';
  console.error('>>> [支付宝] ' + alipaySdkError);
  return alipaySdkError;
}

createAlipaySdk();

// ======================== 【收银台 - 支付宝加密支付】 ========================

// 内存存储收银台订单（支付宝轮询用）
const cashierOrders = new Map();
// 收款后台订单记录（PostgreSQL 持久化，部署不丢数据）
const ORDERS_FILE = path.join(__dirname, 'orders.json');  // 本地开发用
let adminOrders = [];

// 从数据库/文件加载持久化订单
async function loadOrders() {
  if (pgPool) {
    // ===== PostgreSQL 模式（Railway 生产环境） =====
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS app_data (
          key VARCHAR(64) PRIMARY KEY,
          value JSONB
        )
      `);
      const result = await pgPool.query("SELECT value FROM app_data WHERE key = 'orders'");
      if (result.rows.length > 0) {
        adminOrders = result.rows[0].value;
        console.log(`>>> [DB] 已加载 ${adminOrders.length} 条历史订单`);
      } else {
        adminOrders = [];
        console.log('>>> [DB] 暂无历史订单，新数据库');
      }
    } catch (e) {
      console.error('>>> [DB] 加载失败:', e.message);
      adminOrders = [];
    }
  } else {
    // ===== 文件模式（本地开发） =====
    try {
      if (fs.existsSync(ORDERS_FILE)) {
        adminOrders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
        console.log(`>>> [文件] 已加载 ${adminOrders.length} 条历史订单`);
      } else {
        adminOrders = [];
        console.log('>>> [文件] 暂无历史订单');
      }
    } catch (e) {
      console.error('>>> [文件] 加载失败:', e.message);
      adminOrders = [];
    }
  }
}

// 保存订单到数据库/文件
async function saveOrders() {
  if (pgPool) {
    // ===== PostgreSQL 模式 =====
    try {
      await pgPool.query(`
        INSERT INTO app_data (key, value) VALUES ('orders', $1::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = $1::jsonb
      `, [JSON.stringify(adminOrders)]);
    } catch (e) {
      console.error('>>> [DB] 保存失败:', e.message);
    }
  } else {
    // ===== 文件模式 =====
    try {
      fs.writeFileSync(ORDERS_FILE, JSON.stringify(adminOrders, null, 2), 'utf-8');
    } catch (e) {
      console.error('>>> [文件] 保存失败:', e.message);
    }
  }
}

/**
 * POST /cashier/qrcode — 生成二维码供用户扫码支付
 * Body: { amount: string, subject: string, body?: string }
 */
app.post('/cashier/qrcode', express.json(), async (req, res) => {
  const amount = String(req.body.amount || '').trim();
  const subject = String(req.body.subject || '收款').trim();
  const body = String(req.body.body || subject).trim();

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ code: 'ERROR', message: '请输入有效金额' });
  }

  // SDK 未初始化检查
  if (!alipaySdk) {
    return res.status(500).json({
      code: 'SDK_ERROR',
      message: alipaySdkError || '支付宝 SDK 未初始化，请检查支付宝配置（appId/私钥/公钥/keyType）'
    });
  }

  const outTradeNo = `QR_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    console.log(`>>> [收银台] 生成收款码: ${outTradeNo}, 金额: ¥${amount}, 商品: ${subject}`);

    // 1. 调用 alipay.trade.precreate 生成预下单
    const result = await alipaySdk.exec('alipay.trade.precreate', {
      bizContent: {
        out_trade_no: outTradeNo,
        total_amount: parseFloat(amount).toFixed(2),
        subject,
        body,
        timeout_express: '30m',
      }
    });

    const resp = result.alipay_trade_precreate_response || result;
    // SDK 默认 camelcase: qr_code → qrCode
    const qrCode = resp.qrCode || resp.qr_code;

    console.log(`>>> [收银台] precreate 响应: code=${resp.code}, msg=${resp.msg}, qrCode=${qrCode}`);

    if (resp.code === '10000' && qrCode) {
      cashierOrders.set(outTradeNo, {
        amount, subject, body,
        qrCode,
        status: 'waiting',
        createdAt: Date.now(),
      });
      setTimeout(() => cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

      // 记录到收款后台订单列表
      adminOrders.push({
        outTradeNo,
        amount: parseFloat(amount).toFixed(2),
        subject,
        status: 'generated', // 订单生成
        createdAt: new Date().toISOString(),
        paidAt: null,
      });
      await saveOrders();

      // 2. 生成二维码图片
      let qrDataUrl = '';
      try {
        qrDataUrl = await QRCode.toDataURL(qrCode, {
          width: 300,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
      } catch (qrErr) {
        console.error(`>>> [收银台] 二维码生成失败: ${qrErr.message}`);
      }

      return res.json({
        code: 'OK',
        out_trade_no: outTradeNo,
        qr_code: qrCode,
        qr_image: qrDataUrl,
        amount,
        subject,
        message: '收款码已生成',
      });
    } else {
      const errDetail = JSON.stringify({
        code: resp.code,
        sub_code: resp.subCode || resp.sub_code,
        sub_msg: resp.subMsg || resp.sub_msg,
        msg: resp.msg,
      });
      console.error(`>>> [收银台] 收款码生成失败: ${errDetail}`);
      return res.status(500).json({
        code: 'ALIPAY_ERROR',
        message: '支付宝接口错误',
        detail: errDetail,
        alipay_code: resp.code,
        alipay_sub_code: resp.subCode || resp.sub_code,
        alipay_sub_msg: resp.subMsg || resp.sub_msg,
        alipay_msg: resp.msg,
      });
    }
  } catch (err) {
    console.error(`>>> [收银台] 异常:`, err.message);
    res.status(500).json({ code: 'ERROR', message: '支付服务异常: ' + err.message });
  }
});

/**
 * GET /cashier/check — 查询订单支付状态
 * Query: out_trade_no
 */
app.get('/cashier/check', async (req, res) => {
  const outTradeNo = (req.query.out_trade_no || '').trim();
  if (!outTradeNo) {
    return res.status(400).json({ code: 'ERROR', message: '缺少 out_trade_no' });
  }

  // 先查内存
  const localOrder = cashierOrders.get(outTradeNo);
  if (localOrder && localOrder.status === 'paid') {
    return res.json({ code: 'OK', status: 'paid', trade_no: localOrder.tradeNo, ...localOrder });
  }

  // 再查支付宝
  try {
    const result = await alipaySdk.exec('alipay.trade.query', {
      bizContent: { out_trade_no: outTradeNo }
    });
    const resp = result.alipay_trade_query_response || result;
    const tradeStatus = resp.tradeStatus || resp.trade_status;
    const tradeNo = resp.tradeNo || resp.trade_no;

    if (resp.code === '10000') {
      if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
        const order = cashierOrders.get(outTradeNo) || {};
        order.status = 'paid';
        order.tradeNo = tradeNo;
        order.payerUserId = resp.buyerUserId || resp.buyer_user_id;
        order.payerLogonId = resp.buyerLogonId || resp.buyer_logon_id;
        cashierOrders.set(outTradeNo, order);

        // 更新收款后台订单状态
        const adminOrder = adminOrders.find(o => o.outTradeNo === outTradeNo);
        if (adminOrder) {
          adminOrder.status = 'paid';
          adminOrder.paidAt = new Date().toISOString();
          adminOrder.tradeNo = tradeNo;
          await saveOrders();
        }

        return res.json({
          code: 'OK',
          status: 'paid',
          trade_no: tradeNo,
          amount: resp.totalAmount || resp.total_amount,
          payer: resp.buyerLogonId || resp.buyer_logon_id || '',
        });
      }
      // 首次查询到正在扫描中，更新为"支付中"
      const adminOrder = adminOrders.find(o => o.outTradeNo === outTradeNo);
      if (adminOrder && adminOrder.status === 'generated') {
        adminOrder.status = 'paying';
        await saveOrders();
      }
      return res.json({ code: 'OK', status: 'waiting', trade_status: tradeStatus });
    } else if (resp.code === '40004') {
      return res.json({ code: 'OK', status: 'waiting', message: '订单尚未支付' });
    } else {
      return res.json({ code: 'ERROR', message: resp.sub_msg || resp.msg, alipay_code: resp.code });
    }
  } catch (err) {
    return res.json({ code: 'ERROR', message: err.message });
  }
});

/**
 * POST /cashier/notify — 支付宝异步通知接收
 */
app.post('/cashier/notify', express.urlencoded({ extended: false }), async (req, res) => {
  console.log(`>>> [收银台] 收到支付宝通知:`, JSON.stringify(req.body));

  const outTradeNo = req.body.out_trade_no;
  const tradeStatus = req.body.trade_status;

  if (tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED') {
    const order = cashierOrders.get(outTradeNo) || {};
    order.status = 'paid';
    order.tradeNo = req.body.trade_no;
    order.payerUserId = req.body.buyer_id;
    order.payerLogonId = req.body.buyer_logon_id;
    cashierOrders.set(outTradeNo, order);

    // 更新收款后台
    const adminOrder = adminOrders.find(o => o.outTradeNo === outTradeNo);
    if (adminOrder) {
      adminOrder.status = 'paid';
      adminOrder.paidAt = new Date().toISOString();
      adminOrder.tradeNo = req.body.trade_no;
      await saveOrders();
    }
    console.log(`>>> [收银台] 支付成功(通知): ${outTradeNo}, 交易号: ${req.body.trade_no}`);
  }

  res.send('success');
});

// ======================== 【收款后台 API】 ========================

/**
 * GET /api/orders — 获取所有订单记录（收款后台用）
 */
app.get('/api/orders', (req, res) => {
  // 返回最新的在前
  const list = [...adminOrders].reverse();
  res.json({ code: 'OK', data: list, total: list.length });
});

/**
 * POST /api/orders — 手动更新订单状态（收银台前端调用）
 * Body: { outTradeNo, status }
 */
app.post('/api/orders', express.json(), async (req, res) => {
  const { outTradeNo, status } = req.body;
  const order = adminOrders.find(o => o.outTradeNo === outTradeNo);
  if (order) {
    order.status = status;
    if (status === 'paid') {
      order.paidAt = new Date().toISOString();
    }
    await saveOrders();
  }
  res.json({ code: 'OK' });
});

// ======================== 【退款 API】 ========================

/**
 * POST /api/refund — 订单退款（调用支付宝 alipay.trade.refund）
 * Body: { outTradeNo, refundAmount? }  不传 refundAmount 则全额退款
 */
app.post('/api/refund', express.json(), async (req, res) => {
  const { outTradeNo, refundAmount } = req.body;

  if (!outTradeNo) {
    return res.status(400).json({ code: 'ERROR', message: '缺少订单号' });
  }

  const order = adminOrders.find(o => o.outTradeNo === outTradeNo);
  if (!order) {
    return res.status(404).json({ code: 'ERROR', message: '订单不存在' });
  }

  if (order.status !== 'paid') {
    return res.status(400).json({ code: 'ERROR', message: '仅已支付的订单可以退款' });
  }

  if (order.refund) {
    return res.status(400).json({ code: 'ERROR', message: '该订单已退款，不能重复退款' });
  }

  // SDK 未初始化检查
  if (!alipaySdk) {
    return res.status(500).json({
      code: 'SDK_ERROR',
      message: alipaySdkError || '支付宝 SDK 未初始化，请检查支付宝配置'
    });
  }

  const amount = refundAmount ? parseFloat(refundAmount).toFixed(2) : order.amount;
  const amountNum = parseFloat(amount);
  const orderAmountNum = parseFloat(order.amount);

  if (amountNum <= 0 || amountNum > orderAmountNum) {
    return res.status(400).json({ code: 'ERROR', message: `退款金额无效，应在 0.01 ~ ${order.amount} 之间` });
  }

  const outRequestNo = `RF_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    console.log(`>>> [退款] 发起退款: ${outTradeNo}, 金额: ¥${amount}, 请求号: ${outRequestNo}`);

    const result = await alipaySdk.exec('alipay.trade.refund', {
      bizContent: {
        out_trade_no: outTradeNo,
        refund_amount: amount,
        out_request_no: outRequestNo,
      }
    });

    const resp = result.alipay_trade_refund_response || result;
    console.log(`>>> [退款] 响应: code=${resp.code}, msg=${resp.msg}`);

    if (resp.code === '10000') {
      const refundTradeNo = resp.tradeNo || resp.trade_no;

      order.refund = {
        refundNo: refundTradeNo || '',
        refundAmount: amount,
        refundedAt: new Date().toISOString(),
        outRequestNo,
      };

      // 全额退款 → refunded，部分退款 → partial_refund
      if (amountNum >= orderAmountNum) {
        order.status = 'refunded';
      } else {
        order.status = 'partial_refund';
      }

      await saveOrders();
      console.log(`>>> [退款] 退款成功: ${outTradeNo}, 退款号: ${refundTradeNo}`);

      return res.json({
        code: 'OK',
        message: '退款成功',
        refund_no: refundTradeNo,
        refund_amount: amount,
        out_request_no: outRequestNo,
      });
    } else {
      const errMsg = resp.subMsg || resp.sub_msg || resp.msg || '退款失败';
      console.error(`>>> [退款] 退款失败: code=${resp.code}, sub_code=${resp.subCode || resp.sub_code}, msg=${errMsg}`);
      return res.status(500).json({
        code: 'ALIPAY_ERROR',
        message: errMsg,
        alipay_code: resp.code,
        alipay_sub_code: resp.subCode || resp.sub_code,
      });
    }
  } catch (err) {
    console.error(`>>> [退款] 异常:`, err.message);
    res.status(500).json({ code: 'ERROR', message: '退款服务异常: ' + err.message });
  }
});

// ======================== 【安全设置 - 二级安全密码】 ========================

// 安全配置（内存缓存，启动时从数据库加载）
let securityConfig = {
  passwordHash: null,    // SHA-256 哈希后的安全密码，null=未设置
  skipPassword: false,   // 免密退款开关
  merchantName: '',      // 商户名称
  merchantContact: '',   // 联系人姓名
  merchantPhone: '',     // 联系人手机号
  merchantPassword: '',  // 登录密码
};

// 从数据库/文件加载安全配置
async function loadSecurity() {
  if (pgPool) {
    try {
      const result = await pgPool.query("SELECT value FROM app_data WHERE key = 'security'");
      if (result.rows.length > 0) {
        securityConfig = result.rows[0].value;
        console.log(`>>> [安全] 已加载安全配置, 密码已设置:${!!securityConfig.passwordHash}, 免密退款:${securityConfig.skipPassword}`);
      } else {
        console.log('>>> [安全] 暂无安全配置（首次使用）');
      }
    } catch (e) {
      console.error('>>> [安全] 加载失败:', e.message);
    }
  } else {
    try {
      const secFile = path.join(__dirname, 'security.json');
      if (fs.existsSync(secFile)) {
        securityConfig = JSON.parse(fs.readFileSync(secFile, 'utf-8'));
        console.log(`>>> [安全] 已从文件加载安全配置`);
      }
    } catch (e) {
      console.error('>>> [安全] 文件加载失败:', e.message);
    }
  }
  // 用 CONFIG 中的值作为默认值
  if (!securityConfig.merchantName && CONFIG.merchantName) {
    securityConfig.merchantName = CONFIG.merchantName;
  }
  // 联系人姓名默认与商户名称一致（都使用支付宝商户名）
  if (!securityConfig.merchantContact && CONFIG.merchantName) {
    securityConfig.merchantContact = CONFIG.merchantName;
  }
  if (!securityConfig.merchantPhone && CONFIG.merchantPhone) {
    securityConfig.merchantPhone = CONFIG.merchantPhone;
  }
  if (!securityConfig.merchantPassword && CONFIG.merchantPassword) {
    securityConfig.merchantPassword = CONFIG.merchantPassword;
  }
}

// 保存安全配置到数据库/文件
async function saveSecurity() {
  if (pgPool) {
    try {
      await pgPool.query(`
        INSERT INTO app_data (key, value) VALUES ('security', $1::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = $1::jsonb
      `, [JSON.stringify(securityConfig)]);
    } catch (e) {
      console.error('>>> [安全] 保存失败:', e.message);
    }
  } else {
    try {
      fs.writeFileSync(path.join(__dirname, 'security.json'), JSON.stringify(securityConfig, null, 2), 'utf-8');
    } catch (e) {
      console.error('>>> [安全] 文件保存失败:', e.message);
    }
  }
}

// SHA-256 哈希
function hashPassword(pwd) {
  return crypto.createHash('sha256').update('heijin_pay_' + pwd + '_security_2024').digest('hex');
}

/**
 * GET /api/security — 获取当前安全配置
 */
app.get('/api/security', (req, res) => {
  const phone = getSessionPhone(req);
  res.json({
    code: 'OK',
    data: {
      hasPassword: !!securityConfig.passwordHash,
      skipPassword: securityConfig.skipPassword,
      merchantName: getMerchantNameByPhone(phone),
      merchantContact: securityConfig.merchantContact || CONFIG.merchantContact || '',
      merchantPhone: phone || securityConfig.merchantPhone || CONFIG.merchantPhone || '',
    },
  });
});

/**
 * 向商户管理系统同步商户名称变更
 * @param {string} managerUrl 商户管理系统地址
 * @param {string} phone 当前登录手机号
 * @param {string} name 新商户名称
 */
function notifyManagerMerchantName(managerUrl, phone, name) {
  if (!managerUrl || !phone) return;
  const url = managerUrl.replace(/\/$/, '') + '/api/sync/merchant-name';
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;
  const payload = JSON.stringify({ phone, name });
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
      console.log(`>>> [sync-name] 已通知商户管理系统: ${url}, 响应: ${response.statusCode} ${data.slice(0, 200)}`);
    });
  });
  request.on('error', (err) => {
    console.error(`>>> [sync-name] 通知商户管理系统失败: ${url}, ${err.message}`);
  });
  request.write(payload);
  request.end();
}

/**
 * POST /api/security/merchant-name — 修改商户名称
 * Body: { name }
 */
app.post('/api/security/merchant-name', express.json(), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = getSessionPhone(req);
  securityConfig.merchantName = name;
  if (phone) {
    const entry = merchantNameMap.get(phone) || { managerUrl: '' };
    merchantNameMap.set(phone, { name, managerUrl: entry.managerUrl || '' });
    // 如果知道商户管理系统地址，回通知它同步更新
    if (entry.managerUrl) {
      notifyManagerMerchantName(entry.managerUrl, phone, name);
    }
  }
  await saveSecurity();
  console.log(`>>> [安全] 商户名称已更新: ${name}${phone ? ' (phone=' + phone + ')' : ''}`);
  res.json({ code: 'OK', merchantName: name });
});

/**
 * POST /api/security/merchant-info — 修改联系人姓名和手机号
 * Body: { merchantContact?, merchantPhone? }
 */
app.post('/api/security/merchant-info', express.json(), async (req, res) => {
  const contact = String(req.body.merchantContact || '').trim();
  const phone = String(req.body.merchantPhone || '').trim();
  securityConfig.merchantContact = contact;
  securityConfig.merchantPhone = phone;
  await saveSecurity();
  console.log(`>>> [安全] 商户联系信息已更新: ${contact}, ${phone}`);
  res.json({ code: 'OK', merchantContact: contact, merchantPhone: phone });
});

/**
 * POST /api/security/password — 设置/修改二级安全密码
 * Body: { oldPassword?, newPassword, confirmPassword }
 */
app.post('/api/security/password', express.json(), async (req, res) => {
  const { oldPassword, newPassword, confirmPassword } = req.body;

  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ code: 'ERROR', message: '新密码长度不能少于4位' });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ code: 'ERROR', message: '两次输入的密码不一致' });
  }

  // 如果已设置过密码，需要验证旧密码
  if (securityConfig.passwordHash) {
    if (!oldPassword) {
      return res.status(400).json({ code: 'ERROR', message: '请输入原密码' });
    }
    if (hashPassword(oldPassword) !== securityConfig.passwordHash) {
      return res.status(400).json({ code: 'ERROR', message: '原密码错误' });
    }
  }

  securityConfig.passwordHash = hashPassword(newPassword);
  await saveSecurity();
  console.log('>>> [安全] 二级安全密码已' + (oldPassword ? '修改' : '设置'));
  res.json({ code: 'OK', message: oldPassword ? '密码已修改' : '安全密码已设置' });
});

/**
 * POST /api/security/verify — 验证二级安全密码
 * Body: { password }
 */
app.post('/api/security/verify', express.json(), (req, res) => {
  const { password } = req.body;

  if (!securityConfig.passwordHash) {
    return res.json({ code: 'OK', verified: true, message: '未设置安全密码' });
  }

  if (!password) {
    return res.status(400).json({ code: 'ERROR', message: '请输入安全密码' });
  }

  if (hashPassword(password) === securityConfig.passwordHash) {
    return res.json({ code: 'OK', verified: true, message: '验证通过' });
  }

  return res.status(400).json({ code: 'ERROR', verified: false, message: '密码错误' });
});

/**
 * POST /api/security/skip — 切换免密退款状态
 * Body: { password } （需要先验证当前安全密码）
 */
app.post('/api/security/skip', express.json(), async (req, res) => {
  const { password, enable } = req.body;

  if (!securityConfig.passwordHash) {
    return res.status(400).json({ code: 'ERROR', message: '请先设置二级安全密码' });
  }

  if (!password || hashPassword(password) !== securityConfig.passwordHash) {
    return res.status(400).json({ code: 'ERROR', message: '安全密码错误' });
  }

  securityConfig.skipPassword = !!enable;
  await saveSecurity();
  console.log(`>>> [安全] 免密退款已${securityConfig.skipPassword ? '开启' : '关闭'}`);
  res.json({ code: 'OK', skipPassword: securityConfig.skipPassword, message: `免密退款已${securityConfig.skipPassword ? '开启' : '关闭'}` });
});

/**
 * POST /api/security/reset-by-paypwd — 忘记密码：通过支付宝支付密码重置安全密码
 * Body: { payPassword, newPassword, confirmPassword }
 * 注：支付宝支付密码仅作前端校验占位，实际不调用支付宝接口（商户端无法验证用户支付密码）
 * 此功能为预留扩展点，当前实现允许在忘记密码时重置
 */
app.post('/api/security/reset-by-paypwd', express.json(), async (req, res) => {
  const { payPassword, newPassword, confirmPassword } = req.body;

  if (!payPassword || payPassword.length < 6) {
    return res.status(400).json({ code: 'ERROR', message: '请输入有效的支付宝支付密码' });
  }

  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ code: 'ERROR', message: '新密码长度不能少于4位' });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({ code: 'ERROR', message: '两次输入的新密码不一致' });
  }

  securityConfig.passwordHash = hashPassword(newPassword);
  await saveSecurity();
  console.log('>>> [安全] 通过忘记密码流程重置了安全密码');
  res.json({ code: 'OK', message: '安全密码已重置' });
});

// ======================== 【商户登录 API】 ========================

/**
 * POST /api/sync-phone — 商户管理系统同步允许登录的手机号
 * Body: { phone }
 * 用于本地测试或多商户共享一个收款后台实例时，动态添加可登录手机号
 */
app.post('/api/sync-phone', express.json(), (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  const trimmed = phone.trim();
  allowedPhones.add(trimmed);
  console.log(`>>> [sync-phone] 已同步登录手机号: ${trimmed}`);
  res.json({ code: 'OK', message: '手机号已同步', phone: trimmed });
});

/**
 * POST /api/sync-name — 商户管理系统同步当前商户名称
 * Body: { phone, name, managerUrl }
 * 用于本地测试或多商户共享一个收款后台实例时，按手机号隔离显示商户名
 */
app.post('/api/sync-name', express.json(), (req, res) => {
  const { phone, name, managerUrl } = req.body;
  if (!phone || !/^1\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  const trimmed = phone.trim();
  const safeName = String(name || '').trim();
  const entry = merchantNameMap.get(trimmed) || { name: safeName, managerUrl: '' };
  merchantNameMap.set(trimmed, {
    name: safeName || entry.name,
    managerUrl: String(managerUrl || entry.managerUrl || '').trim()
  });
  console.log(`>>> [sync-name] 已同步商户名称: phone=${trimmed}, name=${safeName}${managerUrl ? ', managerUrl=' + managerUrl : ''}`);
  res.json({ code: 'OK', message: '商户名称已同步', phone: trimmed, name: safeName });
});

/**
 * POST /api/login — 商户手机号+密码登录
 * Body: { phone, password }
 */
app.post('/api/login', express.json(), (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !/^1\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  if (!password) {
    return res.status(400).json({ code: 'FAIL', message: '请输入登录密码' });
  }

  // 验证手机号和密码
  const configPhone = CONFIG.merchantPhone ? CONFIG.merchantPhone.trim() : '';
  const configPwd = CONFIG.merchantPassword || '';

  // 支持 CONFIG.merchantPhone 或动态同步的 allowedPhones 集合
  if (phone.trim() !== configPhone && !allowedPhones.has(phone.trim())) {
    return res.status(400).json({ code: 'FAIL', message: '手机号或密码错误' });
  }

  // 验证密码（支持直接比较或哈希比较）
  const isValidPwd = (password === configPwd) ||
    (hashMerchantPwd(password) === hashMerchantPwd(configPwd) && configPwd !== '');

  // 如果 CONFIG 中的密码是明文 yy123456，直接比较
  if (password === configPwd && configPwd === 'yy123456') {
    const token = crypto.randomBytes(16).toString('hex');
    merchantSessions.set(token, { createdAt: Date.now(), phone: phone.trim() });
    return res.json({ code: 'OK', token, message: '登录成功' });
  }

  // 否则验证哈希
  const inputHash = hashMerchantPwd(password);
  const storedHash = configPwd ? hashMerchantPwd(configPwd) : '';
  if (inputHash === storedHash && configPwd !== '') {
    const token = crypto.randomBytes(16).toString('hex');
    merchantSessions.set(token, { createdAt: Date.now(), phone: phone.trim() });
    return res.json({ code: 'OK', token, message: '登录成功' });
  }

  return res.status(400).json({ code: 'FAIL', message: '手机号或密码错误' });
});

/**
 * POST /api/login/check — 检查 token 是否有效
 * Headers: Authorization: <token>
 */
app.post('/api/login/check', (req, res) => {
  const token = cleanToken(req.headers.authorization);
  const session = merchantSessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) {
    return res.json({ code: 'OK', phone: session.phone });
  }
  return res.status(401).json({ code: 'UNAUTH', message: '未登录或会话已过期' });
});

/**
 * POST /api/login/change-password — 修改用户登录密码
 * Headers: Authorization: <token>
 * Body: { oldPassword, newPassword, confirmPassword }
 */
app.post('/api/login/change-password', express.json(), (req, res) => {
  const token = cleanToken(req.headers.authorization);
  const session = merchantSessions.get(token);
  if (!session || Date.now() - session.createdAt >= SESSION_TTL) {
    return res.status(401).json({ code: 'UNAUTH', message: '请先登录' });
  }

  const { oldPassword, newPassword, confirmPassword } = req.body;

  if (!oldPassword) {
    return res.status(400).json({ code: 'FAIL', message: '请输入原密码' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ code: 'FAIL', message: '新密码长度不能少于6位' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ code: 'FAIL', message: '两次输入的新密码不一致' });
  }

  const configPwd = CONFIG.merchantPassword || '';

  // 验证原密码
  let oldValid = false;
  if (oldPassword === configPwd) {
    oldValid = true;
  } else if (hashMerchantPwd(oldPassword) === hashMerchantPwd(configPwd) && configPwd !== '') {
    oldValid = true;
  }

  if (!oldValid) {
    return res.status(400).json({ code: 'FAIL', message: '原密码错误' });
  }

  // 更新密码（明文存储，由商户管理系统注入）
  CONFIG.merchantPassword = newPassword;

  // 同时更新 securityConfig 中的 merchantPassword（用于商户管理系统同步）
  securityConfig.merchantPassword = newPassword;
  saveSecurity();

  console.log('>>> [商户] 登录密码已修改');
  return res.json({ code: 'OK', message: '密码修改成功' });
});

/**
 * POST /api/login/forgot-password — 忘记密码：通过支付宝支付密码重置
 * Body: { payPassword, newPassword, confirmPassword }
 */
app.post('/api/login/forgot-password', express.json(), (req, res) => {
  const { payPassword, newPassword, confirmPassword } = req.body;

  if (!payPassword || payPassword.length < 6) {
    return res.status(400).json({ code: 'FAIL', message: '请输入有效的支付宝支付密码' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ code: 'FAIL', message: '新密码长度不能少于6位' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ code: 'FAIL', message: '两次输入的新密码不一致' });
  }

  // 更新密码
  CONFIG.merchantPassword = newPassword;
  securityConfig.merchantPassword = newPassword;
  saveSecurity();

  console.log('>>> [商户] 通过忘记密码流程重置了登录密码');
  return res.json({ code: 'OK', message: '密码重置成功' });
});

/**
 * GET /api/login/status — 获取当前登录状态
 */
app.get('/api/login/status', (req, res) => {
  const token = cleanToken(req.headers.authorization);
  const session = merchantSessions.get(token);
  if (session && Date.now() - session.createdAt < SESSION_TTL) {
    return res.json({
      code: 'OK',
      loggedIn: true,
      phone: session.phone,
      merchantName: getMerchantNameByPhone(session.phone)
    });
  }
  return res.json({ code: 'OK', loggedIn: false });
});

// ===== 限额设置 API =====
const LIMITS_FILE = path.join(__dirname, 'limits.json');

let limitsConfig = { minAmount: null, maxAmount: null, dayCount: null, dayAmount: null, monthCount: null, monthAmount: null };

function loadLimits() {
  try { limitsConfig = JSON.parse(fs.readFileSync(LIMITS_FILE, 'utf8')); } catch(e) {}
}

app.get('/api/limits', (req, res) => {
  res.json({ code: 'OK', success: true, config: limitsConfig });
});

app.post('/api/limits', express.json(), async (req, res) => {
  const body = req.body;
  limitsConfig = {
    minAmount: body.minAmount !== '' ? parseFloat(body.minAmount) : null,
    maxAmount: body.maxAmount !== '' ? parseFloat(body.maxAmount) : null,
    dayCount: body.dayCount !== '' ? parseInt(body.dayCount) : null,
    dayAmount: body.dayAmount !== '' ? parseFloat(body.dayAmount) : null,
    monthCount: body.monthCount !== '' ? parseInt(body.monthCount) : null,
    monthAmount: body.monthAmount !== '' ? parseFloat(body.monthAmount) : null
  };
  fs.writeFileSync(LIMITS_FILE, JSON.stringify(limitsConfig, null, 2), 'utf8');
  console.log('>>> [限额] 已更新限额配置:', JSON.stringify(limitsConfig));
  res.json({ code: 'OK', success: true });
});

// ======================== 【支付宝配置管理】 ========================

// 获取当前支付宝配置（私钥脱敏）
app.get('/api/config/alipay', (req, res) => {
  const cfg = CONFIG.alipay;
  // 私钥脱敏：只显示前后各10个字符
  let maskedKey = '';
  if (cfg.privateKey) {
    const pk = cfg.privateKey;
    if (pk.length > 30) {
      maskedKey = pk.substring(0, 15) + '...' + pk.substring(pk.length - 15);
    } else {
      maskedKey = pk.substring(0, 5) + '...';
    }
  }
  res.json({
    code: 'OK',
    data: {
      appId: cfg.appId,
      privateKey: cfg.privateKey,  // 完整私钥（确认修改时需要）
      privateKeyMasked: maskedKey,
      alipayPublicKey: cfg.alipayPublicKey,
      keyType: cfg.keyType || 'PKCS8',
      sdkError: alipaySdkError || null,
    }
  });
});

// 更新支付宝配置并重新初始化 SDK
app.post('/api/config/alipay', express.json(), async (req, res) => {
  const { appId, privateKey, alipayPublicKey, keyType } = req.body;
  const cfg = CONFIG.alipay;

  if (appId !== undefined) cfg.appId = appId;
  if (alipayPublicKey !== undefined) cfg.alipayPublicKey = alipayPublicKey.trim();
  if (keyType !== undefined) cfg.keyType = keyType;

  if (privateKey !== undefined) {
    let trimmedKey = privateKey.trim();
    if (trimmedKey && !trimmedKey.includes('-----BEGIN') && !trimmedKey.includes('-----END')) {
      const userKeyType = (cfg.keyType || 'PKCS8').trim().toUpperCase();
      if (userKeyType === 'PKCS1') {
        trimmedKey = '-----BEGIN RSA PRIVATE KEY-----\n' + trimmedKey + '\n-----END RSA PRIVATE KEY-----';
      } else {
        trimmedKey = '-----BEGIN PRIVATE KEY-----\n' + trimmedKey + '\n-----END PRIVATE KEY-----';
      }
    }
    // 确保 PEM 头尾后有正确换行
    cfg.privateKey = trimmedKey
      .replace(/-----BEGIN [A-Z ]+-----(?!\n)/g, '$&\n')
      .replace(/(?<!\n)-----END [A-Z ]+-----/g, '\n$&');
  }

  // 重新初始化 SDK
  const err = createAlipaySdk();

  console.log(`>>> [支付宝] 配置已更新: appId=${cfg.appId}, keyType=${cfg.keyType}, sdkError=${err || '无'}`);

  res.json({
    code: 'OK',
    message: err ? '配置已保存，但 SDK 初始化失败：' + err : '配置已更新，SDK 重新初始化成功',
    sdkError: err || null,
  });
});

// 从数据库恢复历史订单和安全配置，然后启动服务
Promise.all([loadOrders(), loadSecurity(), loadLimits()]).then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('  黑金PAY 收银台（支付宝加密支付）已启动');
    console.log(`  地址: http://localhost:${PORT}`);
    console.log('========================================');
    console.log('');
    console.log('  收银台页面：');
    console.log(`  http://localhost:${PORT}/cashier.html`);
    console.log('');
    console.log('  模式说明：生成收款码，用户支付宝扫码支付（加密通道）');
    console.log('');
  });
}).catch(err => {
  console.error('>>> 启动失败:', err.message);
  process.exit(1);
});
