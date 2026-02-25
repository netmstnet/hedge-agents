'use strict';

/**
 * technical.cjs — Technical analysis indicators.
 * All computed from OHLCV price data. No external dependencies.
 *
 * Returns structured JSON so LLM can reason about the values directly.
 */

// ─── Moving averages ──────────────────────────────────────────────────────────

function ema(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let emaVal = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    emaVal = closes[i] * k + emaVal * (1 - k);
  }
  return emaVal;
}

function sma(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

// ─── RSI ─────────────────────────────────────────────────────────────────────

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  let gains = 0, losses = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) gains  += changes[i];
    else                losses -= changes[i];
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period; i < changes.length; i++) {
    const gain  = Math.max(0,  changes[i]);
    const loss  = Math.max(0, -changes[i]);
    avgGain = (avgGain * (period - 1) + gain)  / period;
    avgLoss = (avgLoss * (period - 1) + loss)  / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast  = ema(closes, fast);
  const emaSlow  = ema(closes, slow);
  if (emaFast === null || emaSlow === null) return null;
  const macdLine = emaFast - emaSlow;

  // Signal line = EMA of MACD line values
  // Simplified: use last N macdLine values
  const macdSeries = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const f = ema(closes.slice(0, i + 1), fast);
    const s = ema(closes.slice(0, i + 1), slow);
    if (f !== null && s !== null) macdSeries.push(f - s);
  }

  const signalLine = ema(macdSeries, signal);
  const histogram  = signalLine !== null ? macdLine - signalLine : null;

  return {
    macdLine:   round(macdLine),
    signalLine: round(signalLine),
    histogram:  round(histogram),
  };
}

// ─── Bollinger Bands ──────────────────────────────────────────────────────────

function bollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid   = slice.reduce((s, v) => s + v, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  const current = closes[closes.length - 1];

  return {
    upper:  round(mid + stdDevMult * stdDev),
    middle: round(mid),
    lower:  round(mid - stdDevMult * stdDev),
    current: round(current),
    bandwidth: round((4 * stdDev) / mid),
    pctB: round((current - (mid - stdDevMult * stdDev)) / (2 * stdDevMult * stdDev)),
  };
}

// ─── ATR ─────────────────────────────────────────────────────────────────────

function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i]  - closes[i - 1]);
    trs.push(Math.max(hl, hc, lc));
  }
  return round(trs.slice(-period).reduce((s, v) => s + v, 0) / period);
}

// ─── Stochastic Oscillator ────────────────────────────────────────────────────

function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  if (closes.length < kPeriod) return null;
  const kValues = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const highSlice = highs.slice(i - kPeriod + 1, i + 1);
    const lowSlice  = lows.slice(i  - kPeriod + 1, i + 1);
    const highest   = Math.max(...highSlice);
    const lowest    = Math.min(...lowSlice);
    kValues.push(highest === lowest ? 50 : 100 * (closes[i] - lowest) / (highest - lowest));
  }
  const kCurrent = kValues[kValues.length - 1];
  const dCurrent = kValues.length >= dPeriod
    ? kValues.slice(-dPeriod).reduce((s, v) => s + v, 0) / dPeriod
    : null;
  return {
    k: round(kCurrent),
    d: round(dCurrent),
  };
}

// ─── OBV ─────────────────────────────────────────────────────────────────────

function obv(closes, volumes) {
  if (!closes.length || !volumes.length) return null;
  let obvVal = 0;
  for (let i = 1; i < closes.length; i++) {
    if      (closes[i] > closes[i - 1]) obvVal += volumes[i];
    else if (closes[i] < closes[i - 1]) obvVal -= volumes[i];
  }
  return round(obvVal);
}

// ─── Volume Analysis ──────────────────────────────────────────────────────────

