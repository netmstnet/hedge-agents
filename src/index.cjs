'use strict';

/**
 * index.cjs — HedgeAgents main orchestrator.
 *
 * Runs the full multi-agent trading simulation:
 *   1. Load config + create all agents
 *   2. For each trading day:
 *      a. Fetch market data + news
 *      b. Check EMC trigger (Otto)
 *      c. Run analyst ticks in parallel (Dave, Bob, Emily)
 *      d. Process pending reflections
 *      e. Run Otto's monitoring tick
 *      f. Check if BAC/ESC due → run conference
 *      g. Record portfolio snapshot
 *   3. Print final PRUDEX metrics
 *
 * Usage:
 *   node src/index.cjs                        # paper trade (today only)
 *   node src/index.cjs --mock --days 30       # 30-day mock simulation
 *   node src/index.cjs --start 2024-01-01 --end 2024-01-31  # backtest
 */

const logger     = require('./utils/logger.cjs');
const config     = require('./config.cjs');
const { createClaudeClient }         = require('./llm/claude-client.cjs');
const { loadAllProfiles }            = require('./agents/profile-loader.cjs');
const { createEmbeddingProvider }    = require('./memory/embeddings.cjs');
const { MemoryStore }                = require('./memory/memory-store.cjs');
const { PortfolioTracker }           = require('./portfolio/tracker.cjs');
const { computePRUDEX, formatMetricsTable } = require('./portfolio/metrics.cjs');
const { AnalystAgent }               = require('./agents/analyst-agent.cjs');
const { ManagerAgent }               = require('./agents/manager-agent.cjs');
const { MarketDataProvider, buildMockOHLCV } = require('./data/market-data.cjs');
const { NewsProvider }               = require('./data/news-provider.cjs');
const { tradingDayRange, toDateStr } = require('./utils/date-utils.cjs');

const MOD = 'orchestrator';

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mock: false, days: 30, start: null, end: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mock')  opts.mock  = true;
    if (args[i] === '--days')  opts.days  = parseInt(args[++i]);
    if (args[i] === '--start') opts.start = args[++i];
    if (args[i] === '--end')   opts.end   = args[++i];
  }
  return opts;
}

// ─── System initialisation ───────────────────────────────────────────────────

async function initSystem() {
  logger.info(MOD, '=== HedgeAgents Starting ===');
  logger.info(MOD, `Model: ${config.llm.model}`);

  if (!config.llm.apiKey) {
    logger.error(MOD, 'ANTHROPIC_API_KEY not set. Exiting.');
    process.exit(1);
  }

  // Core services
  const llm        = createClaudeClient(config);
  const memStore   = new MemoryStore(config.db.path, { retentionDays: config.schedule?.memoryRetentionDays });
  const embeddings = createEmbeddingProvider(config);
  const profiles   = loadAllProfiles(config.agents);

  // Portfolio tracker
  const tracker = new PortfolioTracker({
    startingCapital: config.portfolio.startingCapital,
    initialWeights:  config.portfolio.initialBudgetWeights,
    analysts:        config.agents.analysts,
  });

  // Create analyst agents
  const analysts = profiles.analysts.map((profile, i) => {
    const analystCfg = config.agents.analysts[i];
    return new AnalystAgent({
      profile: { ...profile, asset: analystCfg.asset, assetLabel: analystCfg.assetLabel },
      llm, memoryStore: memStore, embeddingProvider: embeddings,
      portfolioTracker: tracker, config, analystConfig: analystCfg,
    });
  });

  // Create manager agent (Otto)
  const manager = new ManagerAgent({
    profile: profiles.manager,
    llm, memoryStore: memStore, embeddingProvider: embeddings,
    portfolioTracker: tracker, config,
  });

  // Data providers
  const marketData = new MarketDataProvider({
    cacheTtlHours: config.data.marketData?.cacheTtlHours || 24,
    cacheDir: require('path').join(config.root, 'data', 'cache'),
  });
  const newsProvider = new NewsProvider(config);

  logger.info(MOD, `Agents ready: ${analysts.map(a => a.name).join(', ')} + ${manager.name}`);
  return { llm, memStore, embeddings, tracker, analysts, manager, marketData, newsProvider };
}

