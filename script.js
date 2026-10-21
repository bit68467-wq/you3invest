const USE_MOCK_BACKEND = location.hostname.includes('websim');
const mockApiRequest = USE_MOCK_BACKEND ? (await import('./mock-api.js')).mockApiRequest : null;
import { PLANS, CUSTOM_ASSETS, calendarDaysBetween } from './investment-model.js';
import { DAILY_PRIZES, REWARDS } from './rewards-model.js';
import { translatePage, translateText } from './localization.js';
import { getMarketQuote, refreshMarketQuotes, getMarketHistory, refreshMarketHistory } from './market-prices.js';

const SESSION_KEY = 'h9-test-session-v1';
const LANGUAGE_KEY = 'h9-interface-language-v1';
const RENDER_API_BASE = window.RENDER_API_BASE || '';
const DAY_MS = 86_400_000;
const NETWORKS = {
  bep20: 'BNB · BNB Smart Chain',
  bitcoin: 'BTC · Bitcoin',
  trc20: 'USDT · TRON TRC-20',
};
const LANGUAGES = ['en', 'fr', 'es', 'de', 'pt', 'hi', 'zh', 'it'];
const LANGUAGE_LOCALES = { en: 'en-US', fr: 'fr-FR', es: 'es-ES', de: 'de-DE', pt: 'pt-PT', hi: 'hi-IN', zh: 'zh-CN', it: 'it-IT' };
const TEAM_MEMBER_DETAILS = {
  michael: { name: 'Michael R. Thompson', role: 'CEO · CHIEF EXECUTIVE OFFICER', description: 'Company vision, strategy, and project development.', status: 'Appointment pending confirmation.' },
  alexander: { name: 'Alexander Vance', role: 'CTO · CHIEF TECHNOLOGY OFFICER', description: 'Platform, security, and digital infrastructure.', status: 'Appointment pending confirmation.' },
  david: { name: 'David K. Miller', role: 'COO · CHIEF OPERATING OFFICER', description: 'Processes, organization, and service quality.' },
  sarah: { name: 'Sarah L. Jenkins', role: 'LEGAL & COMPLIANCE', description: 'Responsibility and appointment under verification.' },
};
const $ = (id) => document.getElementById(id);
let language = LANGUAGES.includes(localStorage.getItem(LANGUAGE_KEY)) ? localStorage.getItem(LANGUAGE_KEY) : 'en';
const usd = (amount) => `${Number(amount || 0).toLocaleString(LANGUAGE_LOCALES[language] || 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
const usdAmount = (amount) => `${Number(amount || 0).toLocaleString(LANGUAGE_LOCALES[language] || 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
let accounts = [];
let current = null;
let accessToken = sessionStorage.getItem(SESSION_KEY) || '';
let pendingPasswordResetToken = '';
localStorage.removeItem(SESSION_KEY);
let selectedPlan = null;
let selectedInvestmentId = '';
let selectedFundingInvestmentId = '';
let customDraft = null;
let selectedHistoryFilter = 'all';
let selectedPortfolioChart = '';
let selectedAssetChart = '';
let selectedAssetRange = '1Y';
const ASSET_CHART_RANGES = [
  { id: '1D', days: 1 }, { id: '1W', days: 7 }, { id: '1M', days: 30 },
  { id: '3M', days: 90 }, { id: '6M', days: 182 }, { id: '1Y', days: 365 },
];
let customAccessMonths = 12;
let toastTimer;
let marketRefreshTimer;
let marketHistoryRequest = null;
let catalogHistoryTimer;
let wheelSpinning = false;
let pullStartY = null;
let depositAddresses = { bep20: '', bitcoin: '', trc20: '' };
if (USE_MOCK_BACKEND) {
  for (const network of Object.keys(depositAddresses)) {
    const field = $(`admin-address-${network}`);
    if (field) field.readOnly = false;
  }
  $('save-deposit-addresses').disabled = false;
  $('save-deposit-addresses').textContent = 'Save deposit addresses';
}

async function apiRequest(path, options = {}) {
  if (USE_MOCK_BACKEND) return mockApiRequest(path, options, accessToken);
  const headers = new Headers(options.headers || {});
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(`${RENDER_API_BASE}${path}`, { ...options, headers });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || 'Service temporarily unavailable.');
  return result;
}

async function saveAccounts(target = current) {
  if (!target || !accessToken) return false;
  try {
    const isAdminEdit = current.role === 'admin' && target.id !== current.id;
    const result = await apiRequest(isAdminEdit ? '/api/admin/account' : '/api/account', {
      method: 'PUT',
      body: JSON.stringify({ ...target, id: target.id }),
    });
    Object.assign(target, result.account);
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  }
}

function applyAccount(account) {
  const index = accounts.findIndex((item) => item.id === account.id);
  if (index >= 0) accounts[index] = account;
  current = account;
  render();
}

function setError(id, message = '') {
  $(id).textContent = translateText(message, language);
  $(id).classList.remove('success');
}

function toast(message) {
  const node = $('toast');
  node.textContent = translateText(message, language);
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2500);
}

function openTeamMember(memberId) {
  const member = TEAM_MEMBER_DETAILS[memberId];
  if (!member) return;
  $('team-member-title').textContent = member.name;
  $('team-member-role').textContent = translateText(member.role, language);
  $('team-member-description').textContent = translateText(member.description, language);
  const status = $('team-member-status');
  status.hidden = !member.status;
  status.textContent = member.status ? translateText(member.status, language) : '';
  $('team-member-dialog').showModal();
}

