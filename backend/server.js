import 'dotenv/config';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pg from 'pg';
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
  bep20: { asset: 'USDT', label: 'USDT · BNB Smart Chain (BEP-20)', env: 'DEPOSIT_ADDRESS_BNB_BEP20', address: '0x2859d146Dc8e4cB332736986feE9D32B641fbde8' },
  trc20: { asset: 'USDT', label: 'USDT · TRON TRC-20', env: 'DEPOSIT_ADDRESS_USDT_TRC20', address: 'TYQgWx4eQ6Js94UMexfyLXbqNE4Fucfg7Y' },
  bitcoin: { asset: 'BTC', label: 'BTC · Bitcoin', env: 'DEPOSIT_ADDRESS_BTC', address: 'bc1par0exs9cyw9w53xsceyh6wzl7f43gdjn6xsq0kyq4qsqsvr2uynqf5llc6' },
};
const staffEmails = new Set(String(process.env.STAFF_EMAILS || '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean));
const depositsEnabled = () => process.env.ENABLE_CRYPTO_DEPOSITS !== 'false';
const now = () => Date.now();
const id = () => crypto.randomUUID();
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
    wallet: { deposit: 0, earnings: 0 }, investments: [], transactions: [],
    depositRequests: [], withdrawalRequests: [], preferences: { language: 'en', theme: 'dark' },
    withdrawalWallet: null, walletChangeRequests: [], withdrawalPinSet: false,
    h9Points: 0, bonusSpins: 0, pointHistory: [], referralCode: accountId.slice(-7).toUpperCase(),
    referrals: [], activeBonuses: [], rewardRedemptions: [], dailyPrizes: [],
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

function publicAccount(row, depositRequests = [], withdrawalRequests = [], exposeStaffRole = false) {
  const data = row.account_data || {};
  return {
    ...data,
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role === 'staff' && !staffEmails.has(String(row.email).toLowerCase()) && !exposeStaffRole ? 'user' : row.role,
    status: row.status,
    createdAt: Number(row.created_at),
    revision: Number(row.revision),
    depositRequests,
    withdrawalRequests,
    withdrawalPinSet: Boolean(row.withdrawal_pin_hash),
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
    createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    transactionId: row.transaction_id,
  };
}

function withdrawalView(row) {
  return {
    id: row.id, amount: Number(row.amount), network: row.network, asset: networks[row.network]?.asset || row.network,
    address: row.address, status: row.status, payoutHash: row.payout_hash, payoutAmount: row.payout_amount == null ? null : Number(row.payout_amount), payoutAsset: row.payout_asset, transactionId: row.transaction_id,
    createdAt: Number(row.created_at), reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
  };
}

async function getAccount(row) {
  const [deposits, withdrawals] = await Promise.all([
    pool.query('SELECT * FROM deposit_requests WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100', [row.id]),
    pool.query('SELECT * FROM withdrawal_requests WHERE account_id = $1 ORDER BY created_at DESC LIMIT 100', [row.id]),
  ]);
  return publicAccount(row, deposits.rows.map(depositView), withdrawals.rows.map(withdrawalView));
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

function requireStaff(req, res, next) {
  const account = req.account;
  const authorized = account?.role === 'admin' || (account?.role === 'staff' && staffEmails.has(String(account.email).toLowerCase()));
  if (!authorized) return json(res, { error: 'Not authorized.' }, 403);
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
  return Object.fromEntries(Object.entries(networks).map(([key, config]) => [key, String(process.env[config.env] || config.address).trim()]));
}

function validWalletAddress(network, address) {
  if (network === 'bep20') return /^0x[a-fA-F0-9]{40}$/.test(address);
  if (network === 'trc20') return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  if (network === 'bitcoin') return /^(bc1[ac-hj-np-z02-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i.test(address);
  return false;
}

app.post('/api/auth/register', authRateLimit, async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (username.length < 3 || username.length > 30 || !emailPattern.test(email) || password.length < 12 || password.length > 200) {
      return json(res, { error: 'Use a valid username and email, and a password of at least 12 characters.' }, 400);
    }
    if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD_SALT || !process.env.ADMIN_PASSWORD_HASH) return json(res, { error: 'Service admin is not configured.' }, 503);
    if (email === adminEmail) return json(res, { error: 'This email is reserved.' }, 409);
    const credentials = await passwordHash(password);
    const account = baseAccount({ id: id(), username, email, data: { preferences: { language: ['en','fr','es','de','pt','hi','zh','it'].includes(req.body?.language) ? req.body.language : 'en', theme: 'dark' } } });
    await pool.query(
      'INSERT INTO app_accounts (id, username, email, role, status, password_salt, password_hash, account_data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
      [account.id, username, email, 'user', 'approved', credentials.salt, credentials.hash, JSON.stringify(account), account.createdAt],
    );
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO app_sessions (token_hash, account_id, expires_at) VALUES ($1,$2,NOW() + ($3 * INTERVAL '1 hour'))", [hashToken(token), account.id, sessionHours]);
    return json(res, { token, account });
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
  const preferences = req.body?.preferences;
  if (!preferences || typeof preferences !== 'object') return json(res, { error: 'Invalid account update.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    const data = row.account_data || {};
    data.preferences = {
      ...(data.preferences || {}),
      language: ['en','fr','es','de','pt','hi','zh','it'].includes(preferences.language) ? preferences.language : data.preferences?.language || 'en',
      theme: ['dark','light'].includes(preferences.theme) ? preferences.theme : data.preferences?.theme || 'dark',
    };
    await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),row.id]);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.put('/api/admin/account', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const targetId = String(req.body?.id || '');
    const row = (await pool.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [targetId])).rows[0];
    if (!row) return json(res, { error: 'Account not found.' }, 404);
    const wallet = req.body?.wallet;
    const status = String(req.body?.status || row.status);
    if (!wallet || !Number.isFinite(Number(wallet.deposit)) || !Number.isFinite(Number(wallet.earnings)) || Number(wallet.deposit) < 0 || Number(wallet.earnings) < 0 || !['approved','blocked','pending','rejected'].includes(status)) {
      return json(res, { error: 'Enter valid non-negative balances and account status.' }, 400);
    }
    const data = row.account_data || {};
    if (Number(wallet.deposit) !== Number(data.wallet?.deposit || 0) || Number(wallet.earnings) !== Number(data.wallet?.earnings || 0)) {
      return json(res, { error: 'Balance adjustments require an audited ledger operation.' }, 409);
    }
    const updated = (await pool.query('UPDATE app_accounts SET status=$1,revision=revision+1 WHERE id=$2 RETURNING *', [status,targetId])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { next(error); }
});

app.get('/api/deposit-addresses', requireAuth, (req, res) => {
  if (!depositsEnabled() && req.account.role !== 'admin') return json(res, { error: 'Crypto deposits are temporarily disabled.' }, 503);
  const addresses = getDepositAddresses();
  if (Object.values(addresses).some((value) => !value)) return json(res, { error: 'Deposit service is not fully configured.' }, 503);
  return json(res, { addresses });
});

app.post('/api/deposits', requireAuth, async (req, res, next) => {
  if (!depositsEnabled()) return json(res, { error: 'Crypto deposits are temporarily disabled.' }, 503);
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
      const accountRow = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
      if (!accountRow || accountRow.status !== 'approved') { await client.query('ROLLBACK'); return json(res, { error: 'Account is not active.' }, 403); }
      await client.query(
        'INSERT INTO deposit_requests (id,account_id,network,asset,amount,amount_currency,deposit_address,tx_hash,status,transaction_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [requestId,req.account.id,network,config.asset,amount,'USD',address,txHash,'pending',transactionId,createdAt],
      );
      const data = accountRow.account_data || {};
      data.transactions ||= [];
      data.transactions.unshift({ id: transactionId, type: 'deposit', amount: 0, network, status: 'pending', date: createdAt, requestId });
      await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data), accountRow.id]);
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

app.put('/api/auth/password', requireAuth, authRateLimit, async (req, res, next) => {
  try {
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 12 || newPassword.length > 200) return json(res, { error: 'New password must be at least 12 characters.' }, 400);
    if (!await passwordMatches(currentPassword, req.account.password_salt, req.account.password_hash)) return json(res, { error: 'Current password is incorrect.' }, 401);
    const credentials = await passwordHash(newPassword);
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    await pool.query('UPDATE app_accounts SET password_salt=$1,password_hash=$2,revision=revision+1 WHERE id=$3', [credentials.salt,credentials.hash,req.account.id]);
    await pool.query('DELETE FROM app_sessions WHERE account_id=$1 AND token_hash<>$2', [req.account.id,hashToken(token)]);
    const row = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [req.account.id])).rows[0];
    return json(res, { account: await getAccount(row) });
  } catch (error) { next(error); }
});

