'use strict';

/**
 * embeddings.cjs — Text embedding providers.
 *
 * Provider 1: Voyage AI (api.voyageai.com)
 *   Best quality. Requires VOYAGE_API_KEY in secrets.
 *   Model: voyage-finance-2 (finance-tuned) or voyage-2 (general).
 *
 * Provider 2: TF-IDF cosine similarity (zero dependencies, offline)
 *   Fallback when no Voyage API key. Good enough for structured financial text.
 *
 * Usage:
 *   const { createEmbeddingProvider } = require('./embeddings.cjs');
 *   const provider = createEmbeddingProvider(config);
 *   const vector = await provider.embed('bitcoin price rising on macro optimism');
 */

const https  = require('https');
const logger = require('../utils/logger.cjs');
const { cosineSimilarity } = require('../utils/math.cjs');

const MOD = 'memory:embeddings';

// ─── Voyage AI provider ──────────────────────────────────────────────────────

class VoyageEmbeddingProvider {
  constructor(apiKey, model = 'voyage-finance-2') {
    this._apiKey = apiKey;
    this._model  = model;
    this.type    = 'voyage';
  }

  async embed(text) {
    const body = JSON.stringify({
      input: [text],
      model: this._model,
    });

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.voyageai.com',
        path:     '/v1/embeddings',
        method:   'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(raw);
            if (res.statusCode !== 200) {
              return reject(new Error(`Voyage API error ${res.statusCode}: ${raw.slice(0, 200)}`));
            }
            const embedding = parsed.data?.[0]?.embedding;
            if (!embedding) return reject(new Error('No embedding in Voyage response'));
            resolve(embedding);
          } catch (e) {
            reject(new Error(`Failed to parse Voyage response: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Embed multiple texts in one batch request */
  async embedBatch(texts) {
    const body = JSON.stringify({ input: texts, model: this._model });
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.voyageai.com',
        path:     '/v1/embeddings',
        method:   'POST',
        headers: {
          'Authorization':  `Bearer ${this._apiKey}`,
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(options, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode !== 200) return reject(new Error(`Voyage batch error ${res.statusCode}`));
            resolve(parsed.data.map(d => d.embedding));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Cosine similarity between two embedded texts */
  async similarity(textA, textB) {
    const [embA, embB] = await Promise.all([this.embed(textA), this.embed(textB)]);
    return cosineSimilarity(embA, embB);
  }
}

// ─── TF-IDF cosine similarity provider ───────────────────────────────────────

const STOP_WORDS = new Set([
  'the','a','an','is','it','in','on','at','to','of','and','or','but','for',
  'with','this','that','was','were','are','be','been','by','from','as','have',
  'has','had','will','would','could','should','may','might','shall','do','does',
  'did','not','no','so','if','its','their','they','we','he','she','i','you',
  'our','my','your','his','her','which','who','what','when','where','how',
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s%$.-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

function buildTfidfVector(tokens, vocabulary) {
  const tf = {};
  tokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });
  const vector = new Array(vocabulary.length).fill(0);
  vocabulary.forEach((word, i) => {
    vector[i] = (tf[word] || 0) / tokens.length;
  });
  return vector;
}

class TfidfEmbeddingProvider {
  constructor() {
    this.type = 'tfidf';
    this._vocabulary = [];
    this._memoryVocab = new Map(); // memorised vocabularies per corpus
  }

  /** Generate token list (used instead of float vector) */
  async embed(text) {
    // Returns tokens array — stored as tfidf_tokens in DB
    return tokenize(text);
  }

  /** Not applicable for TF-IDF — returns tokens instead */
  async embedBatch(texts) {
    return texts.map(t => tokenize(t));
  }

  /**
   * Compute cosine similarity between a query and stored memories.
   * Uses TF-IDF with the corpus vocabulary built from all memory tokens.
   *
   * @param {string[]} queryTokens   - From embed(queryText)
   * @param {string[][]} corpusTokens - Array of token arrays from stored memories
   * @returns {number[]} Similarity scores parallel to corpusTokens
   */
  batchSimilarity(queryTokens, corpusTokens) {
    // Build vocabulary from corpus + query
    const vocabSet = new Set(queryTokens);
    corpusTokens.forEach(tokens => tokens.forEach(t => vocabSet.add(t)));
    const vocabulary = [...vocabSet];

    const queryVec = buildTfidfVector(queryTokens, vocabulary);
    return corpusTokens.map(tokens => {
      const docVec = buildTfidfVector(tokens, vocabulary);
      return cosineSimilarity(queryVec, docVec);
    });
  }
}

// ─── Retrieval ────────────────────────────────────────────────────────────────

/**
 * Retrieve top-K most similar memories from a list.
 *
 * @param {object} provider       - VoyageEmbeddingProvider or TfidfEmbeddingProvider
 * @param {string} queryText      - The summarized query Qt
 * @param {object[]} memories     - From MemoryStore.getRetrievableMemories()
 * @param {number} K              - How many to return (default 5)
 * @returns {Promise<object[]>}   Top K memories sorted by relevance
 */
async function retrieveTopK(provider, queryText, memories, K = 5) {
  if (!memories.length) return [];

  if (provider.type === 'voyage') {
    // Embed query
    const queryVec = await provider.embed(queryText);

    // Score each memory
    const scored = memories
      .filter(m => m.embedding && m.embedding.length > 0)
      .map(m => ({
        ...m,
        score: cosineSimilarity(queryVec, m.embedding),
      }));

    // If some memories have no embeddings, include them with score 0
    const noEmbed = memories.filter(m => !m.embedding || !m.embedding.length).map(m => ({ ...m, score: 0 }));

    return [...scored, ...noEmbed]
      .sort((a, b) => b.score - a.score)
      .slice(0, K);

  } else {
    // TF-IDF path
    const queryTokens = await provider.embed(queryText);
    const corpusTokens = memories.map(m => m.tfidfTokens || []);
    const scores = provider.batchSimilarity(queryTokens, corpusTokens);

    return memories
      .map((m, i) => ({ ...m, score: scores[i] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, K);
  }
}

/**
 * Index a batch of memories: compute embeddings and store them back.
 *
 * @param {object} provider
 * @param {object} memoryStore  - MemoryStore instance
 * @param {object[]} memories   - Unindexed memories (no embedding or tfidfTokens)
 */
async function indexMemories(provider, memoryStore, memories) {
  const unindexed = memories.filter(m =>
    provider.type === 'voyage' ? !m.embedding : !m.tfidfTokens
  );
  if (!unindexed.length) return;

  logger.info(MOD, `Indexing ${unindexed.length} memories via ${provider.type}`);

  const texts = unindexed.map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
  );

  const embeddings = await provider.embedBatch(texts);

  for (let i = 0; i < unindexed.length; i++) {
    if (provider.type === 'voyage') {
      memoryStore.updateMemory(unindexed[i].id, { embedding: embeddings[i] });
    } else {
      memoryStore.updateMemory(unindexed[i].id, { tfidfTokens: embeddings[i] });
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

function createEmbeddingProvider(cfg) {
  if (cfg.embeddings?.voyageApiKey) {
    logger.info(MOD, 'Using Voyage AI embeddings (voyage-finance-2)');
    return new VoyageEmbeddingProvider(cfg.embeddings.voyageApiKey);
  }
  logger.info(MOD, 'Using TF-IDF embeddings (no VOYAGE_API_KEY set)');
  return new TfidfEmbeddingProvider();
}

module.exports = {
  VoyageEmbeddingProvider,
  TfidfEmbeddingProvider,
  createEmbeddingProvider,
  retrieveTopK,
  indexMemories,
  tokenize,
};