function timestampDate(value) {
  return new Date(value).toLocaleDateString(LANGUAGE_LOCALES[language] || 'en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

function timestampDateTime(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
  return new Date(timestamp).toLocaleString(LANGUAGE_LOCALES[language] || 'en-US', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  });
}

function depositRequestAmount(request) {
  if (request.amountCurrency === 'USD' || !request.asset) return usdAmount(request.amount);
  return `${Number(request.amount).toLocaleString(LANGUAGE_LOCALES[language] || 'en-US', { maximumFractionDigits: 8 })} ${request.asset}`;
}

function movementAmount(transaction) {
  if (transaction.type === 'deposit') {
    const request = movementRequest(transaction);
    if (request?.status === 'confirmed' && Number(request.creditUsdt) > 0) return `+${usd(request.creditUsdt)}`;
    if (request) return depositRequestAmount(request);
    return usd(transaction.amount);
  }
  const value = usd(transaction.amount);
  if (transaction.type === 'account-adjustment') {
    return `${transaction.direction === 'debit' ? '−' : '+'}${value}`;
  }
  if (['deposit', 'earnings', 'compounding', 'earning-redemption', 'early-closure', 'maturity', 'coupon', 'withdrawal-refund'].includes(transaction.type)) {
    return `+${value}`;
  }
  if (['investment', 'withdrawal', 'subscription'].includes(transaction.type)) return `−${value}`;
  return value;
}

function earningsNoticeKey(accountId = current?.id) {
  return `h9-earnings-notice-v1:${accountId || 'guest'}`;
}

function readEarningsNoticeState() {
  try {
    const state = JSON.parse(localStorage.getItem(earningsNoticeKey()) || '{}');
    return state && typeof state === 'object' ? state : {};
  } catch {
    return {};
  }
}

function openApp(account) {
  current = account;
  language = LANGUAGES.includes(account.preferences?.language) ? account.preferences.language : language;
  localStorage.setItem(LANGUAGE_KEY, language);
  document.documentElement.lang = language;
  $('landing-language-select').value = language;
  $('language-select').value = language;
  selectedHistoryFilter = 'all';
  if (accessToken) sessionStorage.setItem(SESSION_KEY, accessToken);
  $('landing').hidden = true;
  $('auth-screen').hidden = true;
  $('app-shell').hidden = false;
  $('bottom-nav').hidden = false;
  render();
  refreshAccount();
  apiRequest('/api/deposit-addresses').then(({ addresses }) => {
    depositAddresses = addresses || depositAddresses;
    if (current?.role === 'admin') {
      for (const network of Object.keys(depositAddresses)) {
        const field = $(`admin-address-${network}`);
        if (field) field.value = depositAddresses[network];
      }
    }
    refreshDepositAddressDisplay();
    if (current?.role === 'admin') renderAdmin();
  }).catch(() => {});
  setView('home');
  scheduleMarketAccountRefresh();
  if (current.role === 'admin') {
    apiRequest('/api/admin/accounts').then(({ accounts: list }) => {
      accounts = list;
      current = accounts.find((item) => item.id === current.id) || current;
      render();
    }).catch((error) => toast(error.message));
  }
}

function signOut() {
  clearInterval(marketRefreshTimer);
  marketRefreshTimer = undefined;
  if (accessToken) apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
  current = null;
  accessToken = '';
  accounts = [];
  customDraft = null;
  language = LANGUAGES.includes(localStorage.getItem(LANGUAGE_KEY)) ? localStorage.getItem(LANGUAGE_KEY) : 'en';
  document.documentElement.lang = language;
  $('landing-language-select').value = language;
  sessionStorage.removeItem(SESSION_KEY);
  $('app-shell').hidden = true;
  $('bottom-nav').hidden = true;
  $('auth-screen').hidden = true;
  $('landing').hidden = false;
  showAuthMode('login');
  clearInterval(catalogHistoryTimer);
  catalogHistoryTimer = undefined;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAuthMode(mode) {
  $('landing').hidden = true;
  $('auth-screen').hidden = false;
  const register = mode === 'register';
  $('auth-entry').hidden = false;
  $('login-form').hidden = register;
  $('register-form').hidden = !register;
  $('password-reset-request-form').hidden = true;
  $('password-reset-form').hidden = true;
  $('forgot-password-button').hidden = register;
  $('auth-switch').hidden = false;
  $('auth-title').textContent = register ? 'Create your account' : 'Welcome back';
  $('auth-subtitle').textContent = register ? 'Create your You Invest account.' : 'Sign in to your You Invest account.';
  $('show-login').classList.toggle('selected', !register);
  $('show-register').classList.toggle('selected', register);
  translatePage(language);
}

function balanceTotal() {
  const activePortfolio = current.investments
    .filter((investment) => investment.status === 'active')
    .reduce((sum, investment) => sum + (Number(investment.marketValue) || investment.principal), 0);
  return current.wallet.deposit + current.wallet.earnings + (Number(current.wallet.unlocked) || 0) + activePortfolio;
}

function withdrawalBalance() {
  return $('withdraw-source').value === 'unlocked'
    ? Number(current?.wallet?.unlocked) || 0
    : Number(current?.wallet?.earnings) || 0;
}

function updateWithdrawalQuote() {
  if (!current) return;
  const unlocked = $('withdraw-source').value === 'unlocked';
  const rate = unlocked ? 0.2 : 0.04;
  const available = withdrawalBalance();
  const amount = Math.max(0, Number($('withdraw-amount').value) || 0);
  $('withdraw-available').textContent = usd(available);
  $('withdraw-fee-note').textContent = translateText('Withdrawal fee', language) + ': ' + (rate * 100) + '% · ' + translateText('Fee', language) + ' ' + usd(amount * rate) + ' · ' + translateText('Payout', language) + ' ' + usd(Math.max(0, amount - amount * rate));
}

function redeemableEarnings() {
  return (current?.investments || []).reduce(
    (sum, investment) => sum + (investment.status === 'active'
      ? Math.max(0, Number(investment.marketValue) - Number(investment.principal))
      : 0),
    0,
  );
}

async function refreshAccount() {
  if (!current) return;
  try {
    await refreshMarketQuotes();
    updateVisibleMarketQuotes();
    await apiRequest('/api/investments/mark', {
      method: 'POST',
      body: JSON.stringify({ quotes: currentMarketQuotes() }),
    });
    const { account } = await apiRequest('/api/account');
    if (account.role === 'admin') {
      const { accounts: list } = await apiRequest('/api/admin/accounts');
      accounts = list;
      current = accounts.find((item) => item.id === account.id) || account;
    } else {
      const index = accounts.findIndex((item) => item.id === account.id);
      if (index >= 0) accounts[index] = account;
      current = account;
    }
    render();
    return true;
  } catch (error) {
    if (/session expired|not active/i.test(error.message)) {
      signOut();
      setError('login-error', /not active/i.test(error.message)
        ? 'This account is not active.'
        : 'Session expired. Please log in again.');
    } else {
      toast(error.message);
    }
    return false;
  }
}

function scheduleMarketAccountRefresh() {
  clearInterval(marketRefreshTimer);
  if (!current) return;
  marketRefreshTimer = setInterval(() => {
    if (current && document.visibilityState !== 'hidden') refreshAccount();
  }, 60_000);
}

async function resumeSession() {
  if (!accessToken) return;
  try {
    await refreshMarketQuotes();
    await apiRequest('/api/investments/mark', {
      method: 'POST',
      body: JSON.stringify({ quotes: currentMarketQuotes() }),
    });
    const { account } = await apiRequest('/api/account');
    current = account;
    accounts = [account];
    openApp(account);
  } catch (error) {
    accessToken = '';
    sessionStorage.removeItem(SESSION_KEY);
    setError('login-error', error.message);
  }
}

function renderPlan(plan, compact = false) {
  return `<article class="plan-card ${compact ? 'compact' : ''}" data-plan-card="${plan.id}">
    <div class="plan-card-top"><span class="duration-tag">${translateText(plan.months === 6 ? '6 months' : plan.months === 12 ? '1 year' : (plan.months / 12) + ' years', language)}</span><span class="plan-lock">${translateText('Capital locked', language)}</span></div>
    <h3>${esc(translateText(plan.name, language))}</h3>
    <div class="plan-rate market-plan-rate">${translateText('Market-linked', language)}<small>${translateText('variable value', language)}</small></div>
    <div class="plan-data"><span>${translateText('Capital protection', language)}</span><b>-20%</b></div>
    <p class="plan-description">${translateText('Portfolio value follows live market prices. No fixed daily return.', language)}</p>
    <button class="primary-button" type="button" data-plan-details="${plan.id}">${compact ? 'Details' : 'Plan details'}</button>
  </article>`;
}

function createCustomDraft() {
  const defaults = Object.fromEntries(PLANS[0].allocations.map((asset) => [asset.name, asset.weight]));
  return {
    amount: '', months: customAccessMonths, stopLossPercent: 20, autoRedeemPercent: 0,
    allocations: Object.fromEntries(CUSTOM_ASSETS.map((asset) => [asset.name, {
      selected: true, weight: defaults[asset.name] || 0,
    }])),
  };
}

function customAllocationTotal() {
  return Object.values(customDraft?.allocations || {}).reduce(
    (sum, asset) => sum + (asset.selected ? Number(asset.weight) || 0 : 0), 0,
  );
}

function updateCustomAllocationSummary() {
  const total = customAllocationTotal();
  const label = $('custom-allocation-total');
  const button = $('custom-invest-button');
  if (!label || !button) return;
  label.textContent = total.toLocaleString(LANGUAGE_LOCALES[language], { maximumFractionDigits: 2 }) + '% / 100%';
  label.classList.toggle('valid', Math.abs(total - 100) <= 0.01);
  button.disabled = Math.abs(total - 100) > 0.01 || !Object.values(customDraft.allocations).some((asset) => asset.selected);
}

function renderCustomPlan() {
  const section = $('custom-plan-section');
  if (!section || !current) return;
  const subscription = current.customPlanSubscription;
  const configuredMonths = Number(subscription?.months);
  const paidMonths = [6, 12, 24, 36, 60].includes(configuredMonths) ? configuredMonths : 12;
  const paidDurationLabel = paidMonths === 6 ? '6 months' : paidMonths === 12 ? '1 year' : (paidMonths / 12) + ' years';
  const hasAccess = Number(subscription?.expiresAt) > Date.now();
  if (!hasAccess) {
    const balance = Number(current.wallet?.deposit) || 0;
    const accessOptions = [6, 12, 24, 36, 60].map((months) => {
      const label = months === 6 ? '6 months' : months === 12 ? '1 year' : (months / 12) + ' years';
      return '<option value="' + months + '" ' + (customAccessMonths === months ? 'selected' : '') + '>' + translateText(label, language) + '</option>';
    }).join('');
    const accessPrice = customAccessMonths * 50 / 12;
    section.innerHTML = '<div class="custom-plan-head"><div><p class="eyebrow">' + translateText('CUSTOM PLAN ACCESS', language) + '</p><h2 id="custom-plan-title">' + translateText('Custom plan', language) + '</h2><p>' + translateText('Choose assets, allocation, stop-loss, and automatic redemption.', language) + '</p></div><strong class="custom-plan-price">$50<small> / ' + translateText('year', language) + '</small></strong></div><label class="custom-access-term">' + translateText('Access duration', language) + '<select data-custom-access-months>' + accessOptions + '</select><b>' + usd(accessPrice) + '</b></label><div class="custom-plan-unlock"><span>' + translateText('Available deposit balance', language) + ': <b>' + usd(balance) + '</b></span><button class="primary-button" type="button" data-unlock-custom-plan ' + (balance < accessPrice ? 'disabled' : '') + '>' + translateText('Unlock for', language) + ' ' + usd(accessPrice) + '</button></div><p class="custom-plan-note">' + translateText('Access is charged upfront at $50 per year for the full selected duration.', language) + '</p>';
    return;
  }
  customDraft ||= createCustomDraft();
  const allowedTerms = [6, 12, 24, 36, 60].filter((months) => months <= paidMonths);
  if (!allowedTerms.includes(Number(customDraft.months))) customDraft.months = allowedTerms.at(-1);
  const durationOptions = allowedTerms.map((months) => {
    const name = months === 6 ? '6 months' : months === 12 ? '1 year' : (months / 12) + ' years';
    return '<option value="' + months + '" ' + (Number(customDraft.months) === months ? 'selected' : '') + '>' + translateText(name, language) + '</option>';
  }).join('');
  const assetRows = CUSTOM_ASSETS.map((asset) => {
    const config = customDraft.allocations[asset.name];
    return '<div class="custom-asset-row"><label><input type="checkbox" data-custom-asset="' + esc(asset.name) + '" ' + (config.selected ? 'checked' : '') + '><span>' + esc(asset.name) + '</span></label><div><input type="number" min="0.1" max="100" step="0.1" value="' + esc(config.weight) + '" data-custom-weight="' + esc(asset.name) + '" ' + (config.selected ? '' : 'disabled') + ' aria-label="' + esc(asset.name) + ' allocation percentage"><span>%</span></div></div>';
  }).join('');
  section.innerHTML = '<div class="custom-plan-head"><div><p class="eyebrow">' + translateText('CUSTOM PLAN ACCESS', language) + '</p><h2 id="custom-plan-title">' + translateText('Custom plan', language) + '</h2><p>' + translateText('Access duration', language) + ': ' + translateText(paidDurationLabel, language) + ' · ' + translateText('Access until', language) + ' ' + timestampDate(subscription.expiresAt) + '</p></div><span class="custom-plan-active">' + translateText('Active', language) + '</span></div><form id="custom-plan-form" class="custom-plan-form"><div class="custom-assets-heading"><b>' + translateText('Choose assets and allocation', language) + '</b><span id="custom-allocation-total"></span></div><div class="custom-asset-list">' + assetRows + '</div><div class="custom-form-grid"><label>' + translateText('Investment amount (USDT)', language) + '<input type="number" min="0.000001" step="any" required data-custom-field="amount" value="' + esc(customDraft.amount) + '"></label><label>' + translateText('Contract term', language) + '<select data-custom-field="months">' + durationOptions + '</select></label><label>' + translateText('Stop-loss threshold (%)', language) + '<input type="number" min="1" max="80" step="1" required data-custom-field="stopLossPercent" value="' + esc(customDraft.stopLossPercent) + '"></label><label>' + translateText('Auto-redeem new profits (%)', language) + '<input type="number" min="0" max="100" step="1" required data-custom-field="autoRedeemPercent" value="' + esc(customDraft.autoRedeemPercent) + '"></label></div><p class="form-error" id="custom-plan-error" role="alert"></p><button class="primary-button" id="custom-invest-button" type="submit">' + translateText('Create custom investment', language) + '</button><p class="custom-plan-note">' + translateText('Selected asset weights must total 100%. A 0% auto-redemption setting keeps all profits invested.', language) + '</p></form>';
  updateCustomAllocationSummary();
}

function renderInvestment(investment, ended = false) {
  const plan = PLANS.find((item) => item.id === investment.planId);
  const maturityAt = investment.maturityAt || investment.startedAt + investment.days * DAY_MS;
  const totalDays = Math.max(1, calendarDaysBetween(investment.startedAt, maturityAt));
  const remainingDays = ended ? 0 : Math.max(0, calendarDaysBetween(Date.now(), maturityAt));
  const elapsedDays = totalDays - remainingDays;
  const progress = Math.max(0, Math.min(100, (elapsedDays / totalDays) * 100));
  const marketValue = investment.status === 'closed-early'
    ? Number(investment.closePortfolioValue) || 0
    : Number(investment.marketValue) || investment.principal;
  const marketChange = (marketValue / investment.principal - 1) * 100;
  const suspended = !ended && investment.protectionSuspended;
  const status = ended ? 'Completed' : suspended ? 'Suspended at stop loss' : 'Active';
  const redeemable = ended ? 0 : Math.max(0, marketValue - investment.principal);
  const autoRedeemEnabled = investment.autoRedeemEnabled === true;
  const autoRedeemPercent = Math.min(100, Math.max(1, Number(investment.autoRedeemPercent) || 100));
  const stopLossPercent = Math.min(80, Math.max(1, Number(investment.stopLossPercent) || 20));
  return `<article class="investment-card">
    <div class="investment-card-head"><div><b>${esc(plan?.name || investment.planName || `${investment.days}-day plan`)}</b><span>${translateText('Locked capital', language)} ${usd(marketValue)} (${marketChange >= 0 ? '+' : ''}${marketChange.toLocaleString(LANGUAGE_LOCALES[language], { maximumFractionDigits: 2 })}%)</span></div><span class="state-badge ${ended ? 'ended' : suspended ? 'protected' : 'active'}">${translateText(status, language)}</span></div>
    <div class="progress-track"><i style="width:${progress}%"></i></div>
    <div class="investment-live-values"><div><span>${translateText('Locked capital', language)}</span><b>${usd(marketValue)}</b></div><div><span>${translateText('Redeemable profits', language)}</span><b>${usd(redeemable)}</b></div><div><span>${translateText('Current portfolio value', language)}</span><b>${usd(marketValue)}</b></div></div>
    <div class="investment-details"><span>${ended ? `${investment.status === 'closed-early' ? 'Closed' : 'Completed'} ${timestampDate(investment.closedAt || investment.maturedAt)}` : `${remainingDays} ${translateText('days remaining', language)} · ${translateText('Matures', language)} ${timestampDate(maturityAt)}`}</span><span>${translateText('Protection threshold', language)} <b>${usd(investment.principal * (1 - stopLossPercent / 100))} (${stopLossPercent}%)</b></span></div>
    ${investment.status === 'closed-early' ? `<div class="released-line">Early-close refund · ${usd(investment.closeRefund)}</div>` : ended ? `<div class="released-line">${translateText('Maturity value released for withdrawal · 20% fee', language)} · ${usd(marketValue)}</div>` : `<div class="released-line">${translateText('Market-linked contract. No fixed daily return.', language)}</div>`}
    ${Array.isArray(investment.stopLossPeriods) && investment.stopLossPeriods.length ? `<details class="investment-stop-history"><summary>Stop-loss periods <span>${investment.stopLossPeriods.length}</span></summary><div>${investment.stopLossPeriods.map((period) => `<p><b>${period.inherited ? translateText('Tracking began while protection active', language) + ' · ' : ''}${timestampDateTime(period.startedAt)}${period.endedAt ? ` → ${timestampDateTime(period.endedAt)}` : ' · ongoing'}</b><small>${translateText('Protection threshold', language)} ${Number(period.thresholdPercent) || stopLossPercent}% · ${translateText('Protected value', language)} ${usd(period.protectionValue)}</small></p>`).join('')}</div></details>` : ''}
    ${!ended ? `<div class="auto-redeem-control"><label class="auto-redeem-toggle"><input type="checkbox" data-auto-redeem="${esc(investment.id)}" ${autoRedeemEnabled ? 'checked' : ''}><span>${translateText('Auto-redeem profits', language)}</span></label><label class="auto-redeem-rate"><input type="number" inputmode="numeric" min="1" max="100" step="1" value="${autoRedeemPercent}" data-auto-redeem-percent="${esc(investment.id)}" aria-label="${translateText('Auto-redeem percentage', language)}" ${autoRedeemEnabled ? '' : 'disabled'}><span>% ${translateText('of new profits', language)}</span></label></div>` : ''}
    <div class="investment-actions">
      ${!ended ? `<button class="outline-button add-investment-funds-button" type="button" data-add-investment-funds="${esc(investment.id)}">${translateText('Add funds', language)}</button>` : ''}
      <button class="text-link investment-detail-button" type="button" data-investment-detail="${esc(investment.id)}">${translateText('Investment details', language)} <span>→</span></button>
      ${redeemable > 0 ? `<button class="outline-button redeem-investment-button" type="button" data-redeem-investment="${esc(investment.id)}">${translateText('Redeem profits', language)} · ${usd(redeemable)}</button>` : ''}
    </div>
  </article>`;
}

function renderMarketQuoteContent(assetName) {
  const quote = getMarketQuote(assetName);
  if (!quote) return `<span>${translateText('Market quote', language)}</span><b class="market-quote-empty">${translateText('Waiting for market data...', language)}</b>`;
  const value = Number(quote.price).toLocaleString(LANGUAGE_LOCALES[language] || 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const marketTime = new Date(quote.marketAt).toLocaleString(LANGUAGE_LOCALES[language] || 'en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const price = [quote.currency, value, quote.unit].filter(Boolean).join(' ');
  return `<span>${translateText('Market quote', language)}</span><b>${price}</b><small>${esc(quote.instrument)} · ${esc(quote.provider)} · ${marketTime}</small>`;
}

const HISTORY_ASSETS = [
  ['gold', 'Gold', '#e8bf68'], ['oil', 'Oil', '#e68d64'], ['electricity', 'Electricity', '#79e2d5'],
  ['sp500', 'S&P 500', '#8bd482'], ['nasdaq', 'NASDAQ', '#79a8fa'], ['tesla', 'Tesla', '#f17d91'],
  ['artificialIntelligence', 'Artificial intelligence', '#bd92ef'], ['bitcoin', 'Bitcoin', '#f2a24b'], ['ethereum', 'Ethereum', '#8da9ff'],
];

function marketPoints(key, name) {
  const points = [...(getMarketHistory()?.histories?.[key] || [])];
  const quote = getMarketQuote(name);
  const price = Number(quote?.price);
  const time = Number(quote?.marketAt);
  if (Number.isFinite(price) && price > 0 && Number.isFinite(time) && time > 0) {
    const latest = points.at(-1);
    if (!latest || time > latest.time) points.push({ time, value: price });
    else if (time === latest.time) points[points.length - 1] = { time, value: price };
  }
  return points;
}

function drawLineChart(container, sourcePoints, chartLabel, options = {}) {
  if (!container) return;
  const data = [...sourcePoints]
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value))
    .sort((a, b) => a.time - b.time);
  if (!data.length) {
    container.innerHTML = '<p>' + translateText('Waiting for the live market feed...', language) + '</p>';
    return;
  }
  const rawMin = Math.min(...data.map((point) => point.value));
  const rawMax = Math.max(...data.map((point) => point.value));
  const padding = Math.max((rawMax - rawMin) * 0.08, Math.abs(rawMax) * 0.001, 0.01);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const start = data[0].time;
  const end = data.at(-1).time;
  const span = Math.max(1, end - start);
  const left = 68, right = 704, top = 16, bottom = 198;
  const x = (time) => data.length === 1 ? (left + right) / 2 : left + (time - start) / span * (right - left);
  const y = (value) => bottom - (value - min) / (max - min) * (bottom - top);
  const locale = LANGUAGE_LOCALES[language] || 'en-US';
  const valueLabel = (value) => value.toLocaleString(locale, { maximumFractionDigits: 2 });
  const moneyLabel = (value) => [options.currency, valueLabel(value)].filter(Boolean).join(' ');
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max - (max - min) * index / 4;
    const py = y(value);
    return '<line class="asset-history-grid" x1="' + left + '" y1="' + py + '" x2="' + right + '" y2="' + py + '"></line><text x="' + (left - 8) + '" y="' + (py + 3) + '" text-anchor="end">' + esc(valueLabel(value)) + '</text>';
  }).join('');
  const verticalGrid = [0, 0.5, 1].map((fraction) => {
    const px = left + (right - left) * fraction;
    return '<line class="asset-history-grid asset-history-grid-vertical" x1="' + px + '" y1="' + top + '" x2="' + px + '" y2="' + bottom + '"></line>';
  }).join('');
  const path = data.map((point, index) => (index ? 'L' : 'M') + x(point.time).toFixed(2) + ',' + y(point.value).toFixed(2)).join(' ');
  const dateOptions = span > 180 * DAY_MS
    ? { month: 'short', year: 'numeric' }
    : span > 2 * DAY_MS
      ? { month: 'short', day: 'numeric' }
      : { hour: '2-digit', minute: '2-digit' };
  const dateLabel = (fraction) => new Date(start + span * fraction).toLocaleDateString(locale, dateOptions);
  const dates = [0, 0.5, 1].map((fraction) => {
    const anchor = fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle';
    return '<text x="' + (left + (right - left) * fraction) + '" y="222" text-anchor="' + anchor + '">' + esc(dateLabel(fraction)) + '</text>';
  }).join('');
  const latest = data.at(-1);
  const interactive = options.interactive === true;
  const readout = interactive
    ? '<div class="asset-chart-readout"><time></time><b></b></div>'
    : '';
  const crosshair = interactive
    ? '<g class="asset-chart-cursor" visibility="hidden"><line class="asset-history-crosshair" y1="' + top + '" y2="' + bottom + '"></line><circle class="asset-history-focus" r="4"></circle></g>'
    : '';
  container.innerHTML = readout + '<svg class="' + (interactive ? 'asset-history-interactive' : '') + '" viewBox="0 0 720 232" role="img" aria-label="' + esc(chartLabel) + '"' + (interactive ? ' tabindex="0"' : '') + '><g>' + grid + verticalGrid + '</g><path class="asset-history-line" d="' + path + '"></path>' + crosshair + '<circle class="asset-history-current" cx="' + x(latest.time) + '" cy="' + y(latest.value) + '" r="3.5"></circle>' + dates + '</svg>';
  if (!interactive) return;

  const svg = container.querySelector('svg');
  const readoutTime = container.querySelector('.asset-chart-readout time');
  const readoutValue = container.querySelector('.asset-chart-readout b');
  const cursor = svg.querySelector('.asset-chart-cursor');
  const cursorLine = cursor.querySelector('line');
  const cursorPoint = cursor.querySelector('circle');
  let focusedIndex = data.length - 1;
  const showPoint = (index) => {
    focusedIndex = Math.max(0, Math.min(data.length - 1, index));
    const point = data[focusedIndex];
    const px = x(point.time);
    const py = y(point.value);
    cursor.setAttribute('visibility', 'visible');
    cursorLine.setAttribute('x1', px);
    cursorLine.setAttribute('x2', px);
    cursorPoint.setAttribute('cx', px);
    cursorPoint.setAttribute('cy', py);
    readoutTime.textContent = new Date(point.time).toLocaleString(locale, {
      month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    readoutValue.textContent = moneyLabel(point.value);
  };
  showPoint(focusedIndex);
  const focusPointer = (event) => {
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width) return;
    const chartX = (event.clientX - bounds.left) / bounds.width * 720;
    const targetTime = start + Math.max(0, Math.min(1, (chartX - left) / (right - left))) * span;
    let low = 0, high = data.length - 1;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (data[middle].time < targetTime) low = middle + 1;
      else high = middle;
    }
    if (low > 0 && targetTime - data[low - 1].time <= data[low].time - targetTime) low -= 1;
    showPoint(low);
  };
  svg.addEventListener('pointermove', focusPointer);
  svg.addEventListener('pointerdown', focusPointer);
  svg.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    showPoint(focusedIndex + (event.key === 'ArrowRight' ? 1 : -1));
  });
}

