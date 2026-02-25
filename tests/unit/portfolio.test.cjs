'use strict';

/**
 * portfolio.test.cjs — Unit tests for portfolio math and risk calculations.
 *
 * Tests:
 *   - pricesToReturns
 *   - totalReturn
 *   - annualisedReturn
 *   - stressTest scenarios
 *   - entropy and effectiveNumberOfBets
 *
 * Run with: node --test tests/unit/portfolio.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  annualisedReturn,
  totalReturn,
  entropy,
  effectiveNumberOfBets,
} = require('../../src/utils/math.cjs');

const { pricesToReturns, stressTest } = require('../../src/tools/risk.cjs');

// ─── pricesToReturns ──────────────────────────────────────────────────────────

describe('pricesToReturns', () => {
  test('[100, 110, 99] → [0.1, -0.1]', () => {
    const result = pricesToReturns([100, 110, 99]);
    assert.strictEqual(result.length, 2, 'Should have 2 returns for 3 prices');

    // r[0] = (110 - 100) / 100 = 0.1
    assert.ok(
      Math.abs(result[0] - 0.1) < 1e-10,
      `r[0] should be 0.1, got ${result[0]}`
    );
    // r[1] = (99 - 110) / 110 = -0.1
    assert.ok(
      Math.abs(result[1] - (-0.1)) < 1e-10,
      `r[1] should be -0.1, got ${result[1]}`
    );
  });

  test('[100, 200] → [1.0] (100% return)', () => {
    const result = pricesToReturns([100, 200]);
    assert.strictEqual(result.length, 1);
    assert.ok(Math.abs(result[0] - 1.0) < 1e-10);
  });

  test('[200, 100] → [-0.5] (50% loss)', () => {
    const result = pricesToReturns([200, 100]);
    assert.strictEqual(result.length, 1);
    assert.ok(Math.abs(result[0] - (-0.5)) < 1e-10);
  });

  test('Single price → empty array', () => {
    assert.deepStrictEqual(pricesToReturns([100]), []);
  });

  test('Empty array → empty array', () => {
    assert.deepStrictEqual(pricesToReturns([]), []);
  });

  test('Long series: last return computed correctly', () => {
    const prices = [100, 105, 102, 108, 110];
    const result = pricesToReturns(prices);
    assert.strictEqual(result.length, 4);
    // Last return: (110 - 108) / 108
    const expected = (110 - 108) / 108;
    assert.ok(Math.abs(result[3] - expected) < 1e-10);
  });
});

// ─── totalReturn ─────────────────────────────────────────────────────────────

describe('totalReturn', () => {
  test('[0.1, -0.1] → total return ≈ -0.01 (i.e. 1.1 * 0.9 - 1 = -0.01)', () => {
    // (1 + 0.1) * (1 - 0.1) - 1 = 1.1 * 0.9 - 1 = 0.99 - 1 = -0.01
    const result = totalReturn([0.1, -0.1]);
    assert.ok(
      Math.abs(result - (-0.01)) < 1e-10,
      `Expected -0.01, got ${result}`
    );
  });

  test('[0.5, 0.5] → total return = 1.25 (125%)', () => {
    // 1.5 * 1.5 - 1 = 2.25 - 1 = 1.25
    const result = totalReturn([0.5, 0.5]);
    assert.ok(Math.abs(result - 1.25) < 1e-10, `Expected 1.25, got ${result}`);
  });

  test('Empty returns → 0', () => {
    const result = totalReturn([]);
    assert.strictEqual(result, 0);
  });

  test('[0.1, -0.2, 0.3] → compounded correctly', () => {
    // 1.1 * 0.8 * 1.3 - 1 = 1.144 - 1 = 0.144
    const expected = 1.1 * 0.8 * 1.3 - 1;
    const result   = totalReturn([0.1, -0.2, 0.3]);
    assert.ok(Math.abs(result - expected) < 1e-10);
  });
});

// ─── annualisedReturn ────────────────────────────────────────────────────────

describe('annualisedReturn', () => {
  test('252 days at 0.001/day → ~28.7% annualised return', () => {
    // compounded = (1.001)^252 ≈ 1.2868
    // annualisedReturn = compounded^(252/252) - 1 = 1.2868 - 1 = 0.2868
    const returns = Array(252).fill(0.001);
    const result  = annualisedReturn(returns);

    const expected = Math.pow(1.001, 252) - 1; // ≈ 0.2868
    assert.ok(
      Math.abs(result - expected) < 0.001,
      `Expected ~${(expected * 100).toFixed(2)}%, got ${(result * 100).toFixed(2)}%`
    );
    // Should be approximately 28%
    assert.ok(result > 0.25 && result < 0.33, `Expected ~28%, got ${(result * 100).toFixed(2)}%`);
  });

  test('Zero returns → 0% annualised return', () => {
    const returns = Array(252).fill(0);
    const result  = annualisedReturn(returns);
    assert.ok(Math.abs(result) < 1e-10, `Expected 0, got ${result}`);
  });

  test('Fewer than 252 days is scaled correctly', () => {
    // 126 days at 0.002/day
    // compounded = (1.002)^126 = 1.2848...
    // annualisedReturn = 1.2848^(252/126) - 1 = 1.2848^2 - 1 ≈ 0.6507
    const returns = Array(126).fill(0.002);
    const result  = annualisedReturn(returns);
    const compounded = Math.pow(1.002, 126);
    const expected   = Math.pow(compounded, 252 / 126) - 1;
    assert.ok(Math.abs(result - expected) < 0.001, `Expected ${expected.toFixed(4)}, got ${result.toFixed(4)}`);
  });

  test('Empty returns → 0', () => {
    const result = annualisedReturn([]);
    assert.strictEqual(result, 0);
  });
});

// ─── stressTest ──────────────────────────────────────────────────────────────

describe('stressTest', () => {
  test('Bear Market: 1 BTC at $50,000 → P&L = -$15,000', () => {
    // Bear Market scenario: default shock = -30%
    // pnl = 1 * 50000 * (-0.30) = -15000
    const result = stressTest({ 'BTC-USD': 1 }, { 'BTC-USD': 50000 });

    assert.ok(!result.error, 'Should not error');
    assert.strictEqual(result.currentValue, 50000, 'Current value should be $50,000');

    const bearScenario = result.scenarios.find(s => s.name === 'Bear Market');
    assert.ok(bearScenario, 'Should include Bear Market scenario');
    assert.ok(
      Math.abs(bearScenario.pnl - (-15000)) < 0.01,
      `Bear Market P&L should be -15000, got ${bearScenario.pnl}`
    );
    assert.ok(
      Math.abs(bearScenario.pnlPct - (-30)) < 0.01,
      `Bear Market P&L% should be -30%, got ${bearScenario.pnlPct}`
    );
    assert.ok(
      Math.abs(bearScenario.valueAfter - 35000) < 0.01,
      `Value after should be 35000, got ${bearScenario.valueAfter}`
    );
  });

  test('Crypto Crash: BTC-USD gets -50% shock', () => {
    const result = stressTest({ 'BTC-USD': 2 }, { 'BTC-USD': 30000 });
    const scenario = result.scenarios.find(s => s.name === 'Crypto Crash (BTC)');
    assert.ok(scenario);
    // pnl = 2 * 30000 * (-0.50) = -30000
    assert.ok(Math.abs(scenario.pnl - (-30000)) < 0.01, `Expected -30000, got ${scenario.pnl}`);
  });

  test('All stress scenarios are present', () => {
    const result = stressTest({ 'BTC-USD': 1 }, { 'BTC-USD': 50000 });
    const names  = result.scenarios.map(s => s.name);
    const expected = ['Bear Market', 'Crypto Crash (BTC)', 'Market Flash Crash', 'Rate Spike (FX/Bonds)', 'Mild Correction'];
    for (const name of expected) {
      assert.ok(names.includes(name), `Missing scenario: ${name}`);
    }
  });

  test('Multiple positions: total portfolio stressed correctly', () => {
    // 1 BTC at $40,000 + 100 DJI shares at $350
    // Total = 40000 + 35000 = 75000
    // Bear Market: all default -30% → pnl = -22500
    const result = stressTest(
      { 'BTC-USD': 1, '^DJI': 100 },
      { 'BTC-USD': 40000, '^DJI': 350 }
    );
    assert.strictEqual(result.currentValue, 75000);

    const bear = result.scenarios.find(s => s.name === 'Bear Market');
    assert.ok(Math.abs(bear.pnl - (-22500)) < 0.01, `Expected -22500, got ${bear.pnl}`);
  });
});

// ─── entropy ─────────────────────────────────────────────────────────────────

describe('entropy', () => {
  test('entropy([0.5, 0.5]) > entropy([0.9, 0.1])', () => {
    const h1 = entropy([0.5, 0.5]);
    const h2 = entropy([0.9, 0.1]);
    assert.ok(h1 > h2, `entropy([0.5,0.5])=${h1.toFixed(4)} should > entropy([0.9,0.1])=${h2.toFixed(4)}`);
  });

  test('entropy([1, 0]) = 0 (concentrated portfolio)', () => {
    // H = -1*ln(1) - 0*ln(0) = 0 (0*log(0) defined as 0)
    const result = entropy([1, 0]);
    assert.strictEqual(result, 0, `Expected 0, got ${result}`);
  });

  test('Equal distribution has maximum entropy for N assets', () => {
    // For uniform distribution, H = ln(N)
    const n       = 4;
    const uniform = Array(n).fill(1 / n);
    const result  = entropy(uniform);
    const expected = Math.log(n); // ln(4) ≈ 1.386
    assert.ok(
      Math.abs(result - expected) < 1e-10,
      `Expected entropy = ln(4) = ${expected.toFixed(6)}, got ${result.toFixed(6)}`
    );
  });

  test('entropy([0.5, 0.5]) = ln(2) ≈ 0.693', () => {
    const result   = entropy([0.5, 0.5]);
    const expected = Math.log(2);
    assert.ok(Math.abs(result - expected) < 1e-10);
  });

  test('entropy([0.33, 0.33, 0.34]) ≈ ln(3) for near-uniform 3-asset', () => {
    // Approx uniform → entropy ≈ ln(3)
    const result   = entropy([1/3, 1/3, 1/3]);
    const expected = Math.log(3);
    assert.ok(Math.abs(result - expected) < 1e-10);
  });
});

// ─── effectiveNumberOfBets ───────────────────────────────────────────────────

describe('effectiveNumberOfBets', () => {
  test('effectiveNumberOfBets([1, 0, 0]) = 1', () => {
    // ENB = 1 / sum(w^2) = 1 / (1^2 + 0 + 0) = 1
    const result = effectiveNumberOfBets([1, 0, 0]);
    assert.strictEqual(result, 1, `Expected 1, got ${result}`);
  });

  test('effectiveNumberOfBets([0.5, 0.5]) = 2', () => {
    // ENB = 1 / (0.25 + 0.25) = 1 / 0.5 = 2
    const result = effectiveNumberOfBets([0.5, 0.5]);
    assert.strictEqual(result, 2, `Expected 2, got ${result}`);
  });

  test('effectiveNumberOfBets([0.25, 0.25, 0.25, 0.25]) = 4', () => {
    // ENB = 1 / (4 * 0.0625) = 1 / 0.25 = 4
    const result = effectiveNumberOfBets([0.25, 0.25, 0.25, 0.25]);
    assert.ok(Math.abs(result - 4) < 1e-9, `Expected 4, got ${result}`);
  });

  test('effectiveNumberOfBets([0, 0, 0]) = 0 (no weights)', () => {
    const result = effectiveNumberOfBets([0, 0, 0]);
    assert.strictEqual(result, 0);
  });

  test('ENB increases with more diversification', () => {
    // 2-asset concentrated vs diversified
    const concentrated  = effectiveNumberOfBets([0.9, 0.1]);
    const diversified   = effectiveNumberOfBets([0.5, 0.5]);
    assert.ok(
      diversified > concentrated,
      `Diversified ENB (${diversified}) should be > concentrated (${concentrated})`
    );
  });
});

console.log('✅ portfolio.test.cjs loaded');
