'use strict';

/**
 * memory.test.cjs — Unit tests for MemoryStore and TF-IDF retrieval.
 *
 * Tests:
 *   - MemoryStore CRUD (insert, getMemories, getMemoryStats, purgeOldMemories)
 *   - TfidfEmbeddingProvider.embed() tokenisation
 *   - retrieveTopK: query relevance (bitcoin vs stocks)
 *
 * Uses a fresh temp SQLite DB per test suite: /tmp/test-memory-<timestamp>.db
 * Run with: node --test tests/unit/memory.test.cjs
 */

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const { MemoryStore } = require('../../src/memory/memory-store.cjs');
const { TfidfEmbeddingProvider, retrieveTopK, tokenize } = require('../../src/memory/embeddings.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tempDbPath() {
  return `/tmp/test-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function makeStore(dbPath) {
  return new MemoryStore(dbPath, {});
}

// ─── MemoryStore: basic CRUD ──────────────────────────────────────────────────

describe('MemoryStore – insertMemory / getMemories', () => {
  let store;
  let dbPath;

  before(() => {
    dbPath = tempDbPath();
    store  = makeStore(dbPath);
  });

  after(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('Insert 10 memories for TestAgent and getMemories returns all 10', () => {
    for (let i = 0; i < 10; i++) {
      store.insertMemory({
        agentName:  'TestAgent',
        memoryType: 'M_MI',
        content:    { tick: i, price: 100 + i, note: `Market snapshot ${i}` },
        asset:      'BTC-USD',
      });
    }

    const memories = store.getMemories('TestAgent', 'M_MI');
    assert.strictEqual(memories.length, 10, 'Should retrieve exactly 10 M_MI memories');
  });

  test('getMemories without type filter returns all memory types', () => {
    // Insert one M_IR and one M_GE for the same agent
    store.insertMemory({ agentName: 'TestAgent', memoryType: 'M_IR', content: 'Reflection 1' });
    store.insertMemory({ agentName: 'TestAgent', memoryType: 'M_GE', content: 'Experience 1' });

    const all = store.getMemories('TestAgent');
    assert.ok(all.length >= 12, `Should return ≥12 memories, got ${all.length}`);
  });

  test('getMemories filters by agent name', () => {
    store.insertMemory({ agentName: 'OtherAgent', memoryType: 'M_MI', content: 'Other data' });

    const testAgentMems = store.getMemories('TestAgent', 'M_MI');
    assert.ok(
      testAgentMems.every(m => m.agent_name === 'TestAgent'),
      'All returned memories should belong to TestAgent'
    );
  });

  test('Content is JSON-parsed correctly for object content', () => {
    const content = { price: 42000, volume: 1234, signal: 'BULLISH' };
    store.insertMemory({ agentName: 'TestAgent', memoryType: 'M_MI', content });
    const [latest] = store.getMemories('TestAgent', 'M_MI', 1);
    assert.deepStrictEqual(latest.content, content);
  });

  test('Content is returned as-is for string content', () => {
    store.insertMemory({ agentName: 'TestAgent', memoryType: 'M_IR', content: 'Plain string memory' });
    const [latest] = store.getMemories('TestAgent', 'M_IR', 1);
    assert.strictEqual(latest.content, 'Plain string memory');
  });
});

// ─── MemoryStore: stats ──────────────────────────────────────────────────────

describe('MemoryStore – getMemoryStats', () => {
  let store;
  let dbPath;

  before(() => {
    dbPath = tempDbPath();
    store  = makeStore(dbPath);
  });

  after(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('getMemoryStats returns correct counts per type', () => {
    store.insertMemory({ agentName: 'StatsAgent', memoryType: 'M_MI', content: 'MI 1' });
    store.insertMemory({ agentName: 'StatsAgent', memoryType: 'M_MI', content: 'MI 2' });
    store.insertMemory({ agentName: 'StatsAgent', memoryType: 'M_MI', content: 'MI 3' });
    store.insertMemory({ agentName: 'StatsAgent', memoryType: 'M_IR', content: 'IR 1' });
    store.insertMemory({ agentName: 'StatsAgent', memoryType: 'M_GE', content: 'GE 1' });
    store.insertMemory({ agentName: 'StatsAgent', memoryType: 'M_GE', content: 'GE 2' });

    const stats = store.getMemoryStats('StatsAgent');
    assert.strictEqual(stats.M_MI, 3, 'Should count 3 M_MI entries');
    assert.strictEqual(stats.M_IR, 1, 'Should count 1 M_IR entry');
    assert.strictEqual(stats.M_GE, 2, 'Should count 2 M_GE entries');
  });

  test('Stats for unknown agent returns empty object', () => {
    const stats = store.getMemoryStats('NonExistentAgent');
    assert.deepStrictEqual(stats, {});
  });
});

// ─── MemoryStore: purgeOldMemories ───────────────────────────────────────────

describe('MemoryStore – purgeOldMemories', () => {
  let store;
  let dbPath;

  before(() => {
    dbPath = tempDbPath();
    store  = makeStore(dbPath);
  });

  after(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('purgeOldMemories with 0-day retention deletes all M_MI', () => {
    const agentName = 'PurgeAgent';

    // Insert 5 M_MI memories
    for (let i = 0; i < 5; i++) {
      store.insertMemory({ agentName, memoryType: 'M_MI', content: `MI ${i}` });
    }
    // Insert 2 M_IR and 1 M_GE (should NOT be purged)
    store.insertMemory({ agentName, memoryType: 'M_IR', content: 'IR 1' });
    store.insertMemory({ agentName, memoryType: 'M_IR', content: 'IR 2' });
    store.insertMemory({ agentName, memoryType: 'M_GE', content: 'GE 1' });

    // Purge with 0 days retention (cutoff = now → all M_MI deleted since they're all old)
    store.purgeOldMemories(0);

    const miAfter = store.getMemories(agentName, 'M_MI');
    assert.strictEqual(miAfter.length, 0, 'All M_MI should be deleted after 0-day purge');

    // Non-MI memories should survive
    const irAfter = store.getMemories(agentName, 'M_IR');
    assert.strictEqual(irAfter.length, 2, 'M_IR memories should not be purged');
    const geAfter = store.getMemories(agentName, 'M_GE');
    assert.strictEqual(geAfter.length, 1, 'M_GE memories should not be purged');
  });
});

// ─── TfidfEmbeddingProvider ──────────────────────────────────────────────────

describe('TfidfEmbeddingProvider', () => {
  const provider = new TfidfEmbeddingProvider();

  test('embed("bitcoin price rising") returns a non-empty array of tokens', async () => {
    const tokens = await provider.embed('bitcoin price rising');
    assert.ok(Array.isArray(tokens), 'embed() should return an array');
    assert.ok(tokens.length > 0, 'embed() should return non-empty token array');
    // Should include meaningful tokens (stop words filtered out)
    assert.ok(tokens.includes('bitcoin'), `"bitcoin" should be in tokens: ${tokens}`);
    assert.ok(tokens.includes('price'),   `"price" should be in tokens: ${tokens}`);
    assert.ok(tokens.includes('rising'),  `"rising" should be in tokens: ${tokens}`);
  });

  test('tokenize() strips stop words', () => {
    const tokens = tokenize('the bitcoin and the price is rising high');
    assert.ok(!tokens.includes('the'),  '"the" should be filtered (stop word)');
    assert.ok(!tokens.includes('and'),  '"and" should be filtered (stop word)');
    assert.ok(!tokens.includes('is'),   '"is" should be filtered (stop word)');
    assert.ok(tokens.includes('bitcoin'));
    assert.ok(tokens.includes('price'));
    assert.ok(tokens.includes('rising'));
    assert.ok(tokens.includes('high'));
  });

  test('embed() is deterministic for same input', async () => {
    const a = await provider.embed('ethereum block reward halving');
    const b = await provider.embed('ethereum block reward halving');
    assert.deepStrictEqual(a, b, 'Same input should produce same tokens');
  });
});

// ─── retrieveTopK: bitcoin vs stocks relevance ───────────────────────────────

describe('retrieveTopK – TF-IDF retrieval', () => {
  let store;
  let dbPath;

  before(async () => {
    dbPath = tempDbPath();
    store  = makeStore(dbPath);
    const provider = new TfidfEmbeddingProvider();

    // Insert 5 bitcoin-focused memories
    const bitcoinTexts = [
      'Bitcoin price surges on ETF approval news driving crypto market rally',
      'BTC mining hashrate hits all-time high as institutional demand grows',
      'Bitcoin on-chain metrics show accumulation by long-term holders',
      'Crypto market led by bitcoin amid macroeconomic uncertainty and dollar weakness',
      'Bitcoin halving cycle approaching as block reward reduction expected next year',
    ];

    for (const text of bitcoinTexts) {
      const tokens = await provider.embed(text);
      store.insertMemory({
        agentName:   'RetAgent',
        memoryType:  'M_MI',
        content:     text,
        tfidfTokens: tokens,
      });
    }

    // Insert 15 stock-focused memories
    const stockTexts = [
      'Dow Jones industrial average rallies on strong earnings season',
      'S&P 500 hits new record high as technology stocks outperform',
      'Federal Reserve rate decision impacts equity market valuations',
      'Stock market volatility increases ahead of quarterly earnings reports',
      'Blue-chip companies report strong revenue growth and raise guidance',
      'Dividend yield stocks attract investors in uncertain economic environment',
      'Market breadth improves as small-cap stocks join the equity rally',
      'Equity markets digest inflation data and adjust portfolio allocations',
      'Sector rotation from growth to value stocks observed in equity markets',
      'Corporate buyback programs support equity prices across major indices',
      'Dow Jones futures indicate higher open after positive economic indicators',
      'Portfolio managers increase equity allocation as bond yields stabilise',
      'Stock selection remains critical amid diverging sector performance metrics',
      'Earnings per share growth drives premium valuations in equity markets',
      'Index fund flows accelerate as passive investment continues to dominate',
    ];

    for (const text of stockTexts) {
      const tokens = await provider.embed(text);
      store.insertMemory({
        agentName:   'RetAgent',
        memoryType:  'M_MI',
        content:     text,
        tfidfTokens: tokens,
      });
    }
  });

  after(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('Query about bitcoin returns mostly bitcoin memories in top-5', async () => {
    const provider = new TfidfEmbeddingProvider();
    const memories  = store.getRetrievableMemories('RetAgent');

    assert.strictEqual(memories.length, 20, 'Should have all 20 memories');

    const top5 = await retrieveTopK(provider, 'bitcoin cryptocurrency BTC halving crypto market', memories, 5);

    assert.strictEqual(top5.length, 5, 'Should return exactly 5 results');

    // Count bitcoin-related results in top-5 (at least 3 out of 5 should be bitcoin)
    const bitcoinKeywords = ['bitcoin', 'btc', 'crypto', 'halving', 'mining', 'hashrate'];
    const bitcoinCount = top5.filter(m => {
      const text = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).toLowerCase();
      return bitcoinKeywords.some(kw => text.includes(kw));
    }).length;

    assert.ok(
      bitcoinCount >= 3,
      `Expected ≥3 bitcoin results in top-5, got ${bitcoinCount}. Top-5: ${top5.map(m => m.content).join(' | ')}`
    );
  });

  test('retrieveTopK returns results sorted by score descending', async () => {
    const provider = new TfidfEmbeddingProvider();
    const memories  = store.getRetrievableMemories('RetAgent');
    const topK = await retrieveTopK(provider, 'bitcoin price', memories, 5);

    for (let i = 0; i < topK.length - 1; i++) {
      assert.ok(
        topK[i].score >= topK[i + 1].score,
        `Result[${i}].score (${topK[i].score}) should be ≥ result[${i+1}].score (${topK[i+1].score})`
      );
    }
  });

  test('retrieveTopK with K > memories returns all memories', async () => {
    const provider  = new TfidfEmbeddingProvider();
    const memories  = store.getRetrievableMemories('RetAgent');
    const topK = await retrieveTopK(provider, 'market', memories, 100);
    assert.strictEqual(topK.length, 20, 'Should return all 20 when K > total');
  });

  test('retrieveTopK with empty memories returns empty array', async () => {
    const provider = new TfidfEmbeddingProvider();
    const topK = await retrieveTopK(provider, 'bitcoin', [], 5);
    assert.deepStrictEqual(topK, []);
  });
});

// ─── Portfolio state & conference logs ──────────────────────────────────────

describe('MemoryStore – portfolio state', () => {
  let store;
  let dbPath;

  before(() => {
    dbPath = tempDbPath();
    store  = makeStore(dbPath);
  });

  after(() => {
    store.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  test('savePortfolioState and getLatestPortfolioState round-trip', () => {
    const state = { cash: 50000, positions: { 'BTC-USD': 1 }, totalValue: 100000 };
    store.savePortfolioState(state);

    const latest = store.getLatestPortfolioState();
    assert.ok(latest, 'Should return latest state');
    assert.deepStrictEqual(latest.state, state);
  });

  test('getPortfolioHistory returns saved states in desc order', () => {
    store.savePortfolioState({ tick: 1, value: 100000 });
    store.savePortfolioState({ tick: 2, value: 101000 });
    store.savePortfolioState({ tick: 3, value: 102000 });

    const history = store.getPortfolioHistory(3);
    assert.strictEqual(history.length, 3);
    // Most recent first
    assert.strictEqual(history[0].state.tick, 3);
  });
});

console.log('✅ memory.test.cjs loaded');
