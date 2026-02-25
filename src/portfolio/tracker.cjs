'use strict';

/**
 * tracker.cjs — Portfolio position tracking and P&L.
 *
 * Tracks: cash, positions per agent (each agent manages their assigned asset),
 * total portfolio value, daily returns, and equity curve.
 *
 * Budget weights (from BAC) determine how much of total capital each agent controls.
 */

const logger = require('../utils/logger.cjs');
const MOD = 'portfolio:tracker';

class PortfolioTracker {
  /**
   * @param {object} cfg
   * @param {number} cfg.startingCapital - Total capital in USD
   * @param {object} cfg.initialWeights  - { agentName: fraction }
   * @param {object[]} cfg.analysts       - Agent configs with .name and .asset
   */
  constructor(cfg) {
    this._startingCapital = cfg.startingCapital || 100000;
    this._initialWeights  = cfg.initialWeights  || {};
    this._analysts        = cfg.analysts         || [];

    // Portfolio state
    this._cash         = this._startingCapital;
    this._positions    = {};   // { agentName: { asset, qty, avgCost, currentPrice } }
    this._budgetWeights = { ...this._initialWeights };
    this._equityCurve  = [this._startingCapital];
    this._dailyReturns = [];
    this._trades       = [];   // trade log
    this._currentDate  = null;

    // Initialise positions
    for (const analyst of this._analysts) {
      this._positions[analyst.name] = {
        asset:        analyst.asset,
        qty:          0,
        avgCost:      0,
        currentPrice: 0,
        unrealisedPnl: 0,
      };
    }

    logger.info(MOD, `Portfolio initialised: $${this._startingCapital} across ${this._analysts.length} agents`);
  }

  // ─── Budget weights ────────────────────────────────────────────────────────

  /**
   * Update budget weights after a BAC.
   * @param {{ agentName: fraction }} weights - Must sum to 1.0
   */
  updateBudgetWeights(weights) {
    const total = Object.values(weights).reduce((s, v) => s + v, 0);
    if (Math.abs(total - 1.0) > 0.01) {
      logger.warn(MOD, `Budget weights sum to ${total}, normalising`);
      Object.keys(weights).forEach(k => { weights[k] /= total; });
    }
    this._budgetWeights = { ...weights };
    logger.info(MOD, `Budget updated: ${JSON.stringify(this._budgetWeights)}`);
  }

  /**
   * Get the capital budget assigned to a specific agent.
   */
  getAgentBudget(agentName) {
    const totalValue = this.getTotalValue();
    const weight     = this._budgetWeights[agentName] || 0;
    return totalValue * weight;
  }

  /**
   * Get the available (uninvested) cash for an agent.
   */
  getAgentAvailableCash(agentName) {
    const budget  = this.getAgentBudget(agentName);
    const pos     = this._positions[agentName];
    const invested = pos ? pos.qty * pos.currentPrice : 0;
    return Math.max(0, budget - invested);
  }

  // ─── Trade execution ───────────────────────────────────────────────────────

  /**
   * Execute an agent's trade action.
   *
   * @param {string} agentName
   * @param {object} decision    - { action, quantity_pct, stop_loss_pct, take_profit_pct }
   * @param {number} price       - Current market price
   * @param {string} date        - YYYY-MM-DD
   * @returns {{ executed: bool, trade: object, reason: string }}
   */
  executeAction(agentName, decision, price, date) {
    const pos    = this._positions[agentName];
    const budget = this.getAgentBudget(agentName);
    const avail  = this.getAgentAvailableCash(agentName);
    const action = decision.action || 'Hold';
    const qtyPct = Math.min(1.0, Math.max(0, decision.quantity_pct || 0));

    let executed = false;
    let tradeQty = 0;
    let tradeCost = 0;
    let reason   = 'No trade';

    if (action === 'Buy' && qtyPct > 0 && avail > 10) {
      // Deploy qtyPct of available cash
      tradeCost = avail * qtyPct;
      tradeQty  = tradeCost / price;

      // Update position (FIFO average cost)
      const prevCost  = pos.qty * pos.avgCost;
      pos.qty        += tradeQty;
      pos.avgCost     = pos.qty > 0 ? (prevCost + tradeCost) / pos.qty : price;
      pos.currentPrice = price;
      this._cash     -= tradeCost;

      executed = true;
      reason   = `Bought ${tradeQty.toFixed(6)} @ ${price}`;

    } else if ((action === 'Sell' || action === 'Reduce') && pos.qty > 0) {
      const sellFraction = action === 'Reduce' ? qtyPct : (qtyPct === 0 ? 1.0 : qtyPct);
      tradeQty   = pos.qty * sellFraction;
      tradeCost  = tradeQty * price;
      const proceeds = tradeCost;
      const costBasis = tradeQty * pos.avgCost;
      const realisedPnl = proceeds - costBasis;

      pos.qty    -= tradeQty;
      if (pos.qty < 1e-10) { pos.qty = 0; pos.avgCost = 0; }
      this._cash += proceeds;

      executed = true;
      reason   = `Sold ${tradeQty.toFixed(6)} @ ${price}, realised P&L: $${realisedPnl.toFixed(2)}`;

    } else if (action === 'Hold' || action === 'SetTradingConditions' || action === 'AdjustPrice' || action === 'AdjustQuantity') {
      executed = true; // Acknowledge the decision, no position change
      reason   = `Hold — monitoring position`;
    }

    // Log trade
    const trade = {
      date, agentName, action, price, tradeQty, tradeCost, qtyPct, executed, reason,
      stopLoss:   decision.stop_loss_pct,
      takeProfit: decision.take_profit_pct,
    };
    this._trades.push(trade);

    if (executed) {
      logger.info(MOD, `[${agentName}] ${reason}`);
    }

    return { executed, trade, reason };
  }