function portfolioHistory(allocations, baseValue = 100) {
  const series = allocations.flatMap((allocation) => {
    const item = HISTORY_ASSETS.find((asset) => asset[1] === allocation.name);
    const points = item ? marketPoints(item[0], item[1]) : [];
    return points.length > 1 && points[0].value > 0 ? [{ weight: Number(allocation.weight) || 0, points, base: points[0].value }] : [];
  }).filter((item) => item.weight > 0);
  if (!series.length) return [];
  const times = [...new Set(series.flatMap((item) => item.points.map((point) => point.time)))].sort((a, b) => a - b);
  const last = new Map(series.map((item) => [item, 0]));
  return times.map((time) => {
    let value = 0, weight = 0;
    for (const item of series) {
      let index = last.get(item);
      while (index + 1 < item.points.length && item.points[index + 1].time <= time) index += 1;
      last.set(item, index);
      if (item.points[index].time <= time && item.points[index].value > 0) {
        value += item.weight * item.points[index].value / item.base;
        weight += item.weight;
      }
    }
    return weight ? { time, value: baseValue * value / weight } : null;
  }).filter(Boolean);
}

function renderAssetHistoryChart() {
  const marketList = $('asset-market-list');
  if (!marketList) return;
  const locale = LANGUAGE_LOCALES[language] || 'en-US';
  marketList.innerHTML = HISTORY_ASSETS.map(([key, name]) => {
    const points = marketPoints(key, name);
    const quote = getMarketQuote(name);
    const price = Number(quote?.price);
    const change = points.length > 1 && points[0].value !== 0 ? (points.at(-1).value / points[0].value - 1) * 100 : null;
    const priceText = Number.isFinite(price) ? [quote.currency, price.toLocaleString(locale, { maximumFractionDigits: 2 }), quote.unit].filter(Boolean).join(' ') : translateText('Quote unavailable', language);
    return '<button class="asset-market-row" type="button" data-asset-chart="' + key + '"><span><b>' + esc(name) + '</b><small>' + esc(priceText) + '</small></span><span class="asset-market-change ' + (change >= 0 ? 'positive' : 'negative') + '">' + (change === null ? '—' : (change > 0 ? '+' : '') + change.toLocaleString(locale, { maximumFractionDigits: 2 }) + '%') + '<i>⌄</i></span></button>';
  }).join('');

  const investments = (current?.investments || []).filter((investment) => investment.status === 'active');
  const choices = [
    ...investments.map((investment) => ({ id: 'investment:' + investment.id, label: investment.planName || 'Investment', allocations: investment.allocation || PLANS.find((plan) => plan.id === investment.planId)?.allocations || [], base: investment.principal })),
    ...PLANS.map((plan) => ({ id: plan.id, label: plan.name, allocations: plan.allocations, base: 100 })),
  ];
  if (!choices.some((choice) => choice.id === selectedPortfolioChart)) selectedPortfolioChart = choices[0]?.id || '';
  const selectors = $('plan-chart-selectors');
  selectors.innerHTML = choices.map((choice) => '<button type="button" class="chart-selector' + (choice.id === selectedPortfolioChart ? ' active' : '') + '" data-portfolio-chart="' + esc(choice.id) + '">' + esc(choice.label) + '</button>').join('');
  const selected = choices.find((choice) => choice.id === selectedPortfolioChart);
  drawLineChart($('plan-history-chart'), selected ? portfolioHistory(selected.allocations, selected.base) : [], selected ? selected.label + ' portfolio performance' : translateText('Plan performance', language));

  const assetKey = selectedAssetChart;
  if (assetKey) renderAssetDetailChart(assetKey);
}

function renderAssetDetailChart(key) {
  const asset = HISTORY_ASSETS.find((item) => item[0] === key);
  if (!asset) return;
  const [, name] = asset;
  const quote = getMarketQuote(name);
  const currency = quote?.currency || 'USD';
  const pair = name + ' / ' + currency;
  $('asset-detail-title').textContent = pair;
  $('asset-chart-ranges').innerHTML = ASSET_CHART_RANGES.map(({ id }) =>
    '<button type="button" class="asset-chart-range' + (id === selectedAssetRange ? ' active' : '') + '" data-asset-range="' + id + '" aria-pressed="' + (id === selectedAssetRange) + '">' + id + '</button>',
  ).join('');
  const range = ASSET_CHART_RANGES.find((item) => item.id === selectedAssetRange) || ASSET_CHART_RANGES.at(-1);
  const since = Date.now() - range.days * DAY_MS;
  const intraday = getMarketHistory()?.intraday?.[key] || [];
  const points = range.id === '1D' && intraday.length ? [...intraday] : marketPoints(key, name);
  const livePrice = Number(quote?.price);
  const liveTime = Number(quote?.marketAt);
  if (range.id === '1D' && Number.isFinite(livePrice) && (key === 'electricity' || livePrice > 0) && Number.isFinite(liveTime)) {
    const latest = points.at(-1);
    if (!latest || liveTime > latest.time) points.push({ time: liveTime, value: livePrice });
    else if (liveTime === latest.time) points[points.length - 1] = { time: liveTime, value: livePrice };
  }
  const visiblePoints = points.filter((point) => point.time >= since);
  const chartPoints = visiblePoints.length ? visiblePoints : range.id === '1D' ? points.slice(-1) : points;
  drawLineChart($('asset-detail-chart'), chartPoints, pair + ' historical price chart', {
    currency, interactive: true,
  });
  $('asset-detail-quote').innerHTML = renderMarketQuoteContent(name);
}

function loadAssetHistory() {
  if (marketHistoryRequest) return marketHistoryRequest;
  marketHistoryRequest = Promise.all([refreshMarketQuotes(), refreshMarketHistory()]).then(([, history]) => {
    updateVisibleMarketQuotes();
    if (history) renderAssetHistoryChart();
    else {
      $('plan-history-chart').innerHTML = '<p>' + translateText('Market data unavailable', language) + '</p>';
      $('asset-market-list').innerHTML = '<p>' + translateText('Market data unavailable', language) + '</p>';
    }
  }).finally(() => {
    marketHistoryRequest = null;
  });
  return marketHistoryRequest;
}

function updateVisibleMarketQuotes() {
  document.querySelectorAll('.asset-market-price').forEach((node) => {
    node.innerHTML = renderMarketQuoteContent(node.dataset.assetName);
  });
}

function currentMarketQuotes() {
  return Object.fromEntries([...new Set(PLANS.flatMap((plan) => plan.allocations.map((item) => item.name)))]
    .map((name) => [name, Number(getMarketQuote(name)?.price)])
    .filter(([, price]) => Number.isFinite(price) && price > 0));
}

function renderAllocationRows(allocation) {
  return allocation.map((item) => {
    const weight = Math.max(0, Math.min(100, Number(item.weight) || 0));
    return `<div class="allocation-row">
      <div class="allocation-row-head">
        <span><b>${esc(item.name)}</b><small>${esc(item.category || 'Mercato')}</small></span>
        <span class="allocation-values"><b>${weight.toLocaleString(LANGUAGE_LOCALES[language])}%</b></span>
      </div>
      <div class="allocation-track"><i style="width:${weight}%"></i></div>
      <div class="asset-market-price" data-asset-name="${esc(item.name)}">${renderMarketQuoteContent(item.name)}</div>
    </div>`;
  }).join('');
}

function showPlanDetails(id) {
  selectedPlan = PLANS.find((plan) => plan.id === id);
  if (!selectedPlan) return;
  $('details-eyebrow').textContent = 'PLAN DETAILS';
  $('details-title').textContent = translateText(selectedPlan.name, language);
  $('details-overview').innerHTML = `
    <div><span>${translateText('Contract term', language)}</span><b>${translateText(selectedPlan.months === 6 ? '6 months' : selectedPlan.months === 12 ? '1 year' : (selectedPlan.months / 12) + ' years', language)}</b></div>
    <div><span>${translateText('Return model', language)}</span><b>${translateText('Market-linked, variable', language)}</b></div>
    <div><span>${translateText('Capital protection', language)}</span><b>-20%</b></div>`;
  $('allocation-intro').textContent = translateText('Portfolio value follows live market prices. No fixed daily return.', language);
  $('details-allocation').innerHTML = renderAllocationRows(selectedPlan.allocations);
  selectedInvestmentId = '';
  $('details-invest-button').hidden = false;
  $('details-close-investment').hidden = true;
  translatePage(language);
  $('details-dialog').showModal();
}

function showInvestmentDetails(id) {
  const investment = current?.investments.find((item) => item.id === id);
  if (!investment) return;
  const plan = PLANS.find((item) => item.id === investment.planId);
  const allocation = investment.allocation?.length ? investment.allocation : (plan?.allocations || []);
  selectedPlan = plan || { allocations: allocation };
  const ended = investment.status !== 'active';
  const marketValue = investment.status === 'closed-early'
    ? Number(investment.closePortfolioValue) || 0
    : Number(investment.marketValue) || investment.principal;
  const redeemable = ended ? 0 : Math.max(0, marketValue - investment.principal);
  const alreadyRedeemed = Number(investment.earningsRedeemedGross) || current.transactions
    .filter((entry) => entry.type === 'earning-redemption' && entry.investmentId === investment.id)
    .reduce((sum, entry) => sum + (Number(entry.grossAmount) || Number(entry.amount) || 0), 0);
  const currentGain = Math.max(0, marketValue - Number(investment.principal || 0));
  const estimatedEarlyRefund = Math.max(0, marketValue * 0.35 - alreadyRedeemed - currentGain);
  const suspended = !ended && investment.protectionSuspended;
  const stopLossPercent = Math.min(80, Math.max(1, Number(investment.stopLossPercent) || 20));
  selectedInvestmentId = investment.id;
  $('details-eyebrow').textContent = investment.status === 'closed-early' ? 'CLOSED EARLY' : ended ? 'COMPLETED INVESTMENT' : suspended ? 'SUSPENDED INVESTMENT' : 'ACTIVE INVESTMENT';
  $('details-title').textContent = plan ? translateText(plan.name, language) : translateText(investment.planName || `${investment.days}-day plan`, language);
  $('details-overview').innerHTML = `
    <div><span>${translateText('Investment status', language)}</span><b>${translateText(investment.status === 'closed-early' ? 'Closed early' : ended ? 'Completed' : suspended ? 'Suspended at stop loss' : 'Active', language)}</b></div>
    ${investment.status === 'closed-early' ? `<div><span>Early-close refund</span><b>${usd(investment.closeRefund)}</b></div><div><span>Portfolio value at closure</span><b>${usd(investment.closePortfolioValue)}</b></div><div><span>65% early-close penalty</span><b>${usd(investment.closePenalty)}</b></div><div><span>All generated gains deducted</span><b>${usd(investment.closeGainsDeducted ?? investment.closePreviouslyRedeemedGains)}</b></div>` : ''}
    <div><span>${translateText('Locked capital', language)}</span><b>${usd(marketValue)}</b></div>
    <div><span>${translateText('Current portfolio value', language)}</span><b>${usd(marketValue)}</b></div>
    <div><span>${translateText('Redeemable profits', language)}</span><b>${usd(redeemable)}</b></div>
    ${!ended ? `<div><span>Estimated early-close refund</span><b>${usd(estimatedEarlyRefund)}</b></div><div><span>Calculation</span><b>${usd(marketValue)} − 65% penalty − ${usd(alreadyRedeemed + currentGain)} generated gains</b></div>` : ''}
    <div><span>${translateText('Days remaining', language)}</span><b>${Math.max(0, calendarDaysBetween(Date.now(), investment.maturityAt || investment.startedAt + investment.days * DAY_MS))}</b></div>
    <div><span>${translateText('Market change', language)}</span><b>${((marketValue / investment.principal - 1) * 100).toLocaleString(LANGUAGE_LOCALES[language], { maximumFractionDigits: 2 })}%</b></div>
    <div><span>${translateText('Capital protection threshold', language)}</span><b>${usd(investment.principal * (1 - stopLossPercent / 100))} (${stopLossPercent}% ${translateText('stop loss', language)})</b></div>
    <div><span>${translateText('Contract maturity', language)}</span><b>${timestampDate(investment.maturedAt || investment.startedAt + investment.days * DAY_MS)}</b></div>
    <div><span>${translateText('Started', language)}</span><b>${timestampDate(investment.startedAt)}</b></div>
    ${(investment.stopLossPeriods || []).map((period, index) => `<div><span>${translateText('Stop-loss period', language)} ${index + 1}</span><b>${timestampDateTime(period.startedAt)} · ${period.endedAt ? timestampDateTime(period.endedAt) : translateText('Ongoing', language)} · ${Number(period.thresholdPercent) || stopLossPercent}%</b></div>`).join('')}`;
  $('allocation-intro').textContent = translateText('Live reference quotes and portfolio allocation.', language);
  $('details-allocation').innerHTML = renderAllocationRows(allocation);
  $('details-invest-button').hidden = true;
  $('details-close-investment').hidden = ended;
  translatePage(language);
  $('details-dialog').showModal();
}