function volumeAnalysis(volumes, period = 20) {
  if (!volumes.length) return null;
  const current = volumes[volumes.length - 1];
  const avg = volumes.slice(-period).reduce((s, v) => s + v, 0) / Math.min(period, volumes.length);
  return {
    current: current,
    average: round(avg),
    ratio:   round(current / avg),
    trend:   current > avg * 1.2 ? 'HIGH' : current < avg * 0.8 ? 'LOW' : 'NORMAL',
  };
}

// ─── Trend Analysis ───────────────────────────────────────────────────────────

function trendAnalysis(closes) {
  if (closes.length < 50) return null;
  const current = closes[closes.length - 1];
  const ema9   = ema(closes, 9);
  const ema21  = ema(closes, 21);
  const sma50  = sma(closes, 50);
  const sma200 = closes.length >= 200 ? sma(closes, 200) : null;

  // Simple trend scoring: count bull/bear signals
  let score = 0;
  if (ema9  && current > ema9)   score++;
  if (ema9  && ema9 > ema21)     score++;
  if (ema21 && current > ema21)  score++;
  if (sma50 && current > sma50)  score++;
  if (sma200 && current > sma200) score++;

  const maxScore = sma200 ? 5 : 4;
  const trendStrength = score / maxScore;

  return {
    direction:  score >= maxScore * 0.6 ? 'BULLISH' : score <= maxScore * 0.4 ? 'BEARISH' : 'NEUTRAL',
    strength:   round(trendStrength),
    ema9:       round(ema9),
    ema21:      round(ema21),
    sma50:      round(sma50),
    sma200:     sma200 ? round(sma200) : null,
    priceVsEma9:  ema9  ? round((current - ema9)  / ema9  * 100) : null,
    priceVsSma50: sma50 ? round((current - sma50) / sma50 * 100) : null,
  };
}

// ─── Support & Resistance ─────────────────────────────────────────────────────

function supportResistance(highs, lows, closes, lookback = 20) {
  if (closes.length < lookback) return null;
  const recent = { highs: highs.slice(-lookback), lows: lows.slice(-lookback) };
  const resistance = Math.max(...recent.highs);
  const support    = Math.min(...recent.lows);
  const current    = closes[closes.length - 1];
  const range      = resistance - support;

  return {
    resistance:  round(resistance),
    support:     round(support),
    current:     round(current),
    range:       round(range),
    positionPct: round(range > 0 ? (current - support) / range * 100 : 50),
    nearResistance: range > 0 && (resistance - current) / range < 0.1,
    nearSupport:    range > 0 && (current - support) / range < 0.1,
  };
}

// ─── Volatility Regime ────────────────────────────────────────────────────────

function volatilityRegime(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const dailyReturns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
  const recent = dailyReturns.slice(-period);
  const avgReturn = recent.reduce((s, v) => s + v, 0) / recent.length;
  const variance  = recent.reduce((s, v) => s + (v - avgReturn) ** 2, 0) / (recent.length - 1);
  const annVol    = Math.sqrt(variance * 252) * 100;

  let regime;
  if (annVol < 15)       regime = 'LOW';
  else if (annVol < 30)  regime = 'MEDIUM';
  else if (annVol < 50)  regime = 'HIGH';
  else                   regime = 'EXTREME';

  return {
    annualisedVolPct: round(annVol),
    regime,
    dailyVol: round(Math.sqrt(variance) * 100),
  };
}

// ─── Drawdown Analysis ────────────────────────────────────────────────────────

function drawdownAnalysis(closes) {
  if (closes.length < 2) return null;
  let peak = closes[0];
  let maxDD = 0, currentDD = 0, daysUnderwater = 0;

  for (const c of closes) {
    if (c > peak) { peak = c; }
    currentDD = (peak - c) / peak;
    if (currentDD > maxDD) maxDD = currentDD;
    if (currentDD > 0) daysUnderwater++;
  }

  const current = closes[closes.length - 1];
  const currentDDFromPeak = (peak - current) / peak;

  return {
    maxDrawdownPct:     round(maxDD * 100),
    currentDrawdownPct: round(currentDDFromPeak * 100),
    peakPrice:          round(peak),
    daysUnderwater,
    inDrawdown: currentDDFromPeak > 0.01,
  };
}

