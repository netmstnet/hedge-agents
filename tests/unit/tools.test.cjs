'use strict';

/**
 * tools.test.cjs — Unit tests for technical indicators and risk tools.
 *
 * Tests technical.cjs: rsi, sma, ema, bollingerBands, macd, stochastic
 * Tests risk.cjs:      computeRiskMetrics, pricesToReturns, stressTest
 * Tests math.cjs:      maxDrawdown, sharpeRatio, optimizePortfolio
 *
 * Run with: node --test tests/unit/tools.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { rsi, sma, ema, macd, bollingerBands, stochastic } = require('../../src/tools/technical.cjs');
const { computeRiskMetrics, pricesToReturns, stressTest } = require('../../src/tools/risk.cjs');
const { maxDrawdown, sharpeRatio, optimizePortfolio, covarianceMatrix } = require('../../src/utils/math.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate N prices that alternate +delta / -delta from a base, producing neutral RSI */
function alternatingPrices(n, base = 100, delta = 1) {
  const prices = [base];
  for (let i = 1; i < n; i++) {
    prices.push(i % 2 === 0 ? base : base + delta);
  }
  return prices;
}

/** Generate N monotonically increasing prices */
function risingPrices(n, start = 100, step = 1) {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

/** Generate N monotonically decreasing prices */
function fallingPrices(n, start = 200, step = 1) {
  return Array.from({ length: n }, (_, i) => start - i * step);
}

/** Generate N constant prices */
function flatPrices(n, price = 100) {
  return Array.from({ length: n }, () => price);
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

describe('RSI', () => {
  test('RSI on alternating up/down series should be ~50', () => {
    // Alternating: each up move is followed by equal down move → gains ≈ losses → RSI ≈ 50
    const prices = [];
    for (let i = 0; i < 60; i++) {
      prices.push(100 + (i % 2 === 0 ? 1 : 0));
    }
    const result = rsi(prices, 14);
    assert.ok(result !== null, 'RSI should return a value');
    // Alternating +1/-1 around 100 → equal avg gain/loss → RS=1 → RSI=50
    assert.ok(result >= 40 && result <= 60, `Expected RSI ~50, got ${result}`);
  });

  test('RSI on all-rising series should be 100', () => {
    const prices = risingPrices(30, 100, 1);
    const result = rsi(prices, 14);
    assert.ok(result !== null, 'RSI should return a value');
    // No losses → avgLoss=0 → code returns 100
    assert.strictEqual(result, 100, `Expected RSI=100, got ${result}`);
  });

  test('RSI on all-falling series should be ~0', () => {
    const prices = fallingPrices(30, 200, 1);
    const result = rsi(prices, 14);
    assert.ok(result !== null, 'RSI should return a value');
    // No gains → avgGain=0 → RS=0 → RSI=0
    assert.ok(result < 5, `Expected RSI near 0, got ${result}`);
  });

  test('RSI returns null when insufficient data', () => {
    const result = rsi([100, 101, 102], 14); // needs at least period+1=15
    assert.strictEqual(result, null);
  });
});

// ─── SMA ─────────────────────────────────────────────────────────────────────

describe('SMA', () => {
  test('SMA(5) on [1,2,3,4,5] = 3.0', () => {
    const result = sma([1, 2, 3, 4, 5], 5);
    assert.strictEqual(result, 3.0);
  });

  test('SMA uses last N elements when series is longer', () => {
    // SMA(3) on [1,2,3,4,5] → last 3 = [3,4,5] → 4.0
    const result = sma([1, 2, 3, 4, 5], 3);
    assert.strictEqual(result, 4.0);
  });

  test('SMA returns null when series is shorter than period', () => {
    const result = sma([1, 2, 3], 5);
    assert.strictEqual(result, null);
  });
});

// ─── EMA ─────────────────────────────────────────────────────────────────────

describe('EMA', () => {
  test('EMA(3) on [1,2,3,4,5] = 4.0', () => {
    // k = 2/(3+1) = 0.5
    // Seed = avg(first 3) = (1+2+3)/3 = 2
    // After price 4: 4*0.5 + 2*0.5 = 3
    // After price 5: 5*0.5 + 3*0.5 = 4
    const result = ema([1, 2, 3, 4, 5], 3);
    assert.ok(Math.abs(result - 4.0) < 1e-9, `Expected EMA≈4.0, got ${result}`);
  });

  test('EMA(2) on [10, 20, 30]', () => {
    // k = 2/(2+1) = 2/3
    // Seed = avg(first 2) = 15
    // After price 30: 30*(2/3) + 15*(1/3) = 20 + 5 = 25
    const result = ema([10, 20, 30], 2);
    assert.ok(Math.abs(result - 25) < 0.01, `Expected EMA≈25, got ${result}`);
  });

  test('EMA returns null when series is shorter than period', () => {
    const result = ema([1, 2], 5);
    assert.strictEqual(result, null);
  });
});

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

describe('Bollinger Bands', () => {
  test('bollingerBands: middle = SMA(20), upper > middle > lower', () => {
    // Use 30 prices with some variance so stdDev > 0
    const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
    const result = bollingerBands(prices, 20, 2);

    assert.ok(result !== null, 'Should return bands for sufficient data');
    // Middle should equal SMA(20) of the last 20 prices
    const last20  = prices.slice(-20);
    const sma20   = last20.reduce((s, v) => s + v, 0) / 20;
    assert.ok(Math.abs(result.middle - sma20) < 0.01,
      `Middle (${result.middle}) should equal SMA20 (${sma20.toFixed(4)})`);
    assert.ok(result.upper > result.middle,  `Upper (${result.upper}) > middle (${result.middle})`);
    assert.ok(result.lower < result.middle,  `Lower (${result.lower}) < middle (${result.middle})`);
  });

  test('bollingerBands with identical prices: upper = lower = middle (zero std)', () => {
    const prices = flatPrices(25, 100);
    const result = bollingerBands(prices, 20, 2);
    assert.ok(result !== null);
    // std=0, so upper = lower = middle = 100
    assert.strictEqual(result.middle, 100);
    assert.strictEqual(result.upper, 100);
    assert.strictEqual(result.lower, 100);
  });

  test('bollingerBands returns null when insufficient data', () => {
    const result = bollingerBands([100, 101, 102], 20);
    assert.strictEqual(result, null);
  });
});

// ─── MACD ─────────────────────────────────────────────────────────────────────

describe('MACD', () => {
  test('MACD line = EMA(12) - EMA(26) within 0.01%', () => {
    // Need at least 26+9=35 prices. Use 50 prices with a trend.
    const prices = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 2);

    const result = macd(prices, 12, 26, 9);
    assert.ok(result !== null, 'MACD should return for 50+ prices');

    // Verify macdLine = EMA(12) - EMA(26) from the technical module
    const ema12 = ema(prices, 12);
    const ema26 = ema(prices, 26);
    const expectedMacdLine = ema12 - ema26;

    const tolerance = Math.abs(expectedMacdLine) * 0.0001 + 0.0001; // 0.01% or 0.0001 abs
    assert.ok(
      Math.abs(result.macdLine - expectedMacdLine) < tolerance,
      `MACD line ${result.macdLine} should ≈ EMA12-EMA26 ${expectedMacdLine.toFixed(4)} (±${tolerance.toFixed(6)})`
    );
  });

  test('MACD returns null when insufficient data', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = macd(prices, 12, 26, 9);
    assert.strictEqual(result, null);
  });

  test('MACD result has macdLine, signalLine, histogram', () => {
    const prices = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.5) * 10 + i);
    const result = macd(prices);
    assert.ok(result !== null);
    assert.ok('macdLine'   in result, 'Should have macdLine');
    assert.ok('signalLine' in result, 'Should have signalLine');
    assert.ok('histogram'  in result, 'Should have histogram');
  });
});

