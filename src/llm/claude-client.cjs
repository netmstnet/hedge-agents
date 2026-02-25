'use strict';

/**
 * claude-client.cjs — Anthropic Claude API client.
 *
 * Supports:
 *   - Single-turn completions (system prompt + user message)
 *   - Multi-turn conversations (message history array — needed for conferences)
 *   - Automatic retry on rate limit (429)
 *   - Structured JSON response parsing with validation
 *
 * Pure Node.js https module — no external SDK.
 * Ported and extended from BrewBoard's llm-client.cjs.
 */

const https  = require('https');
const logger = require('../utils/logger.cjs');

const MOD = 'llm:claude';

class ClaudeClient {
  /**
   * @param {object} cfg - { apiKey, model, temperature, maxRetries, retryDelayMs }
   */
  constructor(cfg) {
    if (!cfg.apiKey) throw new Error('ClaudeClient: apiKey is required');
    this._apiKey       = cfg.apiKey;
    this._model        = cfg.model        || 'claude-sonnet-4-6';
    this._temperature  = cfg.temperature  ?? 0.7;
    this._maxRetries   = cfg.maxRetries   ?? 3;
    this._retryDelayMs = cfg.retryDelayMs ?? 5000;
  }

  get model() { return this._model; }

  /**
   * Single-turn completion.
   *
   * @param {string} userPrompt
   * @param {string} [systemPrompt]
   * @param {number} [maxTokens=1500]
   * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number }>}
   */
  async complete(userPrompt, systemPrompt, maxTokens = 1500) {
    return this._call({
      system:   systemPrompt || undefined,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens,
    });
  }

  /**
   * Multi-turn conversation (for conferences).
   * Accepts an array of { role: 'user'|'assistant', content: string } messages.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {string} [systemPrompt]
   * @param {number} [maxTokens=1500]
   * @returns {Promise<{ text: string, inputTokens: number, outputTokens: number }>}
   */
  async converse(messages, systemPrompt, maxTokens = 1500) {
    return this._call({
      system:   systemPrompt || undefined,
      messages,
      maxTokens,
    });
  }

  /**
   * Complete and parse JSON response. Retries with a correction prompt if JSON
   * is malformed.
   *
   * @param {string} userPrompt
   * @param {string} [systemPrompt]
   * @param {number} [maxTokens=1500]
   * @returns {Promise<object>} Parsed JSON object
   */
  async completeJSON(userPrompt, systemPrompt, maxTokens = 1500) {
    const systemWithJSON = (systemPrompt || '') +
      '\n\nIMPORTANT: Your response MUST be valid JSON only. No markdown, no code fences, no explanatory text — pure JSON object.';
    const { text } = await this.complete(userPrompt, systemWithJSON, maxTokens);
    return this._parseJSON(text, userPrompt, systemWithJSON, maxTokens);
  }

  /**
   * Multi-turn complete and parse JSON.
   */
  async converseJSON(messages, systemPrompt, maxTokens = 1500) {
    const systemWithJSON = (systemPrompt || '') +
      '\n\nIMPORTANT: Your response MUST be valid JSON only. No markdown, no code fences, no explanatory text — pure JSON object.';
    const { text } = await this.converse(messages, systemWithJSON, maxTokens);
    return this._parseJSON(text, null, systemWithJSON, maxTokens, messages);
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  async _parseJSON(text, userPrompt, systemPrompt, maxTokens, messages) {
    // Strip markdown code fences if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
    }
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      logger.warn(MOD, 'JSON parse failed, attempting correction', { raw: cleaned.slice(0, 200) });
      // One retry with explicit correction prompt
      const correctionMsg = `The previous response was not valid JSON. Here is what was returned:\n\n${cleaned}\n\nPlease return ONLY a valid JSON object, nothing else.`;
      const retry = messages
        ? await this.converseJSON([...messages, { role: 'assistant', content: text }, { role: 'user', content: correctionMsg }], systemPrompt, maxTokens)
        : await this.completeJSON(correctionMsg, systemPrompt, maxTokens);
      return retry;
    }
  }

  async _call({ system, messages, maxTokens }) {
    const body = JSON.stringify({
      model:       this._model,
      max_tokens:  maxTokens,
      temperature: this._temperature,
      ...(system ? { system } : {}),
      messages,
    });

    let attempt = 0;
    while (attempt <= this._maxRetries) {
      try {
        const result = await this._request(body);
        return result;
      } catch (err) {
        if (err.statusCode === 429 && attempt < this._maxRetries) {
          attempt++;
          logger.warn(MOD, `Rate limit hit, retry ${attempt}/${this._maxRetries} in ${this._retryDelayMs}ms`);
          await sleep(this._retryDelayMs * attempt);
        } else {
          throw err;
        }
      }
    }
  }

  _request(body) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'x-api-key':         this._apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
          'content-length':    Buffer.byteLength(body),
        },
      };

      const req = https.request(options, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            return reject(new Error(`Failed to parse Claude response: ${e.message}`));
          }

          if (res.statusCode !== 200) {
            const errMsg = parsed.error ? parsed.error.message : raw.slice(0, 300);
            const err    = new Error(`Claude API error ${res.statusCode}: ${errMsg}`);
            err.statusCode = res.statusCode;
            logger.error(MOD, `API error ${res.statusCode}: ${errMsg}`);
            return reject(err);
          }

          const text = parsed.content?.[0]?.text;
          if (!text) {
            return reject(new Error('Unexpected Claude response: no content[0].text'));
          }

          const inputTokens  = parsed.usage?.input_tokens  || 0;
          const outputTokens = parsed.usage?.output_tokens || 0;
          logger.debug(MOD, `tokens in=${inputTokens} out=${outputTokens}`);

          resolve({ text, inputTokens, outputTokens });
        });
      });

      req.on('error', err => {
        logger.error(MOD, `HTTPS error: ${err.message}`);
        reject(err);
      });

      req.write(body);
      req.end();
    });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Factory — creates a ClaudeClient from app config.
 */
function createClaudeClient(cfg) {
  return new ClaudeClient({
    apiKey:       cfg.llm.apiKey,
    model:        cfg.llm.model,
    temperature:  cfg.llm.temperature,
    maxRetries:   cfg.llm.maxRetries,
    retryDelayMs: cfg.llm.retryDelayMs,
  });
}

module.exports = { ClaudeClient, createClaudeClient };
