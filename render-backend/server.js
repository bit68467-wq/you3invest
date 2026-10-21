import crypto from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';
import { PLANS, contractMaturityAt } from '../investment-model.js';
import { DAILY_TICKET_POOL, REWARDS, chooseDailyPrize } from '../rewards-model.js';
import marketApi from '../server.js';

const { Pool } = pg;
const scrypt = promisify(crypto.scrypt);
const app = express();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
const port = Number(process.env.PORT || 3000);
const sessionHours = Math.max(1, Math.min(720, Number(process.env.SESSION_TTL_HOURS) || 168));
const networks = {
  bep20: { asset: 'BNB', label: 'BNB · BNB Smart Chain', env: 'DEPOSIT_ADDRESS_BNB_BEP20' },
  trc20: { asset: 'USDT', label: 'USDT · TRON TRC-20', env: 'DEPOSIT_ADDRESS_USDT_TRC20' },
  bitcoin: { asset: 'BTC', label: 'BTC · Bitcoin', env: 'DEPOSIT_ADDRESS_BTC' },
};
const now = () => Date.now();
const id = () => crypto.randomUUID();
const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const fee = (gross, rate) => roundMoney(roundMoney(gross) * rate);
const transaction = (type, amount, network = '', status = 'completed', extra = {}) => ({ id: id(), type, amount, network, status, date: now(), ...extra });
function pointEntry(data, amount, type, label, extra = {}) {
  data.pointHistory ||= [];
  const entry = { id: id(), amount, type, label, date: now(), ...extra };
  data.pointHistory.unshift(entry);
  return entry;
}
async function insertPlatformFee(client, { accountId, type, grossAmount, feeAmount, referenceId, createdAt = now() }) {
  if (feeAmount <= 0) return;
  await client.query(
    'INSERT INTO platform_fee_ledger (id,account_id,type,gross_amount,fee_amount,reference_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id(),accountId,type,roundMoney(grossAmount),roundMoney(feeAmount),referenceId || null,createdAt],
  );
}
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const json = (res, data, status = 200) => res.status(status).json(data);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const authAttempts = new Map();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));

function baseAccount({ id: accountId, username, email, role = 'user', createdAt = now(), data = {} }) {
  return {
    id: accountId, username, email, role, status: 'approved', createdAt, revision: 1,
    wallet: { deposit: 0, earnings: 0, unlocked: 0 }, investments: [], transactions: [],
    depositRequests: [], withdrawalRequests: [], preferences: { language: 'en', theme: 'dark' },
    withdrawalWallet: null, walletChangeRequests: [], withdrawalPinSet: false,
    h9Points: 0, bonusSpins: 0, pointHistory: [], referralCode: crypto.randomBytes(8).toString('hex').slice(0, 12).toUpperCase(),
    referrals: [], activeBonuses: [], rewardRedemptions: [], dailyPrizes: [], lastDailyPrizeDate: null, customPlanSubscription: null,
    ...data,
  };
}

async function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function passwordMatches(password, salt, storedHash) {
  if (!salt || !storedHash) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(storedHash, 'hex');
  return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
}

function publicAccount(row, depositRequests = []) {
  const data = { ...(row.account_data || {}) };
  delete data.withdrawalPinHash;
  delete data.withdrawalPinSalt;
  const recoveryKeySet = Boolean(data.recoveryKeyIssuer && data.recoveryKeyHash && data.recoveryKeySalt);
  delete data.recoveryKeyIssuer;
  delete data.recoveryKeyHash;
  delete data.recoveryKeySalt;
  data.recoveryKeySet = recoveryKeySet;
  data.wallet ||= { deposit: 0, earnings: 0, unlocked: 0 };
  data.wallet.unlocked = Number(data.wallet.unlocked) || 0;
  return {
    ...data,
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    status: row.status,
    createdAt: Number(row.created_at),
    revision: Number(row.revision),
    depositRequests,
    withdrawalRequests: data.withdrawalRequests || [],
    withdrawalPinSet: Boolean(data.withdrawalPinSet),
  };
}

function depositView(row) {
  return {
    id: row.id,
    amount: Number(row.amount),
    amountCurrency: row.amount_currency || 'crypto',
    asset: row.asset,
    network: row.network,
    depositAddress: row.deposit_address,
    txHash: row.tx_hash,
    status: row.status,
    creditUsdt: row.credit_usdt == null ? null : Number(row.credit_usdt),
    grossCreditUsdt: row.gross_usdt == null ? null : Number(row.gross_usdt),
    feeAmount: row.fee_usdt == null ? null : Number(row.fee_usdt),
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    transactionId: row.transaction_id,
  };
}

async function getAccount(row) {
  const { rows } = await pool.query(
    'SELECT * FROM deposit_requests WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100',
    [row.id],
  );
  return publicAccount(row, rows.map(depositView));
}

function requireAuth(req, res, next) {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token || token.length > 256) return json(res, { error: 'Sign in to continue.' }, 401);
  pool.query(
    'SELECT a.*, s.expires_at FROM app_sessions s JOIN app_accounts a ON a.id = s.account_id WHERE s.token_hash = $1 AND s.expires_at > NOW()',
    [hashToken(token)],
  ).then(({ rows }) => {
    if (!rows[0] || rows[0].status !== 'approved') return json(res, { error: 'Session expired. Please log in again.' }, 401);
    req.account = rows[0];
    next();
  }).catch(next);
}

function requireAdmin(req, res, next) {
  if (req.account?.role !== 'admin') return json(res, { error: 'Not authorized.' }, 403);
  next();
}

function authRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const entry = authAttempts.get(key) || { count: 0, resetAt: now() + 15 * 60_000 };
  if (entry.resetAt <= now()) { entry.count = 0; entry.resetAt = now() + 15 * 60_000; }
  entry.count += 1;
  if (authAttempts.size > 10_000) {
    for (const [ip, attempt] of authAttempts) if (attempt.resetAt <= now()) authAttempts.delete(ip);
  }
  authAttempts.set(key, entry);
  if (entry.count > 30) return json(res, { error: 'Too many attempts. Try again later.' }, 429);
  next();
}

function safeTxHash(network, value) {
  const hash = String(value || '').trim();
  if (network === 'bep20') return /^0x[a-fA-F0-9]{64}$/.test(hash) ? hash.toLowerCase() : '';
  return /^[a-fA-F0-9]{64}$/.test(hash) ? hash.toLowerCase() : '';
}

function getDepositAddresses() {
  return Object.fromEntries(Object.entries(networks).map(([key, config]) => [key, String(process.env[config.env] || '').trim()]));
}

function validWithdrawalAddress(network, address) {
  if (network === 'bep20') return /^0x[a-fA-F0-9]{40}$/.test(address);
  if (network === 'trc20') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  if (network === 'bitcoin') return /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i.test(address);
  return false;
}

async function loadMarketQuotes() {
  try {
    const response = await marketApi.fetch(new Request('https://render.local/api/asset-prices'));
    const data = await response.json();
    const keys = { Gold: 'gold', Oil: 'oil', Electricity: 'electricity', 'S&P 500': 'sp500', NASDAQ: 'nasdaq', Tesla: 'tesla', 'Artificial intelligence': 'artificialIntelligence', Bitcoin: 'bitcoin', Ethereum: 'ethereum' };
    return Object.fromEntries(Object.entries(keys).flatMap(([name, key]) => {
      const price = Number(data?.quotes?.[key]?.price);
      return Number.isFinite(price) && price > 0 ? [[name, price]] : [];
    }));
  } catch { return {}; }
}