app.put('/api/auth/withdrawal-password', requireAuth, authRateLimit, async (req, res, next) => {
  try {
    const loginPassword = String(req.body?.loginPassword || '');
    const pin = String(req.body?.pin || '');
    if (!/^\d{6}$/.test(pin)) return json(res, { error: 'Withdrawal password must contain exactly six digits.' }, 400);
    if (!await passwordMatches(loginPassword, req.account.password_salt, req.account.password_hash)) return json(res, { error: 'Login password is incorrect.' }, 401);
    const credentials = await passwordHash(pin);
    const row = (await pool.query('UPDATE app_accounts SET withdrawal_pin_salt=$1,withdrawal_pin_hash=$2,withdrawal_pin_attempts=0,withdrawal_pin_locked_until=NULL,revision=revision+1 WHERE id=$3 RETURNING *', [credentials.salt,credentials.hash,req.account.id])).rows[0];
    return json(res, { account: await getAccount(row) });
  } catch (error) { next(error); }
});

app.post('/api/withdrawal-wallet', requireAuth, async (req, res, next) => {
  try {
    const network = String(req.body?.network || '');
    const address = String(req.body?.address || '').trim();
    if (!validWalletAddress(network, address)) return json(res, { error: 'Enter a valid address for the selected network.' }, 400);
    const client = await pool.connect();
    let requested = false;
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
      if (!row || row.status !== 'approved') { await client.query('ROLLBACK'); return json(res, { error: 'Account is not active.' }, 403); }
      const data = row.account_data || {};
      const linked = data.withdrawalWallet;
      if (linked?.network === network && linked.address === address) {
        await client.query('ROLLBACK');
        return json(res, { account: await getAccount(row), requested: false });
      }
      data.walletChangeRequests ||= [];
      if (data.walletChangeRequests.some((item) => item.status === 'pending')) { await client.query('ROLLBACK'); return json(res, { error: 'A wallet change is already pending.' }, 409); }
      data.walletChangeRequests.unshift({ id: id(), network, address, previousNetwork: linked?.network || null, previousAddress: linked?.address || null, status: 'pending', createdAt: now() });
      requested = true;
      await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),row.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
    const row = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [req.account.id])).rows[0];
    return json(res, { account: await getAccount(row), requested });
  } catch (error) { next(error); }
});

