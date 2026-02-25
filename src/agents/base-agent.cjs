'use strict';

/**
 * base-agent.cjs — Core agent loop implementing the paper's Section 3.3 workflow.
 *
 * Single Agent Workflow (from paper Figure 7):
 *   1. Market data + news arrive
 *   2. Run tools → toolResults
 *   3. Summarize current situation into Qt (LLM call)
 *   4. Retrieve top-K memories using Qt (cosine similarity)
 *   5. Build decision prompt: profile + tools + memories
 *   6. LLM decides: action, qty_pct, rationale
 *   7. Execute action on portfolio
 *   8. Store Qt + market snapshot in M_MI
 *   9. Store pending reflection (resolved next tick)
 *
 * Reflection (called on next tick for previous decision):
 *   10. Build reflection prompt: previous decision + outcome
 *   11. LLM reflects: what worked, what failed, lesson
 *   12. Store reflection in M_IR
 */

const logger = require('../utils/logger.cjs');
const { runAgentTools } = require('../tools/registry.cjs');
const { retrieveTopK, indexMemories } = require('../memory/embeddings.cjs');
const {
  buildSummarizedQueryPrompt,
  buildDecisionPrompt,
  buildReflectionPrompt,
} = require('../llm/prompt-builder.cjs');

const MOD = 'agent:base';

class BaseAgent {
  /**
   * @param {object} opts
   * @param {object}  opts.profile       - Loaded profile (from profile-loader)
   * @param {object}  opts.llm           - ClaudeClient instance
   * @param {object}  opts.memoryStore   - MemoryStore instance
   * @param {object}  opts.embeddingProvider - TfidfEmbeddingProvider or VoyageEmbeddingProvider
   * @param {object}  opts.portfolioTracker  - PortfolioTracker instance
   * @param {object}  opts.config        - Full app config
   */
  constructor(opts) {
    this.profile      = opts.profile;
    this.name         = opts.profile.name;
    this.llm          = opts.llm;
    this.memory       = opts.memoryStore;
    this.embeddings   = opts.embeddingProvider;
    this.portfolio    = opts.portfolioTracker;
    this.config       = opts.config;
    this._K           = opts.config?.llm?.memory?.retrievalK || 5;
    this._maxTokens   = opts.config?.llm?.maxTokens || {};

    logger.info(MOD, `Initialised agent: ${this.name} (${this.profile.role})`);
  }

  // ─── Single agent tick ─────────────────────────────────────────────────────

  /**
   * Run one decision cycle for this agent.
   *
   * @param {object} ctx
   * @param {string}   ctx.date        - YYYY-MM-DD
   * @param {object}   ctx.ohlcv       - { opens, highs, lows, closes, volumes, dates }
   * @param {string[]} ctx.news        - Array of headline strings
   * @param {object}   [ctx.allAssetData] - All assets' OHLCV (for Otto's correlation tools)
   * @param {object}   [ctx.prices]    - Current prices { agentName: price }
   * @returns {Promise<object>} { decision, memoryId, portfolioResult }
   */
  async tick(ctx) {
    const { date, ohlcv, news } = ctx;
    logger.info(MOD, `[${this.name}] Tick: ${date}`);

    // Step 1: Update current price in portfolio
    if (ohlcv.closes.length && this.portfolio) {
      const price  = ohlcv.closes[ohlcv.closes.length - 1];
      const priceMap = {};
      priceMap[this.name] = price;
      this.portfolio.updatePrices(priceMap);
    }

    // Step 2: Run tools permitted by this agent's profile
    const toolCtx = {
      ohlcv,
      news,
      symbol:         this.profile.asset,
      portfolioState: this.portfolio?.getSnapshot(),
      allAssetData:   ctx.allAssetData,
      prices:         ctx.prices,
      config:         this.config?.portfolio,
    };
    const toolResults = await runAgentTools(this.profile.tools, toolCtx);

    // Step 3: Build summarized query Qt
    const queryPrompt = buildSummarizedQueryPrompt(this.profile, {
      date, prices: { current: ohlcv.closes[ohlcv.closes.length - 1] }, news, toolResults,
    });
    let qt = `${this.name} on ${date}: market analysis`;
    try {
      const { text } = await this.llm.complete(
        queryPrompt.user, queryPrompt.system,
        this._maxTokens.summarizedQuery || 500
      );
      qt = text.trim();
    } catch (e) {
      logger.warn(MOD, `[${this.name}] Qt generation failed: ${e.message} — using fallback`);
    }

    // Step 4: Retrieve top-K memories
    let memories = [];
    try {
      const allMemories = this.memory.getRetrievableMemories(this.name, 2000);
      // Index any unindexed memories first
      await indexMemories(this.embeddings, this.memory, allMemories);
      // Re-fetch with embeddings
      const indexed = this.memory.getRetrievableMemories(this.name, 2000);
      memories = await retrieveTopK(this.embeddings, qt, indexed, this._K);
    } catch (e) {
      logger.warn(MOD, `[${this.name}] Memory retrieval failed: ${e.message}`);
    }

    // Step 5: Build decision prompt
    const portfolioState = this.portfolio?.getSnapshot();
    const decisionPrompt = buildDecisionPrompt(this.profile, {
      date,
      prices: {
        current:       ohlcv.closes[ohlcv.closes.length - 1],
        open:          ohlcv.opens[ohlcv.opens.length - 1],
        high:          ohlcv.highs[ohlcv.highs.length - 1],
        low:           ohlcv.lows[ohlcv.lows.length - 1],
        previousClose: ohlcv.closes.length > 1 ? ohlcv.closes[ohlcv.closes.length - 2] : null,
      },
      news,
      toolResults,
      portfolioState,
    }, memories);

    // Step 6: LLM decision
    let decision = { action: 'Hold', quantity_pct: 0, rationale: 'No LLM response', confidence: 0 };
    try {
      decision = await this.llm.completeJSON(
        decisionPrompt.user,
        decisionPrompt.system,
        this._maxTokens.decision || 1500
      );
      logger.info(MOD, `[${this.name}] Decision: ${decision.action} qty=${decision.quantity_pct} conf=${decision.confidence}`);
    } catch (e) {
      logger.error(MOD, `[${this.name}] LLM decision failed: ${e.message} — defaulting to Hold`);
    }

    // Step 7: Execute action
    let portfolioResult = null;
    if (this.portfolio) {
      const currentPrice = ohlcv.closes[ohlcv.closes.length - 1];
      portfolioResult = this.portfolio.executeAction(this.name, decision, currentPrice, date);
    }

    // Step 8: Store M_MI (market information memory)
    const marketSnapshot = {
      date, qt,
      price:    ohlcv.closes[ohlcv.closes.length - 1],
      key_indicators: {
        rsi:  toolResults.technicalIndicators?.rsi,
        macd: toolResults.technicalIndicators?.macd?.histogram,
        trend: toolResults.trendAnalysis?.direction,
      },
      news_count: news.length,
      decision_action: decision.action,
    };
    const memId = this.memory.insertMemory({
      agentName:    this.name,
      memoryType:   'M_MI',
      content:      marketSnapshot,
      asset:        this.profile.asset,
    });

    // Index the new memory (async, don't block)
    this._indexMemoryAsync(memId, JSON.stringify(marketSnapshot));

    // Step 9: Store pending reflection (to be resolved next tick)
    this.memory.savePendingReflection(this.name, this.profile.asset || this.profile.assetLabel, {
      date,
      action:     decision.action,
      price:      ohlcv.closes[ohlcv.closes.length - 1],
      rationale:  decision.rationale,
      riskLevel:  decision.risk_level,
      confidence: decision.confidence,
      qty:        decision.quantity_pct,
    });

    return { decision, memoryId: memId, portfolioResult, toolResults, qt, memories: memories.length };
  }