function markInvestments(data, quotes = {}) {
  data.wallet ||= { deposit: 0, earnings: 0, unlocked: 0 };
  data.wallet.unlocked = Number(data.wallet.unlocked) || 0;
  data.investments ||= [];
  data.transactions ||= [];
  const fees = [];
  for (const investment of data.investments) {
    if (investment.status !== 'active') continue;
    investment.marketTrackingValue = Number.isFinite(Number(investment.marketTrackingValue))
      ? Number(investment.marketTrackingValue) : Number(investment.marketValue) || Number(investment.principal);
    const basis = Array.isArray(investment.marketBasis) ? investment.marketBasis : [];
    const totalWeight = basis.reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
    if (totalWeight > 0) {
      const prices = investment.lastMarketPrices || {};
      let weightedMove = 0;
      for (const item of basis) {
        const previous = Number(prices[item.name]) || Number(item.price);
        const current = Number(quotes[item.name]) || previous;
        weightedMove += (Number(item.weight) / totalWeight) * (previous > 0 && current > 0 ? current / previous : 1);
        if (current > 0) prices[item.name] = current;
      }
      investment.lastMarketPrices = prices;
      investment.marketTrackingValue = Math.max(0, investment.marketTrackingValue * weightedMove);
    }
    const principal = Number(investment.principal) || 0;
    const floor = principal * (1 - Math.min(80, Math.max(1, Number(investment.stopLossPercent) || 20)) / 100);
    investment.protectionSuspended = investment.marketTrackingValue <= floor;
    investment.marketValue = investment.protectionSuspended ? floor : investment.marketTrackingValue;
    investment.compoundBalance = Math.max(0, investment.marketValue - principal);
    if (!investment.protectionSuspended && investment.autoRedeemEnabled === true) {
      const previous = Math.max(0, Number(investment.previousRedeemable) || 0);
      const current = Math.max(0, investment.marketValue - principal);
      const gross = roundMoney(Math.max(0, current - previous) * Math.min(100, Math.max(1, Number(investment.autoRedeemPercent) || 100)) / 100);
      if (gross > 0) {
        const feeAmount = fee(gross, 0.01);
        const net = roundMoney(gross - feeAmount);
        investment.marketValue = roundMoney(investment.marketValue - gross);
        investment.marketTrackingValue = roundMoney(investment.marketTrackingValue - gross);
        investment.compoundBalance = Math.max(0, investment.marketValue - principal);
        investment.earningsRedeemedGross = roundMoney((Number(investment.earningsRedeemedGross) || 0) + gross);
        data.wallet.earnings = roundMoney(Number(data.wallet.earnings || 0) + net);
        data.transactions.unshift({ id: id(), type: 'earning-redemption', amount: net, grossAmount: gross, feeAmount, investmentId: investment.id, planName: investment.planName, automatic: true, status: 'completed', date: now() });
        fees.push({ accountId: data.id, type: 'earnings-redemption', grossAmount: gross, feeAmount, referenceId: investment.id });
      }
    }
    investment.previousRedeemable = Math.max(0, investment.marketValue - principal);
    const maturityAt = Number(investment.maturityAt) || Number(investment.startedAt) + Number(investment.days) * 86_400_000;
    investment.maturityAt = maturityAt;
    if (now() >= maturityAt) {
      investment.status = 'matured'; investment.maturedAt = maturityAt; investment.compoundBalance = 0;
      data.wallet.unlocked = roundMoney(Number(data.wallet.unlocked || 0) + Number(investment.marketValue || 0));
      data.transactions.unshift({ id: id(), type: 'maturity', amount: Number(investment.marketValue || 0), status: 'completed', investmentId: investment.id, planName: investment.planName, date: maturityAt });
    }
  }
  return fees;
}

async function saveLockedAccount(client, row, data, fees = []) {
  data.id = row.id;
  await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data), row.id]);
  for (const item of fees) await insertPlatformFee(client, { ...item, accountId: item.accountId || row.id, createdAt: item.createdAt || now() });
}
app.post('/api/auth/register', authRateLimit, async (req, res, next) => {
  const username = String(req.body?.username || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (username.length < 3 || username.length > 30 || !emailPattern.test(email) || password.length < 12 || password.length > 200) {
    return json(res, { error: 'Use a valid username and email, and a password of at least 12 characters.' }, 400);
  }
  if (email === adminEmail) return json(res, { error: 'This email is reserved.' }, 409);
  try {
    const credentials = await passwordHash(password);
    let referralCode;
    do {
      referralCode = crypto.randomBytes(8).toString('hex').slice(0, 12).toUpperCase();
    } while ((await pool.query("SELECT 1 FROM app_accounts WHERE account_data->>'referralCode'=$1 LIMIT 1", [referralCode])).rowCount);
    const token = crypto.randomBytes(32).toString('base64url');
    const client = await pool.connect();
    let account;
    try {
      await client.query('BEGIN');
      const inviteCode = String(req.body?.referralCode || '').trim().toUpperCase();
      const inviter = inviteCode ? (await client.query("SELECT * FROM app_accounts WHERE UPPER(account_data->>'referralCode')=$1 AND id<>$2 FOR UPDATE", [inviteCode, ''])).rows[0] : null;
      account = baseAccount({ id: id(), username, email, data: {
        referralCode, h9Points: inviter ? 25 : 0, invitedBy: inviter?.id || null,
        preferences: { language: ['en','fr','es','de','pt','hi','zh','it'].includes(req.body?.language) ? req.body.language : 'en', theme: 'dark' },
      } });
      if (inviter) {
        const inviterData = inviter.account_data || {};
        inviterData.h9Points = (Number(inviterData.h9Points) || 0) + 10;
        pointEntry(inviterData, 10, 'referral', `Invitation accepted · ${username}`, { referredAccountId: account.id });
        inviterData.referrals ||= [];
        inviterData.referrals.unshift({ id: account.id, username, date: now(), points: 10 });
        await saveLockedAccount(client, inviter, inviterData);
        pointEntry(account, 25, 'referral-welcome', 'Welcome points');
      }
      await client.query(
        'INSERT INTO app_accounts (id, username, email, role, status, password_salt, password_hash, account_data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
        [account.id, username, email, 'user', 'approved', credentials.salt, credentials.hash, JSON.stringify(account), account.createdAt],
      );
      await client.query("INSERT INTO app_sessions (token_hash, account_id, expires_at) VALUES ($1,$2,NOW() + ($3 * INTERVAL '1 hour'))", [hashToken(token), account.id, sessionHours]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    return json(res, { token, account }, 201);
  } catch (error) {
    if (error.code === '23505') return json(res, { error: 'Email or username is already in use.' }, 409);
    next(error);
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!emailPattern.test(email) || !password || password.length > 200) return json(res, { error: 'Email or password is incorrect.' }, 401);
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    let row = (await pool.query('SELECT * FROM app_accounts WHERE email = $1', [email])).rows[0];
    if (email === adminEmail && process.env.ADMIN_PASSWORD_HASH) {
      if (!await passwordMatches(password, process.env.ADMIN_PASSWORD_SALT, process.env.ADMIN_PASSWORD_HASH)) {
        return json(res, { error: 'Email or password is incorrect.' }, 401);
      }
      if (!row) {
        const credentials = await passwordHash(password, process.env.ADMIN_PASSWORD_SALT);
        const data = baseAccount({ id: id(), username: 'Admin-' + id().slice(0, 8), email, role: 'admin' });
        row = (await pool.query(
          'INSERT INTO app_accounts (id,username,email,role,status,password_salt,password_hash,account_data,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING *',
          [data.id,data.username,email,'admin','approved',credentials.salt,credentials.hash,JSON.stringify(data),data.createdAt],
        )).rows[0];
      } else if (row.role !== 'admin') {
        return json(res, { error: 'Admin account configuration conflict.' }, 503);
      }
    } else if (!row || row.role === 'admin' || !await passwordMatches(password, row.password_salt, row.password_hash)) {
      return json(res, { error: 'Email or password is incorrect.' }, 401);
    }
    if (row.status !== 'approved') return json(res, { error: 'This account is not active.' }, 403);
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO app_sessions (token_hash, account_id, expires_at) VALUES ($1,$2,NOW() + ($3 * INTERVAL '1 hour'))", [hashToken(token), row.id, sessionHours]);
    return json(res, { token, account: await getAccount(row) });
  } catch (error) { next(error); }
});

app.post('/api/admin/recovery-key', requireAuth, requireAdmin, async (req, res, next) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!emailPattern.test(email)) return json(res, { error: 'Enter a valid account email.' }, 400);
  const recoveryCode = crypto.randomBytes(24).toString('hex').toUpperCase();
  try {
    const credentials = await passwordHash(recoveryCode);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM app_accounts WHERE email=$1 FOR UPDATE', [email])).rows[0];
      if (!row) { await client.query('ROLLBACK'); return json(res, { error: 'No registered account was found.' }, 404); }
      const data = row.account_data || {};
      data.recoveryKeySalt = credentials.salt;
      data.recoveryKeyHash = credentials.hash;
      data.recoveryKeyIssuer = req.account.id;
      await saveLockedAccount(client, row, data);
      await client.query('DELETE FROM password_reset_tokens WHERE account_id=$1', [row.id]);
      await client.query('COMMIT');
      const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
      return json(res, { account: await getAccount(updated), recoveryCode });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  } catch (error) { next(error); }
});