function renderActivity(transaction) {
  const titles = {
    deposit: 'Deposit',
    investment: 'Investment started',
    subscription: 'Custom plan subscription',
    earnings: 'Daily earnings',
    compounding: 'Daily return reinvested',
    'earning-redemption': 'Earnings redeemed',
    'early-closure': 'Investment closed early',
    maturity: 'Portfolio value released',
    withdrawal: 'Withdrawal request',
    'withdrawal-refund': 'Withdrawal refunded',
    coupon: 'Coupon redemption',
    bonus: 'Earnings boost activated',
    'account-adjustment': 'Balance adjustment',
    'stop-loss': 'Stop-loss protection started',
    'stop-loss-resumed': 'Stop-loss protection ended',
  };
  const date = timestampDate(transaction.date);
  const status = {
    pending: 'Pending review',
    confirmed: 'Confirmed',
    completed: 'Completed',
    accredited: 'Credited',
    rejected: 'Rejected',
    requested: 'Pending redemption',
    compounded: 'Reinvested',
    suspended: 'Protection active',
  }[transaction.status] || 'Recorded';
  const investmentReference = transaction.investmentId
    ? `${transaction.planName || 'Investment'} · #${String(transaction.investmentId).slice(0, 8)}`
    : '';
  const context = investmentReference || NETWORKS[transaction.network] || transaction.planName || '';
  return `<article class="activity-row">
    <span class="activity-mark" aria-hidden="true">${transaction.type === 'stop-loss' ? '!' : transaction.type === 'stop-loss-resumed' ? '↻' : transaction.type === 'deposit' || transaction.type === 'maturity' || transaction.type === 'withdrawal-refund' || transaction.type === 'account-adjustment' && transaction.direction === 'credit' ? '↓' : transaction.type === 'withdrawal' || transaction.type === 'account-adjustment' && transaction.direction === 'debit' ? '↑' : '↗'}</span>
    <span class="activity-copy"><b>${translateText(transaction.additional ? 'Additional funds added' : titles[transaction.type] || 'Account activity', language)}</b><small>${esc(context ? `${translateText(context, language)} · ` : '')}${translateText(status, language)} · ${date}</small></span>
    <b class="activity-amount ${movementAmount(transaction).startsWith('+') ? 'movement-credit' : movementAmount(transaction).startsWith('−') ? 'movement-debit' : ''}">${movementAmount(transaction)}</b>
  </article>`;
}

function movementCategory(transaction) {
  if (transaction.type === 'deposit') return 'deposits';
  if (transaction.type === 'withdrawal') return 'withdrawals';
  if (transaction.type === 'investment' || transaction.type === 'early-closure' || transaction.type === 'stop-loss' || transaction.type === 'stop-loss-resumed') return 'investments';
  if (transaction.type === 'account-adjustment' && transaction.direction === 'credit') return 'credits';
  if (['earnings', 'compounding', 'earning-redemption', 'maturity', 'coupon', 'withdrawal-refund'].includes(transaction.type)) return 'credits';
  return 'other';
}

function movementRequest(transaction) {
  if (transaction.type === 'deposit') {
    return (current.depositRequests || []).find((request) =>
      request.id === transaction.requestId || request.transactionId === transaction.id,
    ) || null;
  }
  if (transaction.type === 'withdrawal' || transaction.type === 'withdrawal-refund') {
    return (current.withdrawalRequests || []).find((request) =>
      request.id === transaction.requestId || request.transactionId === transaction.id,
    ) || null;
  }
  return null;
}

function renderMovement(transaction) {
  const request = movementRequest(transaction);
  const withdrawalFeeRate = request?.feeRate ?? (request?.source === 'unlocked' ? 0.2 : 0.04);
  const detailRows = [
    ['Date and time', timestampDateTime(transaction.date)],
    ['Movement type', translateText({
      deposit: 'Deposit',
      investment: transaction.additional ? 'Additional funds added' : 'Investment',
      subscription: 'Custom plan subscription',
      earnings: 'Earnings credited',
      compounding: 'Return reinvested',
      'earning-redemption': 'Earnings redeemed',
      'early-closure': 'Investment closed early',
      maturity: 'Portfolio value released',
      withdrawal: 'Withdrawal',
      'withdrawal-refund': 'Withdrawal refund',
      coupon: 'Reward credit',
      bonus: 'Bonus activated',
      'account-adjustment': 'Balance adjustment',
      'stop-loss': 'Stop-loss protection started',
      'stop-loss-resumed': 'Stop-loss protection ended',
    }[transaction.type] || 'Other movement', language)],
    ['Status', translateText({
      pending: 'Pending review',
      confirmed: 'Confirmed',
      completed: 'Completed',
      accredited: 'Credited',
      rejected: 'Rejected',
      requested: 'Pending redemption',
      compounded: 'Reinvested',
      suspended: 'Protection active',
    }[transaction.status] || 'Recorded', language)],
    ['Amount', transaction.type === 'deposit' && request
      ? depositRequestAmount(request)
      : movementAmount(transaction)],
  ];
  if (request?.creditUsdt) detailRows.push(['Credited to deposit balance after 1% fee', usd(request.creditUsdt)]);
  if (transaction.type === 'deposit' && request?.feeAmount) detailRows.push(['Platform fee (1%)', usd(request.feeAmount)]);
  if (transaction.grossAmount !== undefined) detailRows.push(['Gross amount', usd(transaction.grossAmount)]);
  if (transaction.type === 'withdrawal' && request?.status === 'pending' && request.feeAmount > 0) detailRows.push(['Platform fee (' + (withdrawalFeeRate * 100) + '%)', usd(request.feeAmount)]);
  else if (transaction.type === 'withdrawal' && request?.status === 'completed' && request.feeAmount > 0) detailRows.push(['Platform fee (' + (withdrawalFeeRate * 100) + '%)', usd(request.feeAmount)]);
  else if (transaction.feeAmount > 0 && transaction.type !== 'withdrawal') detailRows.push(['Platform fee', usd(transaction.feeAmount)]);
  if (transaction.type === 'withdrawal' && request?.status === 'pending' && request.payoutAmount !== undefined) detailRows.push(['Estimated net payout', usd(request.payoutAmount)]);
  else if (transaction.payoutAmount !== undefined && transaction.status === 'completed') detailRows.push(['Net payout after ' + (withdrawalFeeRate * 100) + '% fee', usd(transaction.payoutAmount)]);
  if (transaction.penaltyAmount !== undefined) detailRows.push(['Early-close penalty (65%)', usd(transaction.penaltyAmount)]);
  if (transaction.gainsAlreadyGenerated !== undefined) detailRows.push(['Previously redeemed gains deducted', usd(transaction.gainsAlreadyGenerated)]);
  if (transaction.portfolioValue !== undefined) detailRows.push(['Portfolio value at closure', usd(transaction.portfolioValue)]);
  if (transaction.network) detailRows.push(['Network', NETWORKS[transaction.network] || transaction.network]);
  if (request?.createdAt) detailRows.push(['Request submitted', timestampDateTime(request.createdAt)]);
  if (request?.reviewedAt) detailRows.push(['Reviewed', timestampDateTime(request.reviewedAt)]);
  if (request?.txHash) detailRows.push(['Transaction hash', request.txHash]);
  if (request?.payoutHash) detailRows.push(['Payout hash', request.payoutHash]);
  if (request?.address) detailRows.push(['Destination address', request.address]);
  else if (transaction.addressHint) detailRows.push(['Destination address', transaction.addressHint]);
  if (transaction.planName) detailRows.push(['Plan or reference', transaction.planName]);
  if (transaction.balanceType) detailRows.push(['Balance affected', translateText(transaction.balanceType === 'deposit' ? 'Deposit balance' : 'Earnings balance', language)]);
  if (transaction.previousBalance !== undefined) detailRows.push(['Previous balance', usd(transaction.previousBalance)]);
  if (transaction.newBalance !== undefined) detailRows.push(['Updated balance', usd(transaction.newBalance)]);
  if (transaction.investmentId) detailRows.push(['Investment ID', transaction.investmentId]);
  if (transaction.earningDay) detailRows.push(['Accrual date', transaction.earningDay]);
  if (transaction.requestId) detailRows.push(['Request ID', transaction.requestId]);
  if (transaction.type === 'subscription') {
    const termMonths = Number(transaction.termMonths) || 12;
    detailRows.push(['Access duration', translateText(termMonths === 6 ? '6 months' : (termMonths / 12) + (termMonths === 12 ? ' year' : ' years'), language)]);
    if (transaction.accessUntil) detailRows.push(['Access until', timestampDateTime(transaction.accessUntil)]);
  }
  if (transaction.type === 'stop-loss') {
    if (transaction.inherited) detailRows.push(['Tracking began while protection active', translateText('Original stop-loss start date is unavailable.', language)]);
    detailRows.push(['Protection threshold', (Number(transaction.thresholdPercent) || 20) + '%']);
    detailRows.push(['Protected portfolio value', usd(transaction.protectionValue)]);
    detailRows.push(['No cash transfer', translateText('Exposure paused at the protection threshold.', language)]);
  }
  if (transaction.type === 'stop-loss-resumed') detailRows.push(['Protection resumed', timestampDateTime(transaction.resumedAt || transaction.date)]);
  detailRows.push(['Movement ID', transaction.id]);

  const title = transaction.additional ? 'Additional funds added' : ({
    deposit: 'Deposit', investment: 'Investment started', subscription: 'Custom plan subscription', earnings: 'Daily earnings',
    compounding: 'Daily return reinvested', 'earning-redemption': 'Earnings redeemed',
    maturity: 'Portfolio value released', withdrawal: 'Withdrawal request',
    'withdrawal-refund': 'Withdrawal refunded',
    coupon: 'Coupon redemption', bonus: 'Earnings boost activated',
    'account-adjustment': 'Balance adjustment',
    'stop-loss': 'Stop-loss protection started',
    'stop-loss-resumed': 'Stop-loss protection ended',
  }[transaction.type] || 'Account activity');
  const status = {
    pending: 'Pending review', confirmed: 'Confirmed', completed: 'Completed',
    accredited: 'Credited', rejected: 'Rejected', requested: 'Pending redemption',
    compounded: 'Reinvested', suspended: 'Protection active',
  }[transaction.status] || 'Recorded';
  const context = transaction.investmentId
    ? `${transaction.planName || 'Investment'} · #${String(transaction.investmentId).slice(0, 8)}`
    : NETWORKS[transaction.network] || transaction.planName || '';
  return `<details class="movement-entry">
    <summary class="movement-summary">
      <span class="activity-mark" aria-hidden="true">${transaction.type === 'stop-loss' ? '!' : transaction.type === 'stop-loss-resumed' ? '↻' : transaction.type === 'deposit' || transaction.type === 'maturity' || transaction.type === 'withdrawal-refund' || transaction.type === 'account-adjustment' && transaction.direction === 'credit' ? '↓' : transaction.type === 'withdrawal' || transaction.type === 'account-adjustment' && transaction.direction === 'debit' ? '↑' : '↗'}</span>
      <span class="activity-copy"><b>${esc(translateText(title, language))}</b><small>${esc(context ? `${translateText(context, language)} · ` : '')}${esc(translateText(status, language))} · ${timestampDateTime(transaction.date)}</small></span>
      <b class="activity-amount ${movementAmount(transaction).startsWith('+') ? 'movement-credit' : movementAmount(transaction).startsWith('−') ? 'movement-debit' : ''}">${movementAmount(transaction)}</b><span class="movement-expand" aria-hidden="true">⌄</span>
    </summary>
    <div class="movement-details">${detailRows.map(([label, value]) =>
      `<div><span>${esc(translateText(label, language))}</span><b>${esc(value)}</b></div>`,
    ).join('')}</div>
  </details>`;
}

function renderPointActivity(entry) {
  return `<article class="points-row">
    <span><b>${esc(translateText(entry.label, language))}</b><small>Bonus points · ${timestampDate(entry.date)}</small></span>
    <b class="points-delta ${entry.amount < 0 ? 'spent' : ''}">${entry.amount > 0 ? '+' : ''}${entry.amount.toLocaleString(LANGUAGE_LOCALES[language])}</b>
  </article>`;
}

function renderAccountRequestHistory(account) {
  const history = [
    ...(account.depositRequests || [])
      .filter((request) => request.status !== 'pending')
      .map((request) => ({ type: 'Deposit', request })),
    ...(account.withdrawalRequests || [])
      .filter((request) => request.status !== 'pending')
      .map((request) => ({ type: 'Withdrawal', request })),
  ];
  if (account.reviewedAt && ['approved', 'rejected'].includes(account.status)) {
    history.push({
      type: 'Account registration',
      request: {
        id: `account-${account.id}`,
        amount: null,
        status: account.status,
        createdAt: account.createdAt,
        reviewedAt: account.reviewedAt,
      },
    });
  }
  history.sort((a, b) => (b.request.reviewedAt || b.request.createdAt || 0) -
    (a.request.reviewedAt || a.request.createdAt || 0));

  return `<details class="account-history">
    <summary>Request history <span>${history.length}</span></summary>
    ${history.length ? `<div class="account-history-list">${history.map(({ type, request }) => {
      const status = {
        confirmed: 'Confirmed',
        completed: 'Paid',
        rejected: 'Rejected',
        approved: 'Approved',
      }[request.status] || request.status;
      const reference = request.txHash || request.address;
      return `<article class="account-history-row">
        <div><b>${esc(type)}${request.amount === null ? '' : ` · ${type === 'Deposit' ? depositRequestAmount(request) : usd(request.amount)}`}</b><span class="history-status">${esc(status)}</span></div>
        <small>Submitted ${timestampDate(request.createdAt)} · Reviewed ${timestampDate(request.reviewedAt || request.createdAt)}</small>
        ${request.network ? `<small>${esc(NETWORKS[request.network] || request.network)}</small>` : ''}
        ${reference ? `<code>${esc(reference)}</code>` : ''}
        ${request.payoutHash ? `<small>External payout hash</small><code>${esc(request.payoutHash)}</code>` : ''}
      </article>`;
    }).join('')}</div>` : '<p class="account-history-empty">No reviewed requests.</p>'}
  </details>`;
}

