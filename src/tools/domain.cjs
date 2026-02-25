'use strict';

/**
 * domain.cjs — Domain-specific tools for Bitcoin, Equities, Forex, and Portfolio.
 *
 * Many of these rely on external APIs (Fear & Greed, FRED, etc.) that may not
 * always be available. All functions return gracefully with available data or
 * clearly labelled stubs when the API is unavailable.
 *
 * For production: wire in real API calls.
 * For testing/demo: stubs return plausible synthetic data.
 */

const https  = require('https');
const logger = require('../utils/logger.cjs');
const { optimizePortfolio, covarianceMatrix } = require('../utils/math.cjs');
const { pricesToReturns } = require('./risk.cjs');

const MOD = 'tools:domain';

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// ─── Bitcoin / Crypto ────────────────────────────────────────────────────────

async function getBlockchainMetrics(ctx) {
  // Blockchain.info public API — free, no key
  try {
    const stats = await httpGet('https://api.blockchain.info/stats');
    return {
      hashRateEH:        round(stats.hash_rate / 1e18),
      difficulty:        stats.difficulty,
      mempoolSize:       stats.mempool_size,
      minutesBetweenBlocks: round(stats.minutes_between_blocks),
      totalBTCMined:     round(stats.totalbc / 1e8),
      marketPriceUSD:    stats.market_price_usd,
      interpretation: `Hash rate ${round(stats.hash_rate / 1e18)} EH/s. Mempool ${stats.mempool_size} unconfirmed txs.`,
    };
  } catch (e) {
    logger.warn(MOD, `Blockchain metrics unavailable: ${e.message}`);
    return {
      note: 'Blockchain metrics API unavailable',
      interpretation: 'Unable to fetch on-chain data. Use price/news data only.',
    };
  }
}

async function getCryptoSentiment(ctx) {
  // Fear & Greed Index — free API
  try {
    const data = await httpGet('https://api.alternative.me/fng/?limit=7');
    const current = data.data[0];
    const weekAgo = data.data[6];
    return {
      value:          parseInt(current.value),
      label:          current.value_classification,
      trend:          parseInt(current.value) > parseInt(weekAgo.value) ? 'IMPROVING' : 'DETERIORATING',
      weekAgoValue:   parseInt(weekAgo.value),
      weekAgoLabel:   weekAgo.value_classification,
      interpretation: `Fear & Greed: ${current.value} (${current.value_classification}). ` +
        (parseInt(current.value) < 25 ? 'Extreme Fear — potential buy signal. ' : '') +
        (parseInt(current.value) > 75 ? 'Extreme Greed — potential sell signal. ' : ''),
    };
  } catch (e) {
    logger.warn(MOD, `Fear & Greed API unavailable: ${e.message}`);
    return { note: 'Fear & Greed API unavailable', value: null, label: 'Unknown' };
  }
}

async function getRegulatoryScan(ctx) {
  const news = ctx.news || [];
  const regKeywords = ['regulation', 'ban', 'SEC', 'CFTC', 'illegal', 'crackdown', 'approved', 'ETF', 'license', 'compliance'];
  const regNews = news.filter(headline =>
    regKeywords.some(kw => headline.toLowerCase().includes(kw.toLowerCase()))
  );
  const riskLevel = regNews.length >= 3 ? 'HIGH' : regNews.length >= 1 ? 'MEDIUM' : 'LOW';
  return {
    regulatoryNews:    regNews.slice(0, 5),
    count:             regNews.length,
    riskLevel,
    interpretation: `Regulatory risk: ${riskLevel}. Found ${regNews.length} regulatory-related headlines.`,
  };
}

