const CACHE_KEY = "h9-live-market-prices-v1";
const assetKeys = {
  Gold: "gold",
  Oil: "oil",
  Electricity: "electricity",
  "S&P 500": "sp500",
  NASDAQ: "nasdaq",
  Tesla: "tesla",
  "Artificial intelligence": "artificialIntelligence",
  Bitcoin: "bitcoin",
  Ethereum: "ethereum",
};

function readCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return saved?.quotes && typeof saved.quotes === "object" ? saved : { quotes: {}, fetchedAt: 0 };
  } catch {
    return { quotes: {}, fetchedAt: 0 };
  }
}

let marketCache = readCache();

export function getMarketQuote(assetName) {
  const key = assetKeys[assetName];
  return key ? marketCache.quotes[key] || null : null;
}

export async function refreshMarketQuotes() {
  try {
    const response = await fetch("/api/asset-prices", { cache: "no-store" });
    if (!response.ok) return marketCache.quotes;
    const data = await response.json();
    const nextQuotes = { ...marketCache.quotes };
    for (const [key, quote] of Object.entries(data?.quotes || {})) {
      const price = Number(quote?.price);
      const marketAt = Number(quote?.marketAt);
      if (Number.isFinite(price) && (key === 'electricity' || price > 0) && Number.isFinite(marketAt) && marketAt > 0) {
        nextQuotes[key] = { ...quote, price, marketAt };
      }
    }
    if (Object.keys(nextQuotes).length) {
      marketCache = { quotes: nextQuotes, fetchedAt: Number(data.fetchedAt) || Date.now() };
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(marketCache)); } catch {}
    }
  } catch {}
  return marketCache.quotes;
}

const HISTORY_CACHE_KEY = "h9-live-market-history-v6";

function readHistoryCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_CACHE_KEY) || "null");
    return saved?.histories && typeof saved.histories === "object"
      ? { histories: saved.histories, candles: saved.candles || {}, intraday: saved.intraday || {}, fetchedAt: Number(saved.fetchedAt) || 0 }
      : null;
  } catch {
    return null;
  }
}

let marketHistory = readHistoryCache();

export function getMarketHistory() {
  return marketHistory;
}

export async function refreshMarketHistory() {
  try {
    const response = await fetch("/api/asset-history", { cache: "no-store" });
    if (!response.ok) return marketHistory;
    const data = await response.json();
    const histories = Object.fromEntries(Object.entries(data?.histories || {}).flatMap(([key, points]) => {
      const valid = Array.isArray(points)
        ? points.map((point) => ({ time: Number(point.time), value: Number(point.value) }))
          .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value))
          .sort((a, b) => a.time - b.time)
        : [];
      return valid.length ? [[key, valid]] : [];
    }));
    const candles = Object.fromEntries(Object.entries(data?.candles || {}).flatMap(([key, items]) => {
      const valid = Array.isArray(items) ? items.map((item) => ({
        time: Number(item.time), open: Number(item.open), high: Number(item.high),
        low: Number(item.low), close: Number(item.close),
      })).filter((item) => Number.isFinite(item.time) && [item.open, item.high, item.low, item.close].every(Number.isFinite))
        .sort((a, b) => a.time - b.time) : [];
      return valid.length ? [[key, valid]] : [];
    }));
    const intraday = Object.fromEntries(Object.entries(data?.intraday || {}).flatMap(([key, points]) => {
      const valid = Array.isArray(points) ? points.map((point) => ({ time: Number(point.time), value: Number(point.value) }))
        .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value))
        .sort((a, b) => a.time - b.time) : [];
      return valid.length ? [[key, valid]] : [];
    }));
    if (!Object.keys(histories).length && !Object.keys(candles).length && !Object.keys(intraday).length) return marketHistory;
    marketHistory = {
      histories: { ...(marketHistory?.histories || {}), ...histories },
      candles: { ...(marketHistory?.candles || {}), ...candles },
      intraday: { ...(marketHistory?.intraday || {}), ...intraday },
      fetchedAt: Number(data.fetchedAt) || Date.now(),
    };
    try { localStorage.setItem(HISTORY_CACHE_KEY, JSON.stringify(marketHistory)); } catch {}
  } catch {}
  return marketHistory;
}
