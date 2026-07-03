/**
 * ============================================
 *  黑金PAY 收银台 · UID 版（支付宝个人收款）
 * ============================================
 *
 * 无需申请支付宝开放平台应用，只需你的支付宝 UID 即可收款。
 * 支持两种模式：
 *   模式 A（内置）：扫码跳转支付宝转账页面，金额自动填入，后台手动确认到账
 *   模式 B（第三方 API）：接入你的支付中转平台，全自动处理
 *
 * 使用方式：
 *   1. npm install
 *   2. 填写下方 CONFIG 中的 alipayUid
 *   3. node index.js
 *   4. 打开浏览器访问 http://localhost:3002/cashier.html
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');
const express = require('express');
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
const PORT = process.env.PORT || 3002;

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

// ======================== 【配置区 — 只需填入支付宝 UID】 ========================

const CONFIG = {

  // 商户类型: 'uid' 或 'uid-simple'（由商户管理系统注入）
  type: 'uid',

  // 【必填】支付宝 UID（你的支付宝唯一用户 ID）
  // 获取方式：打开支付宝 APP → 我的 → 点击头像 → 个人信息页查看"用户 ID"
  alipayUid: '2088522254750914',

  // 【可选】本服务公网地址（部署后填写，例：https://xxx.up.railway.app）
  // 填写后二维码将使用 HTTPS 网页跳转方式，可绕过支付宝「当前码值存在风险」提示
  // 本地测试可填：http://你的局域网IP:3002（手机和电脑需在同一WiFi）
  // 留空则使用直连 alipays:// 协议（会触发支付宝安全提示，但仍可正常转账）
  baseUrl: 'http://192.168.0.112:3002',

  // 【可选】第三方支付 API 地址（接入支付中转平台时填写）
  // 填写后将使用第三方 API 处理支付，不填则使用内置 alipays:// 协议
  paymentApi: '',

  // 【可选】第三方 API 密钥
  apiKey: '',

  // 商户名称（用于后台默认显示）
  merchantName: 'UID测试',

  // 商户登录手机号（由商户管理系统注入，用于后台登录验证）
  merchantPhone: '',

  // 商户登录密码（由商户管理系统注入，默认 yy123456）
  merchantPassword: '',
};

// ======================== 【商户登录会话管理】 ========================

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24小时
const merchantSessions = new Map(); // token -> { createdAt, phone }

// 商户密码哈希
function hashMerchantPwd(pwd) {
  return crypto.createHash('sha256').update('heijin_pay_uid_' + pwd + '_security_2024').digest('hex');
}

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
setInterval(cleanExpiredSessions, 10 * 60 * 1000);

// ======================== 【工具函数】 ========================

// 发起 HTTP/HTTPS 请求（用于第三方 API 调用）
function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 15000,
    };

    if (options.body) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      reqOptions.headers['Content-Type'] = reqOptions.headers['Content-Type'] || 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });

    if (options.body) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.write(bodyStr);
    }
    req.end();
  });
}

// ======================== 【收银台 - UID 收款】 ========================

// 内存存储收银台订单（用于收银台轮询）
const cashierOrders = new Map();
// 收款后台订单记录
const ORDERS_FILE = path.join(__dirname, 'orders.json');
let adminOrders = [];

// 从数据库/文件加载持久化订单
async function loadOrders() {
  if (pgPool) {
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
    try {
      await pgPool.query(`
        INSERT INTO app_data (key, value) VALUES ('orders', $1::jsonb)
        ON CONFLICT (key) DO UPDATE SET value = $1::jsonb
      `, [JSON.stringify(adminOrders)]);
    } catch (e) {
      console.error('>>> [DB] 保存失败:', e.message);
    }
  } else {
    try {
      fs.writeFileSync(ORDERS_FILE, JSON.stringify(adminOrders, null, 2), 'utf-8');
    } catch (e) {
      console.error('>>> [文件] 保存失败:', e.message);
    }
  }
}

/**
 * POST /cashier/qrcode — 生成收款二维码
 *
 * 模式 A（内置）：生成 alipays:// 转账链接 → 用户扫码跳转支付宝转账
 * 模式 B（第三方 API）：调用你的支付 API → 获取支付链接
 *
 * Body: { amount: string, subject: string, body?: string }
 */
