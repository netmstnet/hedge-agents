'use strict';

/**
 * prompt-builder.cjs — All LLM prompt templates for HedgeAgents.
 *
 * Templates map exactly to the paper's 6 prompt types:
 *   1. Single agent decision (Section 3.3)
 *   2. Reflection update      (Section 3.3)
 *   3. Summarized query Qt    (Section 3.3)
 *   4. BAC analyst report     (Section 3.4.1)
 *   5. BAC Otto decision      (Section 3.4.1)
 *   6. ESC case presentation  (Section 3.4.2)
 *   7. ESC peer response      (Section 3.4.2)
 *   8. ESC distillation       (Section 3.4.2)
 *   9. EMC crisis presentation (Section 3.4.3)
 *  10. EMC peer suggestion     (Section 3.4.3)
 *  11. EMC Otto synthesis      (Section 3.4.3)
 *  12. EMC final decision      (Section 3.4.3)
 */

// ─── Helper ──────────────────────────────────────────────────────────────────

function fmt(memories) {
  if (!memories || !memories.length) return 'No relevant past experience retrieved.';
  return memories.map((m, i) =>
    `[Memory ${i + 1}] (${m.memoryType}, ${new Date(m.createdAt * 1000).toISOString().slice(0, 10)})\n${
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }`
  ).join('\n\n');
}

function fmtTools(toolResults) {
  if (!toolResults || !Object.keys(toolResults).length) return 'No tool results available.';
  return Object.entries(toolResults).map(([name, result]) =>
    `**${name}:**\n${typeof result === 'object' ? JSON.stringify(result, null, 2) : result}`
  ).join('\n\n');
}

function fmtPortfolio(portfolio) {
  if (!portfolio) return 'Portfolio data unavailable.';
  return JSON.stringify(portfolio, null, 2);
}

// ─── 1. Summarized Query Qt ───────────────────────────────────────────────────
// Before memory retrieval, agent summarizes current situation into a concise query.

function buildSummarizedQueryPrompt(profile, currentData) {
  const { prices, news, toolResults, date } = currentData;
  return {
    system: `${profile.description}\n\nYou are generating a concise query to search your memory bank for relevant past experiences.`,
    user: `## Current Market Situation — ${date || 'today'}

**Asset:** ${profile.assetLabel || profile.responsibleFor}
**Current Prices:** ${JSON.stringify(prices)}
**Recent News Headlines:** ${news?.join('\n- ') || 'None'}
**Key Indicators:** ${JSON.stringify(toolResults?.technicalIndicators || {})}

## Task
In 2-3 sentences, summarise the current market conditions and what key factors are driving the market right now.
This summary will be used to search your memory for similar past situations.

Respond with ONLY the summary text (no JSON, no formatting).`,
  };
}

// ─── 2. Single Agent Decision ─────────────────────────────────────────────────

function buildDecisionPrompt(profile, currentData, memories) {
  const { prices, news, toolResults, date, portfolioState } = currentData;
  return {
    system: profile.description,
    user: `## Market Environment — ${date || 'today'}

**Asset:** ${profile.assetLabel || profile.responsibleFor}
**Current Price:** ${JSON.stringify(prices)}
**Recent News:**
- ${news?.join('\n- ') || 'No news available'}

## Technical Analysis Results
${fmtTools(toolResults)}

## Your Portfolio Position
${fmtPortfolio(portfolioState)}

## Retrieved Experience (Top ${memories.length} similar situations from your memory)
${fmt(memories)}

## Decision Task
Based on your expertise, the current market data, tool results, and your past experience, make an investment decision.

You MUST respond with a valid JSON object in this exact format:
{
  "market_summary": "Brief assessment of current market conditions (2-3 sentences)",
  "key_factors": ["factor 1", "factor 2", "factor 3"],
  "action": "Buy | Sell | Hold | AdjustQuantity | AdjustPrice | SetTradingConditions",
  "quantity_pct": 0.0,
  "rationale": "Detailed explanation of your decision (3-5 sentences)",
  "risk_level": "low | medium | high",
  "stop_loss_pct": 0.0,
  "take_profit_pct": 0.0,
  "confidence": 0.0
}

Notes:
- quantity_pct: fraction of your allocated budget to deploy (0.0 = nothing, 1.0 = all-in)
- stop_loss_pct: percentage below entry to set stop loss (e.g. 0.05 = 5%)
- take_profit_pct: percentage above entry to take profit (e.g. 0.10 = 10%)
- confidence: your confidence in this decision (0.0 to 1.0)`,
  };
}

