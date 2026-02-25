'use strict';

/**
 * config.cjs — Centralised config loader.
 * Merges JSON config files with environment variable overrides.
 * Secrets loaded from .secrets file (same pattern as BrewBoard).
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ─── Load .secrets file (KEY=value format) ────────────────────────────────────
function loadSecrets() {
  const secretsPath = path.join(ROOT, '.secrets');
  if (!fs.existsSync(secretsPath)) return {};
  const secrets = {};
  fs.readFileSync(secretsPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.split('=');
    if (k && v.length) secrets[k.trim()] = v.join('=').trim();
  });
  return secrets;
}

// ─── Load a JSON config file ───────────────────────────────────────────────────
function loadJson(filename) {
  const p = path.join(ROOT, 'config', filename);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse config/${filename}: ${e.message}`);
  }
}

const secrets  = loadSecrets();
const agentCfg = loadJson('agents.json');
const dataCfg  = loadJson('data-sources.json');
const portCfg  = loadJson('portfolio.json');
const schedCfg = loadJson('schedule.json');
const llmCfg   = loadJson('llm.json');

const config = {
  env: process.env.NODE_ENV || 'development',
  root: ROOT,

  llm: {
    apiKey:       secrets.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
    model:        secrets.ANTHROPIC_MODEL   || process.env.ANTHROPIC_MODEL   || llmCfg.model || 'claude-sonnet-4-6',
    temperature:  llmCfg.temperature || 0.7,
    maxTokens:    llmCfg.maxTokens   || {},
    retryOnRateLimit: llmCfg.retryOnRateLimit !== false,
    retryDelayMs: llmCfg.retryDelayMs || 5000,
    maxRetries:   llmCfg.maxRetries   || 3,
    memory:       llmCfg.memory       || { retrievalK: 5 },
  },

  embeddings: {
    voyageApiKey: secrets.VOYAGE_API_KEY || process.env.VOYAGE_API_KEY || '',
    provider: (secrets.VOYAGE_API_KEY || process.env.VOYAGE_API_KEY) ? 'voyage' : 'tfidf',
  },

  agents:    agentCfg,
  data:      dataCfg,
  portfolio: {
    ...portCfg,
    startingCapital: parseInt(process.env.STARTING_CAPITAL || portCfg.startingCapital || 100000),
  },
  schedule:  schedCfg,

  db: {
    path: path.join(ROOT, 'data', 'hedge-agents.db'),
  },

  news: {
    alpacaKey:    secrets.ALPACA_NEWS_API_KEY || process.env.ALPACA_NEWS_API_KEY || '',
    alpacaSecret: secrets.ALPACA_NEWS_SECRET  || process.env.ALPACA_NEWS_SECRET  || '',
  },
};

// Warn if no API key
if (!config.llm.apiKey) {
  // eslint-disable-next-line no-console
  console.warn('[config] WARNING: ANTHROPIC_API_KEY not set — LLM calls will fail');
}

module.exports = config;