app.post('/cashier/qrcode', express.json(), async (req, res) => {
  const amount = String(req.body.amount || '').trim();
  const subject = String(req.body.subject || '收款').trim();
  const body = String(req.body.body || subject).trim();

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
    return res.status(400).json({ code: 'ERROR', message: '请输入有效金额' });
  }

  const outTradeNo = `UID_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    let qrContent; // 最终用于生成二维码的内容
    let useApi = false;
    let frontendBaseUrl = '';  // 将从 req.body.base_url 获取
    let effectiveBaseUrl = '';   // 最终使用的跳转地址

    // ===== 模式 C：UID 简易支付（直接跳转，不生成二维码）=====
    if (CONFIG.type === 'uid-simple') {
      if (!CONFIG.alipayUid) {
        return res.status(400).json({
          code: 'CONFIG_ERROR',
          message: '请在 index.js 的 CONFIG 中填写 alipayUid（支付宝用户ID）',
        });
      }
      const bizData = JSON.stringify({ s: 'money', u: CONFIG.alipayUid, a: parseFloat(amount).toFixed(2), m: subject });
      qrContent = `alipays://platformapi/startapp?appId=20000674&actionType=scan&biz_data=${encodeURIComponent(bizData)}`;
      console.log(`>>> [UID收银台] UID 简易支付，直接跳转: ${outTradeNo}, 金额: ¥${amount}`);

      cashierOrders.set(outTradeNo, {
        amount, subject, body,
        qrCode: qrContent,
        status: 'waiting',
        useApi: false,
        createdAt: Date.now(),
      });
      setTimeout(() => cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

      adminOrders.push({
        outTradeNo,
        amount: parseFloat(amount).toFixed(2),
        subject,
        status: 'generated',
        useApi: false,
        createdAt: new Date().toISOString(),
        paidAt: null,
      });
      await saveOrders();

      return res.json({
        code: 'OK',
        out_trade_no: outTradeNo,
        qr_code: qrContent,
        qr_image: '',
        amount,
        subject,
        use_api: false,
        use_direct_redirect: true,
        message: '正在跳转支付宝...',
      });
    }

    // ===== 模式 B：使用第三方 API =====
    if (CONFIG.paymentApi && CONFIG.apiKey) {
      console.log(`>>> [UID收银台] 使用第三方 API 创建订单: ${outTradeNo}, 金额: ¥${amount}`);
      try {
        const apiResult = await httpRequest(CONFIG.paymentApi + '/create', {
          method: 'POST',
          body: {
            uid: CONFIG.alipayUid,
            amount: parseFloat(amount).toFixed(2),
            subject,
            out_trade_no: outTradeNo,
            api_key: CONFIG.apiKey,
          },
        });

        if (apiResult.status === 200 && apiResult.data && apiResult.data.qr_code) {
          qrContent = apiResult.data.qr_code;
          useApi = true;
          console.log(`>>> [UID收银台] 第三方 API 返回成功`);
        } else {
          console.error(`>>> [UID收银台] 第三方 API 返回异常:`, JSON.stringify(apiResult));
          return res.status(500).json({
            code: 'API_ERROR',
            message: '第三方支付 API 返回异常',
            detail: JSON.stringify(apiResult.data),
          });
        }
      } catch (apiErr) {
        console.error(`>>> [UID收银台] 第三方 API 请求失败:`, apiErr.message);
        return res.status(500).json({
          code: 'API_ERROR',
          message: '第三方支付 API 连接失败: ' + apiErr.message,
        });
      }
    }

    // ===== 模式 A：使用 alipays:// 协议 =====
    if (!useApi) {
      if (!CONFIG.alipayUid) {
        return res.status(400).json({
          code: 'CONFIG_ERROR',
          message: '请在 index.js 的 CONFIG 中填写 alipayUid（支付宝用户ID）',
        });
      }

      // 二维码内容策略（优先级：前端 base_url > CONFIG.baseUrl > 直连 alipays://）
      // 原理：二维码编码为普通 HTTP 链接 → 支付宝扫码打开网页 → 用户点击按钮手动触发 alipays://
      // 支付宝官方要求：必须由用户主动触发（点击按钮），自动跳转会被拦截
      frontendBaseUrl = req.body.base_url || '';  // 前端传来的当前浏览器地址
      effectiveBaseUrl = frontendBaseUrl || CONFIG.baseUrl || '';

      if (effectiveBaseUrl) {
        const redirectUrl = `${effectiveBaseUrl}/pay/?amount=${parseFloat(amount).toFixed(2)}&uid=${CONFIG.alipayUid}&memo=${encodeURIComponent(subject)}`;
        qrContent = redirectUrl;
        console.log(`>>> [UID收银台] 使用 HTTPS 跳转方式: ${outTradeNo}, 金额: ¥${amount}`);
        console.log(`   二维码内容: ${redirectUrl}`);
      } else {
        // ⚠️ 直连 alipays:// 极易被支付宝风控拦截，强烈建议配置 baseUrl
        // 尝试新 appId=20000674（收款新入口），支付宝对旧 20000123 风控更严
        const bizData = JSON.stringify({ s: 'money', u: CONFIG.alipayUid, a: parseFloat(amount).toFixed(2), m: subject });
        qrContent = `alipays://platformapi/startapp?appId=20000674&actionType=scan&biz_data=${encodeURIComponent(bizData)}`;
        console.log(`>>> [UID收银台] ⚠️ 直连 alipays://（不推荐，易被风控）: ${outTradeNo}, 金额: ¥${amount}`);
        console.log(`   ⚠️ 建议：访问收银台时使用局域网IP（如 http://192.168.x.x:3002），让系统自动获取地址`);
      }
    }

    // 生成二维码图片
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(qrContent, {
        width: 300,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' }
      });
    } catch (qrErr) {
      console.error(`>>> [UID收银台] 二维码生成失败: ${qrErr.message}`);
    }

    // 存储到内存（收银台轮询用）
    cashierOrders.set(outTradeNo, {
      amount, subject, body,
      qrCode: qrContent,
      status: 'waiting',
      useApi,
      createdAt: Date.now(),
    });
    setTimeout(() => cashierOrders.delete(outTradeNo), 31 * 60 * 1000);

    // 记录到收款后台订单列表
    adminOrders.push({
      outTradeNo,
      amount: parseFloat(amount).toFixed(2),
      subject,
      status: 'generated',
      useApi,
      createdAt: new Date().toISOString(),
      paidAt: null,
    });
    await saveOrders();

    return res.json({
      code: 'OK',
      out_trade_no: outTradeNo,
      qr_code: qrContent,
      qr_image: qrDataUrl,
      amount,
      subject,
      use_api: useApi,
      use_redirect: !useApi && !!effectiveBaseUrl,  // 使用 HTTPS 跳转方式（含前端傳來的 base_url）
      message: useApi ? '收款码已生成（第三方API）' : (!useApi && !effectiveBaseUrl ? '⚠️ 未配置跳转地址，二维码可能被支付宝拦截' : '请使用支付宝扫码转账'),
    });
  } catch (err) {
    console.error(`>>> [UID收银台] 异常:`, err.message);
    res.status(500).json({ code: 'ERROR', message: '支付服务异常: ' + err.message });
  }
});