app.post('/api/auth/password-reset/request', authRateLimit, async (req, res, next) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const recoveryCode = String(req.body?.recoveryCode || '').replace(/\s/g, '').toUpperCase();
  if (!emailPattern.test(email) || !recoveryCode || recoveryCode.length > 128) return json(res, { error: 'Email or recovery key is incorrect. Request an admin-issued key from support.' }, 400);
  try {
    const row = (await pool.query('SELECT * FROM app_accounts WHERE email=$1', [email])).rows[0];
    const data = row?.account_data || {};
    if (!row || !data.recoveryKeySalt || !await passwordMatches(recoveryCode, data.recoveryKeySalt, data.recoveryKeyHash)) {
      return json(res, { error: 'Email or recovery key is incorrect. Request an admin-issued key from support.' }, 400);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query('DELETE FROM password_reset_tokens WHERE account_id=$1 OR expires_at<=NOW()', [row.id]);
    await pool.query("INSERT INTO password_reset_tokens (token_hash,account_id,expires_at) VALUES ($1,$2,NOW() + INTERVAL '15 minutes')", [hashToken(token), row.id]);
    return json(res, { token });
  } catch (error) { next(error); }
});

app.post('/api/auth/password-reset/confirm', authRateLimit, async (req, res, next) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!token || token.length > 256 || password.length < 8 || password.length > 200) return json(res, { error: 'Enter a valid reset token and a password of at least 8 characters.' }, 400);
  try {
    const credentials = await passwordHash(password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const reset = (await client.query('SELECT * FROM password_reset_tokens WHERE token_hash=$1 AND expires_at>NOW() FOR UPDATE', [hashToken(token)])).rows[0];
      if (!reset) { await client.query('ROLLBACK'); return json(res, { error: 'This password reset has expired or was already used.' }, 400); }
      const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [reset.account_id])).rows[0];
      if (!row) { await client.query('ROLLBACK'); return json(res, { error: 'Account not found.' }, 404); }
      await client.query('UPDATE app_accounts SET password_salt=$1,password_hash=$2,revision=revision+1 WHERE id=$3', [credentials.salt, credentials.hash, row.id]);
      await client.query('DELETE FROM app_sessions WHERE account_id=$1', [row.id]);
      await client.query('DELETE FROM password_reset_tokens WHERE account_id=$1', [row.id]);
      await client.query('COMMIT');
      return json(res, { ok: true });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  } catch (error) { next(error); }
});

app.put('/api/auth/password', requireAuth, async (req, res, next) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 8 || newPassword.length > 200) return json(res, { error: 'New password must contain at least 8 characters.' }, 400);
  try {
    if (!await passwordMatches(currentPassword, req.account.password_salt, req.account.password_hash)) return json(res, { error: 'Current password is incorrect.' }, 403);
    const credentials = await passwordHash(newPassword);
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const tokenHash = hashToken(token);
    await pool.query('UPDATE app_accounts SET password_salt=$1,password_hash=$2,revision=revision+1 WHERE id=$3', [credentials.salt, credentials.hash, req.account.id]);
    await pool.query('DELETE FROM app_sessions WHERE account_id=$1 AND token_hash<>$2', [req.account.id, tokenHash]);
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [req.account.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    await pool.query('DELETE FROM app_sessions WHERE token_hash = $1', [hashToken(token)]);
    return json(res, { ok: true });
  } catch (error) { next(error); }
});

app.get('/api/account', requireAuth, async (req, res, next) => {
  try { return json(res, { account: await getAccount(req.account) }); }
  catch (error) { next(error); }
});

app.put('/api/account', requireAuth, async (req, res, next) => {
  try {
    const current = req.account.account_data || {};
    const preferences = req.body?.preferences;
    if (!preferences || typeof preferences !== 'object') return json(res, { error: 'Invalid account update.' }, 400);
    const data = { ...current, preferences: {
      language: ['en','fr','es','de','pt','hi','zh','it'].includes(preferences.language) ? preferences.language : current.preferences?.language || 'en',
      theme: ['dark','light'].includes(preferences.theme) ? preferences.theme : current.preferences?.theme || 'dark',
    } };
    const result = await pool.query('UPDATE app_accounts SET account_data=$1::jsonb, revision=revision+1 WHERE id=$2 RETURNING *', [JSON.stringify(data), req.account.id]);
    return json(res, { account: await getAccount(result.rows[0]) });
  } catch (error) { next(error); }
});