// ─── Stochastic Oscillator ────────────────────────────────────────────────────

describe('Stochastic', () => {
  test('Stochastic %K = 100 when close equals period high', () => {
    // 20 bars where price rises steadily, so last close = highest high
    const n = 20;
    const closes = Array.from({ length: n }, (_, i) => 100 + i);
    const highs  = closes.map(c => c + 0.5);     // high is close + 0.5
    const lows   = closes.map(c => c - 0.5);     // low is close - 0.5

    // last close (119) is NOT quite equal to highest high (119.5)
    // Use a scenario where close = high on the last bar
    highs[n - 1] = closes[n - 1]; // make last high = last close

    const result = stochastic(highs, lows, closes, 14, 3);
    assert.ok(result !== null);
    // %K = (close - lowest_low) / (highest_high - lowest_low) * 100
    // With rising prices, close is near the top → K near 100
    assert.ok(result.k > 90, `Expected k near 100, got ${result.k}`);
  });

  test('Stochastic %K = 0 when close equals period low', () => {
    const n = 20;
    const closes = Array.from({ length: n }, (_, i) => 200 - i); // falling
    const highs  = closes.map(c => c + 0.5);
    const lows   = closes.map(c => c - 0.5);
    lows[n - 1]  = closes[n - 1]; // make last low = last close

    const result = stochastic(highs, lows, closes, 14, 3);
    assert.ok(result !== null);
    assert.ok(result.k < 10, `Expected k near 0, got ${result.k}`);
  });

  test('Stochastic returns null when insufficient data', () => {
    const closes = [100, 101, 102];
    const result = stochastic(closes, closes, closes, 14);
    assert.strictEqual(result, null);
  });
});