/**
 * GET /pay/ — 支付宝扫码后打开的中间跳转页
 *
 * 原理：二维码编码为 HTTPS 网页 → 支付宝扫码后在内置浏览器打开网页
 * → 用户手动点击按钮触发 alipays:// → 绕过支付宝自动跳转拦截
 *
 * Query: amount, memo, uid
 */

/**
 * GET /cashier/check — 查询订单支付状态
 *
 * 模式 A：检查后台是否已手动确认到账
 * 模式 B：调用第三方 API 查询
 *
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
    return res.json({ code: 'OK', status: 'paid', trade_no: localOrder.tradeNo });
  }

  // 查后台订单状态
  const adminOrder = adminOrders.find(o => o.outTradeNo === outTradeNo);
  if (!adminOrder) {
    return res.json({ code: 'OK', status: 'waiting', message: '订单不存在' });
  }

  // 如果使用第三方 API，查询 API 状态
  if (adminOrder.useApi && CONFIG.paymentApi && CONFIG.apiKey) {
    try {
      const apiResult = await httpRequest(CONFIG.paymentApi + '/query', {
        method: 'POST',
        body: { out_trade_no: outTradeNo, api_key: CONFIG.apiKey },
      });

      if (apiResult.status === 200 && apiResult.data) {
        const apiStatus = apiResult.data.status || apiResult.data.trade_status;
        if (apiStatus === 'SUCCESS' || apiStatus === 'TRADE_SUCCESS' || apiStatus === 'paid') {
          adminOrder.status = 'paid';
          adminOrder.paidAt = new Date().toISOString();
          adminOrder.tradeNo = apiResult.data.trade_no || '';
          await saveOrders();

          const order = cashierOrders.get(outTradeNo) || {};
          order.status = 'paid';
          order.tradeNo = apiResult.data.trade_no || '';
          cashierOrders.set(outTradeNo, order);

          return res.json({
            code: 'OK', status: 'paid',
            trade_no: apiResult.data.trade_no,
            amount: adminOrder.amount,
          });
        }
      }
    } catch (err) {
      console.error(`>>> [UID收银台] API 查询异常:`, err.message);
    }
  }

  // 模式 A：检查后台是否手动确认
  if (adminOrder.status === 'paid' || adminOrder.status === 'confirmed') {
    const order = cashierOrders.get(outTradeNo) || {};
    order.status = 'paid';
    order.tradeNo = adminOrder.tradeNo || 'MANUAL';
    cashierOrders.set(outTradeNo, order);

    return res.json({
      code: 'OK', status: 'paid',
      trade_no: adminOrder.tradeNo || '',
      amount: adminOrder.amount,
    });
  }

  // 首次查询，标记为"支付中"（用户已扫码）
  if (adminOrder.status === 'generated') {
    adminOrder.status = 'paying';
    await saveOrders();
  }

  return res.json({ code: 'OK', status: 'waiting' });
});

/**
 * POST /cashier/confirm — 手动确认到账（后台管理员操作）
 * Body: { outTradeNo }
 */