app.put('/api/admin/account', requireAuth, requireAdmin, async (req, res, next) => {
  const targetId = String(req.body?.id || '');
  const wallet = req.body?.wallet;
  const status = String(req.body?.status || 'approved');
  if (!targetId || !wallet || !Number.isFinite(Number(wallet.deposit)) || !Number.isFinite(Number(wallet.earnings)) || Number(wallet.deposit) < 0 || Number(wallet.earnings) < 0 || !['approved','blocked','pending','rejected'].includes(status)) {
    return json(res, { error: 'Enter valid non-negative balances and account status.' }, 400);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return json(res, { error: 'Account not found.' }, 404); }
    const data = row.account_data || {};
    const previous = data.wallet || { deposit: 0, earnings: 0, unlocked: 0 };
    data.wallet = { deposit: roundMoney(wallet.deposit), earnings: roundMoney(wallet.earnings), unlocked: Number(previous.unlocked) || 0 };
    if (Array.isArray(req.body.transactions)) data.transactions = req.body.transactions.slice(0, 2000);
    for (const [bucket, amount] of [['deposit',data.wallet.deposit],['earnings',data.wallet.earnings]]) {
      const difference = roundMoney(amount - (Number(previous[bucket]) || 0));
      if (difference) {
        data.transactions ||= [];
        data.transactions.unshift(transaction('admin-balance-adjustment', difference, '', 'completed', { balanceType: bucket, adminId: req.account.id, note: 'Manual administrator adjustment' }));
      }
    }
    await client.query('UPDATE app_accounts SET account_data=$1::jsonb,status=$2,revision=revision+1 WHERE id=$3', [JSON.stringify(data),status,targetId]);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [targetId])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.get('/api/deposit-addresses', requireAuth, (req, res) => {
  if (process.env.ENABLE_CRYPTO_DEPOSITS !== 'true' && req.account.role !== 'admin') return json(res, { error: 'Crypto deposits are temporarily disabled.' }, 503);
  const addresses = getDepositAddresses();
  if (Object.values(addresses).some((value) => !value)) return json(res, { error: 'Deposit service is not fully configured.' }, 503);
  return json(res, { addresses });
});

app.post('/api/deposits', requireAuth, async (req, res, next) => {
  if (process.env.ENABLE_CRYPTO_DEPOSITS !== 'true') return json(res, { error: 'Crypto deposits are temporarily disabled.' }, 503);
  try {
    const network = String(req.body?.network || '');
    const config = networks[network];
    const rawAmount = Number(req.body?.amount);
    const amount = Number.isFinite(rawAmount) ? Number(rawAmount.toFixed(2)) : NaN;
    const txHash = safeTxHash(network, req.body?.txHash);
    const address = getDepositAddresses()[network];
    if (!config || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 || !txHash || !address) {
      return json(res, { error: 'Enter a valid USD amount, network and transaction hash.' }, 400);
    }
    if (String(req.body?.depositAddress || '') !== address) return json(res, { error: 'The deposit address changed. Reopen the request and use the current address.' }, 409);
    const requestId = id();
    const transactionId = id();
    const createdAt = now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO deposit_requests (id,account_id,network,asset,amount,amount_currency,deposit_address,tx_hash,status,transaction_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [requestId,req.account.id,network,config.asset,amount,'USD',address,txHash,'pending',transactionId,createdAt],
      );
      const data = req.account.account_data || {};
      data.transactions ||= [];
      data.transactions.unshift({ id: transactionId, type: 'deposit', amount: 0, network, status: 'pending', date: createdAt, requestId });
      await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data), req.account.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505') return json(res, { error: 'This transaction hash has already been submitted.' }, 409);
      throw error;
    } finally { client.release(); }
    const refreshed = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [req.account.id])).rows[0];
    return json(res, { account: await getAccount(refreshed) }, 201);
  } catch (error) { next(error); }
});

app.get('/api/admin/accounts', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [accounts, deposits] = await Promise.all([
      pool.query('SELECT * FROM app_accounts ORDER BY created_at DESC LIMIT 500'),
      pool.query('SELECT * FROM deposit_requests ORDER BY created_at DESC LIMIT 1000'),
    ]);
    const byAccount = new Map();
    for (const row of deposits.rows) {
      const list = byAccount.get(row.account_id) || [];
      list.push(depositView(row));
      byAccount.set(row.account_id, list);
    }
    return json(res, { accounts: accounts.rows.map((row) => publicAccount(row, byAccount.get(row.id) || [])) });
  } catch (error) { next(error); }
});

app.post('/api/admin/rewards/credit', requireAuth, requireAdmin, async (req, res, next) => {
  const accountId = String(req.body?.accountId || '');
  const points = Number(req.body?.points || 0);
  const spins = Number(req.body?.spins || 0);
  if (!Number.isSafeInteger(points) || points < 0 || !Number.isSafeInteger(spins) || spins < 0 || (!points && !spins)) return json(res, { error: 'Enter a positive whole number of points or extra spins.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return json(res, { error: 'Account not found.' }, 404); }
    const data = row.account_data || {};
    data.h9Points = Number(data.h9Points) || 0;
    data.bonusSpins = Number(data.bonusSpins) || 0;
    if (!Number.isSafeInteger(data.h9Points + points) || !Number.isSafeInteger(data.bonusSpins + spins)) { await client.query('ROLLBACK'); return json(res, { error: 'The new points or spin balance is too large.' }, 400); }
    data.h9Points += points;
    data.bonusSpins += spins;
    if (points) pointEntry(data, points, 'admin-credit', 'Points credited by admin', { adminId: req.account.id });
    await saveLockedAccount(client, row, data);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/admin/deposits/:id/approve', requireAuth, requireAdmin, async (req, res, next) => {
  const rawCreditUsdt = Number(req.body?.creditUsdt);
  const creditUsdt = Number.isFinite(rawCreditUsdt) ? Number(rawCreditUsdt.toFixed(8)) : NaN;
  if (!Number.isFinite(creditUsdt) || creditUsdt <= 0 || creditUsdt > 1_000_000_000) return json(res, { error: 'Enter the verified USDT amount to credit.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deposit = (await client.query('SELECT * FROM deposit_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!deposit || deposit.status !== 'pending') { await client.query('ROLLBACK'); return json(res, { error: 'Deposit not found or already reviewed.' }, 409); }
    const accountRow = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [deposit.account_id])).rows[0];
    if (!accountRow || accountRow.status !== 'approved') { await client.query('ROLLBACK'); return json(res, { error: 'Account is not active.' }, 409); }
    const data = accountRow.account_data || {};
    const grossAmount = roundMoney(creditUsdt);
    const feeAmount = fee(grossAmount, 0.01);
    const creditedAmount = roundMoney(grossAmount - feeAmount);
    data.wallet ||= { deposit: 0, earnings: 0 };
    data.wallet.deposit = roundMoney(Number(data.wallet.deposit || 0) + creditedAmount);
    data.transactions ||= [];
    const reviewedAt = now();
    const tx = data.transactions.find((item) => item.id === deposit.transaction_id);
    if (tx) Object.assign(tx, { status: 'confirmed', amount: creditedAmount, creditedUsdt: creditedAmount, grossAmount, feeAmount, reviewedAt });
    await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),accountRow.id]);
    await client.query('UPDATE deposit_requests SET status=$1,credit_usdt=$2,gross_usdt=$3,fee_usdt=$4,reviewed_at=$5,reviewed_by=$6 WHERE id=$7', ['confirmed',creditedAmount,grossAmount,feeAmount,reviewedAt,req.account.id,deposit.id]);
    await client.query('INSERT INTO deposit_ledger (id,account_id,deposit_id,credit_usdt,balance_after_usdt,created_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id(),accountRow.id,deposit.id,creditedAmount,Number(data.wallet.deposit),reviewedAt,req.account.id]);
    await insertPlatformFee(client, { accountId: accountRow.id, type: 'deposit', grossAmount, feeAmount, referenceId: deposit.id, createdAt: reviewedAt });
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [accountRow.id])).rows[0];
    return json(res, { account: await getAccount(updated), depositId: deposit.id, grossAmount, feeAmount, creditedAmount });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/admin/deposits/:id/reject', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const deposit = (await client.query('SELECT * FROM deposit_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!deposit || deposit.status !== 'pending') { await client.query('ROLLBACK'); return json(res, { error: 'Deposit not found or already reviewed.' }, 409); }
      const accountRow = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [deposit.account_id])).rows[0];
      const data = accountRow?.account_data || {};
      const tx = (data.transactions || []).find((item) => item.id === deposit.transaction_id);
      const reviewedAt = now();
      if (tx) { tx.status = 'rejected'; tx.reviewedAt = reviewedAt; }
      await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),deposit.account_id]);
      await client.query('UPDATE deposit_requests SET status=$1,reviewed_at=$2,reviewed_by=$3 WHERE id=$4', ['rejected',reviewedAt,req.account.id,deposit.id]);
      await client.query('COMMIT');
      const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [deposit.account_id])).rows[0];
      return json(res, { account: await getAccount(updated), depositId: deposit.id });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) { next(error); }
});