// ─── 3. Reflection Update ────────────────────────────────────────────────────

function buildReflectionPrompt(profile, decision, outcome) {
  const { date, action, price, rationale, riskLevel } = decision;
  const { currentPrice, pnlPct, portfolioChangePct, daysHeld, currentDate } = outcome;
  return {
    system: profile.description,
    user: `## Previous Decision (${date})
**Action taken:** ${action} at ${price}
**Rationale:** ${rationale}
**Risk assessed:** ${riskLevel}

## Outcome (${daysHeld} trading day(s) later — ${currentDate})
**Price then:** ${price}
**Price now:**  ${currentPrice}
**P&L:** ${(pnlPct * 100).toFixed(2)}%
**Portfolio change:** ${(portfolioChangePct * 100).toFixed(2)}%

## Reflection Task
Reflect on this trade and what you have learned.

Respond with a valid JSON object:
{
  "outcome_assessment": "Was this a good/bad decision and why? (2-3 sentences)",
  "what_worked": "What aspects of the analysis were correct?",
  "what_failed": "What aspects were wrong or could be improved?",
  "lesson": "The key investment lesson from this experience (1-2 sentences)",
  "strategy_update": "How will you update your strategy based on this? (1-2 sentences)",
  "experience_score": 0.0
}

Notes:
- experience_score: how valuable this experience is for future reference (0.0 to 1.0)`,
  };
}

// ─── 4. BAC Analyst Report ────────────────────────────────────────────────────

function buildBACReportPrompt(profile, metrics, currentOutlook) {
  const { tr, sr, mdd, vol, cr, sor, period } = metrics;
  return {
    system: profile.description,
    user: `## Your Performance This Cycle (${period || 'last 30 days'})
- Total Return (TR): ${(tr * 100).toFixed(2)}%
- Sharpe Ratio (SR): ${sr?.toFixed(3) || 'N/A'}
- Maximum Drawdown (MDD): ${(mdd * 100).toFixed(2)}%
- Volatility (Vol): ${(vol * 100).toFixed(2)}%
- Calmar Ratio (CR): ${cr?.toFixed(3) || 'N/A'}
- Sortino Ratio (SoR): ${sor?.toFixed(3) || 'N/A'}

## Current Market Outlook for ${profile.assetLabel || profile.responsibleFor}
${currentOutlook || 'Market data unavailable.'}

## Budget Allocation Report Task
Prepare your budget allocation report for Manager Otto.
He will use this to decide how much capital to allocate to your asset class next cycle.

Respond with a valid JSON object:
{
  "performance_summary": "Summary of what drove your performance this cycle (2-3 sentences)",
  "performance_drivers": "Key market factors that influenced your results",
  "strengths": "What worked well in your strategy",
  "weaknesses": "What didn't work and why",
  "market_outlook": "Your outlook for ${profile.assetLabel || 'your asset'} next cycle (3-4 sentences)",
  "budget_request_pct": 0.0,
  "justification": "Why you deserve this budget allocation (2-3 sentences)",
  "projected_return_pct": 0.0,
  "projected_risk_level": "low | medium | high"
}

Notes:
- budget_request_pct: the fraction of total fund you're requesting (0.0 to 1.0)
- projected_return_pct: your estimated return for next cycle`,
  };
}

// ─── 5. BAC Otto Decision ─────────────────────────────────────────────────────