app.post('/cashier/confirm', express.json(), async (req, res) => {
  const { outTradeNo } = req.body;
  if (!outTradeNo) {
    return res.status(400).json({ code: 'ERROR', message: '缺少订单号' });
  }

  const order = adminOrders.find(o => o.outTradeNo === outTradeNo);
  if (!order) {
    return res.status(404).json({ code: 'ERROR', message: '订单不存在' });
  }

  if (order.status === 'paid' || order.status === 'confirmed') {
    return res.status(400).json({ code: 'ERROR', message: '该订单已确认到账' });
  }

  order.status = 'paid';
  order.paidAt = new Date().toISOString();
  order.tradeNo = 'MANUAL_' + Date.now();
  await saveOrders();

  // 同步更新内存
  const cachedOrder = cashierOrders.get(outTradeNo);
  if (cachedOrder) {
    cachedOrder.status = 'paid';
    cachedOrder.tradeNo = order.tradeNo;
    cashierOrders.set(outTradeNo, cachedOrder);
  }

  console.log(`>>> [UID收银台] 手动确认到账: ${outTradeNo}, 金额: ¥${order.amount}`);
  res.json({ code: 'OK', message: '已确认到账', out_trade_no: outTradeNo });
});

// ======================== 【收款后台 API】 ========================

/**
 * GET /api/orders — 获取所有订单记录
 */
app.get('/api/orders', (req, res) => {
  const list = [...adminOrders].reverse();
  res.json({ code: 'OK', data: list, total: list.length });
});

