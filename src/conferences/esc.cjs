'use strict';

/**
 * esc.cjs — Experience Sharing Conference (ESC)
 *
 * Runs at the end of every 30-day trading cycle (after BAC).
 * Purpose: Analysts share their most instructive trade from the cycle.
 * Peers cross-review each other's cases, then each analyst distils the
 * collective wisdom into personal General Experience principles (M_GE).
 *
 * Flow (Section 3.4.2 of paper):
 *   1. Each analyst presents their best/most instructive trade case
 *      (uses M_IR memory context to ground the presentation)
 *   2. Each peer responds to each case → 2 responses per case = 6 LLM calls
 *   3. Each analyst distils all cases + responses into personal principles
 *      → 3 LLM calls (one per analyst)
 *   4. New principles stored in M_GE memory for each analyst
 *   5. Returns { cases, responses, principles, transcript }
 */

const logger = require('../utils/logger.cjs');
const {
  buildESCCasePrompt,
  buildESCPeerResponsePrompt,
  buildESCDistillationPrompt,
} = require('../llm/prompt-builder.cjs');

const MOD = 'conference:esc';

class ExperienceSharingConference {
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
  // Public entry point
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Run the Experience Sharing Conference.
   *
   * @param {{ manager: object, analysts: object[] }} agents
   * @returns {Promise<{
   *   cases:      object[],
   *   responses:  object[],
   *   principles: object,
   *   transcript: object[]
   * }>}
   */
  async run(agents) {
    logger.info(MOD, 'ESC starting…');
    const transcript = [];

    // ── Step 1: Each analyst presents their best trade case ──────────────────
    // We first retrieve each analyst's recent M_IR (Investment Reflection)
    // memories to provide grounding context — the analyst "looks back" at
    // their own investment history when choosing which case to present.
    logger.info(MOD, 'Step 1: analysts presenting their best trade cases (parallel)');

    const caseResults = await Promise.allSettled(
      agents.analysts.map(analyst => this._generateCase(analyst))
    );

    // Collect settled cases; keep nulls for failures so peer indices remain stable
    const cases = [];
    caseResults.forEach((result, idx) => {
      const analyst = agents.analysts[idx];
      const name    = _agentName(analyst);

      if (result.status === 'fulfilled' && result.value) {
        const caseEntry = {
          presenterName: name,
          asset:         result.value.asset || _agentProfile(analyst).assetLabel || 'N/A',
          caseData:      result.value,
        };
        cases.push(caseEntry);
        transcript.push({ speaker: name, role: 'esc_case', content: result.value });
        logger.info(MOD, `  ${name} case: ${result.value.action || '?'} — outcome: ${result.value.outcome || '?'}`);
      } else {
        const err = result.reason?.message || 'unknown error';
        logger.warn(MOD, `  ${name} case failed: ${err} — skipping`);
        cases.push({
          presenterName: name,
          asset:         _agentProfile(analyst).assetLabel || 'N/A',
          caseData:      null,
          error:         err,
        });
        transcript.push({ speaker: name, role: 'esc_case', error: err });
      }
    });

    // ── Step 2: Each peer responds to each case ───────────────────────────────
    // For 3 analysts (A, B, C) presenting cases, each case gets 2 peer
    // responses (from the other 2 analysts).  Total = 6 LLM calls.
    // We build all peer-response tasks, then settle them in parallel.
    logger.info(MOD, 'Step 2: peer responses (6 parallel LLM calls)');

    const responseResults = await Promise.allSettled(
      this._buildPeerResponseTasks(agents.analysts, cases)
    );

    const responses = [];
    responseResults.forEach(result => {
      if (result.status === 'fulfilled' && result.value) {
        responses.push(result.value);
        transcript.push({
          speaker: result.value.responderName,
          role:    'esc_peer_response',
          replyTo: result.value.presenterName,
          content: result.value.response,
        });
        logger.info(MOD,
          `  ${result.value.responderName} → ${result.value.presenterName}: "${
            result.value.response?.summary_lesson || '(no summary)'
          }"`
        );
      } else {
        const err = result.reason?.message || 'unknown error';
        logger.warn(MOD, `  Peer response failed: ${err}`);
        transcript.push({ role: 'esc_peer_response', error: err });
      }
    });

    // ── Step 3: Distil all insights into General Experience principles ────────
    // Each analyst individually synthesises the entire conference discussion
    // into personal investment principles.  3 separate LLM calls.
    logger.info(MOD, 'Step 3: distilling principles for each analyst (3 parallel LLM calls)');

    // Filter valid cases for the distillation context
    const validCases = cases.filter(c => c.caseData !== null);

    const distillResults = await Promise.allSettled(
      agents.analysts.map(analyst => this._distilPrinciples(analyst, validCases, responses))
    );

    const principles = {}; // { agentName: distillationJSON }

    distillResults.forEach((result, idx) => {
      const analyst = agents.analysts[idx];
      const name    = _agentName(analyst);

      if (result.status === 'fulfilled' && result.value) {
        principles[name] = result.value;
        transcript.push({ speaker: name, role: 'esc_distillation', content: result.value });
        logger.info(MOD,
          `  ${name} distilled ${result.value.principles?.length || 0} principles`
        );
      } else {
        const err = result.reason?.message || 'unknown error';
        logger.warn(MOD, `  ${name} distillation failed: ${err}`);
        principles[name] = null;
        transcript.push({ speaker: name, role: 'esc_distillation', error: err });
      }
    });

    // ── Step 4: Store new principles into M_GE memory ────────────────────────
    // Each analyst's distilled principles are stored as General Experience (M_GE).
    // This is what will be retrieved in future decision-making sessions.
    logger.info(MOD, 'Step 4: saving M_GE principles to memory store');
    await this._savePrinciples(agents.analysts, principles);

    // ── Step 5: Save conference log ───────────────────────────────────────────
    const outcome = {
      totalCases:      validCases.length,
      totalResponses:  responses.length,
      agentsWithPrinciples: Object.keys(principles).filter(k => principles[k] !== null).length,
      timestamp:       new Date().toISOString(),
    };

    try {
      this._memory.saveConferenceLog('ESC', transcript, outcome);
      logger.info(MOD, 'ESC log saved to memory store');
    } catch (err) {
      logger.warn(MOD, `Could not save ESC log: ${err.message}`);
    }

    logger.info(MOD, `ESC complete. ${validCases.length} cases, ${responses.length} responses, ${
      Object.values(principles).filter(Boolean).length
    } distillations.`);

    return { cases, responses, principles, transcript };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Retrieve M_IR memories for an analyst, then prompt them to present
   * their most instructive recent trade case.
   * @private
   */
  async _generateCase(analyst) {
    const profile = _agentProfile(analyst);
    const name    = profile.name || analyst.name;

    // Retrieve recent Investment Reflection memories (M_IR) to give the
    // LLM grounding — it should pick the best case it has actually made.
    let memoryContext = '';
    try {
      const irMemories = this._memory.getMemories(name, 'M_IR', 10);
      if (irMemories.length > 0) {
        const formatted = irMemories
          .slice(0, 5) // top-5 most recent reflections
          .map((m, i) => {
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
            return `[Reflection ${i + 1}] ${content}`;
          })
          .join('\n\n');
        memoryContext = `\n\n## Your Recent Investment Reflections (M_IR)\n${formatted}`;
      }
    } catch (err) {
      logger.warn(MOD, `Could not retrieve M_IR for ${name}: ${err.message}`);
    }

    // Build the ESC case prompt and augment it with M_IR context
    const { system, user } = buildESCCasePrompt(profile);
    const augmentedUser = memoryContext
      ? `${user}${memoryContext}\n\nUse your reflection memories above to select and describe your best case.`
      : user;

    return this._llm.completeJSON(augmentedUser, system, this._config?.llm?.maxTokens?.esc || 1500);
  }

  /**
   * Build the full set of peer-response tasks.
   * For each presented case, every OTHER analyst responds (2 per case = 6 total).
   * Returns an array of Promises.
   * @private
   */
  _buildPeerResponseTasks(analysts, cases) {
    const tasks = [];

    cases.forEach(presentedCase => {
      if (!presentedCase.caseData) return; // skip failed cases

      analysts.forEach(responder => {
        const responderName = _agentName(responder);

        // An analyst does not review their own case
        if (responderName === presentedCase.presenterName) return;

        tasks.push(
          this._generatePeerResponse(responder, presentedCase)
        );
      });
    });

    return tasks;
  }

  /**
   * Generate one analyst's peer response to another's case.
   * @private
   */
  async _generatePeerResponse(responder, presentedCase) {
    const responderProfile = _agentProfile(responder);
    const { system, user } = buildESCPeerResponsePrompt(
      responderProfile,
      presentedCase.presenterName,
      presentedCase.asset,
      presentedCase.caseData
    );

    const response = await this._llm.completeJSON(
      user,
      system,
      this._config?.llm?.maxTokens?.escPeer || 1000
    );

    return {
      responderName:  _agentName(responder),
      presenterName:  presentedCase.presenterName,
      presenterAsset: presentedCase.asset,
      response,
    };
  }

  /**
   * Generate one analyst's distillation of all cases + responses into
   * personal investment principles.
   * @private
   */
  async _distilPrinciples(analyst, allCases, allResponses) {
    const name = _agentName(analyst);
    const { system, user } = buildESCDistillationPrompt(name, allCases, allResponses);
    return this._llm.completeJSON(
      user,
      system,
      this._config?.llm?.maxTokens?.escDistil || 2000
    );
  }

  /**
   * Persist each analyst's distilled principles into M_GE (General Experience) memory.
   * @private
   */
  async _savePrinciples(analysts, principles) {
    for (const analyst of analysts) {
      const name  = _agentName(analyst);
      const distil = principles[name];
      if (!distil) continue;

      try {
        // Store the entire distillation as one M_GE entry
        this._memory.insertMemory({
          agentName:   name,
          memoryType:  'M_GE',
          content:     distil,
          asset:       'general',
          experienceScore: _averageScore(distil.principles),
        });
        logger.info(MOD, `  Stored M_GE for ${name} (${distil.principles?.length || 0} principles)`);
      } catch (err) {
        logger.warn(MOD, `  Could not store M_GE for ${name}: ${err.message}`);
      }
    }
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

/** Compute average experience score from a principles array (heuristic for memory ranking) */
function _averageScore(principles) {
  if (!Array.isArray(principles) || !principles.length) return 0.7;
  return 0.7 + (principles.length / 5) * 0.3; // more principles → higher score (capped at 1.0)
}

module.exports = { ExperienceSharingConference };
