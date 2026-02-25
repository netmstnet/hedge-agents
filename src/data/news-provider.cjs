'use strict';

/**
 * news-provider.cjs — Fetch financial news headlines.
 *
 * Backends (in priority order):
 *   1. Alpaca News API (if ALPACA_NEWS_API_KEY set)
 *   2. RSS feeds (free, no API key)
 *   3. Mock (for testing)
 */

const https  = require('https');
const http   = require('http');
const logger = require('../utils/logger.cjs');

const MOD = 'data:news';

class NewsProvider {
  /**
   * @param {object} cfg - Full app config (uses cfg.news, cfg.data)
   */
  constructor(cfg) {
    this._alpacaKey    = cfg.news?.alpacaKey    || '';
    this._alpacaSecret = cfg.news?.alpacaSecret || '';
    this._rssFeeds     = cfg.data?.news?.rssFeeds || {};
    this._maxHeadlines = cfg.data?.news?.maxHeadlinesPerAsset || 10;
    this._provider     = this._alpacaKey ? 'alpaca' : 'rss';
    logger.info(MOD, `News provider: ${this._provider}`);
  }

  /**
   * Get headlines for a given asset symbol.
   *
   * @param {string} symbol     - e.g. 'BTC-USD', '^DJI', 'EURUSD=X'
   * @param {number} maxCount   - max headlines to return
   * @returns {Promise<string[]>} Array of headline strings
   */
  async getHeadlines(symbol, maxCount = 10) {
    try {
      if (this._provider === 'alpaca') {
        return await this._fetchAlpacaNews(symbol, maxCount);
      }
      return await this._fetchRSSNews(symbol, maxCount);
    } catch (e) {
      logger.warn(MOD, `News fetch failed for ${symbol}: ${e.message}`);
      return this._mockHeadlines(symbol, maxCount);
    }
  }

  // ─── Alpaca News ──────────────────────────────────────────────────────────

  async _fetchAlpacaNews(symbol, maxCount) {
    // Map Yahoo Finance symbols to Alpaca symbols
    const alpacaSymbol = symbol.replace('^', '').replace('=X', '').replace('-USD', '');

    return new Promise((resolve, reject) => {
      const url = `https://data.alpaca.markets/v1beta1/news?symbols=${alpacaSymbol}&limit=${maxCount}&sort=desc`;
      const req = https.get(url, {
        headers: {
          'APCA-API-KEY-ID':     this._alpacaKey,
          'APCA-API-SECRET-KEY': this._alpacaSecret,
        },
      }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const headlines = (data.news || []).map(n => n.headline).filter(Boolean);
            logger.debug(MOD, `Alpaca: ${headlines.length} headlines for ${symbol}`);
            resolve(headlines.slice(0, maxCount));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('Alpaca timeout')); });
      req.on('error', reject);
    });
  }

  // ─── RSS ──────────────────────────────────────────────────────────────────

  async _fetchRSSNews(symbol, maxCount) {
    // Find relevant RSS feeds for this symbol
    const feeds = this._rssFeeds[symbol] || this._rssFeeds['general'] || [];
    if (!feeds.length) return this._mockHeadlines(symbol, maxCount);

    const results = await Promise.allSettled(
      feeds.map(url => this._fetchRSSFeed(url))
    );

    const allHeadlines = [];
    for (const r of results) {
      if (r.status === 'fulfilled') allHeadlines.push(...r.value);
    }

    // Deduplicate and slice
    const unique = [...new Set(allHeadlines)];
    logger.debug(MOD, `RSS: ${unique.length} headlines for ${symbol}`);
    return unique.slice(0, maxCount);
  }

  async _fetchRSSFeed(url) {
    return new Promise((resolve) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 8000 }, res => {
        if (res.statusCode !== 200) { resolve([]); return; }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const xml = Buffer.concat(chunks).toString('utf8');
          // Extract <title> tags (skip the channel title which is usually the first one)
          const titles = [];
          const titleRegex = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs;
          let match;
          let count = 0;
          while ((match = titleRegex.exec(xml)) !== null) {
            if (count > 0) { // Skip first (channel title)
              const title = match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
              if (title && title.length > 10) titles.push(title);
            }
            count++;
            if (titles.length >= 15) break;
          }
          resolve(titles);
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
  }

  // ─── Mock headlines ───────────────────────────────────────────────────────

  _mockHeadlines(symbol, maxCount) {
    const headlines = {
      'BTC-USD': [
        'Bitcoin surges as institutional demand grows',
        'BTC tests key resistance at recent highs',
        'Crypto market shows resilience amid macro uncertainty',
        'Bitcoin network hash rate reaches all-time high',
        'Analysts remain bullish on BTC long-term outlook',
      ],
      '^DJI': [
        'Dow Jones rises as earnings season beats expectations',
        'Blue chip stocks rally on positive economic data',
        'Fed signals cautious approach to rate cuts',
        'Tech giants lead Dow higher in morning trading',
        'Consumer confidence improves, supporting equity rally',
      ],
      'EURUSD=X': [
        'EUR/USD holds above key support as ECB meeting approaches',
        'Dollar weakens on softer inflation data',
        'Euro strengthens on better-than-expected PMI data',
        'FX markets cautious ahead of central bank decisions',
        'EUR/USD consolidating in tight range this week',
      ],
    };
    return (headlines[symbol] || ['Market remains stable', 'No significant news today']).slice(0, maxCount);
  }
}

module.exports = { NewsProvider };