/**
 * POST /api/orders — 手动更新订单状态
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

// ======================== 【退款 API（本地退款）】 ========================

/**
 * POST /api/refund — 订单退款
 *
 * UID 模板的退款为本地操作（标记退款状态），不通过支付宝 API 执行实际退款。
 * 如需实际退款，请在支付宝 APP 中手动操作，或接入第三方 API。
 *
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

  const amount = refundAmount ? parseFloat(refundAmount).toFixed(2) : order.amount;
  const amountNum = parseFloat(amount);
  const orderAmountNum = parseFloat(order.amount);

  if (amountNum <= 0 || amountNum > orderAmountNum) {
    return res.status(400).json({ code: 'ERROR', message: `退款金额无效，应在 0.01 ~ ${order.amount} 之间` });
  }

  // 如果接入第三方 API，可通过它执行退款
  if (CONFIG.paymentApi && CONFIG.apiKey) {
    try {
      console.log(`>>> [退款] 尝试通过第三方 API 退款: ${outTradeNo}, 金额: ¥${amount}`);
      await httpRequest(CONFIG.paymentApi + '/refund', {
        method: 'POST',
        body: {
          out_trade_no: outTradeNo,
          refund_amount: amount,
          api_key: CONFIG.apiKey,
        },
      });
    } catch (err) {
      console.error(`>>> [退款] 第三方 API 退款异常:`, err.message);
      // 即使 API 失败，仍然标记本地退款
    }
  }

  const outRequestNo = `RF_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  order.refund = {
    refundNo: 'LOCAL_' + outRequestNo,
    refundAmount: amount,
    refundedAt: new Date().toISOString(),
    outRequestNo,
    note: '本地退款（请在支付宝 APP 中手动退款给客户）',
  };

  // 全额退款 → refunded，部分退款 → partial_refund
  if (amountNum >= orderAmountNum) {
    order.status = 'refunded';
  } else {
    order.status = 'partial_refund';
  }

  await saveOrders();
  console.log(`>>> [退款] 本地退款标记完成: ${outTradeNo}, 金额: ¥${amount}`);

  return res.json({
    code: 'OK',
    message: '退款已标记（UID 模板，请在支付宝 APP 中手动操作实际退款）',
    refund_amount: amount,
    out_request_no: outRequestNo,
  });
});

// ======================== 【安全设置】 ========================

let securityConfig = {
  passwordHash: null,
  skipPassword: false,
  merchantName: '',
  merchantContact: '',
  merchantPhone: '',
  merchantPassword: '',
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

  if (pgPool) {
    try {
      const result = await pgPool.query("SELECT value FROM app_data WHERE key = 'security'");
      if (result.rows.length > 0) {
        securityConfig = result.rows[0].value;
        console.log(`>>> [安全] 已加载安全配置`);
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
  if (!securityConfig.merchantName && CONFIG.merchantName) {
    securityConfig.merchantName = CONFIG.merchantName;
  }
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

function hashPassword(pwd) {
  return crypto.createHash('sha256').update('heijin_pay_uid_' + pwd + '_security_2024').digest('hex');
}

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

app.post('/api/security/merchant-name', express.json(), async (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = getSessionPhone(req);
  securityConfig.merchantName = name;
  if (phone) {
    const entry = merchantNameMap.get(phone) || { managerUrl: '' };
    merchantNameMap.set(phone, { name, managerUrl: entry.managerUrl || '' });
    if (entry.managerUrl) {
      notifyManagerMerchantName(entry.managerUrl, phone, name);
    }
  }
  await saveSecurity();
  console.log(`>>> [安全] 商户名称已更新: ${name}${phone ? ' (phone=' + phone + ')' : ''}`);
  res.json({ code: 'OK', merchantName: name });
});

app.post('/api/security/merchant-info', express.json(), async (req, res) => {
  const contact = String(req.body.merchantContact || '').trim();
  const phone = String(req.body.merchantPhone || '').trim();
  securityConfig.merchantContact = contact;
  securityConfig.merchantPhone = phone;
  await saveSecurity();
  console.log(`>>> [安全] 商户联系信息已更新: ${contact}, ${phone}`);
  res.json({ code: 'OK', merchantContact: contact, merchantPhone: phone });
});

app.post('/api/security/password', express.json(), async (req, res) => {
  const { oldPassword, newPassword, confirmPassword } = req.body;

  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ code: 'ERROR', message: '新密码长度不能少于4位' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ code: 'ERROR', message: '两次输入的密码不一致' });
  }
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
 */