function renderAdmin() {
  if (!current || current.role !== 'admin') return;
  const pendingWalletChanges = accounts.flatMap((account) =>
    (account.walletChangeRequests || [])
      .filter((request) => request.status === 'pending')
      .map((request) => ({ account, request })),
  );
  $('pending-wallet-count').textContent = pendingWalletChanges.length;
  $('wallet-queue-empty').hidden = pendingWalletChanges.length > 0;
  $('pending-wallet-changes').innerHTML = pendingWalletChanges.map(({ account, request }) => `
    <article class="queue-card">
      <div class="queue-card-head"><div><b>${esc(account.username)}</b><span>${esc(account.email)}</span></div><span class="queue-status">Pending</span></div>
      <small>Current: ${esc(NETWORKS[request.previousNetwork] || request.previousNetwork)} · ${esc(request.previousAddress)}</small>
      <small>Requested: ${esc(NETWORKS[request.network] || request.network)} · ${esc(request.address)}</small>
      <div class="queue-actions"><button class="approve-button" type="button" data-admin-action="approve-wallet-change" data-user="${esc(account.id)}" data-request="${esc(request.id)}">Approve change</button><button class="reject-button" type="button" data-admin-action="reject-wallet-change" data-user="${esc(account.id)}" data-request="${esc(request.id)}">Reject</button></div>
    </article>`).join('');

  const pendingUsers = accounts.filter((account) => account.status === 'pending');
  const pendingDeposits = accounts.flatMap((account) =>
    (account.depositRequests || [])
      .filter((request) => request.status === 'pending')
      .map((request) => ({ account, request })),
  );
  const pendingWithdrawals = accounts.flatMap((account) =>
    (account.withdrawalRequests || [])
      .filter((request) => request.status === 'pending')
      .map((request) => ({ account, request })),
  );
  $('pending-user-count').textContent = pendingUsers.length;
  $('registered-user-count').textContent = accounts.length;
  $('pending-deposit-count').textContent = pendingDeposits.length;
  $('pending-withdrawal-count').textContent = pendingWithdrawals.length;
  $('users-queue-empty').hidden = pendingUsers.length > 0;
  $('deposits-queue-empty').hidden = pendingDeposits.length > 0;
  $('withdrawals-queue-empty').hidden = pendingWithdrawals.length > 0;
  $('registered-users').innerHTML = accounts.map((account) => `
    <article class="queue-card account-admin-card" data-account-card="${esc(account.id)}">
      <div class="queue-card-head"><div><b>${esc(account.username)}</b><span>${esc(account.email)}</span></div><span class="queue-status ${account.status === 'blocked' ? 'blocked' : ''}">${account.status === 'blocked' ? 'Blocked' : esc(account.status)}</span></div>
      <small>ID ${esc(account.id)} · Registered ${timestampDate(account.createdAt)} · ${account.role === 'admin' ? 'Admin' : 'User'} · ${(account.h9Points || 0).toLocaleString(LANGUAGE_LOCALES[language])} bonus points · ${(account.bonusSpins || 0).toLocaleString(LANGUAGE_LOCALES[language])} extra spins · ${(account.investments || []).length} investments</small>
      <div class="account-balance-fields">
        <label>Deposit balance (USDT)<input type="number" min="0" step="0.01" data-balance="deposit" value="${Number(account.wallet?.deposit || 0)}"></label>
        <label>Earnings balance (USDT)<input type="number" min="0" step="0.01" data-balance="earnings" value="${Number(account.wallet?.earnings || 0)}"></label>
      </div>
      <div class="account-credit-fields">
        <label>Points to add<input type="number" min="0" step="1" inputmode="numeric" data-credit="points" placeholder="0"></label>
        <label>Extra spins to add<input type="number" min="0" step="1" inputmode="numeric" data-credit="spins" placeholder="0"></label>
      </div>
      <div class="queue-actions">
        <button class="approve-button" type="button" data-admin-action="save-account" data-user="${esc(account.id)}">Save balances</button>
        <button class="reject-button" type="button" data-admin-action="toggle-account" data-user="${esc(account.id)}" ${account.id === current.id ? 'disabled' : ''}>${account.status === 'blocked' ? 'Unblock account' : 'Block account'}</button>
      </div>
      ${renderAccountRequestHistory(account)}
      <button class="outline-wide credit-rewards-button" type="button" data-admin-action="credit-rewards" data-user="${esc(account.id)}">Credit points / spins</button>
    </article>`).join('');

  $('pending-users').innerHTML = pendingUsers.map((account) => `
    <article class="queue-card">
      <div class="queue-card-head"><div><b>${esc(account.username)}</b><span>${esc(account.email)}</span></div><span class="queue-status">Pending approval</span></div>
      <small>Registered ${timestampDate(account.createdAt)}</small>
      <div class="queue-actions"><button class="approve-button" type="button" data-admin-action="approve-account" data-user="${esc(account.id)}">Approve account</button><button class="reject-button" type="button" data-admin-action="reject-account" data-user="${esc(account.id)}">Reject</button></div>
    </article>`).join('');

  $('pending-deposits').innerHTML = pendingDeposits.map(({ account, request }) => `
    <article class="queue-card">
      <div class="queue-card-head"><div><b>${esc(account.username)} · ${depositRequestAmount(request)}</b><span>${esc(account.email)}</span></div><span class="queue-status">Pending</span></div>
      <small>${esc(NETWORKS[request.network] || request.network)} · ${timestampDate(request.createdAt)}</small>
      <code class="queue-hash">${esc(request.txHash)}</code>
      <label class="queue-input-label" for="credit-${esc(request.id)}">Verified gross amount (USDT)</label>
      <input class="queue-input" id="credit-${esc(request.id)}" type="number" min="0.00000001" step="any" placeholder="Gross verified amount before 1% platform fee">
      <div class="queue-actions"><button class="approve-button" type="button" data-admin-action="confirm-deposit" data-user="${esc(account.id)}" data-request="${esc(request.id)}">Verify &amp; credit</button><button class="reject-button" type="button" data-admin-action="reject-deposit" data-user="${esc(account.id)}" data-request="${esc(request.id)}">Reject</button></div>
    </article>`).join('');

  $('pending-withdrawals').innerHTML = pendingWithdrawals.map(({ account, request }) => `
    <article class="queue-card" data-withdrawal-card="${esc(request.id)}">
      <div class="queue-card-head"><div><b>${esc(account.username)} · ${usd(request.payoutAmount ?? request.amount * (1 - (request.feeRate ?? (request.source === 'unlocked' ? 0.2 : 0.04))))} net payout</b><span>${esc(account.email)} · ${usd(request.amount)} gross − ${usd(request.feeAmount ?? request.amount * (request.feeRate ?? (request.source === 'unlocked' ? 0.2 : 0.04)))} fee</span></div><span class="queue-status">Pending</span></div>
      <small>${esc(NETWORKS[request.network] || request.network)} · ${timestampDate(request.createdAt)}</small>
      <code class="queue-hash">${esc(request.address)}</code>
      <label class="queue-input-label" for="payout-${esc(request.id)}">External payout hash</label>
      <input class="queue-input" id="payout-${esc(request.id)}" type="text" placeholder="Transaction hash">
      <div class="queue-actions"><button class="approve-button" type="button" data-admin-action="complete-withdrawal" data-user="${esc(account.id)}" data-request="${esc(request.id)}">Mark paid</button><button class="reject-button" type="button" data-admin-action="reject-withdrawal" data-user="${esc(account.id)}" data-request="${esc(request.id)}">Reject and refund</button></div>
    </article>`).join('');
}

function refreshDepositAddressDisplay() {
  const network = $('deposit-network')?.value;
  const address = depositAddresses[network] || '';
  const value = $('deposit-address-value');
  if (!value) return;
  const asset = { bep20: 'BNB', trc20: 'USDT', bitcoin: 'BTC' }[network] || 'crypto';
  $('deposit-asset-label').textContent = `${asset} receiving address`;
  $('deposit-amount-label').textContent = 'Amount (USD)';
  $('deposit-amount').placeholder = 'Amount in USD';
  $('deposit-amount').min = '0.01';
  $('deposit-amount').step = '0.01';
  value.textContent = address || translateText('Address not configured for this network.', language);
  $('deposit-address-box').classList.toggle('unconfigured', !address);
  $('copy-deposit-address').disabled = !address;
}

function renderDailyPrizeOdds() {
  const colors = ['#91d85a', '#68b95d', '#46a579', '#42988e', '#70c994', '#a8e275', '#8cce64', '#5fae78', '#b7e983'];
  const sliceAngle = 360 / DAILY_PRIZES.length;
  const stops = DAILY_PRIZES.map((prize, index) =>
    `${colors[index]} ${index * sliceAngle}deg ${(index + 1) * sliceAngle}deg`,
  );
  $('mystery-wheel').style.background = `conic-gradient(${stops.join(',')})`;
  $('daily-prize-odds').innerHTML = DAILY_PRIZES.map((prize, index) =>
    `<div class="odds-row"><span class="prize-label"><i class="prize-dot" style="--prize-color:${colors[index]}"></i>${prize.points.toLocaleString(LANGUAGE_LOCALES[language])} bonus points</span></div>`,
  ).join('');
}

function updateSpinButton() {
  const today = new Date().toISOString().slice(0, 10);
  const usedDailySpin = current.lastDailyPrizeDate === today;
  const extraSpins = current.bonusSpins || 0;
  $('spin-wheel').disabled = wheelSpinning || (usedDailySpin && extraSpins === 0);
  $('spin-wheel').textContent = usedDailySpin
    ? (extraSpins > 0 ? `${translateText('Use extra spin', language)} · ${extraSpins}` : translateText('Come back tomorrow', language))
    : translateText('Open today’s mystery box', language);
}

function renderRewards() {
  const today = new Date().toISOString().slice(0, 10);
  const inviteUrl = new URL(location.href);
  inviteUrl.hash = '';
  inviteUrl.searchParams.set('ref', current.referralCode || '');
  $('invite-link').value = inviteUrl.href;
  $('h9-points').textContent = (current.h9Points || 0).toLocaleString(LANGUAGE_LOCALES[language]);
  $('extra-spin-count').textContent = (current.bonusSpins || 0).toLocaleString(LANGUAGE_LOCALES[language]);
  $('referral-count').textContent = (current.referrals || []).length.toLocaleString(LANGUAGE_LOCALES[language]);
  updateSpinButton();
  const todaysPrize = (current.dailyPrizes || []).find((prize) =>
    new Date(prize.date).toISOString().slice(0, 10) === today,
  );
  $('wheel-result').textContent = todaysPrize
    ? `${translateText('Today’s prize', language)}: ${todaysPrize.points.toLocaleString(LANGUAGE_LOCALES[language])} bonus points`
    : 'Open one mystery box each day.';
  $('reward-catalog').innerHTML = REWARDS.map((reward) => {
    const detail = reward.type === 'boost'
      ? `${translateText('Double calculated earnings on active plans for', language)} ${reward.hours} ${translateText(reward.hours === 1 ? 'hour' : 'hours', language)}.`
      : `${translateText('Redeem for', language)} ${usd(reward.amount)} ${translateText('in your account deposit balance. Credits cannot be transferred or paid out.', language)}`;
    return `<article class="reward-card">
      <h3>${esc(translateText(reward.title, language))}</h3><p>${esc(detail)}</p>
      <span class="reward-cost">${reward.points.toLocaleString(LANGUAGE_LOCALES[language])} bonus points</span>
      <button class="primary-button" type="button" data-buy-reward="${esc(reward.id)}">${translateText('Redeem', language)}</button>
    </article>`;
  }).join('');

  const activeBonuses = (current.activeBonuses || [])
    .filter((bonus) => bonus.expiresAt > Date.now());
  const redemptions = current.rewardRedemptions || [];
  const benefitRows = [
    ...activeBonuses.map((bonus) => {
      const remainingHours = Math.max(1, Math.ceil((bonus.expiresAt - Date.now()) / 3_600_000));
      return `<article class="reward-row"><span><b>${esc(translateText(bonus.title, language))}</b><small>${translateText('Ends', language)} ${timestampDate(bonus.expiresAt)}</small></span><span class="reward-state">2× · ${remainingHours}${translateText('h left', language)}</span></article>`;
    }),
    ...redemptions.map((coupon) =>
      `<article class="reward-row"><span><b>${esc(translateText(coupon.title, language))}</b><small>${translateText('Redeemed', language)} ${timestampDate(coupon.creditedAt || coupon.requestedAt)} · ${translateText(coupon.balanceDestination === 'deposit' ? 'added to account deposit balance' : 'added to account earnings', language)}</small></span><span class="reward-state">${translateText('Credited', language)}</span></article>`,
    ),
  ];
  $('active-rewards').innerHTML = benefitRows.join('');
  $('active-rewards-empty').hidden = benefitRows.length > 0;

  $('points-history').innerHTML = (current.pointHistory || []).map((entry) => `
    <article class="points-row">
      <span><b>${esc(translateText(entry.label, language))}</b><small>${timestampDate(entry.date)}</small></span>
      <b class="points-delta ${entry.amount < 0 ? 'spent' : ''}">${entry.amount > 0 ? '+' : ''}${entry.amount.toLocaleString(LANGUAGE_LOCALES[language])}</b>
    </article>`).join('');
  $('points-history-empty').hidden = (current.pointHistory || []).length > 0;
  renderDailyPrizeOdds();
}

function renderFullHistory() {
  const entries = [...(current.transactions || [])];
  const recordedRefunds = new Set(entries
    .filter((entry) => entry.type === 'withdrawal-refund')
    .map((entry) => entry.requestId));
  for (const request of current.withdrawalRequests || []) {
    if (request.status !== 'rejected' || !request.reviewedAt || recordedRefunds.has(request.id)) continue;
    entries.push({
      id: `refund-${request.id}`,
      type: 'withdrawal-refund',
      amount: request.amount,
      status: 'completed',
      date: request.reviewedAt,
      network: request.network,
      requestId: request.id,
      planName: 'Withdrawal request refund',
    });
  }
  entries.sort((a, b) => (b.date || 0) - (a.date || 0));
  const categories = [
    ['all', 'All movements'],
    ['deposits', 'Deposits'],
    ['credits', 'Credits'],
    ['withdrawals', 'Withdrawals'],
    ['investments', 'Investments'],
    ['other', 'Other'],
  ];
  $('profile-history-count').textContent = entries.length.toLocaleString(LANGUAGE_LOCALES[language]);
  $('history-filters').innerHTML = categories.map(([key, label]) => {
    const count = key === 'all' ? entries.length : entries.filter((entry) => movementCategory(entry) === key).length;
    return `<button class="history-filter${selectedHistoryFilter === key ? ' active' : ''}" type="button" data-history-filter="${key}" aria-pressed="${selectedHistoryFilter === key}">${esc(translateText(label, language))}<span>${count}</span></button>`;
  }).join('');
  const visibleEntries = selectedHistoryFilter === 'all'
    ? entries
    : entries.filter((entry) => movementCategory(entry) === selectedHistoryFilter);
  $('profile-activity').innerHTML = visibleEntries.map(renderMovement).join('');
  $('profile-activity-empty').hidden = visibleEntries.length > 0;
  $('profile-activity-empty').querySelector('b').textContent = translateText(
    entries.length ? 'No movements in this category' : 'No transactions yet', language,
  );
}