function getHalvingCycle(ctx) {
  // Bitcoin halving history and next estimated date
  const HALVING_BLOCKS = 210000;
  const GENESIS_DATE   = new Date('2009-01-03');
  const AVG_BLOCK_TIME_MIN = 10;

  const halvings = [
    { block: 210000, date: new Date('2012-11-28') },
    { block: 420000, date: new Date('2016-07-09') },
    { block: 630000, date: new Date('2020-05-11') },
    { block: 840000, date: new Date('2024-04-20') },
    { block: 1050000, date: new Date('2028-03-01') }, // estimated
  ];

  const now = new Date();
  const lastHalving = halvings.filter(h => h.date <= now).slice(-1)[0];
  const nextHalving = halvings.find(h => h.date > now);

  const daysToNext  = nextHalving ? Math.round((nextHalving.date - now) / 86400000) : null;
  const daysSinceLast = lastHalving ? Math.round((now - lastHalving.date) / 86400000) : null;

  // Historical patterns: 12-18 months after halving tends to see peak
  const monthsSinceHalving = daysSinceLast ? daysSinceLast / 30 : null;
  let cyclePhase = 'UNKNOWN';
  if (monthsSinceHalving !== null) {
    if (monthsSinceHalving < 6)   cyclePhase = 'POST_HALVING_EARLY';
    else if (monthsSinceHalving < 18) cyclePhase = 'BULL_PHASE';
    else if (monthsSinceHalving < 30) cyclePhase = 'POST_BULL_CORRECTION';
    else                           cyclePhase = 'PRE_HALVING_ACCUMULATION';
  }

  return {
    lastHalvingDate:  lastHalving?.date.toISOString().slice(0, 10),
    lastHalvingBlock: lastHalving?.block,
    nextHalvingDate:  nextHalving?.date.toISOString().slice(0, 10),
    daysToNextHalving: daysToNext,
    daysSinceLastHalving: daysSinceLast,
    cyclePhase,
    interpretation: `Bitcoin halving cycle phase: ${cyclePhase}. ` +
      (daysToNext ? `${daysToNext} days until next halving.` : 'Next halving date TBD.'),
  };
}

// ─── Equities ────────────────────────────────────────────────────────────────

async function getEarningsCalendar(ctx) {
  // Would call Alpaca or Yahoo Finance earnings calendar
  // For now: return a plausible stub with next earnings note
  return {
    note: 'Earnings calendar requires Alpaca API integration',
    upcomingEarnings: [],
    interpretation: 'No earnings calendar data available. Monitor financial news for earnings announcements.',
  };
}

async function getFundamentalValuation(ctx) {
  // P/E, P/B estimated from index data (simplified)
  const { closes } = ctx.ohlcv;
  if (!closes.length) return { error: 'No price data' };

  const current = closes[closes.length - 1];
  const yearHigh = Math.max(...closes.slice(-252));
  const yearLow  = Math.min(...closes.slice(-252));
  const yearPct  = (current - yearLow) / (yearHigh - yearLow);

  return {
    currentPrice:   round(current),
    yearHigh:       round(yearHigh),
    yearLow:        round(yearLow),
    positionIn52wk: round(yearPct * 100),
    interpretation: yearPct > 0.8 ? 'Near 52-week high — caution on valuation'
      : yearPct < 0.2 ? 'Near 52-week low — potential value opportunity'
      : 'Mid-range valuation',
  };
}

async function getSectorRotation(ctx) {
  return {
    note: 'Sector rotation requires sector ETF data (XLK, XLV, XLE, etc.)',
    interpretation: 'Monitor sector ETF relative strength for rotation signals.',
  };
}

async function getIndexComposition(ctx) {
  // DJ30 top movers (derived from price data)
  const { closes, dates } = ctx.ohlcv;
  if (!closes.length || closes.length < 2) return { error: 'Insufficient data' };

  const recentReturn = (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2];
  return {
    indexReturn1d:  round(recentReturn * 100),
    latestDate:     dates[dates.length - 1],
    interpretation: `DJ30 ${recentReturn >= 0 ? 'gained' : 'lost'} ${Math.abs(round(recentReturn * 100))}% today.`,
  };
}

// ─── Forex ───────────────────────────────────────────────────────────────────

async function getCentralBankCalendar(ctx) {
  // Major central bank meeting dates (hardcoded approximation)
  const now = new Date();
  const upcomingMeetings = [
    { bank: 'Federal Reserve', nextMeeting: '2024-03-20', rateExpectation: 'Hold at 5.25-5.50%' },
    { bank: 'ECB',             nextMeeting: '2024-03-07', rateExpectation: 'Hold at 4.50%' },
    { bank: 'Bank of Japan',   nextMeeting: '2024-03-19', rateExpectation: 'Possible exit from negative rates' },
    { bank: 'Bank of England', nextMeeting: '2024-03-21', rateExpectation: 'Hold at 5.25%' },
  ].filter(m => new Date(m.nextMeeting) > now);

  return {
    upcomingMeetings: upcomingMeetings.slice(0, 3),
    note: 'Meeting dates approximate — verify with official calendars',
    interpretation: upcomingMeetings.length
      ? `${upcomingMeetings.length} central bank meetings upcoming. Monitor for rate surprises.`
      : 'No major central bank meetings in immediate horizon.',
  };
}