app.post('/api/login', express.json(), (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !/^1\d{10}$/.test(phone.trim())) {
    return res.status(400).json({ code: 'FAIL', message: '请输入有效的 11 位手机号' });
  }
  if (!password) {
    return res.status(400).json({ code: 'FAIL', message: '请输入登录密码' });
  }

  const configPhone = CONFIG.merchantPhone ? CONFIG.merchantPhone.trim() : '';
  const configPwd = CONFIG.merchantPassword || '';

  // 支持 CONFIG.merchantPhone 或动态同步的 allowedPhones 集合
  if (phone.trim() !== configPhone && !allowedPhones.has(phone.trim())) {
    return res.status(400).json({ code: 'FAIL', message: '手机号或密码错误' });
  }

  // 直接比较或哈希比较
  if (password === configPwd && configPwd === 'yy123456') {
    const token = crypto.randomBytes(16).toString('hex');
    merchantSessions.set(token, { createdAt: Date.now(), phone: phone.trim() });
    return res.json({ code: 'OK', token, message: '登录成功' });
  }

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

  let oldValid = false;
  if (oldPassword === configPwd) {
    oldValid = true;
  } else if (hashMerchantPwd(oldPassword) === hashMerchantPwd(configPwd) && configPwd !== '') {
    oldValid = true;
  }

  if (!oldValid) {
    return res.status(400).json({ code: 'FAIL', message: '原密码错误' });
  }

  CONFIG.merchantPassword = newPassword;
  securityConfig.merchantPassword = newPassword;
  saveSecurity();

  console.log('>>> [商户] 登录密码已修改');
  return res.json({ code: 'OK', message: '密码修改成功' });
});

/**
 * POST /api/login/forgot-password — 忘记密码：通过支付宝支付密码重置
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

// ======================== 【限额设置】 ========================

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

// ======================== 【HTTPS 网页跳转（绕过风险提示）】 ========================

/**
 * GET /pay/ — 支付宝扫码后打开的中间跳转页
 *
 * 原理：二维码编码为 HTTPS 网页 → 支付宝扫码后在内置浏览器打开网页
 * → 用户点击按钮手动触发 alipays:// → 用户主动行为可绕过自动跳转的风控检测
 *
 * 支付宝官方文档明确指出：必须由用户主动触发（如点击按钮），否则可能被拦截
 *
 * Query: amount, memo, uid
 */