app.post('/api/admin/wallet-change', requireAuth, requireStaff, async (req, res, next) => {
  try {
    const accountId = String(req.body?.accountId || '');
    const requestId = String(req.body?.requestId || '');
    const decision = String(req.body?.decision || '');
    if (!['approve','reject'].includes(decision)) return json(res, { error: 'Invalid wallet-change decision.' }, 400);
    if (accountId === req.account.id) return json(res, { error: 'You cannot approve your own wallet change.' }, 403);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
      const data = row?.account_data || {};
      const request = (data.walletChangeRequests || []).find((item) => item.id === requestId && item.status === 'pending');
      if (!row || !request) { await client.query('ROLLBACK'); return json(res, { error: 'Wallet-change request not found or already reviewed.' }, 409); }
      const reviewedAt = now();
      request.status = decision === 'approve' ? 'approved' : 'rejected';
      request.reviewedAt = reviewedAt;
      request.reviewedBy = req.account.id;
      if (decision === 'approve') data.withdrawalWallet = { network: request.network, address: request.address, linkedAt: reviewedAt };
      await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),row.id]);
      await client.query('COMMIT');
      const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
      return json(res, { account: await getAccount(updated) });
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  } catch (error) { next(error); }
});

app.post('/api/withdrawals', requireAuth, authRateLimit, async (req, res, next) => {
  const network = String(req.body?.network || '');
  const address = String(req.body?.address || '').trim();
  const pin = String(req.body?.pin || '');
  const rawAmount = Number(req.body?.amount);
  const amount = Number.isFinite(rawAmount) ? Number(rawAmount.toFixed(8)) : NaN;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000 || !/^\d{6}$/.test(pin)) return json(res, { error: 'Enter a valid withdrawal amount and six-digit code.' }, 400);
  if (!validWalletAddress(network, address)) return json(res, { error: 'Destination address is invalid for this network.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [req.account.id])).rows[0];
    if (!row || row.status !== 'approved') { await client.query('ROLLBACK'); return json(res, { error: 'Account is not active.' }, 403); }
    if (row.withdrawal_pin_locked_until && new Date(row.withdrawal_pin_locked_until).getTime() > now()) { await client.query('ROLLBACK'); return json(res, { error: 'Withdrawal password is temporarily locked. Try again later.' }, 429); }
    if (!row.withdrawal_pin_hash) { await client.query('ROLLBACK'); return json(res, { error: 'Set a withdrawal password before requesting a payout.' }, 401); }
    if (!await passwordMatches(pin, row.withdrawal_pin_salt, row.withdrawal_pin_hash)) {
      await client.query("UPDATE app_accounts SET withdrawal_pin_attempts=withdrawal_pin_attempts+1,withdrawal_pin_locked_until=CASE WHEN withdrawal_pin_attempts+1 >= 5 THEN NOW()+INTERVAL '30 minutes' ELSE withdrawal_pin_locked_until END WHERE id=$1", [row.id]);
      await client.query('COMMIT');
      return json(res, { error: 'Withdrawal password is incorrect.' }, 401);
    }
    const data = row.account_data || {};
    const linked = data.withdrawalWallet;
    if (!linked || linked.network !== network || linked.address !== address) { await client.query('ROLLBACK'); return json(res, { error: 'Use your linked withdrawal wallet.' }, 409); }
    data.wallet ||= { deposit: 0, earnings: 0 };
    const available = Number(data.wallet.deposit || 0);
    if (amount > available) { await client.query('ROLLBACK'); return json(res, { error: 'Insufficient available deposit balance.' }, 409); }
    const requestId = id();
    const transactionId = id();
    const createdAt = now();
    data.wallet.deposit = Number((available - amount).toFixed(8));
    data.transactions ||= [];
    data.transactions.unshift({ id: transactionId, type: 'withdrawal', amount, network, asset: 'USDT', status: 'pending', date: createdAt, requestId });
    await client.query('INSERT INTO withdrawal_requests (id,account_id,amount,network,address,status,transaction_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [requestId,row.id,amount,network,address,'pending',transactionId,createdAt]);
    await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),row.id]);
    await client.query('INSERT INTO withdrawal_ledger (id,account_id,withdrawal_id,event,amount_usdt,balance_after_usdt,created_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id(),row.id,requestId,'reserved',amount,data.wallet.deposit,createdAt,row.id]);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) }, 201);
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/admin/withdrawals/:id/complete', requireAuth, requireStaff, async (req, res, next) => {
  const network = String(req.body?.network || '');
  const payoutHash = safeTxHash(network, req.body?.payoutHash);
  const payoutAsset = String(req.body?.payoutAsset || '');
  const rawPayoutAmount = Number(req.body?.payoutAmount);
  const payoutAmount = Number.isFinite(rawPayoutAmount) ? Number(rawPayoutAmount.toFixed(8)) : NaN;
  if (!payoutHash || !networks[network] || payoutAsset !== networks[network].asset || !Number.isFinite(payoutAmount) || payoutAmount <= 0) return json(res, { error: 'Enter the actual payout amount, asset and transaction hash.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const withdrawal = (await client.query('SELECT * FROM withdrawal_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!withdrawal || withdrawal.status !== 'pending') { await client.query('ROLLBACK'); return json(res, { error: 'Withdrawal not found or already reviewed.' }, 409); }
    if (withdrawal.account_id === req.account.id) { await client.query('ROLLBACK'); return json(res, { error: 'You cannot review your own withdrawal.' }, 403); }
    if (network !== withdrawal.network) { await client.query('ROLLBACK'); return json(res, { error: 'Payout network does not match the request.' }, 400); }
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [withdrawal.account_id])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return json(res, { error: 'Account not found.' }, 404); }
    const data = row.account_data || {};
    const tx = (data.transactions || []).find((item) => item.id === withdrawal.transaction_id);
    const reviewedAt = now();
    if (tx) { tx.status = 'completed'; tx.payoutHash = payoutHash; tx.payoutAmount = payoutAmount; tx.payoutAsset = payoutAsset; tx.reviewedAt = reviewedAt; }
    await client.query('UPDATE withdrawal_requests SET status=$1,payout_hash=$2,payout_amount=$3,payout_asset=$4,reviewed_at=$5,reviewed_by=$6 WHERE id=$7', ['completed',payoutHash,payoutAmount,payoutAsset,reviewedAt,req.account.id,withdrawal.id]);
    await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),row.id]);
    await client.query('INSERT INTO withdrawal_ledger (id,account_id,withdrawal_id,event,amount_usdt,balance_after_usdt,tx_hash,created_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id(),row.id,withdrawal.id,'paid',Number(withdrawal.amount),Number(data.wallet?.deposit || 0),payoutHash,reviewedAt,req.account.id]);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return json(res, { error: 'This payout transaction hash has already been recorded.' }, 409);
    next(error);
  } finally { client.release(); }
});

