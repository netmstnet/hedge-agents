'use strict';

/**
 * manager-agent.cjs — Hedge Fund Manager Otto.
 * Orchestrates conferences, monitors EMC triggers, runs portfolio optimization.
 */

const { BaseAgent } = require('./base-agent.cjs');
const logger = require('../utils/logger.cjs');

const MOD = 'agent:manager';

class ManagerAgent extends BaseAgent {
  constructor(opts) {
    super(opts);
    this._emcTriggerHistory = {}; // { agentName: [priceSeries] }
  }

  /**
   * Check if an Extreme Market Conference should be triggered.
   * Paper: daily amplitude >5% OR 3-day cumulative >10% for any asset.
   *
   * @param {object} ohlcvByAgent - { agentName: ohlcvData }
   * @param {object} schedule     - config.schedule
   * @returns {{ triggered, crisisAgentName, reason } | null}
   */
  checkEMCTrigger(ohlcvByAgent, schedule) {
    const dailyThresh  = (schedule?.emc?.dailyAmplitudeThresholdPct  || 5)  / 100;
    const threeDayThr  = (schedule?.emc?.threeDayCumulativeThresholdPct || 10) / 100;

    for (const [agentName, ohlcv] of Object.entries(ohlcvByAgent)) {
      const closes = ohlcv.closes || [];
      if (closes.length < 2) continue;

      // Daily amplitude
      const today    = closes[closes.length - 1];
      const yesterday = closes[closes.length - 2];
      const dailyMove = Math.abs((today - yesterday) / yesterday);

      if (dailyMove >= dailyThresh) {
        const direction = today < yesterday ? 'decline' : 'spike';
        logger.warn(MOD, `EMC trigger: ${agentName} daily ${direction} ${(dailyMove * 100).toFixed(1)}%`);
        return {
          triggered: true,
          crisisAgentName: agentName,
          reason: `Daily ${direction} of ${(dailyMove * 100).toFixed(1)}% (threshold: ${dailyThresh * 100}%)`,
          dailyChangePct: (today - yesterday) / yesterday,
        };
      }

      // 3-day cumulative
      if (closes.length >= 4) {
        const threeDayAgo  = closes[closes.length - 4];
        const cumulative3d = Math.abs((today - threeDayAgo) / threeDayAgo);
        if (cumulative3d >= threeDayThr) {
          const direction = today < threeDayAgo ? 'decline' : 'rally';
          logger.warn(MOD, `EMC trigger: ${agentName} 3-day ${direction} ${(cumulative3d * 100).toFixed(1)}%`);
          return {
            triggered: true,
            crisisAgentName: agentName,
            reason: `3-day cumulative ${direction} of ${(cumulative3d * 100).toFixed(1)}% (threshold: ${threeDayThr * 100}%)`,
            dailyChangePct: (today - yesterday) / yesterday,
          };
        }
      }
    }

    return { triggered: false };
  }

  /**
   * Otto's own tick — analyses all assets, monitors portfolio health.
   * Called after analyst ticks so Otto has full picture.
   */
  async tick(ctx) {
    // Otto runs a simplified tick: tool analysis + monitoring, no trade actions
    logger.info(MOD, `[${this.name}] Manager tick: ${ctx.date}`);
    const snapshot = this.portfolio?.getSnapshot();

    // Check stop-loss / take-profit conditions across all positions
    if (this.portfolio && ctx.prices) {
      const triggers = this.portfolio.checkTriggerConditions(ctx.prices);
      for (const trigger of triggers) {
        logger.warn(MOD, `[Otto] Trigger condition for ${trigger.agentName}: ${trigger.reason} (${(trigger.pnlPct * 100).toFixed(2)}%)`);
      }
    }

    return {
      decision:       { action: 'Monitor', rationale: 'Portfolio monitoring tick' },
      portfolioValue: snapshot?.totalValue,
    };
  }
}

module.exports = { ManagerAgent };