function render() {
  if (!current) return;
  const wallet = current.wallet;
  wallet.unlocked = Number(wallet.unlocked) || 0;
  const locked = current.investments
    .filter((investment) => investment.status === 'active')
    .reduce((sum, investment) => sum + (Number(investment.marketValue) || investment.principal), 0);
  $('user-chip').textContent = current.username;
  $('profile-username').textContent = current.username;
  $('profile-email').textContent = current.email;
  $('profile-account-id').textContent = current.id;
  $('profile-avatar').textContent = [...current.username][0].toLocaleUpperCase('it-IT');
  language = LANGUAGES.includes(current.preferences?.language) ? current.preferences.language : 'en';
  $('language-select').value = language;
  $('theme-select').value = current.preferences?.theme || 'dark';
  document.documentElement.lang = language;
  document.documentElement.dataset.theme = $('theme-select').value;
  const linkedWallet = current.withdrawalWallet;
  const pendingWalletChange = (current.walletChangeRequests || []).some((request) => request.status === 'pending');
  $('bound-wallet-label').textContent = pendingWalletChange
    ? 'Wallet change awaiting admin approval'
    : linkedWallet?.address ? `${NETWORKS[linkedWallet.network] || linkedWallet.network} · ${linkedWallet.address.slice(0, 8)}…${linkedWallet.address.slice(-5)}` : 'No wallet linked';
  $('edit-wallet-button').textContent = linkedWallet ? 'Request change' : 'Link wallet';
  $('edit-wallet-button').disabled = pendingWalletChange;
  $('wallet-title').textContent = linkedWallet ? 'Request wallet change' : 'Link a withdrawal wallet';
  $('save-wallet-button').textContent = linkedWallet ? 'Request admin approval' : 'Save wallet';
  $('withdrawal-pin-status').textContent = current.withdrawalPinSet ? 'Set' : 'Not set';
  $('edit-withdrawal-pin-button').textContent = current.withdrawalPinSet ? 'Change PIN' : 'Set PIN';
  $('wallet-network').value = linkedWallet?.network || 'bep20';
  $('wallet-address').value = linkedWallet?.address || '';
  $('withdraw-address').value = linkedWallet?.address || '';
  $('withdraw-network').value = linkedWallet?.network || 'bep20';
  $('withdraw-network').disabled = Boolean(linkedWallet);
  $('open-admin').hidden = current.role !== 'admin';
  $('reset-account-data').hidden = current.role !== 'admin';
  const total = balanceTotal();
  $('total-balance').textContent = usd(total);
  const chartParts = [
    Number(wallet.deposit) || 0,
    Number(wallet.unlocked) || 0,
    Number(wallet.earnings) || 0,
    locked,
  ].map((amount) => Math.max(0, amount));
  const chartTotal = chartParts.reduce((sum, amount) => sum + amount, 0);
  const circumference = 2 * Math.PI * 48;
  let chartOffset = 0;
  document.querySelectorAll('[data-balance-segment]').forEach((segment, index) => {
    const length = chartTotal ? chartParts[index] / chartTotal * circumference : 0;
    const visibleLength = Math.max(0, length - 3);
    segment.style.strokeDasharray = chartTotal
      ? visibleLength + ' ' + (circumference - visibleLength)
      : '0 ' + circumference;
    segment.style.strokeDashoffset = String(-chartOffset);
    chartOffset += length;
  });
  $('deposit-balance').textContent = usd(wallet.deposit);
  $('unlocked-balance').textContent = usd(wallet.unlocked);
  $('earnings-balance').textContent = usd(wallet.earnings);
  $('locked-balance').textContent = usd(locked);
  $('reinvested-balance').textContent = usd(redeemableEarnings());
  document.querySelectorAll('[data-redeem-earnings]').forEach((button) => {
    button.disabled = redeemableEarnings() <= 0;
    const label = `${translateText('Redeem profits', language)} · ${usd(redeemableEarnings())}`;
    (button.querySelector('b') || button).textContent = label;
  });
  $('profile-deposit').textContent = usd(wallet.deposit);
  $('profile-unlocked').textContent = usd(wallet.unlocked);
  $('profile-earnings').textContent = usd(wallet.earnings);
  updateWithdrawalQuote();
  $('invest-available').textContent = usd(wallet.deposit);

  const active = current.investments.filter((investment) => investment.status === 'active');
  const ended = current.investments.filter((investment) => investment.status !== 'active');
  $('home-investments').innerHTML = active.slice(0, 3).map((investment) => renderInvestment(investment)).join('');
  $('home-investments-empty').hidden = active.length > 0;
  $('active-investments').innerHTML = active.map((investment) => renderInvestment(investment)).join('');
  $('active-empty').hidden = active.length > 0;
  $('ended-investments').innerHTML = ended.map((investment) => renderInvestment(investment, true)).join('');
  $('ended-empty').hidden = ended.length > 0;
  $('locked-total').textContent = usd(locked);
  $('credited-total').textContent = usd(redeemableEarnings());

  const transactions = [...current.transactions].sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 5);
  $('home-history-count').textContent = current.transactions.length.toLocaleString(LANGUAGE_LOCALES[language]);
  $('recent-activity').innerHTML = transactions.map(renderActivity).join('');
  $('activity-empty').hidden = transactions.length > 0;
  renderFullHistory();
  const notificationsSeenAt = current.preferences?.notificationsSeenAt || 0;
  let earningsNotice = readEarningsNoticeState();
  const unreadEarnings = current.transactions.filter((item) =>
    item.type === 'earnings' && (item.date || 0) > notificationsSeenAt,
  );
  if (unreadEarnings.length &&
      Date.now() - (Number(earningsNotice.shownAt) || 0) >= DAY_MS) {
    earningsNotice = {
      shownAt: Date.now(),
      ids: unreadEarnings.map((item) => item.id),
    };
    localStorage.setItem(earningsNoticeKey(), JSON.stringify(earningsNotice));
  }
  const surfacedEarnings = new Set(Array.isArray(earningsNotice.ids) ? earningsNotice.ids : []);
  const notificationTransactions = current.transactions.filter((item) =>
    item.type !== 'compounding' && (item.type !== 'earnings' || surfacedEarnings.has(item.id)),
  );
  const unreadNotifications = notificationTransactions
    .filter((item) => (item.date || 0) > notificationsSeenAt)
    .slice(0, 12);
  $('notification-list').innerHTML = unreadNotifications.map(renderActivity).join('');
  $('notifications-empty').hidden = unreadNotifications.length > 0;
  const latestNonEarningAt = current.transactions
    .filter((item) => item.type !== 'earnings' && item.type !== 'compounding')
    .reduce((latest, item) => Math.max(latest, item.date || 0), 0);
  const latestActivityAt = Math.max(
    latestNonEarningAt,
    surfacedEarnings.size ? Number(earningsNotice.shownAt) || 0 : 0,
  );
  $('notification-dot').hidden = latestActivityAt <= notificationsSeenAt;
  renderRewards();
  $('home-plans').innerHTML = PLANS.map((plan) => renderPlan(plan, true)).join('');
  $('catalog-plans').innerHTML = PLANS.map((plan) => renderPlan(plan)).join('');
  renderAssetHistoryChart();
  renderCustomPlan();
  renderAdmin();
  translatePage(language);
}

function setView(name) {
  if (name === 'admin' && current?.role !== 'admin') return;
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.tab === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (name === 'catalog') {
    loadAssetHistory();
    if (!catalogHistoryTimer) {
      catalogHistoryTimer = setInterval(() => {
        if (!document.hidden && $('view-catalog').classList.contains('active')) loadAssetHistory();
      }, 60_000);
    }
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function adminAction(action, accountId, requestId, card) {
  if (!current || current.role !== 'admin') return;
  const target = accounts.find((account) => account.id === accountId);
  if (!target) return;
  if (action === 'confirm-deposit' || action === 'reject-deposit') {
    const approve = action === 'confirm-deposit';
    const creditUsdt = Number(card?.querySelector('.queue-input')?.value);
    if (approve && (!Number.isFinite(creditUsdt) || creditUsdt <= 0)) {
      toast('Enter the verified USDT credit amount.');
      return;
    }
    try {
      let netCredit = 0;
      if (approve) {
        const result = await apiRequest(`/api/admin/deposits/${encodeURIComponent(requestId)}/approve`, {
          method: 'POST', body: JSON.stringify({ creditUsdt }),
        });
        netCredit = Number(result.creditedAmount) || Number(result.account?.depositRequests?.find((item) => item.id === requestId)?.creditUsdt) || creditUsdt * 0.99;
        if (USE_MOCK_BACKEND) {
          Object.assign(target, result.account);
          if (target.id === current.id) current = target;
          else accounts[accounts.findIndex((item) => item.id === target.id)] = target;
        } else {
          const { accounts: refreshedAccounts } = await apiRequest('/api/admin/accounts');
          accounts = refreshedAccounts;
          current = accounts.find((account) => account.id === current.id) || current;
        }
      } else if (USE_MOCK_BACKEND) {
        const request = (target.depositRequests || []).find((item) => item.id === requestId && item.status === 'pending');
        if (!request) throw new Error('Deposit not found or already reviewed.');
        request.status = 'rejected'; request.reviewedAt = Date.now();
        const transaction = target.transactions.find((item) => item.id === request.transactionId);
        if (transaction) transaction.status = 'rejected';
        if (!await saveAccounts(target)) return;
      } else {
        await apiRequest(`/api/admin/deposits/${encodeURIComponent(requestId)}/reject`, { method: 'POST' });
        const { accounts: refreshedAccounts } = await apiRequest('/api/admin/accounts');
        accounts = refreshedAccounts;
        current = accounts.find((account) => account.id === current.id) || current;
      }
      render();
      toast(approve ? `Deposit verified: ${usd(creditUsdt)} gross · ${usd(netCredit)} credited after 1% fee.` : 'Deposit rejected.');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'credit-rewards') {
    const accountCard = document.querySelector(`[data-account-card="${CSS.escape(accountId)}"]`);
    const points = Number(accountCard?.querySelector('[data-credit="points"]')?.value || 0);
    const spins = Number(accountCard?.querySelector('[data-credit="spins"]')?.value || 0);
    if (!Number.isSafeInteger(points) || points < 0 ||
        !Number.isSafeInteger(spins) || spins < 0 || (points === 0 && spins === 0)) {
      toast('Enter a positive whole number of points or extra spins.');
      return;
    }
    try {
      const { account } = await apiRequest('/api/admin/rewards/credit', {
        method: 'POST',
        body: JSON.stringify({ accountId, points, spins }),
      });
      const index = accounts.findIndex((item) => item.id === account.id);
      if (index >= 0) accounts[index] = account;
      if (current.id === account.id) current = account;
      render();
      toast('Points and extra spins credited.');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'approve-wallet-change' || action === 'reject-wallet-change') {
    try {
      const { account } = await apiRequest('/api/admin/wallet-change', {
        method: 'POST',
        body: JSON.stringify({
          accountId,
          requestId,
          decision: action === 'approve-wallet-change' ? 'approve' : 'reject',
        }),
      });
      const index = accounts.findIndex((item) => item.id === account.id);
      if (index >= 0) accounts[index] = account;
      if (current.id === account.id) current = account;
      render();
      toast(action === 'approve-wallet-change' ? 'Wallet change approved.' : 'Wallet change rejected.');
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  const before = JSON.stringify(accounts);
  let message = '';
  if (action === 'save-account') {
    const accountCard = document.querySelector(`[data-account-card="${CSS.escape(accountId)}"]`);
    const deposit = Number(accountCard?.querySelector('[data-balance="deposit"]')?.value);
    const earnings = Number(accountCard?.querySelector('[data-balance="earnings"]')?.value);
    if (!Number.isFinite(deposit) || !Number.isFinite(earnings) || deposit < 0 || earnings < 0) {
      toast('Enter valid non-negative balances.');
      return;
    }
    const previousWallet = target.wallet || { deposit: 0, earnings: 0 };
    const balanceChanges = [
      ['deposit', Number(previousWallet.deposit) || 0, deposit],
      ['earnings', Number(previousWallet.earnings) || 0, earnings],
    ].filter(([, previous, next]) => previous !== next);
    const adjustedAt = Date.now();
    target.transactions ||= [];
    for (const [balanceType, previousBalance, newBalance] of balanceChanges) {
      target.transactions.unshift({
        id: crypto.randomUUID?.() || `${adjustedAt}-${Math.random().toString(36).slice(2)}`,
        type: 'account-adjustment',
        amount: Math.abs(newBalance - previousBalance),
        direction: newBalance > previousBalance ? 'credit' : 'debit',
        balanceType,
        previousBalance,
        newBalance,
        status: 'completed',
        date: adjustedAt,
        planName: 'Administrator balance adjustment',
      });
    }
    target.wallet = { ...target.wallet, deposit, earnings };
    message = `Balances updated for ${target.username}.`;
  } else if (action === 'toggle-account' && target.id !== current.id) {
    target.status = target.status === 'blocked' ? 'approved' : 'blocked';
    message = target.status === 'blocked'
      ? `Account ${target.username} blocked.`
      : `Account ${target.username} unblocked.`;
  } else if (action === 'approve-account' && target.status === 'pending') {
    target.status = 'approved';
    target.approvedAt = Date.now();
    target.reviewedAt = target.approvedAt;
    message = `Account ${target.username} approved.`;
  } else if (action === 'reject-account' && target.status === 'pending') {
    target.status = 'rejected';
    target.reviewedAt = Date.now();
    message = `Account ${target.username} rejected.`;
  } else if (action === 'confirm-deposit') {
    const request = target.depositRequests.find((item) => item.id === requestId && item.status === 'pending');
    if (!request) return;
    request.status = 'confirmed';
    request.reviewedAt = Date.now();
    target.wallet.deposit += request.amount;
    const transaction = target.transactions.find((item) => item.id === request.transactionId);
    if (transaction) transaction.status = 'confirmed';
    message = `Deposit request of ${usd(request.amount)} confirmed.`;
  } else if (action === 'reject-deposit') {
    const request = target.depositRequests.find((item) => item.id === requestId && item.status === 'pending');
    if (!request) return;
    request.status = 'rejected';
    request.reviewedAt = Date.now();
    const transaction = target.transactions.find((item) => item.id === request.transactionId);
    if (transaction) transaction.status = 'rejected';
    message = 'Deposit request rejected.';
  } else if (action === 'complete-withdrawal' || action === 'reject-withdrawal') {
    const request = target.withdrawalRequests.find((item) => item.id === requestId && item.status === 'pending');
    const payoutHash = card?.querySelector('.queue-input')?.value.trim();
    if (!request || (action === 'complete-withdrawal' && !payoutHash)) {
      toast('Enter the payout transaction hash before marking this withdrawal as paid.');
      return;
    }
    try {
      const result = await apiRequest(`/api/admin/withdrawals/${encodeURIComponent(requestId)}/${action === 'complete-withdrawal' ? 'complete' : 'reject'}`, {
        method: 'POST', body: JSON.stringify(action === 'complete-withdrawal' ? { payoutHash } : {}),
      });
      Object.assign(target, result.account);
      const targetIndex = accounts.findIndex((item) => item.id === target.id);
      if (targetIndex >= 0) accounts[targetIndex] = target;
      message = action === 'complete-withdrawal'
        ? `Withdrawal paid: ${usd(result.account.withdrawalRequests.find((item) => item.id === requestId)?.payoutAmount || request.amount * (1 - (request.source === 'unlocked' ? 0.2 : 0.04)))} net after the applicable fee.`
        : `Request rejected; ${usd(request.amount)} returned to the original balance.`;
      render();
      toast(message);
      return;
    } catch (error) {
      toast(error.message);
      return;
    }
  }
  if (!message) return;
  if (!await saveAccounts(target)) {
    accounts = JSON.parse(before);
    current = accounts.find((account) => account.id === current.id) || current;
    render();
    return;
  }
  current = accounts.find((account) => account.id === current.id) || current;
  render();
  toast(message);
}

function openPlan(id) {
  selectedPlan = PLANS.find((plan) => plan.id === id);
  if (!selectedPlan) return;
  $('plan-dialog-title').textContent = selectedPlan.name;
  const term = selectedPlan.months === 6 ? '6 months' : selectedPlan.months === 12 ? '1 year' : (selectedPlan.months / 12) + ' years';
  $('plan-terms').textContent = `${translateText(term, language)} · ${translateText('Market-linked contract. No fixed daily return.', language)} · ${translateText('Capital protection', language)} -20%.`;
  $('invest-amount').value = '';
  setError('plan-error');
  $('plan-dialog').showModal();
}

async function registerAccount(event) {
  event.preventDefault();
  setError('register-error');
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  if (submitButton.disabled) return;
  const username = $('register-username').value.trim();
  const email = $('register-email').value.trim().toLowerCase();
  const password = $('register-password').value;
  if (password !== $('register-confirm').value) {
    setError('register-error', 'Passwords do not match.');
    return;
  }
  submitButton.disabled = true;
  try {
  const result = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, language, referralCode: $('register-referral').value.trim() }),
    });
    accessToken = result.token;
    sessionStorage.setItem(SESSION_KEY, accessToken);
    accounts = [result.account];
    $('register-form').reset();
    openApp(result.account);
    toast('Your account is ready.');
  } catch (error) {
    setError('register-error', error.message);
    return;
  } finally {
    submitButton.disabled = false;
  }
}

async function showRecoveryKey(code, email) {
  $('recovery-key-value').value = code;
  let project = null;
  try {
    project = await window.websim?.getCurrentProject?.();
  } catch {}
  const baseUrl = project?.id
    ? 'https://websim.com/p/' + encodeURIComponent(project.id)
    : new URL(location.pathname, location.origin).href;
  const recoveryUrl = new URL(baseUrl);
  recoveryUrl.hash = 'recover?' + new URLSearchParams({ email, key: code });
  $('recovery-link-value').value = recoveryUrl.href;
  $('recovery-key-dialog').showModal();
}

function showPasswordRecovery(mode) {
  $('landing').hidden = true;
  $('auth-screen').hidden = false;
  $('auth-entry').hidden = false;
  $('auth-switch').hidden = true;
  $('login-form').hidden = true;
  $('register-form').hidden = true;
  $('forgot-password-button').hidden = true;
  $('password-reset-request-form').hidden = mode !== 'request';
  $('password-reset-form').hidden = mode !== 'confirm';
  $('auth-title').textContent = mode === 'request' ? 'Reset password' : 'Set a new password';
  $('auth-subtitle').textContent = '';
  translatePage(language);
}

async function requestPasswordReset(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  const email = $('reset-email').value.trim().toLowerCase();
  button.disabled = true;
  $('reset-request-message').textContent = '';
  try {
    const result = await apiRequest('/api/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify({ email, recoveryCode: $('reset-recovery-key').value }),
    });
    pendingPasswordResetToken = result.token;
    $('reset-request-message').textContent = translateText(
      'Recovery key verified. Choose a new password.', language,
    );
    $('reset-request-message').classList.add('success');
    showPasswordRecovery('confirm');
  } catch (error) {
    $('reset-request-message').textContent = translateText(error.message, language);
    $('reset-request-message').classList.remove('success');
  } finally {
    button.disabled = false;
  }
}

async function confirmPasswordReset(event) {
  event.preventDefault();
  setError('reset-password-error');
  const password = $('reset-new-password').value;
  if (password !== $('reset-confirm-password').value) {
    setError('reset-password-error', 'New passwords do not match.');
    return;
  }
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    await apiRequest('/api/auth/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify({
        token: pendingPasswordResetToken || new URLSearchParams(location.search).get('reset') || '',
        password,
      }),
    });
    $('password-reset-form').reset();
    $('password-reset-request-form').reset();
    pendingPasswordResetToken = '';
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('reset');
    history.replaceState(null, '', cleanUrl);
    showAuthMode('login');
    setError('login-error', 'Your password has been updated. You can now log in.');
    $('login-error').classList.add('success');
  } catch (error) {
    setError('reset-password-error', error.message);
  } finally {
    button.disabled = false;
  }
}