app.post('/api/admin/withdrawals/:id/reject', requireAuth, requireStaff, async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const withdrawal = (await client.query('SELECT * FROM withdrawal_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!withdrawal || withdrawal.status !== 'pending') { await client.query('ROLLBACK'); return json(res, { error: 'Withdrawal not found or already reviewed.' }, 409); }
    if (withdrawal.account_id === req.account.id) { await client.query('ROLLBACK'); return json(res, { error: 'You cannot review your own withdrawal.' }, 403); }
    const row = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [withdrawal.account_id])).rows[0];
    if (!row) { await client.query('ROLLBACK'); return json(res, { error: 'Account not found.' }, 404); }
    const data = row.account_data || {};
    data.wallet ||= { deposit: 0, earnings: 0 };
    const amount = Number(withdrawal.amount);
    data.wallet.deposit = Number((Number(data.wallet.deposit || 0) + amount).toFixed(8));
    data.transactions ||= [];
    const reviewedAt = now();
    const tx = data.transactions.find((item) => item.id === withdrawal.transaction_id);
    if (tx) { tx.status = 'rejected'; tx.reviewedAt = reviewedAt; }
    data.transactions.unshift({ id: id(), type: 'withdrawal-refund', amount, network: withdrawal.network, status: 'completed', date: reviewedAt, requestId: withdrawal.id, planName: 'Withdrawal request refund' });
    await client.query('UPDATE withdrawal_requests SET status=$1,reviewed_at=$2,reviewed_by=$3 WHERE id=$4', ['rejected',reviewedAt,req.account.id,withdrawal.id]);
    await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),row.id]);
    await client.query('INSERT INTO withdrawal_ledger (id,account_id,withdrawal_id,event,amount_usdt,balance_after_usdt,created_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id(),row.id,withdrawal.id,'refunded',amount,data.wallet.deposit,reviewedAt,req.account.id]);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/admin/staff', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const accountId = String(req.body?.accountId || '');
    const enabled = req.body?.enabled === true;
    const row = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [accountId])).rows[0];
    if (!row || row.id === req.account.id || row.role === 'admin') return json(res, { error: 'Select an eligible non-admin account.' }, 400);
    if (enabled && !staffEmails.has(String(row.email).toLowerCase())) return json(res, { error: 'Add this email to STAFF_EMAILS before granting staff access.' }, 409);
    const updated = (await pool.query('UPDATE app_accounts SET role=$1,revision=revision+1 WHERE id=$2 RETURNING *', [enabled ? 'staff' : 'user',row.id])).rows[0];
    return json(res, { account: await getAccount(updated) });
  } catch (error) { next(error); }
});

