'use strict';

/**
 * analyst-agent.cjs — Specialist analyst (Dave, Bob, Emily).
 * Extends BaseAgent with BAC reporting and ESC case generation.
 */

const { BaseAgent } = require('./base-agent.cjs');
const { buildBACReportPrompt, buildESCCasePrompt } = require('../llm/prompt-builder.cjs');
const logger = require('../utils/logger.cjs');

const MOD = 'agent:analyst';

class AnalystAgent extends BaseAgent {
  constructor(opts) {
    super(opts);
    this._analystConfig = opts.analystConfig || {}; // asset, assetLabel from agents.json
  }

  /**
   * Generate Budget Allocation Conference report for Otto.
   * Called during BAC (every 30 trading days).
   */
  async generateBACReport(currentOutlook) {
    logger.info(MOD, `[${this.name}] Generating BAC report`);
    const metrics = this.getPerformanceMetrics();
    const prompt  = buildBACReportPrompt(this.profile, {
      tr:   metrics.tr,
      sr:   metrics.sr,
      mdd:  metrics.mdd,
      vol:  metrics.vol,
      cr:   metrics.cr,
      sor:  metrics.sor,
      period: 'last 30 days',
    }, currentOutlook || `Current ${this.profile.assetLabel || this.profile.asset} market conditions.`);

    try {
      const report = await this.llm.completeJSON(
        prompt.user, prompt.system,
        this.config?.llm?.maxTokens?.bacReport || 1200
      );
      return { agentName: this.name, ...report };
    } catch (e) {
      logger.error(MOD, `[${this.name}] BAC report failed: ${e.message}`);
      return {
        agentName: this.name,
        performance_summary: `${this.name} encountered an error generating report.`,
        budget_request_pct: 0.33,
        projected_return_pct: 5,
        projected_risk_level: 'medium',
      };
    }
  }

  /**
   * Generate Experience Sharing Conference case presentation.
   * Retrieves the best case from M_IR memories.
   */
  async generateESCCase() {
    logger.info(MOD, `[${this.name}] Generating ESC case`);

    // Find the most instructive M_IR memory (highest experience_score)
    const irMemories = this.memory.getMemories(this.name, 'M_IR', 50);
    const bestMemory = irMemories
      .filter(m => m.pnl_outcome !== null)
      .sort((a, b) => (b.experience_score || 0) - (a.experience_score || 0))[0];

    const prompt = buildESCCasePrompt(this.profile);
    const systemWithContext = bestMemory
      ? `${this.profile.description}\n\nHere is a recent trade from your memory to draw from:\n${JSON.stringify(bestMemory.content)}`
      : this.profile.description;

    try {
      const caseData = await this.llm.completeJSON(
        prompt.user, systemWithContext,
        this.config?.llm?.maxTokens?.escCase || 800
      );
      return { presenterName: this.name, asset: this.profile.assetLabel || this.profile.asset, caseData };
    } catch (e) {
      logger.error(MOD, `[${this.name}] ESC case failed: ${e.message}`);
      return {
        presenterName: this.name,
        asset: this.profile.assetLabel || this.profile.asset,
        caseData: { lesson: 'No case available', outcome: 'mixed', pnl_pct: 0 },
      };
    }
  }
}

module.exports = { AnalystAgent };