// ─── Main simulation loop ────────────────────────────────────────────────────

async function runSimulation(opts = {}) {
  const { llm, memStore, tracker, analysts, manager, marketData, newsProvider } = await initSystem();

  // Lazy-load conferences (they depend on agents being initialised)
  const { BudgetAllocationConference } = require('./conferences/bac.cjs');
  const { ExperienceSharingConference } = require('./conferences/esc.cjs');
  const { ExtremeMarketConference } = require('./conferences/emc.cjs');

  const bac = new BudgetAllocationConference(llm, memStore, config);
  const esc = new ExperienceSharingConference(llm, memStore, config);
  const emc = new ExtremeMarketConference(llm, memStore, config);

  // Determine trading days
  let tradingDays;
  if (opts.start && opts.end) {
    const s = new Date(opts.start + 'T12:00:00Z');
    const e = new Date(opts.end   + 'T12:00:00Z');
    tradingDays = tradingDayRange(s, e);
  } else {
    const end   = new Date();
    const start = new Date();
    start.setDate(start.getDate() - (opts.days || 1));
    tradingDays = tradingDayRange(start, end);
  }

  logger.info(MOD, `Running ${tradingDays.length} trading days (${toDateStr(tradingDays[0])} → ${toDateStr(tradingDays[tradingDays.length - 1])})`);

  // BAC/ESC scheduling counters
  const bacInterval = config.schedule?.bac?.intervalDays || 30;
  const escInterval = config.schedule?.esc?.intervalDays || 30;
  let daysSinceBAC  = 0;
  let daysSinceESC  = 0;

  // Pre-fetch all OHLCV data (cache it)
  const allOHLCV = {};
  for (const analystAgent of analysts) {
    const symbol = analystAgent.profile.asset;
    if (opts.mock) {
      allOHLCV[analystAgent.name] = buildMockOHLCV(symbol, tradingDays.length + 30, symbol === 'BTC-USD' ? 45000 : symbol === '^DJI' ? 38000 : 1.09);
    } else {
      const start = new Date(tradingDays[0]);
      start.setDate(start.getDate() - 60); // 60 days of history for indicators
      allOHLCV[analystAgent.name] = await marketData.getOHLCV(symbol, start, tradingDays[tradingDays.length - 1]);
    }
  }

  // ── Day loop ───────────────────────────────────────────────────────────────
  for (let dayIdx = 0; dayIdx < tradingDays.length; dayIdx++) {
    const date    = toDateStr(tradingDays[dayIdx]);
    const dayNum  = dayIdx + 1;

    logger.info(MOD, `\n${'═'.repeat(60)}`);
    logger.info(MOD, `Day ${dayNum}/${tradingDays.length}: ${date}`);

    // Slice OHLCV to include only data up to this trading day (no lookahead)
    const ohlcvForDay = {};
    const currentPrices = {};

    for (const agent of analysts) {
      const full = allOHLCV[agent.name];
      // Find index of this date in the data
      const dateIdx = full.dates ? full.dates.indexOf(date) : dayIdx + 30;
      const sliceEnd = dateIdx >= 0 ? dateIdx + 1 : Math.min(dayIdx + 30 + 1, full.closes.length);

      ohlcvForDay[agent.name] = {
        opens:   full.opens.slice(0, sliceEnd),
        highs:   full.highs.slice(0, sliceEnd),
        lows:    full.lows.slice(0, sliceEnd),
        closes:  full.closes.slice(0, sliceEnd),
        volumes: full.volumes.slice(0, sliceEnd),
        dates:   full.dates?.slice(0, sliceEnd) || [],
        symbol:  full.symbol,
      };
      const closes = ohlcvForDay[agent.name].closes;
      currentPrices[agent.name] = closes[closes.length - 1];
    }

    // Fetch news
    const newsForDay = {};
    for (const agent of analysts) {
      try {
        newsForDay[agent.name] = await newsProvider.getHeadlines(agent.profile.asset, 10);
      } catch (e) {
        newsForDay[agent.name] = [];
      }
    }

    // Check EMC trigger
    const emcCheck = manager.checkEMCTrigger(ohlcvForDay, config.schedule);
    if (emcCheck.triggered) {
      logger.warn(MOD, `🚨 EMC TRIGGERED: ${emcCheck.crisisAgentName} — ${emcCheck.reason}`);
      const crisisAgent = analysts.find(a => a.name === emcCheck.crisisAgentName);
      const peers       = analysts.filter(a => a.name !== emcCheck.crisisAgentName);
      if (crisisAgent) {
        await emc.run({ crisisAgent, peers, manager, portfolioState: tracker.getSnapshot(), emcCheck, config });
      }
    }

    // Run analyst ticks in parallel
    const tickResults = await Promise.allSettled(
      analysts.map(agent => agent.tick({
        date,
        ohlcv:       ohlcvForDay[agent.name],
        news:        newsForDay[agent.name] || [],
        allAssetData: ohlcvForDay,
        prices:      currentPrices,
      }))
    );

    // Log decisions
    tickResults.forEach((r, i) => {
      const agent = analysts[i];
      if (r.status === 'fulfilled') {
        logger.info(MOD, `[${agent.name}] → ${r.value.decision.action} | conf=${r.value.decision.confidence || 'N/A'}`);
      } else {
        logger.error(MOD, `[${agent.name}] Tick failed: ${r.reason?.message}`);
      }
    });

    // Process pending reflections (from previous day)
    if (dayIdx > 0) {
      await Promise.allSettled(
        analysts.map(agent => agent.processPendingReflections({
          date, ohlcv: ohlcvForDay[agent.name],
        }))
      );
    }

    // Otto monitoring tick
    await manager.tick({ date, ohlcv: ohlcvForDay[analysts[0]?.name], prices: currentPrices });

    // Update portfolio prices + record daily snapshot
    tracker.updatePrices(currentPrices);
    const { totalValue, dailyReturn } = tracker.recordDailySnapshot(date);
    memStore.savePortfolioState(tracker.getSnapshot());

    logger.info(MOD, `Portfolio: $${totalValue.toFixed(2)} (${dailyReturn >= 0 ? '+' : ''}${(dailyReturn * 100).toFixed(2)}%)`);

    // BAC / ESC scheduling
    daysSinceBAC++;
    daysSinceESC++;

    if (daysSinceBAC >= bacInterval) {
      logger.info(MOD, `\n💼 Running Budget Allocation Conference (Day ${dayNum})`);
      const bacResult = await bac.run({ manager, analysts, portfolioMetrics: tracker.getSnapshot(), allAssetData: ohlcvForDay, config });
      if (bacResult.allocation) {
        tracker.updateBudgetWeights(bacResult.allocation);
      }
      daysSinceBAC = 0;
    }

    if (daysSinceESC >= escInterval) {
      logger.info(MOD, `\n🔄 Running Experience Sharing Conference (Day ${dayNum})`);
      await esc.run({ analysts, manager });
      daysSinceESC = 0;
    }
  }

  // ── Final report ──────────────────────────────────────────────────────────
  logger.info(MOD, '\n' + '═'.repeat(60));
  logger.info(MOD, 'SIMULATION COMPLETE — PRUDEX METRICS');
  logger.info(MOD, '═'.repeat(60));

  const metrics = computePRUDEX(
    tracker.getDailyReturns(),
    tracker.getEquityCurve(),
    tracker.getSnapshot().budgetWeights,
    { riskFreeRate: config.portfolio.riskFreeRate || 0.02 }
  );
  logger.info(MOD, '\n' + formatMetricsTable(metrics));
  logger.info(MOD, '\n' + metrics.summary);

  return { metrics, portfolio: tracker.getSnapshot() };
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const opts = parseArgs();
  runSimulation(opts).then(({ metrics }) => {
    logger.info(MOD, `Done. TR=${metrics.TR}% | SR=${metrics.SR} | MDD=${metrics.MDD}%`);
    process.exit(0);
  }).catch(err => {
    logger.error(MOD, `Fatal error: ${err.message}`, err.stack);
    process.exit(1);
  });
}

module.exports = { runSimulation, initSystem };