async function login(event) {
  event.preventDefault();
  setError('login-error');
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  if (submitButton.disabled) return;
  submitButton.disabled = true;
  const email = $('login-email').value.trim().toLowerCase();
  const password = $('login-password').value;
  try {
    const result = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    accessToken = result.token;
    sessionStorage.setItem(SESSION_KEY, accessToken);
    accounts = [result.account];
    openApp(result.account);
  } catch (error) {
    setError('login-error', error.message);
    return;
  } finally {
    submitButton.disabled = false;
  }
}

async function addDeposit(event) {
  event.preventDefault();
  setError('deposit-error');
  const amount = Number(Number($('deposit-amount').value).toFixed(2));
  const txHash = $('deposit-txhash').value.trim();
  if (!Number.isFinite(amount) || amount <= 0) {
    setError('deposit-error', 'Enter a valid amount.');
    return;
  }
  if (!txHash) {
    setError('deposit-error', 'Enter the transaction hash for review.');
    return;
  }
  if (!depositAddresses[$('deposit-network').value]) {
    setError('deposit-error', 'Deposit address is not configured for this network.');
    return;
  }
  try {
    const network = $('deposit-network').value;
    const result = await apiRequest('/api/deposits', {
      method: 'POST',
      body: JSON.stringify({ amount, network, txHash, depositAddress: depositAddresses[network] }),
    });
    applyAccount(result.account);
    $('deposit-dialog').close();
    $('deposit-form').reset();
    toast('Request submitted for admin review.');
  } catch (error) {
    setError('deposit-error', error.message);
    return;
  }
}

async function addWithdrawal(event) {
  event.preventDefault();
  setError('withdraw-error');
  const amount = Number($('withdraw-amount').value);
  const address = $('withdraw-address').value.trim();
  const pin = $('withdrawal-pin').value;
  const source = $('withdraw-source').value;
  const available = withdrawalBalance();
  if (!Number.isFinite(amount) || amount <= 0 || amount > available) {
    setError('withdraw-error', `Enter a valid amount. Available: ${usd(available)}.`);
    return;
  }
  if (!address) {
    setError('withdraw-error', 'Enter a destination address.');
    return;
  }
  if (!/^\d{6}$/.test(pin)) {
    setError('withdraw-error', 'Enter your six-digit withdrawal password.');
    return;
  }
  try {
    const result = await apiRequest('/api/withdrawals', {
      method: 'POST',
      body: JSON.stringify({ amount, source, network: $('withdraw-network').value, address, pin }),
    });
    applyAccount(result.account);
    $('withdraw-dialog').close();
    $('withdraw-form').reset();
    toast(`Withdrawal submitted. Fee: ${usd(result.feeAmount)} · Net payout: ${usd(result.payoutAmount)}.`);
  } catch (error) {
    setError('withdraw-error', error.message);
    return;
  }
}

async function redeemInvestmentEarnings(button, investmentId = '') {
  if (!current || button.disabled) return;
  button.disabled = true;
  try {
    const { account, amount, grossAmount, feeAmount } = await apiRequest('/api/earnings/redeem', {
      method: 'POST',
      body: JSON.stringify({ ...(investmentId ? { investmentId } : {}), quotes: currentMarketQuotes() }),
    });
    applyAccount(account);
    const investment = current.investments.find((item) => item.id === investmentId);
    const label = investment
      ? `${PLANS.find((plan) => plan.id === investment.planId)?.name || 'Investment'} · `
      : '';
    toast(`${label}${usd(grossAmount || amount)} gross · ${usd(feeAmount || 0)} fee · ${usd(amount)} credited to earnings.`);
  } catch (error) {
    toast(error.message);
    render();
  }
}

async function updateAutoRedeemSetting(investmentId, control) {
  if (!current || control.disabled) return;
  const investment = current.investments.find((item) => item.id === investmentId && item.status === 'active');
  if (!investment) return;
  const card = control.closest('.investment-card');
  const checkbox = card.querySelector('[data-auto-redeem]');
  const percentInput = card.querySelector('[data-auto-redeem-percent]');
  const enabled = control === checkbox ? checkbox.checked : investment.autoRedeemEnabled === true;
  const percent = Number(percentInput.value);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    toast('Choose a percentage between 1 and 100.');
    render();
    return;
  }
  checkbox.disabled = true;
  percentInput.disabled = true;
  try {
    const { account } = await apiRequest('/api/investments/auto-redeem', {
      method: 'POST',
      body: JSON.stringify({ investmentId, enabled, percent }),
    });
    applyAccount(account);
  } catch (error) {
    toast(error.message);
    render();
  }
}

function syncCustomDraftFromForm(form) {
  if (!customDraft || !form) return;
  form.querySelectorAll('[data-custom-field]').forEach((field) => {
    customDraft[field.dataset.customField] = field.value;
  });
  form.querySelectorAll('[data-custom-asset]').forEach((checkbox) => {
    const config = customDraft.allocations[checkbox.dataset.customAsset];
    config.selected = checkbox.checked;
    config.weight = form.querySelector('[data-custom-weight="' + checkbox.dataset.customAsset + '"]').value;
  });
}

async function unlockCustomPlan(button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const { account } = await apiRequest('/api/custom-plan/subscribe', {
      method: 'POST', body: JSON.stringify({ months: customAccessMonths }),
    });
    customDraft = null;
    applyAccount(account);
    const years = customAccessMonths / 12;
    const duration = years === 0.5 ? '6 months' : years + (years === 1 ? ' year' : ' years');
    toast(translateText('Custom plan access activated for', language) + ' ' + translateText(duration, language) + '.');
  } catch (error) {
    toast(error.message);
    render();
  }
}

async function startCustomInvestment(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const error = $('custom-plan-error');
  error.textContent = '';
  syncCustomDraftFromForm(form);
  const maxContractMonths = Number(current.customPlanSubscription?.months) || 0;
  if (![6, 12, 24, 36, 60].includes(Number(customDraft.months)) || Number(customDraft.months) > maxContractMonths) {
    error.textContent = translateText('Contract term cannot exceed your custom-plan access duration.', language);
    return;
  }
  const allocations = Object.entries(customDraft.allocations)
    .filter(([, asset]) => asset.selected)
    .map(([name, asset]) => ({ name, weight: Number(asset.weight) }));
  if (Math.abs(allocations.reduce((sum, asset) => sum + asset.weight, 0) - 100) > 0.01) {
    error.textContent = translateText('Selected asset weights must total 100%.', language);
    return;
  }
  const amount = Number(customDraft.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > current.wallet.deposit) {
    error.textContent = translateText('Enter a valid amount within your deposit balance.', language);
    return;
  }
  const button = $('custom-invest-button');
  button.disabled = true;
  try {
    await refreshMarketQuotes();
    const { account } = await apiRequest('/api/investments', {
      method: 'POST',
      body: JSON.stringify({
        planId: 'custom', amount, months: Number(customDraft.months),
        stopLossPercent: Number(customDraft.stopLossPercent),
        autoRedeemPercent: Number(customDraft.autoRedeemPercent),
        allocations, quotes: currentMarketQuotes(),
      }),
    });
    customDraft = null;
    applyAccount(account);
    setView('investments');
    toast('Custom investment activated.');
  } catch (requestError) {
    error.textContent = translateText(requestError.message, language);
    updateCustomAllocationSummary();
  }
}

async function startInvestment(event) {
  event.preventDefault();
  if (!selectedPlan) return;
  setError('plan-error');
  const amount = Number($('invest-amount').value);
  if (!Number.isFinite(amount) || amount <= 0) {
    setError('plan-error', 'Enter an amount greater than zero.');
    return;
  }
  if (amount > current.wallet.deposit) {
    setError('plan-error', 'Insufficient deposit balance. Add funds to continue.');
    return;
  }
  try {
    await refreshMarketQuotes();
    const result = await apiRequest('/api/investments', {
      method: 'POST',
      body: JSON.stringify({ amount, planId: selectedPlan.id, quotes: currentMarketQuotes() }),
    });
    applyAccount(result.account);
  } catch (error) {
    setError('plan-error', error.message);
    return;
  }
  $('plan-dialog').close();
  $('plan-form').reset();
  setView('investments');
  toast('Plan activated. Your capital is now locked.');
}

function openAddFundsDialog(investmentId) {
  const investment = current?.investments.find((item) => item.id === investmentId && item.status === 'active');
  if (!investment) return;
  selectedFundingInvestmentId = investment.id;
  $('add-funds-plan-terms').textContent = `${investment.planName || 'Investment'} · ${translateText('Matures', language)} ${timestampDate(investment.maturityAt || investment.startedAt + investment.days * DAY_MS)}`;
  $('add-funds-available').textContent = usd(current.wallet.deposit);
  $('add-funds-amount').value = '';
  setError('add-funds-error');
  $('add-funds-dialog').showModal();
}

async function addFundsToInvestment(event) {
  event.preventDefault();
  if (!current || !selectedFundingInvestmentId) return;
  const button = event.currentTarget.querySelector('[type="submit"]');
  if (button.disabled) return;
  const amount = Number($('add-funds-amount').value);
  if (!Number.isFinite(amount) || amount < 0.01) {
    setError('add-funds-error', 'Enter an amount of at least 0.01 USDT.');
    return;
  }
  if (amount > Number(current.wallet.deposit || 0)) {
    setError('add-funds-error', 'Insufficient deposit balance. Add funds to continue.');
    return;
  }
  button.disabled = true;
  try {
    await refreshMarketQuotes();
    const { account } = await apiRequest('/api/investments/add-funds', {
      method: 'POST',
      body: JSON.stringify({ investmentId: selectedFundingInvestmentId, amount, quotes: currentMarketQuotes() }),
    });
    applyAccount(account);
    $('add-funds-dialog').close();
    selectedFundingInvestmentId = '';
    toast('Additional funds added. The original maturity date is unchanged.');
  } catch (error) {
    setError('add-funds-error', error.message);
  } finally {
    button.disabled = false;
  }
}