app.get('/api/asset-prices', async (req, res, next) => {
  try {
    const response = await marketApi.fetch(new Request('https://render.local/api/asset-prices'));
    return json(res, await response.json(), response.status);
  } catch (error) { next(error); }
});
app.get('/api/asset-history', async (req, res, next) => {
  try {
    const response = await marketApi.fetch(new Request('https://render.local/api/asset-history'));
    return json(res, await response.json(), response.status);
  } catch (error) { next(error); }
});
app.get('/api/admin/deposit-addresses', requireAuth, requireAdmin, (req, res) => json(res, { addresses: getDepositAddresses() }));
app.get('/api/admin/platform-fees', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [totals, entries] = await Promise.all([
      pool.query('SELECT type, COALESCE(SUM(gross_amount),0) AS gross_amount, COALESCE(SUM(fee_amount),0) AS fee_amount FROM platform_fee_ledger GROUP BY type ORDER BY type'),
      pool.query('SELECT type,gross_amount,fee_amount,reference_id,created_at FROM platform_fee_ledger ORDER BY created_at DESC LIMIT 200'),
    ]);
    return json(res, { totals: totals.rows.map((item) => ({ type: item.type, grossAmount: Number(item.gross_amount), feeAmount: Number(item.fee_amount) })), entries: entries.rows.map((item) => ({ type: item.type, grossAmount: Number(item.gross_amount), feeAmount: Number(item.fee_amount), referenceId: item.reference_id, date: Number(item.created_at) })) });
  } catch (error) { next(error); }
});
app.post('/api/withdrawal-wallet', requireAuth, async (req, res, next) => {
  try {
    const network = String(req.body?.network || '');
    const address = String(req.body?.address || '').trim();
    if (!networks[network] || !validWithdrawalAddress(network, address)) return json(res, { error: 'Enter a valid network and wallet address.' }, 400);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
      const data = row.account_data || {};
      if (!data.withdrawalWallet) data.withdrawalWallet = { network, address, linkedAt: now() };
      else if (data.withdrawalWallet.network === network && data.withdrawalWallet.address === address) { await client.query('ROLLBACK'); return json(res, { error: 'This wallet is already linked.' }, 409); }
      else {
        data.walletChangeRequests ||= [];
        if (data.walletChangeRequests.some((item) => item.status === 'pending')) { await client.query('ROLLBACK'); return json(res, { error: 'A wallet change request is already awaiting admin review.' }, 409); }
        data.walletChangeRequests.unshift({ id: id(), network, address, status: 'pending', createdAt: now(), previousNetwork: data.withdrawalWallet.network, previousAddress: data.withdrawalWallet.address });
      }
      await saveLockedAccount(client, row, data);
      await client.query('COMMIT');
      const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
      return json(res, { account: await getAccount(updated), requested: Boolean(data.walletChangeRequests?.[0]?.status === 'pending') });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) { next(error); }
});

app.put('/api/auth/withdrawal-password', requireAuth, async (req, res, next) => {
  try {
    const loginPassword = String(req.body?.loginPassword || '');
    const pin = String(req.body?.pin || '');
    if (!/^\d{6}$/.test(pin)) return json(res, { error: 'Withdrawal password must contain exactly 6 digits.' }, 400);
    if (!await passwordMatches(loginPassword, req.account.password_salt, req.account.password_hash)) return json(res, { error: 'Login password is incorrect.' }, 403);
    if (await passwordMatches(pin, req.account.password_salt, req.account.password_hash)) return json(res, { error: 'Withdrawal password must differ from the login password.' }, 400);
    const credentials = await passwordHash(pin);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
      const data = row.account_data || {};
      data.withdrawalPinSalt = credentials.salt; data.withdrawalPinHash = credentials.hash; data.withdrawalPinSet = true;
      await saveLockedAccount(client, row, data);
      await client.query('COMMIT');
      const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
      return json(res, { account: await getAccount(updated) });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  } catch (error) { next(error); }
});