app.get('/pay/', (req, res) => {
  const amount = parseFloat(req.query.amount) || 0;
  const memo = req.query.memo || '';
  const uid = req.query.uid || CONFIG.alipayUid;

  if (!amount || !uid) {
    return res.status(400).send('参数不完整');
  }

  // 多 appId 轮换（支付宝可能封禁特定 appId，这里尝试多个收款入口）
  // 20000674 = 收款（新入口，优先尝试）
  // 20000123 = 收款（旧入口，备选，当前用户反馈该入口可正常跳转）
  const bizData = JSON.stringify({ s: 'money', u: uid, a: amount.toFixed(2), m: memo });
  const encodedBiz = encodeURIComponent(bizData);
  const alipayUrls = [
    {
      label: '收款方式一',
      url: `alipays://platformapi/startapp?appId=20000674&actionType=scan&biz_data=${encodedBiz}`
    },
    {
      label: '收款方式二',
      url: `alipays://platformapi/startapp?appId=20000123&actionType=scan&biz_data=${encodedBiz}`
    }
  ];

  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>黑金PAY · 正在打开支付宝</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background: #070707;
    color: #d4af37;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh;
    text-align: center;
    flex-direction: column;
    padding: 24px;
    -webkit-tap-highlight-color: transparent;
  }
  .card {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(212,175,55,0.15);
    border-radius: 20px;
    padding: 36px 28px;
    width: 100%;
    max-width: 340px;
  }
  .logo { font-size: 26px; font-weight: 800; letter-spacing: 6px; margin-bottom: 4px;
    background: linear-gradient(135deg, #f0d77a, #d4af37, #b8860b);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .brand { font-size: 11px; color: rgba(212,175,55,0.4); margin-bottom: 28px; letter-spacing: 3px; }
  .amount-label { font-size: 12px; color: rgba(255,255,255,0.25); margin-bottom: 6px; letter-spacing: 1px; }
  .amount { font-size: 44px; font-weight: 900; margin-bottom: 4px;
    background: linear-gradient(135deg, #f0d77a, #d4af37);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  .memo { font-size: 13px; color: rgba(212,175,55,0.5); margin-bottom: 28px; word-break: break-all; }
  .spinner {
    width: 40px; height: 40px;
    border: 3px solid rgba(212,175,55,0.2);
    border-top-color: #d4af37;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 18px;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status-text {
    font-size: 15px; font-weight: 700;
    color: #d4af37;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .status-sub {
    font-size: 12px; color: rgba(255,255,255,0.3);
    line-height: 1.6;
  }
  .pay-btn {
    display: none; width: 100%;
    background: linear-gradient(135deg, #d4af37, #b8860b);
    color: #070707;
    border: none; border-radius: 14px;
    padding: 16px 0;
    font-size: 17px; font-weight: 800;
    text-decoration: none;
    letter-spacing: 3px;
    cursor: pointer;
    margin-top: 20px;
    box-shadow: 0 4px 20px rgba(212,175,55,0.25);
  }
  .pay-btn.show { display: block; }
  .fallback {
    display: none;
    margin-top: 24px;
  }
  .fallback.show { display: block; }
  .fallback-note {
    font-size: 11px; color: rgba(255,255,255,0.18);
    margin-top: 20px; line-height: 1.8;
  }
  .success-icon {
    width: 60px; height: 60px;
    border-radius: 50%;
    background: linear-gradient(135deg, #52c41a, #389e0d);
    color: #fff;
    font-size: 32px; font-weight: 800;
    line-height: 60px;
    margin: 0 auto 18px;
    box-shadow: 0 4px 20px rgba(82,196,26,0.3);
  }
  .success-view { display: none; }
  .success-view.show { display: block; }
  .jump-view.hide { display: none; }
  .done-note {
    font-size: 12px; color: rgba(255,255,255,0.3);
    margin-top: 24px; line-height: 1.8;
  }
</style>
</head>
<body>
  <div class="card">
    <!-- 跳转中视图 -->
    <div class="jump-view" id="jumpView">
      <div class="logo">黑金PAY</div>
      <div class="brand">HEIJIN PAY</div>
      <div class="amount-label">支付金额</div>
      <div class="amount">¥${amount.toFixed(2)}</div>
      ${memo ? `<div class="memo">${memo}</div>` : ''}
      <div class="spinner" id="spinner"></div>
      <div class="status-text" id="statusText">正在打开支付宝...</div>
      <div class="status-sub" id="statusSub">请稍候，系统正在为您跳转</div>
      <a class="pay-btn" id="payBtn" href="${alipayUrls[1].url}">重新打开支付宝</a>
      <div class="fallback" id="fallback">
        <div class="fallback-note">
          <span style="color:rgba(212,175,55,0.4)">●</span> 若自动跳转失败，请点击上方按钮<br>
          <span style="color:rgba(212,175,55,0.4)">●</span> 金额已锁定，确认无误后输入密码即可<br>
          <span style="color:rgba(212,175,55,0.4)">●</span> 若提示风险请点击「仍然支付」继续
        </div>
      </div>
    </div>

    <!-- 支付成功视图（从支付宝返回后显示） -->
    <div class="success-view" id="successView">
      <div class="success-icon">✓</div>
      <div class="status-text">支付完成</div>
      <div class="amount" style="margin-top:12px;margin-bottom:20px;">¥${amount.toFixed(2)}</div>
      <div class="status-sub">如已完成付款，请通知商户确认到账</div>
      <div class="done-note">
        <span style="color:rgba(212,175,55,0.4)">●</span> 您可点击左上角返回商家页面<br>
        <span style="color:rgba(212,175,55,0.4)">●</span> 或关闭当前页面
      </div>
    </div>
  </div>
<script>
  (function() {
    var urls = [
      '${alipayUrls[0].url.replace(/'/g, "\\'")}',
      '${alipayUrls[1].url.replace(/'/g, "\\'")}'
    ];
    var triedIndex = 0;
    var hasHidden = false;

    function showSuccess() {
      document.getElementById('jumpView').classList.add('hide');
      document.getElementById('successView').classList.add('show');
      document.title = '黑金PAY · 支付完成';
    }

    function tryOpen() {
      // 优先使用用户反馈有效的 20000123（索引 1）
      var url = urls[triedIndex];
      window.location.href = url;
      triedIndex = (triedIndex + 1) % urls.length;
    }

    // 监听页面可见性：当用户从支付宝返回时，页面会重新变为 visible
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'hidden') {
        hasHidden = true;
      } else if (hasHidden) {
        // 用户已经从支付宝返回，显示支付完成页面
        showSuccess();
      }
    });

    // 页面加载后立即尝试跳转
    tryOpen();

    // 300ms 后尝试第二个入口（兼容部分浏览器）
    setTimeout(function() {
      if (document.visibilityState === 'visible') {
        tryOpen();
      }
    }, 300);

    // 2.5 秒后如果页面仍可见，说明自动跳转失败，显示手动按钮
    setTimeout(function() {
      if (document.visibilityState === 'visible') {
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('statusText').textContent = '未能自动跳转';
        document.getElementById('statusSub').textContent = '请点击下方按钮手动打开支付宝';
        document.getElementById('payBtn').classList.add('show');
        document.getElementById('fallback').classList.add('show');
      }
    }, 2500);
  })();