app.get('/api/admin/accounts', requireAuth, requireStaff, async (req, res, next) => {
  try {
    const [accounts, deposits, withdrawals] = await Promise.all([
      pool.query('SELECT * FROM app_accounts ORDER BY created_at DESC LIMIT 500'),
      pool.query('SELECT * FROM deposit_requests ORDER BY created_at DESC LIMIT 1000'),
      pool.query('SELECT * FROM withdrawal_requests ORDER BY created_at DESC LIMIT 1000'),
    ]);
    const depositsByAccount = new Map();
    for (const row of deposits.rows) {
      const list = depositsByAccount.get(row.account_id) || [];
      list.push(depositView(row));
      depositsByAccount.set(row.account_id, list);
    }
    const withdrawalsByAccount = new Map();
    for (const row of withdrawals.rows) {
      const list = withdrawalsByAccount.get(row.account_id) || [];
      list.push(withdrawalView(row));
      withdrawalsByAccount.set(row.account_id, list);
    }
    const accountData = accounts.rows.map((row) => publicAccount(row, depositsByAccount.get(row.id) || [], withdrawalsByAccount.get(row.id) || [], req.account.role === 'admin'));
    if (req.account.role === 'staff') {
      const staffAccount = (account) => ({ id:account.id,username:account.username,email:account.email,role:account.role,status:account.status,createdAt:account.createdAt,depositRequests:account.depositRequests,withdrawalRequests:account.withdrawalRequests,walletChangeRequests:account.walletChangeRequests });
      return json(res, { accounts: accountData.map((account) => account.id === req.account.id ? account : staffAccount(account)) });
    }
    return json(res, { accounts: accountData });
  } catch (error) { next(error); }
});

