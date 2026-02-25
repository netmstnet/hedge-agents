'use strict';

/**
 * registry.cjs — Tool registry and dispatcher.
 *
 * All 23 tools from the paper are registered here.
 * Tools are plain async functions that take OHLCV + context and return structured JSON.
 *
 * An agent's profile.tools array lists the tool names it can call.
 * The dispatcher executes only the tools the agent has permission to use.
 */

const { runTechnicalIndicators, trendAnalysis, supportResistance, volumeAnalysis, volatilityRegime, drawdownAnalysis } = require('./technical.cjs');
const { computeRiskMetrics, pricesToReturns, stressTest } = require('./risk.cjs');
const domain = require('./domain.cjs');

const MOD = 'tools:registry';

// ─── Tool implementations ─────────────────────────────────────────────────────

const TOOLS = {
  // ── Universal tools ──────────────────────────────────────────────────────────

  technicalIndicators: async (ctx) => {
    return runTechnicalIndicators(ctx.ohlcv);
  },

  trendAnalysis: async (ctx) => {
    return trendAnalysis(ctx.ohlcv.closes);
  },

  supportResistance: async (ctx) => {
    const { highs, lows, closes } = ctx.ohlcv;
    return supportResistance(highs, lows, closes, 20);
  },

  volumeAnalysis: async (ctx) => {
    return volumeAnalysis(ctx.ohlcv.volumes, 20);
  },

  riskMetrics: async (ctx) => {
    const returns = pricesToReturns(ctx.ohlcv.closes);
    const equity  = ctx.portfolioState?.equityCurve || ctx.ohlcv.closes;
    return computeRiskMetrics(returns, equity, {
      riskFreeRate:   ctx.config?.riskFreeRate   || 0.02,
      cvarConfidence: ctx.config?.cvarConfidence || 0.95,
    });
  },

  newsAnalysis: async (ctx) => {
    // Returns pre-fetched news summary (news provider runs separately)
    const headlines = ctx.news || [];
    if (!headlines.length) return { sentiment: 'NEUTRAL', headlines: [], summary: 'No news available' };
    return {
      headlines: headlines.slice(0, 5),
      count: headlines.length,
      // LLM will analyse sentiment in decision prompt — we just pass headlines
      note: 'Sentiment analysis performed in decision prompt',
    };
  },

  priceAlert: async (ctx) => {
    const { closes } = ctx.ohlcv;
    const current = closes[closes.length - 1];
    const prev    = closes[closes.length - 2] || current;
    const change  = (current - prev) / prev;
    const thresholds = ctx.config?.alertThresholds || { pct: 0.05 };
    return {
      current,
      dailyChangePct: round(change * 100),
      alertTriggered: Math.abs(change) >= thresholds.pct,
      alertType: change > 0 ? 'SPIKE_UP' : 'SPIKE_DOWN',
    };
  },

  correlationMatrix: async (ctx) => {
    // Compute pairwise correlations between all analyst asset returns
    if (!ctx.allAssetData) return { error: 'Multi-asset data required for correlation' };
    const returns = {};
    for (const [sym, ohlcv] of Object.entries(ctx.allAssetData)) {
      returns[sym] = pricesToReturns(ohlcv.closes);
    }
    const assets = Object.keys(returns);
    const matrix = {};
    for (const a of assets) {
      matrix[a] = {};
      for (const b of assets) {
        const rA = returns[a];
        const rB = returns[b];
        const n  = Math.min(rA.length, rB.length);
        if (n < 10) { matrix[a][b] = null; continue; }
        const mA = rA.slice(-n).reduce((s, v) => s + v, 0) / n;
        const mB = rB.slice(-n).reduce((s, v) => s + v, 0) / n;
        let cov = 0, vA = 0, vB = 0;
        for (let i = 0; i < n; i++) {
          cov += (rA[rA.length - n + i] - mA) * (rB[rB.length - n + i] - mB);
          vA  += (rA[rA.length - n + i] - mA) ** 2;
          vB  += (rB[rB.length - n + i] - mB) ** 2;
        }
        matrix[a][b] = round(cov / Math.sqrt(vA * vB));
      }
    }
    return { matrix, assets, interpretation: 'Values close to 0 = low correlation = good hedging' };
  },

  drawdownAnalysis: async (ctx) => {
    return drawdownAnalysis(ctx.ohlcv.closes);
  },

  volatilityRegime: async (ctx) => {
    return volatilityRegime(ctx.ohlcv.closes, 20);
  },

  // ── Bitcoin-specific tools ───────────────────────────────────────────────────

  blockchainMetrics: async (ctx) => {
    return domain.getBlockchainMetrics(ctx);
  },

  cryptoSentiment: async (ctx) => {
    return domain.getCryptoSentiment(ctx);
  },

  regulatoryScanner: async (ctx) => {
    return domain.getRegulatoryScan(ctx);
  },

  halvingCycleAnalysis: async (ctx) => {
    return domain.getHalvingCycle(ctx);
  },

  // ── Equities-specific tools ──────────────────────────────────────────────────

  earningsCalendar: async (ctx) => {
    return domain.getEarningsCalendar(ctx);
  },

  fundamentalValuation: async (ctx) => {
    return domain.getFundamentalValuation(ctx);
  },

  sectorRotation: async (ctx) => {
    return domain.getSectorRotation(ctx);
  },

  indexCompositionTracker: async (ctx) => {
    return domain.getIndexComposition(ctx);
  },

  // ── Forex-specific tools ─────────────────────────────────────────────────────

  centralBankMonitor: async (ctx) => {
    return domain.getCentralBankCalendar(ctx);
  },

  interestRateDifferential: async (ctx) => {
    return domain.getInterestRateDifferential(ctx);
  },

  geopoliticalRisk: async (ctx) => {
    return domain.getGeopoliticalRisk(ctx);
  },

  macroEconomicCalendar: async (ctx) => {
    return domain.getMacroCalendar(ctx);
  },

  // ── Manager tools ────────────────────────────────────────────────────────────

  portfolioOptimizer: async (ctx) => {
    return domain.runPortfolioOptimizer(ctx);
  },

  stressTester: async (ctx) => {
    return stressTest(ctx.positions || {}, ctx.prices || {});
  },
};

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Execute all tools permitted for a given agent.
 *
 * @param {string[]} permittedTools - From agent profile.tools
 * @param {object}   context        - Market data, portfolio state, config
 * @returns {Promise<object>}       Tool name → result map
 */
async function runAgentTools(permittedTools, context) {
  const results = {};
  const errors  = {};

  await Promise.allSettled(
    permittedTools.map(async (toolName) => {
      const fn = TOOLS[toolName];
      if (!fn) {
        errors[toolName] = `Tool '${toolName}' not found in registry`;
        return;
      }
      try {
        results[toolName] = await fn(context);
      } catch (e) {
        errors[toolName] = e.message;
      }
    })
  );

  if (Object.keys(errors).length) {
    results._errors = errors;
  }

  return results;
}

function round(v, dp = 4) {
  if (v === null || v === undefined || !isFinite(v)) return null;
  return parseFloat(v.toFixed(dp));
}

module.exports = { runAgentTools, TOOLS };
