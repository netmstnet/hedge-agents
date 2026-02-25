'use strict';

/**
 * emc.cjs — Extreme Market Conference (EMC)
 *
 * Triggered when a single asset moves >5% in one day OR >10% cumulatively
 * over 3 days (thresholds from config/schedule.json).
 *
 * Purpose: Rapid-response crisis management for the affected analyst.
 * Peers give cross-domain suggestions; Otto synthesises; the crisis agent
 * makes a final considered decision.
 *
 * Flow (Section 3.4.3 of paper):
 *   1. Crisis agent presents their situation
 *   2. Each peer gives a suggestion (2 LLM calls, parallel)
 *   3. Otto synthesises all suggestions into balanced guidance (1 LLM call)
 *   4. Crisis agent makes final decision incorporating all input (1 LLM call)
 *   5. Final decision stored in crisis agent's M_IR memory
 *   6. Returns { crisisAgent, finalDecision, transcript }
 */

const logger = require('../utils/logger.cjs');
const {
  buildEMCCrisisPrompt,
  buildEMCPeerSuggestionPrompt,
  buildEMCSynthesisPrompt,
  buildEMCFinalDecisionPrompt,
} = require('../llm/prompt-builder.cjs');

const MOD = 'conference:emc';

// Default asset → agent name mapping (mirrors agents.json)
// Can be overridden by passing schedule.assetAgentMap
const DEFAULT_ASSET_AGENT_MAP = {
  'BTC-USD':  'Dave',
  '^DJI':     'Bob',
  'EURUSD=X': 'Emily',
};