// ─── computeRiskMetrics ───────────────────────────────────────────────────────

describe('computeRiskMetrics', () => {
  test('0% daily returns → SR=0, MDD=0', () => {
    const returns = Array(30).fill(0);
    const equity  = Array(31).fill(100000);
    const result  = computeRiskMetrics(returns, equity);

    assert.strictEqual(result.sr,  0, 'SR should be 0 for zero returns');
    assert.strictEqual(result.mdd, 0, 'MDD should be 0 for flat equity');
  });

  test('Empty returns → error object returned', () => {
    const result = computeRiskMetrics([], []);
    assert.ok(result.error, 'Should have error field');
    assert.strictEqual(result.sr, 0);
    assert.strictEqual(result.mdd, 0);
  });

  test('Positive returns → SR > 0 when returns beat risk-free', () => {
    // 252 days at 0.1%/day → annualised ~28%, well above 2% rf
    // BUT vol=0 (constant returns) → SR=0 per code (vol=0 case)
    // Use noisy returns with positive mean
    const returns = Array(252).fill(0).map((_, i) =>
      i % 3 === 0 ? 0.002 : i % 3 === 1 ? 0.003 : -0.001
    );
    // mean ≈ 0.00133/day → annualised >> 2% rf
    const equity  = [100000];
    for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
    const result = computeRiskMetrics(returns, equity);
    assert.ok(result.sr > 0, `Expected positive SR, got ${result.sr}`);
  });

  test('Negative returns → SR < 0', () => {
    // Consistently negative returns → annualised return < rf → negative SR
    const returns = Array(50).fill(0).map((_, i) =>
      i % 2 === 0 ? -0.005 : 0.001
    );
    const equity  = [100000];
    for (const r of returns) equity.push(equity[equity.length - 1] * (1 + r));
    const result = computeRiskMetrics(returns, equity);
    assert.ok(result.sr < 0, `Expected negative SR, got ${result.sr}`);
  });
});

// ─── maxDrawdown ──────────────────────────────────────────────────────────────

describe('maxDrawdown', () => {
  test('[100, 120, 90, 110] → MDD = 0.25 (25%)', () => {
    // Peak = 120, lowest after peak = 90, DD = (120-90)/120 = 0.25
    const result = maxDrawdown([100, 120, 90, 110]);
    assert.ok(Math.abs(result - 0.25) < 1e-9, `Expected 0.25, got ${result}`);
  });

  test('[100, 110, 120] → MDD = 0 (no drawdown)', () => {
    const result = maxDrawdown([100, 110, 120]);
    assert.strictEqual(result, 0);
  });

  test('[100, 80, 60] → MDD = 0.40 (40%)', () => {
    // Peak = 100, trough = 60 → (100-60)/100 = 0.40
    const result = maxDrawdown([100, 80, 60]);
    assert.ok(Math.abs(result - 0.40) < 1e-9, `Expected 0.40, got ${result}`);
  });

  test('Two-element series [100, 50] → MDD = 0.50', () => {
    const result = maxDrawdown([100, 50]);
    assert.ok(Math.abs(result - 0.50) < 1e-9, `Expected 0.50, got ${result}`);
  });
});

// ─── sharpeRatio ─────────────────────────────────────────────────────────────

