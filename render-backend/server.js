const yahooInstruments = {
  gold: { symbol: "GC=F", instrument: "Gold futures · USD per troy ounce" },
  oil: { symbol: "CL=F", instrument: "WTI crude futures · USD per barrel" },
  sp500: { symbol: "^GSPC", instrument: "S&P 500 index · index points" },
  nasdaq: { symbol: "^IXIC", instrument: "NASDAQ Composite · index points" },
  tesla: { symbol: "TSLA", instrument: "Tesla common stock · USD per share" },
  artificialIntelligence: { symbol: "AIQ", instrument: "Global X AI & Technology ETF · USD per share" },
};

let cachedQuotes = null;
let cachedAt = 0;
let refreshInFlight = null;
let cachedHistory = null;
let historyAt = 0;
let historyInFlight = null;

async function fetchJson(url, yahooRequest = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      headers: yahooRequest
        ? { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; YouInvestMarket/1.0)", referer: "https://finance.yahoo.com/" }
        : { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function yahooQuote(key, asset) {
  const url = "https://query2.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(asset.symbol) + "?range=1d&interval=1m";
  const body = await fetchJson(url, true);
  const result = body?.chart?.result?.[0];
  const meta = result?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!Number.isFinite(price) || price <= 0) return null;
  const chartTime = result?.timestamp?.at(-1);
  const marketAt = Number(meta?.regularMarketTime || chartTime) * 1000;
  return {
    price,
    currency: "USD",
    unit: key === "sp500" || key === "nasdaq" ? "index points" : "",
    instrument: asset.instrument,
    symbol: asset.symbol,
    provider: "Yahoo Finance",
    marketAt: Number.isFinite(marketAt) ? marketAt : Date.now(),
  };
}

async function cryptoQuotes(now) {
  const body = await fetchJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD,ETHUSD");
  const result = body?.result;
  if (body?.error?.length || !result) return {};
  const quotes = {};
  for (const [key, ticker, instrument, symbol] of [
    ["bitcoin", "XXBTZUSD", "Bitcoin spot · USD per BTC", "BTC/USD"],
    ["ethereum", "XETHZUSD", "Ethereum spot · USD per ETH", "ETH/USD"],
  ]) {
    const price = Number(result[ticker]?.c?.[0]);
    if (!Number.isFinite(price) || price <= 0) continue;
    quotes[key] = {
      price, currency: "USD", unit: "", instrument, symbol,
      provider: "Kraken", marketAt: now,
    };
  }
  return quotes;
}

async function electricityQuote(now) {
  const start = new Date(now - 72 * 60 * 60 * 1000).toISOString();
  const end = new Date(now).toISOString();
  const params = new URLSearchParams({ bzn: "DE-LU", start, end });
  const body = await fetchJson("https://api.energy-charts.info/price?" + params);
  if (!Array.isArray(body?.unix_seconds) || !Array.isArray(body?.price)) return null;
  let latest = -1;
  for (let i = 0; i < body.unix_seconds.length; i += 1) {
    const timestamp = Number(body.unix_seconds[i]) * 1000;
    const price = Number(body.price[i]);
    if (Number.isFinite(timestamp) && timestamp <= now && Number.isFinite(price) && timestamp > latest) latest = timestamp;
  }
  if (latest < 0) return null;
  const index = body.unix_seconds.findIndex((timestamp) => Number(timestamp) * 1000 === latest);
  return {
    price: Number(body.price[index]),
    currency: "EUR",
    unit: "per MWh",
    instrument: "DE-LU day-ahead electricity · wholesale market",
    symbol: "DE-LU",
    provider: "Energy-Charts · Bundesnetzagentur",
    marketAt: latest,
  };
}


function aggregateCandles(points, intervalMs) {
  const buckets = new Map();
  for (const point of points) {
    const start = Math.floor(point.time / intervalMs) * intervalMs;
    const candle = buckets.get(start);
    if (!candle) buckets.set(start, { time: point.time, open: point.open ?? point.value, high: point.high ?? point.value, low: point.low ?? point.value, close: point.close ?? point.value });
    else {
      candle.time = point.time;
      candle.high = Math.max(candle.high, point.high ?? point.value);
      candle.low = Math.min(candle.low, point.low ?? point.value);
      candle.close = point.close ?? point.value;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function yahooHistory(asset, since) {
  const symbol = encodeURIComponent(asset.symbol);
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=1y&interval=1d';
  const body = await fetchJson(url, true);
  const result = body?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const candles = timestamps.flatMap((timestamp, index) => {
    const time = Number(timestamp) * 1000;
    const open = Number(quote.open?.[index]);
    const high = Number(quote.high?.[index]);
    const low = Number(quote.low?.[index]);
    const close = Number(quote.close?.[index]);
    return Number.isFinite(time) && time >= since * 1000 && close > 0 && Number.isFinite(open) && Number.isFinite(high) && Number.isFinite(low)
      ? [{ time, open, high, low, close }]
      : [];
  });
  return { candles, points: candles.map((candle) => ({ time: candle.time, value: candle.close })) };
}

async function yahooIntraday(asset) {
  const symbol = encodeURIComponent(asset.symbol);
  const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=1d&interval=5m';
  const body = await fetchJson(url, true);
  const result = body?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  return timestamps.flatMap((timestamp, index) => {
    const time = Number(timestamp) * 1000;
    const value = Number(closes[index]);
    return Number.isFinite(time) && Number.isFinite(value) && value > 0 ? [{ time, value }] : [];
  });
}

function electricityHistory(body, since) {
  return (body?.unix_seconds || []).flatMap((seconds, index) => {
    const time = Number(seconds) * 1000;
    const value = Number(body.price[index]);
    return Number.isFinite(time) && time >= since * 1000 && Number.isFinite(value)
      ? [{ time, value }]
      : [];
  });
}

function electricityUsdHistory(points, fxPoints) {
  let index = 0;
  return points.flatMap((point) => {
    while (index + 1 < fxPoints.length && fxPoints[index + 1].time <= point.time) index += 1;
    const rate = Number(fxPoints[index]?.value);
    return rate > 0 ? [{ time: point.time, value: point.value * rate }] : [];
  });
}

async function loadAssetHistory() {
  const now = Date.now();
  const since = Math.floor((now - 365 * 24 * 60 * 60 * 1000) / 1000);
  const electricityParams = new URLSearchParams({
    bzn: "DE-LU",
    start: new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(),
    end: new Date(now).toISOString(),
  });
  const [yahooEntries, yahooIntradayEntries, bitcoinBody, ethereumBody, bitcoinYahoo, ethereumYahoo, bitcoinIntraday, ethereumIntraday, electricityBody, eurUsdHistory] = await Promise.all([
    Promise.all(Object.entries(yahooInstruments).map(async ([key, asset]) => [key, await yahooHistory(asset, since)])),
    Promise.all(Object.entries(yahooInstruments).map(async ([key, asset]) => [key, await yahooIntraday(asset)])),
    fetchJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=30&since=" + since),
    fetchJson("https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=30&since=" + since),
    yahooHistory({ symbol: "BTC-USD" }, since),
    yahooHistory({ symbol: "ETH-USD" }, since),
    yahooIntraday({ symbol: "BTC-USD" }),
    yahooIntraday({ symbol: "ETH-USD" }),
    fetchJson("https://api.energy-charts.info/price?" + electricityParams),
    yahooHistory({ symbol: "EURUSD=X" }, since),
  ]);
  const histories = {};
  const candles = {};
  const intraday = Object.fromEntries(yahooIntradayEntries.filter(([, points]) => points.length));
  for (const [key, series] of yahooEntries) {
    if (!series.candles.length) continue;
    histories[key] = series.points;
    candles[key] = series.candles;
  }
  for (const [key, body, fallback] of [["bitcoin", bitcoinBody, bitcoinYahoo], ["ethereum", ethereumBody, ethereumYahoo]]) {
    const result = body?.result || {};
    const ticker = Object.keys(result).find((name) => name !== "last");
    const exchangeCandles = (ticker ? result[ticker] : []).flatMap((row) => {
      const time = Number(row[0]) * 1000;
      const open = Number(row[1]), high = Number(row[2]), low = Number(row[3]), close = Number(row[4]);
      return Number.isFinite(time) && time >= since * 1000 && open > 0 && high > 0 && low > 0 && close > 0
        ? [{ time, open, high, low, close }]
        : [];
    });
    if (fallback.candles.length) {
      candles[key] = fallback.candles;
      histories[key] = fallback.points;
    } else if (exchangeCandles.length) {
      candles[key] = exchangeCandles;
      histories[key] = exchangeCandles.map((candle) => ({ time: candle.time, value: candle.close }));
    }
    const intradayYahoo = key === 'bitcoin' ? bitcoinIntraday : ethereumIntraday;
    const recentExchange = exchangeCandles
      .filter((candle) => candle.time >= Date.now() - 24 * 60 * 60_000)
      .map((candle) => ({ time: candle.time, value: candle.close }));
    if (intradayYahoo.length) intraday[key] = intradayYahoo;
    else if (recentExchange.length) intraday[key] = recentExchange;
  }
  const electricity = electricityUsdHistory(electricityHistory(electricityBody, since), eurUsdHistory.points);
  if (electricity.length) {
    histories.electricity = electricity;
    candles.electricity = aggregateCandles(electricity, 60 * 60_000);
    intraday.electricity = electricity.filter((point) => point.time >= Date.now() - 24 * 60 * 60_000);
  }
  return { histories, candles, intraday, fetchedAt: Date.now() };
}

async function loadQuotes() {
  const now = Date.now();
  const [entries, crypto, electricity, eurUsd] = await Promise.all([
    Promise.all(Object.entries(yahooInstruments).map(async ([key, asset]) => [key, await yahooQuote(key, asset)])),
    cryptoQuotes(now),
    electricityQuote(now),
    yahooQuote('eurusd', { symbol: 'EURUSD=X', instrument: 'EUR/USD exchange rate' }),
  ]);
  const quotes = Object.fromEntries(entries.filter(([, quote]) => quote));
  Object.assign(quotes, crypto);
  if (electricity) {
    quotes.electricity = eurUsd
      ? { ...electricity, price: electricity.price * eurUsd.price, currency: 'USD', instrument: 'DE-LU day-ahead electricity · USD per MWh', provider: electricity.provider + ' · converted with Yahoo Finance FX', unit: 'per MWh' }
      : electricity;
  }
  return { quotes, fetchedAt: Date.now() };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("Not found", { status: 404 });
    if (url.pathname === "/api/asset-history") {
      if (cachedHistory && Date.now() - historyAt < 20_000) {
        return Response.json(cachedHistory, { headers: { "Cache-Control": "no-store" } });
      }
      if (!historyInFlight) {
        historyInFlight = loadAssetHistory().then((data) => {
          cachedHistory = data;
          historyAt = Date.now();
          return cachedHistory;
        }).finally(() => { historyInFlight = null; });
      }
      return Response.json(await historyInFlight, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname !== "/api/asset-prices") return new Response("Not found", { status: 404 });
    if (cachedQuotes && Date.now() - cachedAt < 60_000) {
      return Response.json(cachedQuotes, { headers: { "Cache-Control": "no-store" } });
    }
    if (!refreshInFlight) {
      refreshInFlight = loadQuotes().then((data) => {
        if (Object.keys(data.quotes).length) {
          cachedQuotes = {
            quotes: { ...(cachedQuotes?.quotes || {}), ...data.quotes },
            fetchedAt: data.fetchedAt,
          };
          cachedAt = Date.now();
        }
        return cachedQuotes || data;
      }).finally(() => { refreshInFlight = null; });
    }
    const data = await refreshInFlight;
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  },
};