app.post('/api/admin/wallet-change', requireAuth, requireAdmin, async (req, res, next) => {
  const accountId = String(req.body?.accountId || '');
  const requestId = String(req.body?.requestId || '');
  const decision = String(req.body?.decision || '');
  if (!accountId || !requestId || !['approve','reject'].includes(decision)) return json(res, { error: 'Invalid wallet review request.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return json(res, { error: 'Account not found.' }, 404); }
    const data = row.account_data || {};
    const request = (data.walletChangeRequests || []).find((item) => item.id === requestId && item.status === 'pending');
    if (!request) { await client.query('ROLLBACK'); return json(res, { error: 'Wallet change request not found or already reviewed.' }, 409); }
    if (decision === 'approve') data.withdrawalWallet = { network: request.network, address: request.address, linkedAt: now() };
    request.status = decision === 'approve' ? 'approved' : 'rejected';
    request.reviewedAt = now();
    await saveLockedAccount(client, row, data);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/withdrawals', requireAuth, async (req, res, next) => {
  const amount = roundMoney(req.body?.amount);
  const source = req.body?.source === 'unlocked' ? 'unlocked' : 'earnings';
  const feeRate = source === 'unlocked' ? 0.20 : 0.04;
  const network = String(req.body?.network || '');
  const address = String(req.body?.address || '').trim();
  const pin = String(req.body?.pin || '');
  if (!Number.isFinite(amount) || amount <= 0 || !networks[network] || !address) return json(res, { error: 'Invalid amount, network or address.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {};
    data.wallet ||= { deposit: 0, earnings: 0, unlocked: 0 };
    data.wallet.unlocked = Number(data.wallet.unlocked) || 0;
    if (amount > Number(data.wallet[source] || 0)) { await client.query('ROLLBACK'); return json(res, { error: 'Insufficient ' + (source === 'unlocked' ? 'released capital' : 'earnings') + ' balance.' }, 400); }
    if (data.withdrawalWallet?.network !== network || data.withdrawalWallet?.address !== address) { await client.query('ROLLBACK'); return json(res, { error: 'Withdrawals must use your linked wallet and network.' }, 400); }
    if (!data.withdrawalPinHash || !await passwordMatches(pin, data.withdrawalPinSalt, data.withdrawalPinHash)) { await client.query('ROLLBACK'); return json(res, { error: 'Withdrawal password is incorrect or not set.' }, 403); }
    const feeAmount = fee(amount, feeRate);
    const payoutAmount = roundMoney(amount - feeAmount);
    const requestId = id(); const transactionId = id(); const createdAt = now();
    data.wallet[source] = roundMoney(Number(data.wallet[source]) - amount);
    data.withdrawalRequests ||= [];
    data.withdrawalRequests.unshift({ id: requestId, transactionId, amount, source, feeRate, feeAmount, payoutAmount, network, address, status: 'pending', createdAt });
    data.transactions ||= [];
    data.transactions.unshift({ id: transactionId, type: 'withdrawal', amount, source, feeRate, feeAmount, payoutAmount, network, status: 'pending', requestId, addressHint: '…' + address.slice(-6), date: createdAt });
    await saveLockedAccount(client, row, data);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated), payoutAmount, feeAmount });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/admin/withdrawals/:id/complete', requireAuth, requireAdmin, async (req, res, next) => {
  const payoutHash = String(req.body?.payoutHash || '').trim();
  if (!payoutHash || payoutHash.length > 300) return json(res, { error: 'Enter the payout transaction hash.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query("SELECT * FROM app_accounts WHERE account_data->'withdrawalRequests' @> $1::jsonb FOR UPDATE", [JSON.stringify([{ id: req.params.id }])]);
    const row = rows.rows[0]; const data = row?.account_data || {};
    const request = (data.withdrawalRequests || []).find((item) => item.id === req.params.id && item.status === 'pending');
    if (!row || !request) { await client.query('ROLLBACK'); return json(res, { error: 'Withdrawal not found or already reviewed.' }, 409); }
    request.status = 'completed'; request.payoutHash = payoutHash; request.reviewedAt = now();
    request.feeRate = request.source === 'unlocked' ? 0.20 : 0.04;
    request.feeAmount = fee(request.amount, request.feeRate); request.payoutAmount = roundMoney(request.amount - request.feeAmount);
    const tx = (data.transactions || []).find((item) => item.id === request.transactionId);
    if (tx) Object.assign(tx, { status: 'completed', payoutHash, feeAmount: request.feeAmount, payoutAmount: request.payoutAmount, reviewedAt: request.reviewedAt });
    await saveLockedAccount(client, row, data, [{ accountId: row.id, type: request.source === 'unlocked' ? 'withdrawal-released-capital' : 'withdrawal-earnings', grossAmount: request.amount, feeAmount: request.feeAmount, referenceId: request.id, createdAt: request.reviewedAt }]);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated), payoutAmount: request.payoutAmount, feeAmount: request.feeAmount });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/admin/withdrawals/:id/reject', requireAuth, requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query("SELECT * FROM app_accounts WHERE account_data->'withdrawalRequests' @> $1::jsonb FOR UPDATE", [JSON.stringify([{ id: req.params.id }])]);
    const row = rows.rows[0]; const data = row?.account_data || {};
    const request = (data.withdrawalRequests || []).find((item) => item.id === req.params.id && item.status === 'pending');
    if (!row || !request) { await client.query('ROLLBACK'); return json(res, { error: 'Withdrawal not found or already reviewed.' }, 409); }
    request.status = 'rejected'; request.reviewedAt = now(); request.feeAmount = 0; request.payoutAmount = 0;
    data.wallet ||= { deposit: 0, earnings: 0, unlocked: 0 };
    const source = request.source === 'unlocked' ? 'unlocked' : 'earnings';
    data.wallet[source] = roundMoney(Number(data.wallet[source] || 0) + Number(request.amount));
    data.transactions ||= [];
    const tx = data.transactions.find((item) => item.id === request.transactionId);
    if (tx) Object.assign(tx, { status: 'rejected', feeAmount: 0, payoutAmount: 0, reviewedAt: request.reviewedAt });
    data.transactions.unshift({ id: id(), type: 'withdrawal-refund', amount: request.amount, status: 'completed', requestId: request.id, date: request.reviewedAt, network: request.network });
    await saveLockedAccount(client, row, data);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/custom-plan/subscribe', requireAuth, async (req, res, next) => {
  const months = Number(req.body?.months);
  if (![6,12,24,36,60].includes(months)) return json(res, { error: 'Choose a valid custom-plan access duration.' }, 400);
  const amount = roundMoney(months * 50 / 12);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {};
    if (data.customPlanSubscription?.expiresAt > now()) { await client.query('ROLLBACK'); return json(res, { error: 'Custom-plan access is already active.' }, 409); }
    data.wallet ||= { deposit: 0, earnings: 0, unlocked: 0 };
    if (Number(data.wallet.deposit || 0) < amount) { await client.query('ROLLBACK'); return json(res, { error: 'Insufficient deposit balance for the selected subscription duration.' }, 400); }
    const startedAt = now();
    const expiresAt = contractMaturityAt(startedAt, months);
    data.wallet.deposit = roundMoney(Number(data.wallet.deposit) - amount);
    data.customPlanSubscription = { startedAt, expiresAt, amount, months };
    const termName = months === 6 ? '6 months' : (months / 12) + (months === 12 ? ' year' : ' years');
    data.transactions ||= [];
    data.transactions.unshift(transaction('subscription', amount, '', 'completed', { planName: 'Custom plan · ' + termName + ' access', balanceType: 'deposit', termMonths: months, accessUntil: expiresAt }));
    await saveLockedAccount(client, row, data);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/investments/add-funds', requireAuth, async (req, res, next) => {
  const investmentId = String(req.body?.investmentId || '');
  const amount = roundMoney(req.body?.amount);
  if (!investmentId || !Number.isFinite(amount) || amount <= 0) return json(res, { error: 'Enter a valid amount.' }, 400);
  const quotes = await loadMarketQuotes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return json(res, { error: 'Account not found.' }, 404);
    }
    const data = row.account_data || {};
    data.wallet ||= { deposit: 0, earnings: 0, unlocked: 0 };
    data.investments ||= [];
    data.transactions ||= [];
    if (amount > Number(data.wallet.deposit || 0)) {
      await client.query('ROLLBACK');
      return json(res, { error: 'Insufficient deposit balance.' }, 400);
    }
    const fees = markInvestments(data, quotes);
    const investment = data.investments.find((item) => item.id === investmentId);
    if (!investment) {
      await client.query('ROLLBACK');
      return json(res, { error: 'Investment not found.' }, 404);
    }
    if (investment.status !== 'active') {
      await saveLockedAccount(client, row, data, fees);
      await client.query('COMMIT');
      return json(res, { error: 'This investment is no longer active.' }, 409);
    }
    investment.principal = roundMoney(Number(investment.principal) + amount);
    const trackingValue = Number.isFinite(Number(investment.marketTrackingValue)) ? Number(investment.marketTrackingValue) : Number(investment.marketValue) || 0;
    investment.marketTrackingValue = roundMoney(trackingValue + amount);
    const stopLossPercent = Math.min(80, Math.max(1, Number(investment.stopLossPercent) || 20));
    const protectionFloor = investment.principal * (1 - stopLossPercent / 100);
    investment.protectionSuspended = investment.marketTrackingValue <= protectionFloor;
    investment.marketValue = investment.protectionSuspended ? protectionFloor : investment.marketTrackingValue;
    investment.compoundBalance = Math.max(0, investment.marketValue - investment.principal);
    investment.previousRedeemable = Math.max(0, investment.marketValue - investment.principal);
    data.wallet.deposit = roundMoney(Number(data.wallet.deposit || 0) - amount);
    data.transactions.unshift({
      id: id(), type: 'investment', amount, additional: true, status: 'completed',
      investmentId: investment.id, planName: investment.planName, date: now(),
    });
    await saveLockedAccount(client, row, data, fees);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/investments', requireAuth, async (req, res, next) => {
  const plan = PLANS.find((item) => item.id === String(req.body?.planId || ''));
  const amount = roundMoney(req.body?.amount);
  if (!plan || !Number.isFinite(amount) || amount <= 0) return json(res, { error: 'Invalid plan or amount.' }, 400);
  const quotes = await loadMarketQuotes();
  const marketBasis = plan.allocations.flatMap((item) => { const price = Number(quotes[item.name]); return Number.isFinite(price) && price > 0 ? [{ name: item.name, price, weight: item.weight }] : []; });
  if (!marketBasis.length) return json(res, { error: 'Live market data is unavailable; try again later.' }, 503);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {}; data.wallet ||= { deposit: 0, earnings: 0 }; data.investments ||= []; data.transactions ||= [];
    if (amount > Number(data.wallet.deposit || 0)) { await client.query('ROLLBACK'); return json(res, { error: 'Insufficient deposit balance.' }, 400); }
    const startedAt = now(); const maturityAt = contractMaturityAt(startedAt, plan.months);
    const investmentId = id(); const initialPrices = Object.fromEntries(marketBasis.map((item) => [item.name, item.price]));
    const investment = { id: investmentId, planId: plan.id, planName: plan.name, days: Math.ceil((maturityAt - startedAt) / 86_400_000), principal: amount, marketValue: amount, marketTrackingValue: amount, startedAt, maturityAt, marketBasis, lastMarketPrices: initialPrices, protectionSuspended: false, stopLossPercent: 20, autoRedeemEnabled: false, autoRedeemPercent: 100, earningsRedeemedGross: 0, previousRedeemable: 0, compoundBalance: 0, status: 'active', allocation: plan.allocations.map((item) => ({ ...item })) };
    data.wallet.deposit = roundMoney(Number(data.wallet.deposit) - amount); data.investments.unshift(investment);
    data.transactions.unshift({ id: id(), type: 'investment', amount, status: 'completed', investmentId, planName: plan.name, date: startedAt });
    await saveLockedAccount(client, row, data); await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) }, 201);
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/earnings/redeem', requireAuth, async (req, res, next) => {
  const quotes = await loadMarketQuotes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {};
    const fees = markInvestments(data, quotes);
    const selected = req.body?.investmentId ? data.investments.filter((item) => item.id === req.body.investmentId) : data.investments;
    if (req.body?.investmentId && !selected.length) { await client.query('ROLLBACK'); return json(res, { error: 'Investment not found.' }, 404); }
    let grossTotal = 0; let feeTotal = 0; let netTotal = 0;
    for (const investment of selected.filter((item) => item.status === 'active')) {
      const gross = roundMoney(Math.max(0, Number(investment.marketValue) - Number(investment.principal)));
      if (gross <= 0) continue;
      const feeAmount = fee(gross, 0.01); const net = roundMoney(gross - feeAmount);
      investment.marketValue = roundMoney(investment.marketValue - gross); investment.marketTrackingValue = investment.marketValue; investment.compoundBalance = 0;
      investment.earningsRedeemedGross = roundMoney((Number(investment.earningsRedeemedGross) || 0) + gross); investment.previousRedeemable = 0;
      data.wallet ||= { deposit: 0, earnings: 0 }; data.wallet.earnings = roundMoney(Number(data.wallet.earnings || 0) + net);
      data.transactions ||= []; data.transactions.unshift({ id: id(), type: 'earning-redemption', amount: net, grossAmount: gross, feeAmount, status: 'completed', investmentId: investment.id, planName: investment.planName, date: now() });
      fees.push({ accountId: row.id, type: 'earnings-redemption', grossAmount: gross, feeAmount, referenceId: investment.id });
      grossTotal = roundMoney(grossTotal + gross); feeTotal = roundMoney(feeTotal + feeAmount); netTotal = roundMoney(netTotal + net);
    }
    if (!grossTotal) {
      await saveLockedAccount(client, row, data, fees); await client.query('COMMIT');
      return json(res, { error: 'There are no redeemable profits available.' }, 400);
    }
    await saveLockedAccount(client, row, data, fees); await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated), amount: netTotal, grossAmount: grossTotal, feeAmount: feeTotal });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/investments/close', requireAuth, async (req, res, next) => {
  const quotes = await loadMarketQuotes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {}; const fees = markInvestments(data, quotes);
    const investment = (data.investments || []).find((item) => item.id === String(req.body?.investmentId || ''));
    if (!investment) { await client.query('ROLLBACK'); return json(res, { error: 'Investment not found.' }, 404); }
    if (investment.status !== 'active') {
      await saveLockedAccount(client, row, data, fees); await client.query('COMMIT');
      return json(res, { error: 'This investment is no longer active.' }, 409);
    }
    const portfolioValue = roundMoney(Math.max(0, Number(investment.marketValue) || 0));
    const redeemed = Number(investment.earningsRedeemedGross) || 0;
    const currentGain = Math.max(0, portfolioValue - Number(investment.principal || 0));
    const gainsDeducted = roundMoney(redeemed + currentGain);
    const penaltyAmount = fee(portfolioValue, 0.65);
    const refund = roundMoney(Math.max(0, portfolioValue - penaltyAmount - gainsDeducted));
    investment.status = 'closed-early'; investment.closedAt = now(); investment.closePortfolioValue = portfolioValue;
    investment.closePenalty = penaltyAmount; investment.closePreviouslyRedeemedGains = roundMoney(redeemed);
    investment.closeCurrentGainsDeducted = roundMoney(currentGain); investment.closeGainsDeducted = gainsDeducted; investment.closeRefund = refund;
    investment.marketValue = 0; investment.marketTrackingValue = 0; investment.compoundBalance = 0; investment.protectionSuspended = false;
    data.wallet ||= { deposit: 0, earnings: 0, unlocked: 0 }; data.wallet.unlocked = roundMoney(Number(data.wallet.unlocked || 0) + refund);
    data.transactions ||= []; data.transactions.unshift({ id: id(), type: 'early-closure', amount: refund, grossAmount: portfolioValue, feeAmount: penaltyAmount, penaltyAmount, gainsAlreadyGenerated: gainsDeducted, portfolioValue, status: 'completed', investmentId: investment.id, planName: investment.planName, date: investment.closedAt });
    if (penaltyAmount > 0) fees.push({ accountId: row.id, type: 'early-closure-penalty', grossAmount: portfolioValue, feeAmount: penaltyAmount, referenceId: investment.id, createdAt: investment.closedAt });
    if (gainsDeducted > 0) fees.push({ accountId: row.id, type: 'early-closure-gains-recovery', grossAmount: gainsDeducted, feeAmount: gainsDeducted, referenceId: investment.id, createdAt: investment.closedAt });
    await saveLockedAccount(client, row, data, fees); await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated), refund, portfolioValue, penaltyAmount, gainsAlreadyGenerated: gainsDeducted });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/investments/mark', requireAuth, async (req, res, next) => {
  const quotes = await loadMarketQuotes();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {}; const fees = markInvestments(data, quotes);
    await saveLockedAccount(client, row, data, fees); await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/investments/auto-redeem', requireAuth, async (req, res, next) => {
  const investmentId = String(req.body?.investmentId || '');
  const enabled = req.body?.enabled;
  const percent = Number(req.body?.percent);
  if (typeof enabled !== 'boolean' || !Number.isInteger(percent) || percent < 1 || percent > 100) return json(res, { error: 'Choose a valid automatic redemption setting and percentage.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {};
    const investment = (data.investments || []).find((item) => item.id === investmentId && item.status === 'active');
    if (!investment) { await client.query('ROLLBACK'); return json(res, { error: 'Active investment not found.' }, 404); }
    investment.autoRedeemEnabled = enabled;
    investment.autoRedeemPercent = percent;
    await saveLockedAccount(client, row, data);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/rewards/purchase', requireAuth, async (req, res, next) => {
  const reward = REWARDS.find((item) => item.id === String(req.body?.rewardId || ''));
  if (!reward) return json(res, { error: 'This reward is unavailable.' }, 404);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {};
    data.h9Points = Number(data.h9Points) || 0;
    if (data.h9Points < reward.points) { await client.query('ROLLBACK'); return json(res, { error: 'You do not have enough H9 points.' }, 400); }
    data.activeBonuses ||= [];
    data.rewardRedemptions ||= [];
    data.transactions ||= [];
    if (reward.type === 'boost' && data.activeBonuses.some((bonus) => bonus.type === 'double-earnings' && bonus.expiresAt > now())) {
      await client.query('ROLLBACK'); return json(res, { error: 'Use or wait for your current earnings boost to expire first.' }, 409);
    }
    data.h9Points -= reward.points;
    pointEntry(data, -reward.points, 'spend', reward.title, { rewardId: reward.id });
    if (reward.type === 'boost') {
      const startedAt = now();
      const bonus = { id: id(), type: 'double-earnings', multiplier: 2, title: reward.title, startedAt, expiresAt: startedAt + reward.hours * 3_600_000 };
      data.activeBonuses.unshift(bonus);
      data.transactions.unshift(transaction('bonus', 0, '', 'completed', { bonusId: bonus.id, planName: bonus.title }));
    } else {
      const creditedAt = now();
      data.wallet ||= { deposit: 0, earnings: 0, unlocked: 0 };
      data.wallet.deposit = roundMoney(Number(data.wallet.deposit || 0) + reward.amount);
      data.rewardRedemptions.unshift({ id: id(), rewardId: reward.id, title: reward.title, amount: reward.amount, status: 'credited', balanceDestination: 'deposit', requestedAt: creditedAt, creditedAt });
      data.transactions.unshift(transaction('coupon', reward.amount, '', 'completed', { planName: reward.title }));
    }
    await saveLockedAccount(client, row, data);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/rewards/spin', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {};
    data.bonusSpins = Number(data.bonusSpins) || 0;
    data.h9Points = Number(data.h9Points) || 0;
    const today = new Date().toISOString().slice(0, 10);
    const usedDailySpin = data.lastDailyPrizeDate === today;
    if (usedDailySpin && data.bonusSpins < 1) { await client.query('ROLLBACK'); return json(res, { error: 'You already used today’s spin and have no extra spins.' }, 409); }
    if (usedDailySpin) data.bonusSpins -= 1;
    else data.lastDailyPrizeDate = today;
    const prize = chooseDailyPrize(crypto.randomInt(DAILY_TICKET_POOL));
    data.dailyPrizes ||= [];
    data.dailyPrizes.unshift({ id: id(), prizeId: prize.id, points: prize.points, spinType: usedDailySpin ? 'extra' : 'daily', date: now() });
    data.h9Points += prize.points;
    pointEntry(data, prize.points, 'daily-prize', `Daily mystery box · ${prize.points} H9 points`, { prizeId: prize.id });
    await saveLockedAccount(client, row, data);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated), prize });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.delete('/api/admin/accounts', requireAuth, requireAdmin, (req, res) => json(res, { error: 'Bulk deletion is disabled to protect financial records.' }, 409));

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({ status: 'ok' });
  } catch {
    return res.status(503).json({ status: 'unavailable' });
  }
});