describe('sharpeRatio', () => {
  test('Zero-variance constant returns → SR = 0', () => {
    const returns = Array(100).fill(0.001); // all identical → std=0
    const result  = sharpeRatio(returns, 0.02);
    assert.strictEqual(result, 0, 'vol=0 → SR should be 0');
  });

  test('Known return series: SR close to expected value', () => {
    // 252 returns alternating between +0.003 and -0.001
    // mean per day ≈ 0.001, which annualises to ~28% — well above 2% rf
    // daily std ≈ 0.002
    const returns = Array(252).fill(0).map((_, i) => i % 2 === 0 ? 0.003 : -0.001);

    const { annualisedReturn, annualisedVol } = require('../../src/utils/math.cjs');
    const ar  = annualisedReturn(returns);
    const vol = annualisedVol(returns);
    const sr  = sharpeRatio(returns, 0.02);

    // SR = (ar - rf) / vol
    const expected = (ar - 0.02) / vol;
    assert.ok(Math.abs(sr - expected) < 0.01,
      `SR ${sr} should ≈ ${expected.toFixed(4)} (computed from formula)`);
    assert.ok(sr > 0, 'SR should be positive for positive net returns');
  });
});

// ─── optimizePortfolio ────────────────────────────────────────────────────────

describe('optimizePortfolio', () => {
  test('2 assets, equal expected returns, zero correlation → weights ≈ [0.5, 0.5]', () => {
    // Symmetric setup: both assets have same return and variance, no correlation
    const T = 100;
    const r1 = Array(T).fill(0.001); // asset 1 daily returns
    const r2 = Array(T).fill(0.001); // asset 2 daily returns (identical)

    const expectedReturns = [0.1, 0.1]; // equal annual expected returns
    const cov = covarianceMatrix([r1, r2]); // should be diagonal-ish for identical series

    // For a truly symmetric test, use a custom cov matrix (diagonal, equal variance)
    const symCov = [
      [0.0001, 0.0],  // zero off-diagonal = no correlation
      [0.0,   0.0001],
    ];

    const { weights } = optimizePortfolio(
      expectedReturns,
      symCov,
      [r1, r2],
      { lambda1: 0.5, lambda2: 0.3, confidence: 0.95 }
    );

    assert.ok(weights.length === 2, 'Should return 2 weights');
    // Due to symmetry the optimizer should converge near [0.5, 0.5]
    assert.ok(
      Math.abs(weights[0] - 0.5) < 0.15 && Math.abs(weights[1] - 0.5) < 0.15,
      `Weights ${weights.map(w => w.toFixed(4))} should be near [0.5, 0.5]`
    );
    // Weights sum to 1
    const sum = weights.reduce((s, w) => s + w, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `Weights must sum to 1, got ${sum}`);
    // All weights non-negative
    assert.ok(weights.every(w => w >= 0), 'All weights must be non-negative');
  });

  test('Single asset → weight = 1.0', () => {
    const r1 = Array(50).fill(0.001);
    const { weights } = optimizePortfolio([0.1], [[0.0001]], [r1]);
    assert.strictEqual(weights.length, 1);
    assert.ok(Math.abs(weights[0] - 1.0) < 1e-9, `Single asset weight should be 1, got ${weights[0]}`);
  });
});

// ─── pricesToReturns ─────────────────────────────────────────────────────────

describe('pricesToReturns', () => {
  test('[100, 110, 99] → [0.1, -0.1]', () => {
    const result = pricesToReturns([100, 110, 99]);
    assert.strictEqual(result.length, 2);
    assert.ok(Math.abs(result[0] - 0.1)  < 1e-9, `r[0] should be 0.1, got ${result[0]}`);
    assert.ok(Math.abs(result[1] - (-0.1)) < 1e-9, `r[1] should be -0.1, got ${result[1]}`);
  });

  test('Single price → empty returns array', () => {
    const result = pricesToReturns([100]);
    assert.deepStrictEqual(result, []);
  });
});

// ─── stressTest ──────────────────────────────────────────────────────────────

describe('stressTest', () => {
  test('Bear Market: 1 BTC at $50,000 → P&L = -$15,000 (30% shock)', () => {
    const result = stressTest({ 'BTC-USD': 1 }, { 'BTC-USD': 50000 });
    assert.ok(!result.error, `Should not error: ${result.error}`);

    const bearScenario = result.scenarios.find(s => s.name === 'Bear Market');
    assert.ok(bearScenario, 'Should have Bear Market scenario');
    // Bear Market applies default -30% shock
    assert.ok(Math.abs(bearScenario.pnl - (-15000)) < 0.01,
      `Expected PnL -15000, got ${bearScenario.pnl}`);
  });

  test('Empty positions → error', () => {
    const result = stressTest({}, {});
    assert.ok(result.error, 'Should return error for empty positions');
  });
});

console.log('✅ tools.test.cjs loaded');