  // ─── Price updates ─────────────────────────────────────────────────────────

  /**
   * Update current prices for all positions.
   * @param {object} prices - { agentName: currentPrice }
   */
  updatePrices(prices) {
    for (const [agentName, price] of Object.entries(prices)) {
      const pos = this._positions[agentName];
      if (pos && price > 0) {
        pos.currentPrice   = price;
        pos.unrealisedPnl  = pos.qty > 0 ? (price - pos.avgCost) * pos.qty : 0;
      }
    }
  }

  /**
   * Record end-of-day portfolio value (for equity curve and daily returns).
   */
  recordDailySnapshot(date) {
    this._currentDate = date;
    const totalValue  = this.getTotalValue();
    const prevValue   = this._equityCurve[this._equityCurve.length - 1] || totalValue;
    const dailyReturn = prevValue > 0 ? (totalValue - prevValue) / prevValue : 0;

    this._equityCurve.push(totalValue);
    this._dailyReturns.push(dailyReturn);

    logger.debug(MOD, `[${date}] Portfolio: $${totalValue.toFixed(2)} (${(dailyReturn * 100).toFixed(2)}%)`);
    return { totalValue, dailyReturn };
  }

  // ─── Check stop loss / take profit ────────────────────────────────────────

  /**
   * Check if any pending stop-loss or take-profit conditions are triggered.
   * Returns list of actions to execute.
   */
  checkTriggerConditions(currentPrices) {
    const actions = [];
    for (const trade of this._trades.filter(t => !t.triggerChecked && t.action === 'Buy')) {
      const pos = this._positions[trade.agentName];
      const price = currentPrices[trade.agentName] || pos?.currentPrice || 0;
      if (!price || !pos || pos.qty < 1e-10) continue;

      const pnlPct = (price - trade.price) / trade.price;
      if (trade.takeProfit && pnlPct >= trade.takeProfit) {
        actions.push({ agentName: trade.agentName, reason: 'TAKE_PROFIT', price, pnlPct });
      } else if (trade.stopLoss && pnlPct <= -trade.stopLoss) {
        actions.push({ agentName: trade.agentName, reason: 'STOP_LOSS', price, pnlPct });
      }
      trade.triggerChecked = true;
    }
    return actions;
  }

  // ─── Getters ───────────────────────────────────────────────────────────────

  getTotalValue() {
    let total = this._cash;
    for (const pos of Object.values(this._positions)) {
      total += pos.qty * pos.currentPrice;
    }
    return total;
  }

  getSnapshot() {
    const totalValue = this.getTotalValue();
    const positions  = {};
    for (const [name, pos] of Object.entries(this._positions)) {
      if (pos.qty > 1e-10 || pos.currentPrice > 0) {
        positions[name] = {
          asset:         pos.asset,
          qty:           round(pos.qty),
          avgCost:       round(pos.avgCost),
          currentPrice:  round(pos.currentPrice),
          marketValue:   round(pos.qty * pos.currentPrice),
          unrealisedPnl: round(pos.unrealisedPnl),
          unrealisedPnlPct: pos.avgCost > 0 ? round(pos.unrealisedPnl / (pos.qty * pos.avgCost) * 100) : 0,
        };
      }
    }
    const totalReturn = (totalValue - this._startingCapital) / this._startingCapital;
    return {
      date:           this._currentDate,
      cash:           round(this._cash),
      totalValue:     round(totalValue),
      positions,
      budgetWeights:  this._budgetWeights,
      totalReturn:    round(totalReturn * 100),
      startingCapital: this._startingCapital,
    };
  }

  getEquityCurve()   { return this._equityCurve; }
  getDailyReturns()  { return this._dailyReturns; }
  getTrades()        { return this._trades; }
  getPosition(name)  { return this._positions[name] || null; }
}

function round(v, dp = 4) {
  if (v === null || v === undefined || !isFinite(v)) return v;
  return parseFloat(v.toFixed(dp));
}

module.exports = { PortfolioTracker };