app.post('/api/admin/deposits/:id/approve', requireAuth, requireStaff, async (req, res, next) => {
  const rawCreditUsdt = Number(req.body?.creditUsdt);
  const creditUsdt = Number.isFinite(rawCreditUsdt) ? Number(rawCreditUsdt.toFixed(8)) : NaN;
  if (!Number.isFinite(creditUsdt) || creditUsdt <= 0 || creditUsdt > 1_000_000_000) return json(res, { error: 'Enter the verified USDT amount to credit.' }, 400);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const deposit = (await client.query('SELECT * FROM deposit_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!deposit || deposit.status !== 'pending') { await client.query('ROLLBACK'); return json(res, { error: 'Deposit not found or already reviewed.' }, 409); }
    if (deposit.account_id === req.account.id) { await client.query('ROLLBACK'); return json(res, { error: 'You cannot review your own deposit.' }, 403); }
    const accountRow = (await client.query('SELECT * FROM app_accounts WHERE id=$1 FOR UPDATE', [deposit.account_id])).rows[0];
    if (!accountRow || accountRow.status !== 'approved') { await client.query('ROLLBACK'); return json(res, { error: 'Account is not active.' }, 409); }
    const data = accountRow.account_data || {};
    data.wallet ||= { deposit: 0, earnings: 0 };
    data.wallet.deposit = Number(data.wallet.deposit || 0) + creditUsdt;
    data.transactions ||= [];
    const reviewedAt = now();
    const tx = data.transactions.find((item) => item.id === deposit.transaction_id);
    if (tx) { tx.status = 'confirmed'; tx.amount = creditUsdt; tx.creditedUsdt = creditUsdt; tx.reviewedAt = reviewedAt; }
    await client.query('UPDATE app_accounts SET account_data=$1::jsonb,revision=revision+1 WHERE id=$2', [JSON.stringify(data),accountRow.id]);
    await client.query('UPDATE deposit_requests SET status=$1,credit_usdt=$2,reviewed_at=$3,reviewed_by=$4 WHERE id=$5', ['confirmed',creditUsdt,reviewedAt,req.account.id,deposit.id]);
    await client.query('INSERT INTO deposit_ledger (id,account_id,deposit_id,credit_usdt,balance_after_usdt,created_at,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id(),accountRow.id,deposit.id,creditUsdt,Number(data.wallet.deposit),reviewedAt,req.account.id]);
    await client.query('COMMIT');
    const updated = (await pool.query('SELECT * FROM app_accounts WHERE id=$1', [accountRow.id])).rows[0];
    return json(res, { account: await getAccount(updated), depositId: deposit.id });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); next(error); }
  finally { client.release(); }
});

app.post('/api/admin/deposits/:id/reject', requireAuth, requireStaff, async (req, res, next) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const deposit = (await client.query('SELECT * FROM deposit_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!deposit || deposit.status !== 'pending') { await client.query('ROLLBACK'); return json(res, { error: 'Deposit not found or already reviewed.' }, 409); }
      if (deposit.account_id === req.account.id) { await client.query('ROLLBACK'); return json(res, { error: 'You cannot review your own deposit.' }, 403); }
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

app.get('/api/admin/deposit-addresses', requireAuth, requireAdmin, (req, res) => json(res, { addresses: getDepositAddresses() }));

async function marketData(req, res, next) {
  try {
    const request = new Request(`http://localhost${req.originalUrl}`, { method: 'GET' });
    const response = await marketApi.fetch(request);
    const data = await response.json();
    return res.status(response.status).set('Cache-Control', 'no-store').json(data);
  } catch (error) {
    return next(error);
  }
}

app.get(['/api/asset-prices', '/api/asset-history'], marketData);

app.use('/api', (req, res) => json(res, { error: 'This operation is not available on the Render backend yet.' }, 501));
app.use(express.static(root, { index: 'index.html', maxAge: '1h' }));
app.get('*', (req, res) => res.sendFile(path.join(root, 'index.html')));
app.use((error, req, res, next) => {
  console.error('API error:', error?.message || error);
  if (res.headersSent) return next(error);
  return json(res, { error: 'Service temporarily unavailable.' }, 500);
});

const schema = `
  CREATE TABLE IF NOT EXISTS app_accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('user','staff','admin')), status TEXT NOT NULL DEFAULT 'approved', password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, withdrawal_pin_salt TEXT, withdrawal_pin_hash TEXT, withdrawal_pin_attempts INTEGER NOT NULL DEFAULT 0, withdrawal_pin_locked_until TIMESTAMPTZ, account_data JSONB NOT NULL, created_at BIGINT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS app_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL);
  CREATE INDEX IF NOT EXISTS app_sessions_expiry ON app_sessions(expires_at);
  CREATE UNIQUE INDEX IF NOT EXISTS app_accounts_username_lower ON app_accounts (LOWER(username));
  CREATE TABLE IF NOT EXISTS deposit_requests (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, network TEXT NOT NULL, asset TEXT NOT NULL, amount NUMERIC(24,8) NOT NULL CHECK (amount > 0), amount_currency TEXT NOT NULL DEFAULT 'crypto' CHECK (amount_currency IN ('crypto','USD')), deposit_address TEXT NOT NULL, tx_hash TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected')), credit_usdt NUMERIC(24,8), transaction_id TEXT NOT NULL, created_at BIGINT NOT NULL, reviewed_at BIGINT, reviewed_by TEXT REFERENCES app_accounts(id), UNIQUE(network,tx_hash));
  CREATE TABLE IF NOT EXISTS deposit_ledger (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, deposit_id TEXT NOT NULL UNIQUE REFERENCES deposit_requests(id), credit_usdt NUMERIC(24,8) NOT NULL CHECK (credit_usdt > 0), balance_after_usdt NUMERIC(24,8) NOT NULL, created_at BIGINT NOT NULL, created_by TEXT NOT NULL REFERENCES app_accounts(id));
  CREATE TABLE IF NOT EXISTS withdrawal_requests (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, amount NUMERIC(24,8) NOT NULL CHECK (amount > 0), network TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','completed','rejected')), payout_hash TEXT, payout_amount NUMERIC(24,8), payout_asset TEXT, transaction_id TEXT NOT NULL, created_at BIGINT NOT NULL, reviewed_at BIGINT, reviewed_by TEXT REFERENCES app_accounts(id));
  CREATE UNIQUE INDEX IF NOT EXISTS withdrawal_payout_hash_unique ON withdrawal_requests (network,payout_hash) WHERE payout_hash IS NOT NULL;
  CREATE TABLE IF NOT EXISTS withdrawal_ledger (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES app_accounts(id) ON DELETE CASCADE, withdrawal_id TEXT NOT NULL REFERENCES withdrawal_requests(id), event TEXT NOT NULL CHECK (event IN ('reserved','paid','refunded')), amount_usdt NUMERIC(24,8) NOT NULL CHECK (amount_usdt > 0), balance_after_usdt NUMERIC(24,8) NOT NULL, tx_hash TEXT, created_at BIGINT NOT NULL, created_by TEXT NOT NULL REFERENCES app_accounts(id));
`;

async function start() {
  for (const name of ['DATABASE_URL','ADMIN_EMAIL','ADMIN_PASSWORD_SALT','ADMIN_PASSWORD_HASH']) {
    if (!process.env[name]) throw new Error('Missing required environment variable: ' + name);
  }
  if (process.env.ADMIN_PASSWORD_SALT.length < 16 || !/^[a-f0-9]{128}$/i.test(process.env.ADMIN_PASSWORD_HASH)) throw new Error('ADMIN_PASSWORD_SALT/HASH must be a 16+ char salt and 64-byte scrypt hash in hex.');
  await pool.query(schema);
  await pool.query("ALTER TABLE app_accounts ADD COLUMN IF NOT EXISTS withdrawal_pin_salt TEXT");
  await pool.query("ALTER TABLE app_accounts ADD COLUMN IF NOT EXISTS withdrawal_pin_hash TEXT");
  await pool.query("ALTER TABLE app_accounts ADD COLUMN IF NOT EXISTS withdrawal_pin_attempts INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE app_accounts ADD COLUMN IF NOT EXISTS withdrawal_pin_locked_until TIMESTAMPTZ");
  await pool.query("ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS payout_amount NUMERIC(24,8)");
  await pool.query("ALTER TABLE withdrawal_requests ADD COLUMN IF NOT EXISTS payout_asset TEXT");
  await pool.query('ALTER TABLE app_accounts DROP CONSTRAINT IF EXISTS app_accounts_role_check');
  await pool.query("ALTER TABLE app_accounts ADD CONSTRAINT app_accounts_role_check CHECK (role IN ('user','staff','admin'))");
  await pool.query("ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS amount_currency TEXT NOT NULL DEFAULT 'crypto' CHECK (amount_currency IN ('crypto','USD'))");
  if (depositsEnabled()) {
    const addresses = getDepositAddresses();
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