function buildBACDecisionPrompt(profile, analystReports, optimizerResult, portfolioMetrics) {
  const reportsText = Object.entries(analystReports).map(([name, r]) =>
    `### ${name}'s Report\n${JSON.stringify(r, null, 2)}`
  ).join('\n\n');

  return {
    system: profile.description,
    user: `## Budget Allocation Conference — Analyst Reports

${reportsText}

## Portfolio Optimization Results
- Expected Total Return (ETR): ${(optimizerResult.metrics.expectedTotalReturn * 100).toFixed(2)}%
- Portfolio Std Dev: ${(optimizerResult.metrics.portfolioStdDev * 100).toFixed(2)}%
- Mathematical optimal weights: ${JSON.stringify(
  optimizerResult.weights.reduce((o, w, i) => {
    const names = Object.keys(analystReports);
    o[names[i]] = (w * 100).toFixed(1) + '%';
    return o;
  }, {})
)}

## Overall Portfolio Metrics (This Cycle)
${JSON.stringify(portfolioMetrics, null, 2)}

## Budget Allocation Decision Task
Review all analyst reports and the portfolio optimization results.
Make the final budget allocation for the next 30-day cycle.
You may deviate from the mathematical optimum with strong justification.

Respond with a valid JSON object:
{
  "overall_assessment": "How did the portfolio perform overall? (2-3 sentences)",
  "individual_feedback": {
    "Dave": "Feedback on Dave's Bitcoin performance and strategy",
    "Bob": "Feedback on Bob's DJ30 performance and strategy",
    "Emily": "Feedback on Emily's FX performance and strategy"
  },
  "final_allocation": {
    "Dave": 0.0,
    "Bob": 0.0,
    "Emily": 0.0
  },
  "allocation_reasoning": "Why you chose these specific allocations (3-4 sentences)",
  "risk_outlook": "Portfolio-level risk outlook for next cycle",
  "special_instructions": "Any special instructions or warnings for the team"
}

Note: final_allocation values must sum to exactly 1.0 and all must be >= 0.`,
  };
}

// ─── 6. ESC Case Presentation ─────────────────────────────────────────────────

function buildESCCasePrompt(profile) {
  return {
    system: profile.description,
    user: `## Experience Sharing Conference — Case Presentation

Present your most instructive trade from this investment cycle for peer review.
Choose a trade that offers the most valuable learning — it could be a big win, a loss, or a surprising outcome.

Respond with a valid JSON object:
{
  "date": "YYYY-MM-DD",
  "asset": "${profile.assetLabel || profile.responsibleFor}",
  "action": "Buy | Sell | Hold",
  "entry_price": 0.0,
  "exit_price": 0.0,
  "hold_days": 0,
  "pnl_pct": 0.0,
  "position_size_pct": 0.0,
  "reasons_entry": "Why you entered this position (technical + fundamental reasons)",
  "reasons_exit": "Why you exited at this price/time",
  "market_context": "What was happening in the broader market at the time",
  "outcome": "good | bad | mixed",
  "lesson": "The key lesson from this trade (2-3 sentences)",
  "would_do_differently": "What you would change if you could do it again"
}`,
  };
}

// ─── 7. ESC Peer Response ─────────────────────────────────────────────────────

function buildESCPeerResponsePrompt(responderProfile, presenterName, presenterAsset, caseData) {
  return {
    system: responderProfile.description,
    user: `## Experience Sharing Conference — Peer Review

${presenterName} (${presenterAsset} analyst) has shared the following trade case:
${JSON.stringify(caseData, null, 2)}

## Your Response Task
As the ${responderProfile.role}, provide your cross-domain perspective on this trade.
Consider: what can YOU learn from this? What parallels exist in your own market?
What would you have done differently from your domain's perspective?

Respond with a valid JSON object:
{
  "appreciation": "What aspects of this trade impressed you or were well-executed",
  "cross_domain_insight": "A parallel or lesson from your own domain (${responderProfile.assetLabel || responderProfile.responsibleFor})",
  "suggestion": "One specific improvement or alternative approach you would suggest",
  "strategy_adoption": "Will you adopt any aspect of this into your own strategy? How?",
  "summary_lesson": "In one sentence: the most important takeaway from this case"
}`,
  };
}