// ─── Compound indicator summary ───────────────────────────────────────────────

/**
 * Run all indicators and return a unified analysis object.
 * This is the main entry point called from agent tools.
 *
 * @param {object} ohlcv - { opens, highs, lows, closes, volumes, dates }
 * @returns {object} Full technical analysis
 */
function runTechnicalIndicators(ohlcv) {
  const { opens, highs, lows, closes, volumes } = ohlcv;
  if (!closes || closes.length < 2) return { error: 'Insufficient price data' };

  const current = closes[closes.length - 1];
  const prev    = closes[closes.length - 2];
  const dailyChangePct = round((current - prev) / prev * 100);

  const rsiVal  = rsi(closes, 14);
  const macdVal = macd(closes, 12, 26, 9);
  const bbVal   = bollingerBands(closes, 20, 2);
  const atrVal  = atr(highs, lows, closes, 14);
  const stochVal = stochastic(highs, lows, closes, 14, 3);
  const obvVal  = obv(closes, volumes);
  const volA    = volumeAnalysis(volumes, 20);
  const trend   = trendAnalysis(closes);
  const sr      = supportResistance(highs, lows, closes, 20);
  const volReg  = volatilityRegime(closes, 20);
  const dd      = drawdownAnalysis(closes);

  // Composite signal
  const signals = [];
  if (rsiVal !== null) {
    if (rsiVal > 70) signals.push({ indicator: 'RSI', signal: 'OVERBOUGHT', value: rsiVal });
    if (rsiVal < 30) signals.push({ indicator: 'RSI', signal: 'OVERSOLD',   value: rsiVal });
  }
  if (macdVal) {
    if (macdVal.histogram > 0) signals.push({ indicator: 'MACD', signal: 'BULLISH_CROSSOVER', value: macdVal.histogram });
    if (macdVal.histogram < 0) signals.push({ indicator: 'MACD', signal: 'BEARISH_CROSSOVER', value: macdVal.histogram });
  }
  if (bbVal) {
    if (bbVal.pctB > 1)  signals.push({ indicator: 'BB', signal: 'ABOVE_UPPER_BAND', value: bbVal.pctB });
    if (bbVal.pctB < 0)  signals.push({ indicator: 'BB', signal: 'BELOW_LOWER_BAND', value: bbVal.pctB });
  }
  if (stochVal) {
    if (stochVal.k > 80 && stochVal.d > 80) signals.push({ indicator: 'Stochastic', signal: 'OVERBOUGHT', value: stochVal.k });
    if (stochVal.k < 20 && stochVal.d < 20) signals.push({ indicator: 'Stochastic', signal: 'OVERSOLD',   value: stochVal.k });
  }

  return {
    currentPrice:   round(current),
    dailyChangePct,
    rsi:            rsiVal !== null ? round(rsiVal) : null,
    macd:           macdVal,
    bollingerBands: bbVal,
    atr:            atrVal,
    stochastic:     stochVal,
    obv:            obvVal,
    volume:         volA,
    trend,
    supportResistance: sr,
    volatilityRegime: volReg,
    drawdown:       dd,
    signals,
    signalSummary: signals.length
      ? signals.map(s => `${s.indicator}: ${s.signal} (${s.value})`).join(', ')
      : 'No extreme signals',
  };
}

function round(v, dp = 4) {
  if (v === null || v === undefined || isNaN(v)) return null;
  return parseFloat(v.toFixed(dp));
}

module.exports = {
  ema, sma, rsi, macd, bollingerBands, atr, stochastic, obv,
  volumeAnalysis, trendAnalysis, supportResistance, volatilityRegime,
  drawdownAnalysis, runTechnicalIndicators,
};