async function getInterestRateDifferential(ctx) {
  // Simplified IR differential analysis
  const rates = {
    USD: 5.375, EUR: 4.50, GBP: 5.25, JPY: -0.10, CHF: 1.75, AUD: 4.35, NZD: 5.50,
  };
  const symbol = ctx.symbol || 'EURUSD=X';
  const [base, quote] = symbol.replace('=X', '').match(/[A-Z]{3}/g) || ['EUR', 'USD'];
  const differential = (rates[quote] || 0) - (rates[base] || 0);

  return {
    baseRate:      rates[base],
    quoteRate:     rates[quote],
    differential:  round(differential),
    carryDirection: differential > 0 ? `LONG_${base}` : `LONG_${quote}`,
    interpretation: `Rate differential: ${quote} ${rates[quote]}% vs ${base} ${rates[base]}%. ` +
      `Carry trade favours ${differential > 0 ? base : quote} long.`,
  };
}

async function getGeopoliticalRisk(ctx) {
  const news = ctx.news || [];
  const geoKeywords = ['war', 'sanctions', 'conflict', 'invasion', 'NATO', 'geopolitical', 'tensions', 'election', 'coup', 'crisis'];
  const geoNews = news.filter(h => geoKeywords.some(kw => h.toLowerCase().includes(kw)));
  const riskLevel = geoNews.length >= 3 ? 'HIGH' : geoNews.length >= 1 ? 'ELEVATED' : 'NORMAL';
  return {
    geopoliticalNews: geoNews.slice(0, 5),
    count:    geoNews.length,
    riskLevel,
    interpretation: `Geopolitical risk: ${riskLevel}. ${geoNews.length} risk-relevant headlines detected.`,
  };
}

function getMacroCalendar(ctx) {
  return {
    note: 'Macro calendar: watch for CPI (monthly), NFP (first Friday), GDP (quarterly)',
    keyIndicators: ['CPI', 'NFP', 'GDP', 'PMI', 'FOMC', 'ECB Rate Decision'],
    interpretation: 'Major macro releases create short-term FX volatility. Monitor release calendar.',
  };
}

// ─── Portfolio Optimizer (for Otto) ─────────────────────────────────────────

async function runPortfolioOptimizer(ctx) {
  const { analystForecasts, allAssetData, config } = ctx;
  if (!analystForecasts || !allAssetData) {
    return { error: 'Portfolio optimizer requires analystForecasts and allAssetData' };
  }

  const agentNames  = Object.keys(analystForecasts);
  const expectedRet = agentNames.map(n => analystForecasts[n].projected_return_pct / 100 || 0.05);
  const returnSeries = agentNames.map(n => {
    const sym    = allAssetData[n]?.symbol;
    const closes = allAssetData[n]?.closes || [];
    return pricesToReturns(closes);
  });

  const minLen = Math.min(...returnSeries.map(r => r.length));
  const aligned = returnSeries.map(r => r.slice(-minLen));
  const covMat  = covarianceMatrix(aligned);

  const result = optimizePortfolio(expectedRet, covMat, aligned, {
    lambda1: config?.optimization?.lambda1 || 0.5,
    lambda2: config?.optimization?.lambda2 || 0.3,
  });

  const allocation = {};
  agentNames.forEach((n, i) => { allocation[n] = round(result.weights[i]); });

  return {
    optimalWeights:      allocation,
    expectedTotalReturn: round(result.metrics.expectedTotalReturn * 100),
    portfolioStdDev:     round(result.metrics.portfolioStdDev * 100),
    interpretation: `Optimal allocation: ${
      Object.entries(allocation).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ')
    }`,
  };
}

function round(v, dp = 2) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  return parseFloat(v.toFixed(dp));
}

module.exports = {
  getBlockchainMetrics, getCryptoSentiment, getRegulatoryScan, getHalvingCycle,
  getEarningsCalendar, getFundamentalValuation, getSectorRotation, getIndexComposition,
  getCentralBankCalendar, getInterestRateDifferential, getGeopoliticalRisk, getMacroCalendar,
  runPortfolioOptimizer,
};
