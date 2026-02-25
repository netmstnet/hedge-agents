'use strict';

/**
 * bac.cjs — Budget Allocation Conference (BAC)
 *
 * Runs at the end of every 30-day trading cycle.
 * Purpose: Decide how to split the fund's total capital across the three
 * analyst agents (Dave/BTC, Bob/DJ30, Emily/FX) for the next cycle.
 *
 * Flow (Section 3.4.1 of paper):
 *   1. Each analyst submits a BAC performance report (parallel LLM calls)
 *   2. Portfolio optimizer runs on the analyst forecasts
 *   3. Manager Otto reviews all reports + optimizer output and decides final allocation
 *   4. Allocation is saved to memory; returned to caller
 */

const logger        = require('../utils/logger.cjs');
const domain        = require('../tools/domain.cjs');
const {
  buildBACReportPrompt,
  buildBACDecisionPrompt,
} = require('../llm/prompt-builder.cjs');

const MOD = 'conference:bac';

class BudgetAllocationConference {
  /**
   * @param {import('../llm/claude-client.cjs').ClaudeClient} llm
   * @param {import('../memory/memory-store.cjs').MemoryStore}  memoryStore
   * @param {object} config — full app config
   */
  constructor(llm, memoryStore, config) {
    this._llm         = llm;
    this._memory      = memoryStore;
    this._config      = config;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public entry point
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run the Budget Allocation Conference.
   *
   * @param {{ manager: object, analysts: object[] }} agents
   *   agents.manager  — Otto (manager agent / profile)
   *   agents.analysts — [Dave, Bob, Emily] (analyst agents / profiles)
   * @param {object} portfolioMetrics
   *   Per-agent performance metrics for the last cycle.
   *   Shape: { Dave: { tr, sr, mdd, vol, cr, sor, period }, Bob: {...}, Emily: {...}, overall: {...} }
   *   Falls back to treating portfolioMetrics itself as the agent key map.
   * @param {object} allAssetData
   *   Shape: { Dave: { symbol, closes: [] }, Bob: {...}, Emily: {...} }
   * @returns {Promise<{ allocation: object, transcript: object[], outcome: object }>}
   */
  async run(agents, portfolioMetrics, allAssetData) {
    logger.info(MOD, 'BAC starting…');
    const transcript = [];

    // ── Step 1: Each analyst generates their BAC performance report ──────────
    // Runs in parallel; one failure must not abort the whole conference.
    logger.info(MOD, 'Step 1: collecting analyst BAC reports (parallel)');

    const analystReports   = {};   // { agentName: reportJSON }
    const analystForecasts = {};   // { agentName: { projected_return_pct } } for optimizer

    const reportResults = await Promise.allSettled(
      agents.analysts.map(analyst => this._generateAnalystReport(analyst, portfolioMetrics, allAssetData))
    );

    reportResults.forEach((result, idx) => {
      const analyst = agents.analysts[idx];
      const name    = _agentName(analyst);

      if (result.status === 'fulfilled' && result.value) {
        analystReports[name]   = result.value;
        analystForecasts[name] = {
          projected_return_pct: result.value.projected_return_pct || 5,
        };
        transcript.push({ speaker: name, role: 'analyst_report', content: result.value });
        logger.info(MOD, `  ${name} report received (requesting ${(result.value.budget_request_pct * 100).toFixed(0)}%)`);
      } else {
        const err = result.reason?.message || 'unknown error';
        logger.warn(MOD, `  ${name} report failed: ${err} — using empty report`);
        analystReports[name]   = _emptyReport(name);
        analystForecasts[name] = { projected_return_pct: 5 };
        transcript.push({ speaker: name, role: 'analyst_report', error: err });
      }
    });

    // ── Step 2: Run portfolio optimizer ──────────────────────────────────────
    // The optimizer uses analyst forecasts + historical price series to
    // compute mean-variance optimal weights (Section 3.4.1, Eq. 7-9).
    logger.info(MOD, 'Step 2: running portfolio optimizer');

    let domainResult  = {};
    let optimizerResult = _fallbackOptimizerResult(agents.analysts);

    try {
      domainResult = await domain.runPortfolioOptimizer({
        analystForecasts,
        allAssetData,
        config: this._config,
      });

      if (!domainResult.error) {
        // domain.runPortfolioOptimizer returns percentages for ETR/StdDev;
        // buildBACDecisionPrompt expects decimal fractions — adapt here.
        optimizerResult = {
          metrics: {
            expectedTotalReturn: (domainResult.expectedTotalReturn || 0) / 100,
            portfolioStdDev:     (domainResult.portfolioStdDev     || 0) / 100,
          },
          // weights as ordered array matching Object.keys(analystReports)
          weights: agents.analysts.map(a => domainResult.optimalWeights?.[_agentName(a)] || 0),
        };
        logger.info(MOD, `  Optimizer: ETR=${domainResult.expectedTotalReturn}%, StdDev=${domainResult.portfolioStdDev}%`);
      } else {
        logger.warn(MOD, `  Optimizer error: ${domainResult.error} — using equal-weight fallback`);
      }
    } catch (err) {
      logger.warn(MOD, `  Optimizer threw: ${err.message} — using equal-weight fallback`);
    }

    transcript.push({ speaker: 'system', role: 'optimizer_result', content: domainResult });

    // ── Step 3: Otto makes the final allocation decision ─────────────────────
    // Otto reads all analyst reports and the optimizer suggestion, then
    // decides the final capital allocation for the next 30-day cycle.
    logger.info(MOD, 'Step 3: Otto making final allocation decision');

    const overallMetrics = portfolioMetrics?.overall || portfolioMetrics || {};
    const { system, user } = buildBACDecisionPrompt(
      _agentProfile(agents.manager),
      analystReports,
      optimizerResult,
      overallMetrics
    );

    let ottoDecision = null;
    try {
      ottoDecision = await this._llm.completeJSON(user, system, this._config?.llm?.maxTokens?.bac || 2000);
      logger.info(MOD, `  Otto decided: ${JSON.stringify(ottoDecision?.final_allocation)}`);
    } catch (err) {
      logger.error(MOD, `  Otto decision failed: ${err.message} — using equal-weight allocation`);
      ottoDecision = _fallbackOttoDecision(agents.analysts);
    }

    transcript.push({ speaker: 'Otto', role: 'final_allocation', content: ottoDecision });

    // ── Step 4: Extract final allocation ─────────────────────────────────────
    // Normalise allocation to ensure values sum to 1.0 and are all >= 0.
    const allocation = _normaliseAllocation(
      ottoDecision?.final_allocation || {},
      agents.analysts
    );

    const outcome = {
      allocation,
      optimizerSuggestion: domainResult.optimalWeights || {},
      ottoOverride: _computeOverride(domainResult.optimalWeights, allocation),
      analystRequestedAllocations: Object.fromEntries(
        agents.analysts.map(a => [_agentName(a), analystReports[_agentName(a)]?.budget_request_pct || 0])
      ),
      timestamp: new Date().toISOString(),
    };

    // ── Step 5: Save conference log to memory store ───────────────────────────
    try {
      this._memory.saveConferenceLog('BAC', transcript, outcome);
      logger.info(MOD, 'BAC log saved to memory store');
    } catch (err) {
      logger.warn(MOD, `Could not save BAC log: ${err.message}`);
    }

    logger.info(MOD, `BAC complete. Allocation: ${JSON.stringify(allocation)}`);
    return { allocation, transcript, outcome };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Generate a single analyst's BAC report via LLM.
   * @private
   */
  async _generateAnalystReport(analyst, portfolioMetrics, allAssetData) {
    const profile = _agentProfile(analyst);
    const name    = profile.name || analyst.name;

    // Pick per-agent metrics, supporting { Dave: {...}, Bob: {...}, ... } or flat object
    const agentMetrics = portfolioMetrics?.agents?.[name]
      || portfolioMetrics?.[name]
      || portfolioMetrics
      || {};

    // Build a brief current outlook from asset data
    const assetData     = allAssetData?.[name] || {};
    const currentOutlook = _buildOutlookText(profile, assetData);

    const { system, user } = buildBACReportPrompt(profile, agentMetrics, currentOutlook);
    return this._llm.completeJSON(user, system, this._config?.llm?.maxTokens?.bacReport || 1500);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Module-level utilities
// ──────────────────────────────────────────────────────────────────────────────

/** Extract a usable profile object regardless of whether we got an agent instance or raw profile */
function _agentProfile(agent) {
  return agent?.profile || agent || {};
}

/** Extract agent name from agent or profile */
function _agentName(agent) {
  return agent?.name || agent?.profile?.name || 'Unknown';
}

/** Build a brief current-outlook paragraph from available OHLCV data */
function _buildOutlookText(profile, assetData) {
  const { closes = [], symbol, dates = [] } = assetData;
  if (!closes.length) return `No recent price data available for ${profile.assetLabel || profile.responsibleFor || 'this asset'}.`;
  const latest   = closes[closes.length - 1];
  const prev     = closes[closes.length - 2] || latest;
  const change1d = ((latest - prev) / prev * 100).toFixed(2);
  const latestDate = dates[dates.length - 1] || 'recent';
  return `${symbol || profile.assetLabel}: ${latest.toFixed(4)} as of ${latestDate} (${change1d > 0 ? '+' : ''}${change1d}% 1d).`;
}

/** Equal-weight fallback when optimizer fails */
function _fallbackOptimizerResult(analysts) {
  const w = 1 / (analysts.length || 3);
  return {
    metrics: { expectedTotalReturn: 0.05, portfolioStdDev: 0.15 },
    weights: analysts.map(() => w),
  };
}

/** Equal-weight fallback allocation when Otto's LLM call fails */
function _fallbackOttoDecision(analysts) {
  const w = parseFloat((1 / (analysts.length || 3)).toFixed(4));
  const allocation = {};
  analysts.forEach(a => { allocation[_agentName(a)] = w; });
  return {
    overall_assessment: 'LLM unavailable — equal-weight fallback applied.',
    final_allocation: allocation,
    allocation_reasoning: 'Fallback: equal weights due to LLM failure.',
  };
}

/** Empty report used when analyst LLM call fails */
function _emptyReport(name) {
  return {
    performance_summary:    `${name} report unavailable.`,
    budget_request_pct:     0.333,
    projected_return_pct:   5,
    projected_risk_level:   'medium',
  };
}

/**
 * Normalise allocation weights so they sum to exactly 1.0 and are >= 0.
 * Any analysts missing from the map get an equal share of any remainder.
 */
function _normaliseAllocation(rawAlloc, analysts) {
  const allocation = {};
  let total = 0;

  analysts.forEach(a => {
    const name = _agentName(a);
    const val  = Math.max(0, rawAlloc[name] || 0);
    allocation[name] = val;
    total += val;
  });

  if (total === 0) {
    // All zeros — give equal weight
    const w = 1 / analysts.length;
    analysts.forEach(a => { allocation[_agentName(a)] = parseFloat(w.toFixed(4)); });
    return allocation;
  }

  // Normalise
  let normalised = {};
  analysts.forEach(a => {
    const name = _agentName(a);
    normalised[name] = parseFloat((allocation[name] / total).toFixed(4));
  });

  // Fix floating-point drift: add residual to first agent
  const sum = Object.values(normalised).reduce((s, v) => s + v, 0);
  const residual = parseFloat((1 - sum).toFixed(4));
  if (residual !== 0) {
    const first = _agentName(analysts[0]);
    normalised[first] = parseFloat((normalised[first] + residual).toFixed(4));
  }

  return normalised;
}

/** Compute how much Otto deviated from the optimizer suggestion */
function _computeOverride(optimizerWeights, finalAllocation) {
  if (!optimizerWeights) return {};
  const result = {};
  Object.keys(finalAllocation).forEach(name => {
    const opt   = optimizerWeights[name] || 0;
    const final = finalAllocation[name]  || 0;
    result[name] = parseFloat((final - opt).toFixed(4));
  });
  return result;
}

module.exports = { BudgetAllocationConference };
