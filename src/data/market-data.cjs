'use strict';

/**
 * market-data.cjs — Yahoo Finance market data provider.
 *
 * yahoo-finance2 is ESM-only, so we use dynamic import() inside async functions.
 * This works perfectly in Node.js >=12 CJS modules.
 *
 * Provides:
 *   - Historical OHLCV data (with SQLite cache to avoid re-fetching)
 *   - Current quote data
 *   - Batch quote for multiple tickers
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger.cjs');
const { toDateStr } = require('../utils/date-utils.cjs');

const MOD = 'data:market';

// Lazy-loaded yf instance (ESM)
let _yf = null;
async function getYF() {
  if (!_yf) {
    const mod = await import('yahoo-finance2');
    _yf = mod.default;
    // Suppress yahoo-finance2 validation warnings for slightly malformed data
    _yf.setGlobalConfig({ validation: { logErrors: false } });
  }
  return _yf;
}

class MarketDataProvider {
  /**
   * @param {object} cfg - { cacheTtlHours, cacheDir }
   */
  constructor(cfg = {}) {
    this._cacheTtlMs = (cfg.cacheTtlHours || 24) * 3600 * 1000;
    this._cacheDir   = cfg.cacheDir || path.join(__dirname, '../../data/cache');
    if (!fs.existsSync(this._cacheDir)) {
      fs.mkdirSync(this._cacheDir, { recursive: true });
    }
  }

  /**
   * Fetch historical OHLCV data for a symbol.
   *
   * @param {string} symbol  - e.g. 'BTC-USD', '^DJI', 'EURUSD=X'
   * @param {Date}   startDate
   * @param {Date}   endDate
   * @returns {Promise<{
   *   symbol: string,
   *   opens: number[], highs: number[], lows: number[],
   *   closes: number[], volumes: number[], dates: string[],
   *   count: number
   * }>}
   */
  async getOHLCV(symbol, startDate, endDate) {
    const cacheKey  = `${symbol}_${toDateStr(startDate)}_${toDateStr(endDate)}`;
    const cachePath = path.join(this._cacheDir, `${cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

    // Check cache
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < this._cacheTtlMs) {
        logger.debug(MOD, `Cache hit: ${cacheKey}`);
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    }

    logger.info(MOD, `Fetching OHLCV: ${symbol} ${toDateStr(startDate)} → ${toDateStr(endDate)}`);
    const yf = await getYF();

    const result = await yf.historical(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    if (!result || !result.length) {
      logger.warn(MOD, `No data returned for ${symbol}`);
      return { symbol, opens: [], highs: [], lows: [], closes: [], volumes: [], dates: [], count: 0 };
    }

    // Sort chronologically
    result.sort((a, b) => new Date(a.date) - new Date(b.date));

    const data = {
      symbol,
      opens:   result.map(r => r.open   ?? r.close),
      highs:   result.map(r => r.high   ?? r.close),
      lows:    result.map(r => r.low    ?? r.close),
      closes:  result.map(r => r.adjClose ?? r.close),
      volumes: result.map(r => r.volume  ?? 0),
      dates:   result.map(r => toDateStr(new Date(r.date))),
      count:   result.length,
    };

    // Write to cache
    fs.writeFileSync(cachePath, JSON.stringify(data));
    logger.info(MOD, `Fetched ${data.count} bars for ${symbol}`);
    return data;
  }

  /**
   * Fetch current quote for a symbol.
   *
   * @param {string} symbol
   * @returns {Promise<{ symbol, price, change, changePct, volume, high52w, low52w }>}
   */
  async getQuote(symbol) {
    logger.debug(MOD, `Quote: ${symbol}`);
    const yf = await getYF();

    try {
      const q = await yf.quote(symbol);
      return {
        symbol,
        price:      q.regularMarketPrice,
        change:     q.regularMarketChange,
        changePct:  q.regularMarketChangePercent,
        volume:     q.regularMarketVolume,
        high52w:    q.fiftyTwoWeekHigh,
        low52w:     q.fiftyTwoWeekLow,
        marketCap:  q.marketCap,
        name:       q.longName || q.shortName || symbol,
      };
    } catch (e) {
      logger.warn(MOD, `Quote failed for ${symbol}: ${e.message}`);
      return { symbol, price: null, error: e.message };
    }
  }

  /**
   * Fetch quotes for multiple symbols.
   */
  async getBatchQuotes(symbols) {
    const results = await Promise.allSettled(symbols.map(s => this.getQuote(s)));
    return results.map((r, i) =>
      r.status === 'fulfilled' ? r.value : { symbol: symbols[i], price: null, error: r.reason?.message }
    );
  }

  /**
   * Get today's OHLCV slice for a given symbol (last N days ending today).
   *
   * @param {string} symbol
   * @param {number} days   - How many days of history to fetch (default 365)
   */
  async getRecentOHLCV(symbol, days = 365) {
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days - 10); // +10 buffer for weekends
    return this.getOHLCV(symbol, start, end);
  }

  /**
   * Get today's price for a symbol (from quote, not historical).
   */
  async getCurrentPrice(symbol) {
    const q = await this.getQuote(symbol);
    return q.price;
  }
}

/**
 * Build mock OHLCV data for testing (deterministic random walk).
 *
 * @param {string} symbol
 * @param {number} days
 * @param {number} startPrice
 */
function buildMockOHLCV(symbol, days = 100, startPrice = 100) {
  // Deterministic seed based on symbol
  let seed = symbol.split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  function rand() {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  }

  const closes = [startPrice];
  for (let i = 1; i < days; i++) {
    const change = (rand() - 0.48) * 0.03; // slight upward drift
    closes.push(Math.max(1, closes[closes.length - 1] * (1 + change)));
  }

  const opens   = closes.map((c, i) => i === 0 ? c : closes[i - 1]);
  const highs   = closes.map((c, i) => Math.max(c, opens[i]) * (1 + rand() * 0.02));
  const lows    = closes.map((c, i) => Math.min(c, opens[i]) * (1 - rand() * 0.02));
  const volumes = closes.map(() => Math.floor(100000 + rand() * 900000));
  const dates   = Array.from({ length: days }, (_, i) => {
    const d = new Date('2024-01-01');
    d.setDate(d.getDate() + i);
    return toDateStr(d);
  });

  return { symbol, opens, highs, lows, closes, volumes, dates, count: days, isMock: true };
}

module.exports = { MarketDataProvider, buildMockOHLCV };
