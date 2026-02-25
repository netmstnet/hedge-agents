'use strict';

/**
 * risk.cjs — Risk management tools.
 * Wraps math.cjs into tool-friendly structured output for LLM consumption.
 */

const math = require('../utils/math.cjs');

/**
 * Compute all risk metrics for a return series.
 *
 * @param {number[]} dailyReturns - fractional daily returns
 * @param {number[]} equityCurve  - portfolio values over time
 * @param {object}   [opts]       - { riskFreeRate, cvarConfidence }
 * @returns {object} Structured risk metrics
 */
function computeRiskMetrics(dailyReturns, equityCurve, opts = {}) {
  const { riskFreeRate = 0.02, cvarConfidence = 0.95 } = opts;

  if (!dailyReturns.length) {
    return {
      error: 'Insufficient return data',
      tr: 0, arr: 0, sr: 0, cr: 0, sor: 0, mdd: 0, vol: 0, var95: 0, cvar95: 0,
    };
  }

  const tr    = math.totalReturn(dailyReturns);
  const arr   = math.annualisedReturn(dailyReturns);
  const vol   = math.annualisedVol(dailyReturns);
  const sr    = math.sharpeRatio(dailyReturns, riskFreeRate);
  const sor   = math.sortinoRatio(dailyReturns, riskFreeRate);
  const mdd   = equityCurve.length >= 2 ? math.maxDrawdown(equityCurve) : 0;
  const cr    = mdd > 0 ? arr / mdd : (arr > 0 ? Infinity : 0);
  const var95 = math.valueAtRisk(dailyReturns, cvarConfidence);
  const cvar95 = math.conditionalVaR(dailyReturns, cvarConfidence);

  // Interpretation strings for LLM context
  const interpretation = [];
  if (sr < 0)    interpretation.push('Negative Sharpe — not compensating for risk');
  if (sr > 2)    interpretation.push('Excellent Sharpe Ratio (>2)');
  if (mdd > 0.3) interpretation.push('High maximum drawdown (>30%) — significant risk exposure');
  if (vol > 0.4) interpretation.push('High annualised volatility (>40%)');
  if (tr > 0.5)  interpretation.push('Strong total return (>50%)');

  return {
    tr:    round(tr   * 100),
    arr:   round(arr  * 100),
    vol:   round(vol  * 100),
    sr:    round(sr),
    sor:   round(sor),
    mdd:   round(mdd  * 100),
    cr:    round(cr),
    var95: round(var95  * 100),
    cvar95: round(cvar95 * 100),
    interpretation: interpretation.join('; ') || 'Performance within normal range',
    period:  `${dailyReturns.length} trading days`,
  };
}

/**
 * Position sizing — Kelly Criterion (half-Kelly for safety).
 *
 * @param {number} winRate       - Historical win rate (0-1)
 * @param {number} avgWin        - Average winning return (fractional)
 * @param {number} avgLoss       - Average losing return (fractional, positive)
 * @returns {{ kelly, halfKelly, recommendation }}
 */
function kellyCriterion(winRate, avgWin, avgLoss) {
  if (avgLoss === 0) return { kelly: 1, halfKelly: 0.5, recommendation: 'Insufficient data' };
  const kelly = (winRate / avgLoss) - ((1 - winRate) / avgWin);
  const halfKelly = Math.max(0, Math.min(0.5, kelly / 2));
  return {
    kelly:      round(kelly),
    halfKelly:  round(halfKelly),
    recommendation: halfKelly > 0.3 ? 'HIGH_CONVICTION: up to 30% position'
      : halfKelly > 0.1 ? 'MODERATE: 10-20% position'
      : 'LOW: 5-10% or pass',
  };
}

/**
 * Portfolio stress test — simulate portfolio under shock scenarios.
 *
 * @param {object} positions   - { asset: quantity }
 * @param {object} prices      - { asset: currentPrice }
 * @returns {object} Stress scenarios and portfolio impact
 */
function stressTest(positions, prices) {
  const totalValue = Object.entries(positions).reduce((s, [asset, qty]) => {
    return s + qty * (prices[asset] || 0);
  }, 0);

  if (totalValue === 0) return { error: 'No positions to stress test' };

  const scenarios = [
    { name: 'Bear Market',          shocks: { default: -0.30 } },
    { name: 'Crypto Crash (BTC)',   shocks: { 'BTC-USD': -0.50, default: -0.10 } },
    { name: 'Market Flash Crash',   shocks: { default: -0.10 } },
    { name: 'Rate Spike (FX/Bonds)',shocks: { 'EURUSD=X': -0.05, '^DJI': -0.15, default: -0.05 } },
    { name: 'Mild Correction',      shocks: { default: -0.10 } },
  ];

  return {
    currentValue: round(totalValue),
    scenarios: scenarios.map(scenario => {
      const pnl = Object.entries(positions).reduce((s, [asset, qty]) => {
        const price = prices[asset] || 0;
        const shock = scenario.shocks[asset] ?? scenario.shocks.default ?? 0;
        return s + qty * price * shock;
      }, 0);
      return {
        name:       scenario.name,
        pnl:        round(pnl),
        pnlPct:     round(pnl / totalValue * 100),
        valueAfter: round(totalValue + pnl),
      };
    }),
  };
}

/**
 * Compute daily returns from a price series.
 * @param {number[]} prices
 * @returns {number[]}
 */
function pricesToReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return returns;
}

function round(v, dp = 4) {
  if (v === null || v === undefined || !isFinite(v)) return v;
  return parseFloat(v.toFixed(dp));
}

module.exports = { computeRiskMetrics, kellyCriterion, stressTest, pricesToReturns };