  // ─── Reflection ────────────────────────────────────────────────────────────

  /**
   * Process any pending reflections from the previous tick.
   *
   * @param {object} ctx - { date, ohlcv } (current market data to measure outcome)
   */
  async processPendingReflections(ctx) {
    const pending = this.memory.getPendingReflections(this.name);
    if (!pending.length) return [];

    const currentPrice = ctx.ohlcv.closes[ctx.ohlcv.closes.length - 1];
    const results = [];

    for (const reflection of pending) {
      try {
        const prevDecision = reflection.decision;
        const pnlPct = prevDecision.price > 0
          ? (currentPrice - prevDecision.price) / prevDecision.price
          : 0;
        const adjustedPnl = prevDecision.action === 'Sell' ? -pnlPct : pnlPct;

        const reflectPrompt = buildReflectionPrompt(this.profile, prevDecision, {
          currentPrice,
          pnlPct:            adjustedPnl,
          portfolioChangePct: adjustedPnl * (prevDecision.qty || 0),
          daysHeld:          1,
          currentDate:       ctx.date,
        });

        const reflectionResult = await this.llm.completeJSON(
          reflectPrompt.user,
          reflectPrompt.system,
          this._maxTokens.reflection || 1000
        );

        // Store in M_IR
        const irId = this.memory.insertMemory({
          agentName:       this.name,
          memoryType:      'M_IR',
          content:         { ...prevDecision, reflection: reflectionResult, outcome_pnl: adjustedPnl },
          asset:           prevDecision.asset || this.profile.asset,
          pnlOutcome:      adjustedPnl,
          experienceScore: reflectionResult.experience_score || 0.5,
        });

        // Index reflection
        this._indexMemoryAsync(irId, JSON.stringify(reflectionResult));

        this.memory.markReflectionResolved(reflection.id);
        results.push({ id: reflection.id, lesson: reflectionResult.lesson });

        logger.debug(MOD, `[${this.name}] Reflection stored: ${reflectionResult.lesson?.slice(0, 80)}...`);
      } catch (e) {
        logger.warn(MOD, `[${this.name}] Reflection failed: ${e.message}`);
        this.memory.markReflectionResolved(reflection.id); // Don't retry
      }
    }
    return results;
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  async _indexMemoryAsync(memId, text) {
    try {
      if (this.embeddings.type === 'voyage') {
        const embedding = await this.embeddings.embed(text);
        this.memory.updateMemory(memId, { embedding });
      } else {
        const tokens = await this.embeddings.embed(text);
        this.memory.updateMemory(memId, { tfidfTokens: tokens });
      }
    } catch (e) {
      logger.debug(MOD, `Memory indexing deferred: ${e.message}`);
    }
  }

  /**
   * Get performance metrics for BAC report.
   */
  getPerformanceMetrics(startDate) {
    const returns    = this.portfolio?.getDailyReturns()  || [];
    const equity     = this.portfolio?.getEquityCurve()   || [];
    const riskFreeRate = this.config?.portfolio?.riskFreeRate || 0.02;
    const math = require('../utils/math.cjs');

    if (!returns.length) return { tr: 0, arr: 0, sr: 0, mdd: 0, vol: 0, cr: 0, sor: 0 };

    return {
      tr:  math.totalReturn(returns),
      arr: math.annualisedReturn(returns),
      sr:  math.sharpeRatio(returns, riskFreeRate),
      mdd: math.maxDrawdown(equity),
      vol: math.annualisedVol(returns),
      cr:  math.calmarRatio(returns, equity),
      sor: math.sortinoRatio(returns, riskFreeRate),
    };
  }
}

module.exports = { BaseAgent };