// ─── 8. ESC Distillation ─────────────────────────────────────────────────────

function buildESCDistillationPrompt(agentName, allCases, allResponses) {
  const casesText = allCases.map(c =>
    `### ${c.presenterName} (${c.asset})\n${JSON.stringify(c.caseData, null, 2)}`
  ).join('\n\n');
  const responsesText = allResponses.map(r =>
    `### ${r.responderName} responding to ${r.presenterName}\n${JSON.stringify(r.response, null, 2)}`
  ).join('\n\n');

  return {
    system: `You are ${agentName}, distilling collective wisdom from an investment experience sharing session.`,
    user: `## Experience Sharing Conference — Distillation

### Cases Presented
${casesText}

### Peer Responses
${responsesText}

## Distillation Task
Distil the most valuable investment principles from this entire discussion.
These will be stored in your General Experience Memory for future decision-making.

Respond with a valid JSON object:
{
  "principles": [
    {
      "title": "Short principle title",
      "description": "Full description of this investment principle (2-3 sentences)",
      "applicable_to": "Which markets or situations does this apply to?",
      "source": "Which case/discussion inspired this principle"
    }
  ],
  "cross_domain_insights": "Key insights that apply across all asset classes (2-3 sentences)",
  "strategy_updates": "How will these principles update your personal strategy?",
  "risk_lessons": "Risk management lessons from this session"
}

Generate 3-5 principles. Focus on actionable, specific insights.`,
  };
}

// ─── 9. EMC Crisis Presentation ───────────────────────────────────────────────

function buildEMCCrisisPrompt(crisisProfile, portfolioState, lossData, marketData) {
  const { lossAmount, lossPct, daysUnderwater } = lossData;
  return {
    system: crisisProfile.description,
    user: `## EMERGENCY: Extreme Market Conference Triggered

Your portfolio has suffered significant losses and the market is in extreme conditions.

## Current Portfolio State
${JSON.stringify(portfolioState, null, 2)}

## Loss Summary
- Loss amount: ${lossAmount?.toFixed(2) || 'N/A'} USD
- Loss percentage: ${(lossPct * 100).toFixed(2)}%
- Days underwater: ${daysUnderwater || 0}

## Market Conditions
${JSON.stringify(marketData, null, 2)}

## Crisis Presentation Task
Present your situation clearly to the team. Be honest about what went wrong.

Respond with a valid JSON object:
{
  "current_holdings": "Describe your current positions and their status",
  "loss_reasons": [
    "Reason 1 for the loss",
    "Reason 2 for the loss",
    "Reason 3 for the loss"
  ],
  "market_assessment": "Your assessment of whether this is a temporary correction or deeper trend",
  "proposed_action": "Buy | Sell | Hold | Reduce",
  "proposed_quantity_pct": 0.0,
  "rationale": "Why you are proposing this action",
  "risk_if_wrong": "What happens if your assessment is incorrect"
}`,
  };
}

// ─── 10. EMC Peer Suggestion ──────────────────────────────────────────────────

function buildEMCPeerSuggestionPrompt(peerProfile, crisisAgentName, crisisAsset, crisisPresentation) {
  return {
    system: peerProfile.description,
    user: `## Extreme Market Conference — Peer Suggestion

${crisisAgentName} (${crisisAsset} analyst) is in crisis and has presented their situation:
${JSON.stringify(crisisPresentation, null, 2)}

## Your Suggestion Task
As the ${peerProfile.role}, offer your perspective on how ${crisisAgentName} should handle this situation.
Be concrete and specific. Consider: what would YOU do in this situation given your expertise?

Respond with a valid JSON object:
{
  "situation_assessment": "Your reading of the crisis situation (1-2 sentences)",
  "suggested_action": "Buy | Sell | Hold | Reduce | Diversify",
  "suggested_quantity_pct": 0.0,
  "rationale": "Why you suggest this action (2-3 sentences)",
  "cross_domain_perspective": "What does your domain (${peerProfile.assetLabel || peerProfile.role}) tell you about this situation?",
  "key_risk": "The single biggest risk you see in this situation",
  "stance": "aggressive | neutral | conservative"
}`,
  };
}