app.use('/api', (req, res) => json(res, { error: 'This operation is not available on the Render backend yet.' }, 501));
app.use('/render-backend', (req, res) => res.sendStatus(404));
app.use(express.static(root, { index: 'index.html', maxAge: '1h' }));
app.use((req, res) => res.sendFile(path.join(root, 'index.html')));
app.use((error, req, res, next) => {
  console.error('API error:', error?.message || error);
  if (res.headersSent) return next(error);
  return json(res, { error: 'Service temporarily unavailable.' }, 500);
});

const schema = `
  CREATE TABLE IF NOT EXISTS app_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('user','admin')), status TEXT NOT NULL DEFAULT 'approved', password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, account_data JSONB NOT NULL, created_at BIGINT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS app_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
  CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS app_accounts_username_lower ON app_accounts (LOWER(username));
  CREATE TABLE IF NOT EXISTS deposit_requests (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, network TEXT NOT NULL, asset TEXT NOT NULL, amount NUMERIC(24,8) NOT NULL CHECK (amount > 0), amount_currency TEXT NOT NULL DEFAULT 'crypto' CHECK (amount_currency IN ('crypto','USD')), deposit_address TEXT NOT NULL, tx_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected')), credit_usdt NUMERIC(24,8), transaction_id TEXT NOT NULL, created_at BIGINT NOT NULL, reviewed_at BIGINT, reviewed_by TEXT REFERENCES app_accounts(id), UNIQUE(network,tx_hash));
  CREATE TABLE IF NOT EXISTS deposit_ledger (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, deposit_id TEXT NOT NULL UNIQUE REFERENCES deposit_requests(id), credit_usdt NUMERIC(24,8) NOT NULL CHECK (credit_usdt > 0), balance_after_usdt NUMERIC(24,8) NOT NULL, created_at BIGINT NOT NULL, created_by TEXT NOT NULL REFERENCES app_accounts(id));
  CREATE TABLE IF NOT EXISTS platform_fee_ledger (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id), type TEXT NOT NULL, gross_amount NUMERIC(24,8) NOT NULL, fee_amount NUMERIC(24,8) NOT NULL CHECK (fee_amount >= 0), reference_id TEXT, created_at BIGINT NOT NULL);
  CREATE INDEX IF NOT EXISTS platform_fee_ledger_created_at ON platform_fee_ledger(created_at);
  CREATE TABLE IF NOT EXISTS password_reset_tokens (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
  CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry ON password_reset_tokens(expires_at);
`;