async function purchaseReward(button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const { account } = await apiRequest('/api/rewards/purchase', {
      method: 'POST',
      body: JSON.stringify({ rewardId: button.dataset.buyReward }),
    });
    applyAccount(account);
    toast('Reward redeemed with bonus points.');
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

async function spinDailyWheel() {
  const button = $('spin-wheel');
  if (button.disabled || wheelSpinning) return;
  wheelSpinning = true;
  button.disabled = true;
  try {
    const { account, prize } = await apiRequest('/api/rewards/spin', { method: 'POST' });
    applyAccount(account);
    const prizeIndex = DAILY_PRIZES.findIndex((item) => item.id === prize.id);
    const targetAngle = (prizeIndex + 0.5) * (360 / DAILY_PRIZES.length);
    const finalRotation = 5 * 360 + ((360 - targetAngle) % 360);
    const wheel = $('mystery-wheel');
    wheel.style.transition = 'none';
    wheel.style.transform = 'rotate(0deg)';
    wheel.offsetWidth;
    wheel.style.transition = '';
    wheel.style.transform = `rotate(${finalRotation}deg)`;
    window.setTimeout(() => {
      $('wheel-result').textContent = `${translateText('You won', language)} ${prize.points.toLocaleString(LANGUAGE_LOCALES[language])} bonus points.`;
      wheelSpinning = false;
      updateSpinButton();
      toast('Daily bonus points added to your account.');
    }, 4100);
  } catch (error) {
    wheelSpinning = false;
    updateSpinButton();
    toast(error.message);
  }
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.tab)));
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.go)));
document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', async () => {
  const dialog = $(button.dataset.open);
  setError(dialog.id === 'deposit-dialog' ? 'deposit-error' : 'withdraw-error');
  if (dialog.id === 'deposit-dialog') {
    try {
      const { addresses } = await apiRequest('/api/deposit-addresses');
      depositAddresses = addresses || depositAddresses;
      refreshDepositAddressDisplay();
    } catch (error) {
      toast(error.message);
      return;
    }
  }
  if (dialog.id === 'withdraw-dialog') {
    if (!await refreshAccount() || !current) return;
    if (!current.withdrawalWallet) {
      setView('profile');
      $('wallet-dialog').showModal();
      toast('Link a withdrawal wallet before requesting a withdrawal.');
      return;
    }
    if (!current.withdrawalPinSet) {
      setView('profile');
      $('withdrawal-pin-form').reset();
      setError('withdrawal-pin-error');
      $('withdrawal-pin-dialog').showModal();
      toast('Set your withdrawal password before requesting a withdrawal.');
      return;
    }
    $('withdraw-amount').value = '';
    $('withdrawal-pin').value = '';
    $('withdraw-address').value = current.withdrawalWallet?.address || '';
    $('withdraw-network').value = current.withdrawalWallet?.network || 'bep20';
  }
  dialog.showModal();
}));
document.addEventListener('input', (event) => {
  const form = event.target.closest('#custom-plan-form');
  if (!form) return;
  syncCustomDraftFromForm(form);
  updateCustomAllocationSummary();
});
document.addEventListener('change', (event) => {
  const accessTerm = event.target.closest('[data-custom-access-months]');
  if (accessTerm) {
    customAccessMonths = Number(accessTerm.value);
    renderCustomPlan();
    return;
  }
  const customForm = event.target.closest('#custom-plan-form');
  if (customForm) {
    syncCustomDraftFromForm(customForm);
    const checkbox = event.target.closest('[data-custom-asset]');
    if (checkbox) checkbox.closest('.custom-asset-row').querySelector('[data-custom-weight]').disabled = !checkbox.checked;
    updateCustomAllocationSummary();
  }
  const control = event.target.closest('[data-auto-redeem], [data-auto-redeem-percent]');
  if (control) updateAutoRedeemSetting(control.dataset.autoRedeem || control.dataset.autoRedeemPercent, control);
});
document.addEventListener('submit', (event) => {
  if (event.target.id === 'custom-plan-form') startCustomInvestment(event);
});
document.addEventListener('click', (event) => {
  const portfolioButton = event.target.closest('[data-portfolio-chart]');
  if (portfolioButton) {
    selectedPortfolioChart = portfolioButton.dataset.portfolioChart;
    renderAssetHistoryChart();
    return;
  }
  const rangeButton = event.target.closest('[data-asset-range]');
  if (rangeButton) {
    selectedAssetRange = rangeButton.dataset.assetRange;
    if (selectedAssetChart) renderAssetDetailChart(selectedAssetChart);
    return;
  }
  const assetButton = event.target.closest('[data-asset-chart]');
  if (assetButton) {
    selectedAssetChart = assetButton.dataset.assetChart;
    renderAssetDetailChart(selectedAssetChart);
    $('asset-detail-dialog').showModal();
    return;
  }
  const unlockButton = event.target.closest('[data-unlock-custom-plan]');
  if (unlockButton) {
    unlockCustomPlan(unlockButton);
    return;
  }
  const teamMemberButton = event.target.closest('[data-team-member]');
  if (teamMemberButton) openTeamMember(teamMemberButton.dataset.teamMember);
  const planButton = event.target.closest('[data-plan-details]');
  const planCard = event.target.closest('[data-plan-card]');
  if (planButton) showPlanDetails(planButton.dataset.planDetails);
  else if (planCard) showPlanDetails(planCard.dataset.planCard);
  const addFundsButton = event.target.closest('[data-add-investment-funds]');
  if (addFundsButton) {
    openAddFundsDialog(addFundsButton.dataset.addInvestmentFunds);
    return;
  }
  const investmentRedeemButton = event.target.closest('[data-redeem-investment]');
  if (investmentRedeemButton) {
    redeemInvestmentEarnings(investmentRedeemButton, investmentRedeemButton.dataset.redeemInvestment);
    return;
  }
  const investmentCard = event.target.closest('[data-investment-detail]');
  if (investmentCard) showInvestmentDetails(investmentCard.dataset.investmentDetail);
  const redeemButton = event.target.closest('[data-redeem-earnings]');
  if (redeemButton) redeemInvestmentEarnings(redeemButton);
  const closeButton = event.target.closest('[data-close]');
  if (closeButton) $(closeButton.dataset.close).close();
  const rewardButton = event.target.closest('[data-buy-reward]');
  if (rewardButton) purchaseReward(rewardButton);
  const adminButton = event.target.closest('[data-admin-action]');
  if (adminButton) {
    const card = adminButton.closest('.queue-card');
    adminAction(
      adminButton.dataset.adminAction,
      adminButton.dataset.user,
      adminButton.dataset.request,
      card,
    );
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const investmentButton = event.target.closest('[data-investment-detail]');
  if (!investmentButton) return;
  event.preventDefault();
  showInvestmentDetails(investmentButton.dataset.investmentDetail);
});
$('details-invest-button').addEventListener('click', () => {
  const planId = selectedPlan?.id;
  $('details-dialog').close();
  if (planId) openPlan(planId);
});
$('details-close-investment').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!selectedInvestmentId || button.disabled) return;
  const confirmed = window.confirm(translateText('Close this plan now? The refund is current portfolio value minus a 65% penalty and all generated gains, including gains already redeemed. The refund cannot be negative.', language));
  if (!confirmed) return;
  button.disabled = true;
  try {
    await refreshMarketQuotes();
    const result = await apiRequest('/api/investments/close', {
      method: 'POST',
      body: JSON.stringify({ investmentId: selectedInvestmentId, quotes: currentMarketQuotes() }),
    });
    applyAccount(result.account);
    $('details-dialog').close();
    toast(`${translateText('Plan closed', language)} · ${usd(result.refund)} ${translateText('released to withdrawal balance', language)}.`);
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});
$('show-login').addEventListener('click', () => showAuthMode('login'));
$('show-register').addEventListener('click', () => showAuthMode('register'));
document.querySelectorAll('[data-auth]').forEach((button) => {
  button.addEventListener('click', () => showAuthMode(button.dataset.auth));
});
$('auth-back').addEventListener('click', () => {
  $('auth-screen').hidden = true;
  $('landing').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
$('register-form').addEventListener('submit', registerAccount);
$('login-form').addEventListener('submit', login);
$('forgot-password-button').addEventListener('click', () => {
  $('reset-email').value = $('login-email').value.trim();
  $('reset-recovery-key').value = '';
  $('reset-request-message').textContent = '';
  $('reset-request-message').classList.remove('success');
  showPasswordRecovery('request');
});
$('password-reset-request-form').addEventListener('submit', requestPasswordReset);
$('password-reset-form').addEventListener('submit', confirmPasswordReset);
$('deposit-form').addEventListener('submit', addDeposit);
$('withdraw-form').addEventListener('submit', addWithdrawal);
$('withdraw-source').addEventListener('change', updateWithdrawalQuote);
$('withdraw-amount').addEventListener('input', updateWithdrawalQuote);
$('plan-form').addEventListener('submit', startInvestment);
$('add-funds-form').addEventListener('submit', addFundsToInvestment);
$('copy-invite-link').addEventListener('click', async () => {
  const link = $('invite-link').value;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invitation link copied.');
  } catch {
    $('invite-link').select();
    document.execCommand('copy');
    toast('Invitation link copied.');
  }
});
$('spin-wheel').addEventListener('click', spinDailyWheel);
$('open-notifications').addEventListener('click', async () => {
  $('notifications-dialog').showModal();
  const latestActivityAt = current.transactions.reduce((latest, item) => Math.max(latest, item.date || 0), 0);
  const earningsNotice = readEarningsNoticeState();
  earningsNotice.ids = [];
  localStorage.setItem(earningsNoticeKey(), JSON.stringify(earningsNotice));
  current.preferences = { ...(current.preferences || {}), notificationsSeenAt: latestActivityAt };
  $('notification-dot').hidden = true;
  await saveAccounts(current);
});
$('history-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-history-filter]');
  if (!button) return;
  selectedHistoryFilter = button.dataset.historyFilter;
  renderFullHistory();
});
$('edit-wallet-button').addEventListener('click', () => $('wallet-dialog').showModal());
$('edit-withdrawal-pin-button').addEventListener('click', () => {
  setError('withdrawal-pin-error');
  $('withdrawal-pin-form').reset();
  $('withdrawal-pin-dialog').showModal();
});
$('admin-generate-recovery-key').addEventListener('click', async () => {
  const emailField = $('admin-recovery-email');
  if (!emailField.reportValidity()) return;
  const email = emailField.value.trim().toLowerCase();
  const existing = accounts.find((account) => account.email.toLowerCase() === email);
  if (existing?.recoveryKeySet && !confirm('This account already has an admin-issued key. Replace it?')) return;
  try {
    const result = await apiRequest('/api/admin/recovery-key', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    const index = accounts.findIndex((account) => account.id === result.account.id);
    if (index >= 0) accounts[index] = result.account;
    render();
    showRecoveryKey(result.recoveryCode, result.account.email);
  } catch (error) {
    toast(error.message);
  }
});
$('email-support-button').addEventListener('click', () => {
  const emailField = $('reset-email');
  if (!emailField.reportValidity()) return;
  const email = emailField.value.trim().toLowerCase();
  const subject = 'Password recovery and recovery key request';
  const body = 'Hello Support,\n\nI need help recovering the account registered with ' + email +
    '. Please verify my ownership and provide an admin-issued recovery key so I can reset my password.\n\nThank you.';
  location.href = 'mailto:info.cup9@yahoo.com?subject=' + encodeURIComponent(subject) +
    '&body=' + encodeURIComponent(body);
});
$('copy-recovery-key').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('recovery-key-value').value);
    toast('Recovery key copied.');
  } catch {
    $('recovery-key-value').select();
    toast('Select and copy the recovery key.');
  }
});
$('copy-recovery-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('recovery-link-value').value);
    toast('Recovery link copied.');
  } catch {
    $('recovery-link-value').select();
    toast('Select and copy the recovery link.');
  }
});
$('recovery-key-saved').addEventListener('click', () => $('recovery-key-dialog').close());
$('recovery-key-dialog').addEventListener('cancel', (event) => event.preventDefault());
$('recovery-key-dialog').addEventListener('close', () => {
  $('recovery-key-value').value = '';
  $('recovery-link-value').value = '';
});
$('change-password-button').addEventListener('click', () => {
  setError('password-error');
  $('password-form').reset();
  $('password-dialog').showModal();
});
$('wallet-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const address = $('wallet-address').value.trim();
  if (!address) return;
  try {
    const result = await apiRequest('/api/withdrawal-wallet', {
      method: 'POST',
      body: JSON.stringify({ network: $('wallet-network').value, address }),
    });
    applyAccount(result.account);
    $('wallet-dialog').close();
    toast(result.requested ? 'Wallet change sent for admin approval.' : 'Withdrawal wallet linked.');
  } catch (error) {
    toast(error.message);
  }
});
$('withdrawal-pin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('withdrawal-pin-error');
  const pin = $('new-withdrawal-pin').value;
  if (!/^\d{6}$/.test(pin)) {
    setError('withdrawal-pin-error', 'Withdrawal password must contain exactly 6 digits.');
    return;
  }
  if (pin !== $('confirm-withdrawal-pin').value) {
    setError('withdrawal-pin-error', 'Withdrawal passwords do not match.');
    return;
  }
  try {
    const { account } = await apiRequest('/api/auth/withdrawal-password', {
      method: 'PUT',
      body: JSON.stringify({ loginPassword: $('pin-login-password').value, pin }),
    });
    applyAccount(account);
    $('withdrawal-pin-dialog').close();
    $('withdrawal-pin-form').reset();
    toast('Withdrawal password saved.');
  } catch (error) {
    setError('withdrawal-pin-error', error.message);
  }
});
$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('password-error');
  const newPassword = $('new-password').value;
  if (newPassword !== $('confirm-new-password').value) {
    setError('password-error', 'New passwords do not match.');
    return;
  }
  try {
    const { account } = await apiRequest('/api/auth/password', {
      method: 'PUT',
      body: JSON.stringify({
        currentPassword: $('current-password').value,
        newPassword,
      }),
    });
    Object.assign(current, account);
    $('password-dialog').close();
    $('password-form').reset();
    toast('Password updated in this browser.');
  } catch (error) {
    setError('password-error', error.message);
  }
});
$('language-select').addEventListener('change', async (event) => {
  const previous = current.preferences?.language || 'en';
  current.preferences = { ...(current.preferences || {}), language: event.target.value };
  if (!await saveAccounts(current)) {
    current.preferences.language = previous;
    render();
    return;
  }
  language = event.target.value;
  localStorage.setItem(LANGUAGE_KEY, language);
  $('landing-language-select').value = language;
  render();
});
$('landing-language-select').value = language;
$('landing-language-select').addEventListener('change', (event) => {
  language = LANGUAGES.includes(event.target.value) ? event.target.value : 'en';
  localStorage.setItem(LANGUAGE_KEY, language);
  document.documentElement.lang = language;
  $('language-select').value = language;
  translatePage(language);
});
$('deposit-network').addEventListener('change', refreshDepositAddressDisplay);
$('copy-deposit-address').addEventListener('click', async () => {
  const address = depositAddresses[$('deposit-network').value];
  if (!address) return;
  try {
    await navigator.clipboard.writeText(address);
    toast('Deposit address copied.');
  } catch {
    toast('Could not copy deposit address.');
  }
});
$('save-deposit-addresses').addEventListener('click', async () => {
  if (!USE_MOCK_BACKEND) {
    toast('Deposit addresses are managed in Render environment variables.');
    return;
  }
  const addresses = Object.fromEntries(['bep20', 'bitcoin', 'trc20'].map((network) => [
    network, $(`admin-address-${network}`).value.trim(),
  ]));
  try {
    const result = await apiRequest('/api/admin/deposit-addresses', { method: 'PUT', body: JSON.stringify({ addresses }) });
    depositAddresses = result.addresses;
    refreshDepositAddressDisplay();
    toast('Deposit addresses saved.');
  } catch (error) { toast(error.message); }
});
$('theme-select').addEventListener('change', async (event) => {
  const previous = current.preferences?.theme || 'dark';
  current.preferences = { ...(current.preferences || {}), theme: event.target.value };
  document.documentElement.dataset.theme = event.target.value;
  if (!await saveAccounts(current)) {
    current.preferences.theme = previous;
    render();
    return;
  }
  render();
});
$('refresh-account').addEventListener('click', () => {
  refreshAccount();
});
$('home-link').addEventListener('click', (event) => {
  event.preventDefault();
  setView('home');
});
$('open-admin').addEventListener('click', () => setView('admin'));
$('logout-button').addEventListener('click', signOut);
$('reset-account-data').addEventListener('click', () => {
  if (!current || current.role !== 'admin') return;
  if (!confirm('Delete all accounts and activity saved in this browser?')) return;
  apiRequest('/api/admin/accounts', { method: 'DELETE' }).then(() => signOut()).catch((error) => toast(error.message));
});
document.addEventListener('touchstart', (event) => {
  const target = event.target;
  if (!current || window.scrollY > 0 || event.touches.length !== 1 ||
      target.closest('input, textarea, select, button, a, dialog[open], [contenteditable="true"]')) {
    pullStartY = null;
    return;
  }
  pullStartY = event.touches[0].clientY;
}, { passive: true });
document.addEventListener('touchend', (event) => {
  if (pullStartY === null) return;
  const pulledDistance = event.changedTouches[0].clientY - pullStartY;
  pullStartY = null;
  if (current && window.scrollY <= 0 && pulledDistance >= 80 &&
      !document.querySelector('dialog[open]')) {
    refreshAccount();
  }
}, { passive: true });
document.addEventListener('touchcancel', () => {
  pullStartY = null;
}, { passive: true });
document.querySelectorAll('.modal').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
}));

resumeSession();
setInterval(() => {
  if (!current || document.hidden) return;
  refreshAccount();
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && current) {
    refreshAccount();
  }
});
document.documentElement.lang = language;
$('landing-language-select').value = language;
translatePage(language);
$('register-referral').value = new URLSearchParams(location.search).get('ref') || '';
const recoveryFragment = location.hash.slice(1);
if (recoveryFragment.startsWith('recover?')) {
  const recoveryParams = new URLSearchParams(recoveryFragment.slice('recover?'.length));
  const recoveryEmail = recoveryParams.get('email') || '';
  const recoveryCode = recoveryParams.get('key') || '';
  if (recoveryEmail && recoveryCode) {
    $('reset-email').value = recoveryEmail;
    $('reset-recovery-key').value = recoveryCode;
    showPasswordRecovery('request');
    const cleanUrl = new URL(location.href);
    cleanUrl.hash = '';
    history.replaceState(null, '', cleanUrl);
  }
}
pendingPasswordResetToken = new URLSearchParams(location.search).get('reset') || '';
if (pendingPasswordResetToken) showPasswordRecovery('confirm');
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