// ─── 11. EMC Otto Synthesis ───────────────────────────────────────────────────

function buildEMCSynthesisPrompt(ottoProfile, crisisPresentation, peerSuggestions, portfolioMetrics, lambda3) {
  const suggestionsText = Object.entries(peerSuggestions).map(([name, s]) =>
    `### ${name}'s suggestion\n${JSON.stringify(s, null, 2)}`
  ).join('\n\n');

  return {
    system: ottoProfile.description,
    user: `## Extreme Market Conference — Otto's Synthesis

## Crisis Presentation
${JSON.stringify(crisisPresentation, null, 2)}

## Peer Suggestions
${suggestionsText}

## Portfolio-Level Context
${JSON.stringify(portfolioMetrics, null, 2)}

## Synthesis Task
As Fund Manager, synthesize the peer suggestions into a single balanced recommendation.
The weight of expert (outside) perspective vs peer suggestions is controlled by λ₃ = ${lambda3}.
A higher λ₃ means you weight the conservative/protective view more.

Respond with a valid JSON object:
{
  "situation_summary": "Your assessment of the crisis in 2-3 sentences",
  "peer_feedback_evaluation": "How you weigh the different peer suggestions and why",
  "balanced_recommendation": "Your synthesized recommendation",
  "recommended_action": "Buy | Sell | Hold | Reduce",
  "recommended_quantity_pct": 0.0,
  "trigger_conditions": {
    "take_profit_pct": 0.0,
    "stop_loss_pct": 0.0,
    "review_in_days": 0
  },
  "rationale": "Full reasoning for your recommendation (3-4 sentences)",
  "portfolio_protection_measures": "Any broader portfolio protection steps for the whole team"
}`,
  };
}

// ─── 12. EMC Final Decision ───────────────────────────────────────────────────

function buildEMCFinalDecisionPrompt(crisisProfile, crisisPresentation, peerSuggestions, ottoGuidance) {
  const suggestionsText = Object.entries(peerSuggestions).map(([name, s]) =>
    `**${name}:** ${s.suggested_action} (${s.stance}) — ${s.rationale}`
  ).join('\n');

  return {
    system: crisisProfile.description,
    user: `## Extreme Market Conference — Your Final Decision

## Your Crisis Presentation
${JSON.stringify(crisisPresentation, null, 2)}

## Peer Suggestions Received
${suggestionsText}

## Manager Otto's Guidance
${JSON.stringify(ottoGuidance, null, 2)}

## Final Decision Task
Consider all the input from your peers and Otto's guidance.
Make your final, considered decision on how to proceed.

Respond with a valid JSON object:
{
  "peers_considered": "How you weighed the peer suggestions (1-2 sentences)",
  "otto_guidance_incorporated": "How Otto's guidance influenced your decision (1-2 sentences)",
  "final_action": "Buy | Sell | Hold | Reduce",
  "final_quantity_pct": 0.0,
  "trigger_conditions": {
    "take_profit_pct": 0.0,
    "stop_loss_pct": 0.0,
    "review_in_days": 0
  },
  "execution_plan": "Step-by-step how you will execute this decision",
  "rationale": "Final reasoning incorporating all input (3-4 sentences)",
  "lessons_for_memory": "What you will store in your reflection memory from this event"
}`,
  };
}

module.exports = {
  buildSummarizedQueryPrompt,
  buildDecisionPrompt,
  buildReflectionPrompt,
  buildBACReportPrompt,
  buildBACDecisionPrompt,
  buildESCCasePrompt,
  buildESCPeerResponsePrompt,
  buildESCDistillationPrompt,
  buildEMCCrisisPrompt,
  buildEMCPeerSuggestionPrompt,
  buildEMCSynthesisPrompt,
  buildEMCFinalDecisionPrompt,
};