async function start() {
  for (const name of ['DATABASE_URL','ADMIN_EMAIL','ADMIN_PASSWORD_SALT','ADMIN_PASSWORD_HASH']) {
    if (!process.env[name]) throw new Error('Missing required environment variable: ' + name);
  }
  if (process.env.ADMIN_PASSWORD_SALT.length < 16 || !/^[a-f0-9]{128}$/i.test(process.env.ADMIN_PASSWORD_HASH)) throw new Error('ADMIN_PASSWORD_SALT/HASH must be a 16+ char salt and 64-byte scrypt hash in hex.');
  await pool.query(schema);
  await pool.query("ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS amount_currency TEXT NOT NULL DEFAULT 'crypto' CHECK (amount_currency IN ('crypto','USD'))");
  await pool.query('ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS gross_usdt NUMERIC(24,8)');
  await pool.query('ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS fee_usdt NUMERIC(24,8)');
  const addresses = getDepositAddresses();
  if (process.env.ENABLE_CRYPTO_DEPOSITS === 'true') {
    if (!/^0x[a-fA-F0-9]{40}$/.test(addresses.bep20)) throw new Error('DEPOSIT_ADDRESS_BNB_BEP20 is not a valid BNB Smart Chain address.');
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addresses.trc20)) throw new Error('DEPOSIT_ADDRESS_USDT_TRC20 is not a valid TRON address.');
    if (!/^bc1[ac-hj-np-z02-9]{11,71}$/i.test(addresses.bitcoin)) throw new Error('DEPOSIT_ADDRESS_BTC is not a valid bech32 Bitcoin address.');
  }
  await pool.query('DELETE FROM app_sessions WHERE expires_at <= NOW()');
  app.listen(port, () => console.log('Custody API listening on port ' + port));
}

start().catch((error) => {
  console.error('Custody API failed to start:', error.message);
  process.exit(1);
});