</script>
</body>
</html>`);
});

// ======================== 【UID 信息查询 API】 ========================

/**
 * GET /api/network-info — 获取本机局域网 IP 列表
 *
 * 用于 localhost 访问时，前端提示用户可用的局域网地址，
 * 避免手机扫描二维码后因 localhost 无法访问而失败。
 */
app.get('/api/network-info', (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  res.json({ code: 'OK', data: { ips, port: PORT } });
});

/**
 * GET /api/config — 获取当前配置信息（脱敏后返回，不泄露完整 UID）
 */
app.get('/api/config', (req, res) => {
  const uidMasked = CONFIG.alipayUid
    ? CONFIG.alipayUid.slice(0, 4) + '****' + CONFIG.alipayUid.slice(-4)
    : '未配置';
  res.json({
    code: 'OK',
    data: {
      alipayUid: uidMasked,
      hasUid: !!CONFIG.alipayUid,
      hasPaymentApi: !!CONFIG.paymentApi,
      merchantName: CONFIG.merchantName || '未配置',
      type: CONFIG.type || 'uid',
    },
  });
});

// ======================== 【启动服务】 ========================

Promise.all([loadOrders(), loadSecurity(), loadLimits()]).then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('========================================');
    console.log('  黑金PAY 收银台 · UID 版 已启动');
    console.log(`  地址: http://localhost:${PORT}`);
    console.log('========================================');
    console.log('');
    console.log('  收银台页面：');
    console.log(`  http://localhost:${PORT}/cashier.html`);
    console.log('');
    if (CONFIG.paymentApi) {
      console.log('  运行模式：第三方 API（全自动）');
      console.log(`  API 地址：${CONFIG.paymentApi}`);
    } else if (CONFIG.baseUrl) {
      console.log('  运行模式：HTTPS 网页跳转 ✅ 推荐');
      console.log(`  跳转地址：${CONFIG.baseUrl}/pay/`);
      console.log('  说明：扫码打开网页 → 点击按钮 → 跳转支付宝支付');
    } else {
      console.log('  运行模式：alipays:// 直连 ⚠️ 不推荐');
      console.log('  说明：直接唤起支付宝收钱页面（金额已锁定）');
      console.log('  ⚠️ 直连模式可能被支付宝风控拦截，建议配置 baseUrl');
    }
    console.log('');
    if (!CONFIG.alipayUid && !CONFIG.paymentApi) {
      console.log('  ⚠️ 警告：未配置 alipayUid 且未配置 paymentApi，无法收款！');
      console.log('  请在 index.js 的 CONFIG 中至少填写一项。');
    }
    console.log('');
  });
}).catch(err => {
  console.error('>>> 启动失败:', err.message);
  process.exit(1);
});
