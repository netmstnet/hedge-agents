'use strict';

/**
 * metrics.cjs — Compute all 9 PRUDEX metrics + ENT/ENB.
 * From PortfolioTracker data.
 */

const math = require('../utils/math.cjs');

/**
 * Compute all 9 PRUDEX metrics for a completed simulation run.
 *
 * @param {number[]} dailyReturns  - From tracker.getDailyReturns()
 * @param {number[]} equityCurve   - From tracker.getEquityCurve()
 * @param {object}   budgetWeights - From tracker.getSnapshot().budgetWeights
 * @param {object}   [opts]        - { riskFreeRate: 0.02, confidence: 0.95 }
 * @returns {object} All metrics formatted for reporting
 */
function computePRUDEX(dailyReturns, equityCurve, budgetWeights, opts = {}) {
  const { riskFreeRate = 0.02, confidence = 0.95 } = opts;

  if (!dailyReturns.length) {
    return { error: 'No daily returns — run simulation first' };
  }

  const tr    = math.totalReturn(dailyReturns);
  const arr   = math.annualisedReturn(dailyReturns);
  const vol   = math.annualisedVol(dailyReturns);
  const sr    = math.sharpeRatio(dailyReturns, riskFreeRate);
  const sor   = math.sortinoRatio(dailyReturns, riskFreeRate);
  const mdd   = math.maxDrawdown(equityCurve);
  const cr    = mdd > 0 ? arr / mdd : (arr > 0 ? 99 : 0);
  const ent   = math.entropy(Object.values(budgetWeights));
  const enb   = math.effectiveNumberOfBets(Object.values(budgetWeights));

  const metrics = {
    // Profit metrics
    TR:  round(tr  * 100),  // Total Return %
    ARR: round(arr * 100),  // Annual Return Rate %

    // Risk-adjusted profit
    SR:  round(sr),          // Sharpe Ratio
    CR:  round(cr),          // Calmar Ratio
    SoR: round(sor),         // Sortino Ratio

    // Risk metrics
    MDD: round(mdd * 100),  // Maximum Drawdown %
    Vol: round(vol * 100),  // Annualised Volatility %

    // Diversity metrics
    ENT: round(ent),         // Portfolio Entropy
    ENB: round(enb),         // Effective Number of Bets
  };

  // Interpretations
  metrics.summary = buildSummary(metrics);
  metrics.period  = `${dailyReturns.length} trading days`;

  return metrics;
}

function buildSummary(m) {
  const lines = [];
  if (m.TR > 0)        lines.push(`✅ Total return: +${m.TR}%`);
  else                 lines.push(`❌ Total return: ${m.TR}%`);
  if (m.SR > 1.5)     lines.push(`✅ Sharpe ${m.SR} (excellent)`);
  else if (m.SR > 0.5) lines.push(`⚠️  Sharpe ${m.SR} (moderate)`);
  else                 lines.push(`❌ Sharpe ${m.SR} (poor)`);
  if (m.MDD < 15)     lines.push(`✅ Max drawdown ${m.MDD}% (well controlled)`);
  else if (m.MDD < 30) lines.push(`⚠️  Max drawdown ${m.MDD}% (moderate)`);
  else                 lines.push(`❌ Max drawdown ${m.MDD}% (high)`);
  return lines.join(' | ');
}

/**
 * Format metrics as a pretty ASCII table for terminal output.
 */
function formatMetricsTable(metrics) {
  const rows = [
    ['Metric',                  'Value',  'Category'],
    ['─────────────────────', '───────', '────────────'],
    ['Total Return (TR)',       `${metrics.TR}%`,       'Profit'],
    ['Annual Return (ARR)',     `${metrics.ARR}%`,      'Profit'],
    ['Sharpe Ratio (SR)',       `${metrics.SR}`,        'Risk-Adjusted'],
    ['Calmar Ratio (CR)',       `${metrics.CR}`,        'Risk-Adjusted'],
    ['Sortino Ratio (SoR)',     `${metrics.SoR}`,       'Risk-Adjusted'],
    ['Max Drawdown (MDD)',      `${metrics.MDD}%`,      'Risk'],
    ['Volatility (Vol)',        `${metrics.Vol}%`,      'Risk'],
    ['Entropy (ENT)',           `${metrics.ENT}`,       'Diversity'],
    ['Eff. Num. Bets (ENB)',   `${metrics.ENB}`,        'Diversity'],
  ];

  const colWidths = rows[0].map((_, ci) => Math.max(...rows.map(r => String(r[ci]).length)));
  return rows.map(row =>
    row.map((cell, ci) => String(cell).padEnd(colWidths[ci])).join('  ')
  ).join('\n');
}

function round(v, dp = 4) {
  if (v === null || v === undefined || !isFinite(v)) return 0;
  return parseFloat(v.toFixed(dp));
}

module.exports = { computePRUDEX, formatMetricsTable };