class ExtremeMarketConference {
  /**
   * @param {import('../llm/claude-client.cjs').ClaudeClient} llm
   * @param {import('../memory/memory-store.cjs').MemoryStore}  memoryStore
   * @param {object} config — full app config
   */
  constructor(llm, memoryStore, config) {
    this._llm    = llm;
    this._memory = memoryStore;
    this._config = config;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Static: check whether EMC should be triggered
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Check whether current price movements warrant an EMC.
   *
   * @param {{ [asset: string]: { day1: number, day3cumulative: number } }} priceChanges
   *   e.g. { 'BTC-USD': { day1: -0.06, day3cumulative: -0.11 } }
   * @param {object} schedule
   *   Typically config.schedule.  Reads:
   *     schedule.emc.dailyAmplitudeThresholdPct   (default 5)
   *     schedule.emc.threeDayCumulativeThresholdPct (default 10)
   *     schedule.assetAgentMap (optional override of DEFAULT_ASSET_AGENT_MAP)
   * @returns {{ triggered: boolean, crisisAgentName: string, asset: string, reason: string }|{ triggered: false }}
   */
  static checkTrigger(priceChanges, schedule) {
    // Read thresholds from schedule config (already as percentage values)
    const dailyThreshold  = (schedule?.emc?.dailyAmplitudeThresholdPct    ?? 5)  / 100;
    const cumulThreshold  = (schedule?.emc?.threeDayCumulativeThresholdPct ?? 10) / 100;
    const assetAgentMap   = schedule?.assetAgentMap || DEFAULT_ASSET_AGENT_MAP;

    if (!priceChanges || typeof priceChanges !== 'object') {
      return { triggered: false };
    }

    for (const [asset, changes] of Object.entries(priceChanges)) {
      const day1   = changes.day1            ?? 0;
      const day3   = changes.day3cumulative  ?? 0;
      const absDay1 = Math.abs(day1);
      const absDay3 = Math.abs(day3);

      // Check single-day threshold first (more urgent)
      if (absDay1 > dailyThreshold) {
        return {
          triggered:       true,
          crisisAgentName: assetAgentMap[asset] || asset,
          asset,
          reason: `${asset} moved ${_pct(day1)} in a single day (threshold: >${_pct(dailyThreshold)})`,
        };
      }

      // Check 3-day cumulative threshold
      if (absDay3 > cumulThreshold) {
        return {
          triggered:       true,
          crisisAgentName: assetAgentMap[asset] || asset,
          asset,
          reason: `${asset} moved ${_pct(day3)} cumulatively over 3 days (threshold: >${_pct(cumulThreshold)})`,
        };
      }
    }

    return { triggered: false };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public entry point
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run the Extreme Market Conference for the crisis agent.
   *
   * @param {{ manager: object, analysts: object[] }} agents
   * @param {string}  crisisAgentName — name of the agent in crisis (e.g. 'Dave')
   * @param {object}  portfolioState  — crisis agent's current portfolio snapshot
   * @param {object}  lossData        — { lossAmount, lossPct, daysUnderwater }
   * @param {object}  marketData      — current market conditions object
   * @returns {Promise<{ crisisAgent: string, finalDecision: object, transcript: object[] }>}
   */
  async run(agents, crisisAgentName, portfolioState, lossData, marketData) {
    logger.info(MOD, `EMC starting for crisis agent: ${crisisAgentName}`);
    const transcript = [];

    // Locate the crisis agent and peer agents
    const crisisAgent = agents.analysts.find(a => _agentName(a) === crisisAgentName);
    if (!crisisAgent) {
      throw new Error(`EMC: crisis agent "${crisisAgentName}" not found in analysts list`);
    }
    const peers = agents.analysts.filter(a => _agentName(a) !== crisisAgentName);

    // ── Step 1: Crisis agent presents their situation ─────────────────────────
    logger.info(MOD, 'Step 1: crisis agent presenting situation');

    const crisisProfile = _agentProfile(crisisAgent);
    let crisisPresentation = null;

    try {
      const { system, user } = buildEMCCrisisPrompt(
        crisisProfile,
        portfolioState,
        lossData,
        marketData
      );
      crisisPresentation = await this._llm.completeJSON(
        user,
        system,
        this._config?.llm?.maxTokens?.emc || 1500
      );
      logger.info(MOD,
        `  ${crisisAgentName} proposed: ${crisisPresentation?.proposed_action || '?'}`
      );
    } catch (err) {
      logger.error(MOD, `  Crisis presentation failed: ${err.message} — using placeholder`);
      crisisPresentation = {
        current_holdings:    'Data unavailable',
        loss_reasons:        ['LLM failure'],
        market_assessment:   'Unknown',
        proposed_action:     'Hold',
        proposed_quantity_pct: 0,
        rationale:           'LLM unavailable during crisis — conservative Hold applied.',
        risk_if_wrong:       'Unknown',
      };
    }

    transcript.push({
      speaker: crisisAgentName,
      role:    'emc_crisis_presentation',
      content: crisisPresentation,
    });

    // ── Step 2: Each peer gives a suggestion (parallel) ───────────────────────
    logger.info(MOD, `Step 2: collecting peer suggestions (${peers.length} parallel calls)`);

    const peerResults = await Promise.allSettled(
      peers.map(peer => this._generatePeerSuggestion(peer, crisisAgentName, crisisProfile, crisisPresentation))
    );

    const peerSuggestions = {}; // { peerName: suggestionJSON }

    peerResults.forEach((result, idx) => {
      const peer     = peers[idx];
      const peerName = _agentName(peer);

      if (result.status === 'fulfilled' && result.value) {
        peerSuggestions[peerName] = result.value;
        transcript.push({
          speaker: peerName,
          role:    'emc_peer_suggestion',
          content: result.value,
        });
        logger.info(MOD,
          `  ${peerName} suggests: ${result.value.suggested_action || '?'} (${result.value.stance || '?'})`
        );
      } else {
        const err = result.reason?.message || 'unknown error';
        logger.warn(MOD, `  ${peerName} suggestion failed: ${err}`);
        transcript.push({ speaker: peerName, role: 'emc_peer_suggestion', error: err });
      }
    });

    // ── Step 3: Otto synthesises all suggestions ──────────────────────────────
    logger.info(MOD, 'Step 3: Otto synthesising peer suggestions');

    const lambda3        = this._config?.optimization?.lambda3 || 0.5;
    const overallMetrics = portfolioState?.portfolioMetrics || {};
    const ottoProfile    = _agentProfile(agents.manager);
    let ottoSynthesis    = null;

    try {
      const { system, user } = buildEMCSynthesisPrompt(
        ottoProfile,
        crisisPresentation,
        peerSuggestions,
        overallMetrics,
        lambda3
      );
      ottoSynthesis = await this._llm.completeJSON(
        user,
        system,
        this._config?.llm?.maxTokens?.emcSynth || 1500
      );
      logger.info(MOD,
        `  Otto recommends: ${ottoSynthesis?.recommended_action || '?'}`
      );
    } catch (err) {
      logger.warn(MOD, `  Otto synthesis failed: ${err.message} — using neutral fallback`);
      ottoSynthesis = {
        situation_summary:          'Synthesis unavailable.',
        peer_feedback_evaluation:   'N/A',
        balanced_recommendation:    'Hold until data is available.',
        recommended_action:         'Hold',
        recommended_quantity_pct:   0,
        trigger_conditions:         { take_profit_pct: 0.05, stop_loss_pct: 0.05, review_in_days: 3 },
        rationale:                  'LLM unavailable — conservative Hold recommended.',
        portfolio_protection_measures: 'Review all positions.',
      };
    }

    transcript.push({
      speaker: 'Otto',
      role:    'emc_synthesis',
      content: ottoSynthesis,
    });

    // ── Step 4: Crisis agent makes final decision ────────────────────────────
    logger.info(MOD, 'Step 4: crisis agent making final decision');

    let finalDecision = null;

    try {
      const { system, user } = buildEMCFinalDecisionPrompt(
        crisisProfile,
        crisisPresentation,
        peerSuggestions,
        ottoSynthesis
      );
      finalDecision = await this._llm.completeJSON(
        user,
        system,
        this._config?.llm?.maxTokens?.emcFinal || 1500
      );
      logger.info(MOD,
        `  ${crisisAgentName} final decision: ${finalDecision?.final_action || '?'} (qty: ${
          finalDecision?.final_quantity_pct || 0
        })`
      );
    } catch (err) {
      logger.warn(MOD, `  Final decision LLM failed: ${err.message} — applying Hold`);
      finalDecision = {
        peers_considered:              'LLM unavailable.',
        otto_guidance_incorporated:    'LLM unavailable.',
        final_action:                  'Hold',
        final_quantity_pct:            0,
        trigger_conditions:            { take_profit_pct: 0.05, stop_loss_pct: 0.05, review_in_days: 3 },
        execution_plan:                'Hold all positions and review in 3 days.',
        rationale:                     'LLM unavailable — conservative Hold applied.',
        lessons_for_memory:            'EMC triggered due to extreme market movement.',
      };
    }

    transcript.push({
      speaker: crisisAgentName,
      role:    'emc_final_decision',
      content: finalDecision,
    });

    // ── Step 5: Store final decision in crisis agent's M_IR memory ─────────
    // This lets the agent reflect on the crisis event in future cycles.
    logger.info(MOD, `Step 5: saving EMC result to ${crisisAgentName}'s M_IR memory`);

    try {
      this._memory.insertMemory({
        agentName:   crisisAgentName,
        memoryType:  'M_IR',
        content: {
          eventType:         'EMC',
          crisisPresentation,
          peerSuggestions,
          ottoGuidance:      ottoSynthesis,
          finalDecision,
          marketData,
          lossData,
          timestamp:         new Date().toISOString(),
        },
        asset:           crisisProfile.asset || crisisProfile.responsibleFor || 'unknown',
        pnlOutcome:      lossData?.lossPct || null,
        experienceScore: 0.9, // crisis events are highly instructive
      });
      logger.info(MOD, `  M_IR entry saved for ${crisisAgentName}`);
    } catch (err) {
      logger.warn(MOD, `  Could not save M_IR for ${crisisAgentName}: ${err.message}`);
    }

    // ── Step 6: Save conference log ───────────────────────────────────────────
    const outcome = {
      crisisAgentName,
      finalAction:     finalDecision?.final_action,
      finalQuantityPct: finalDecision?.final_quantity_pct,
      timestamp:       new Date().toISOString(),
    };

    try {
      this._memory.saveConferenceLog('EMC', transcript, outcome);
      logger.info(MOD, 'EMC log saved to memory store');
    } catch (err) {
      logger.warn(MOD, `Could not save EMC log: ${err.message}`);
    }

    logger.info(MOD, `EMC complete. ${crisisAgentName} will: ${finalDecision?.final_action}`);

    return { crisisAgent: crisisAgentName, finalDecision, transcript };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Generate one peer's suggestion for the crisis agent.
   * @private
   */
  async _generatePeerSuggestion(peer, crisisAgentName, crisisProfile, crisisPresentation) {
    const peerProfile = _agentProfile(peer);
    const { system, user } = buildEMCPeerSuggestionPrompt(
      peerProfile,
      crisisAgentName,
      crisisProfile.assetLabel || crisisProfile.responsibleFor || crisisAgentName,
      crisisPresentation
    );
    return this._llm.completeJSON(
      user,
      system,
      this._config?.llm?.maxTokens?.emcPeer || 1000
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Module-level utilities
// ──────────────────────────────────────────────────────────────────────────────

function _agentProfile(agent) {
  return agent?.profile || agent || {};
}

function _agentName(agent) {
  return agent?.name || agent?.profile?.name || 'Unknown';
}

/** Format a decimal fraction as a signed percentage string, e.g. -0.06 → "-6.0%" */
function _pct(val) {
  const sign = val >= 0 ? '+' : '';
  return `${sign}${(val * 100).toFixed(1)}%`;
}

module.exports = { ExtremeMarketConference };
