"use strict";

// COORD-143: [Memory] Phase 3 — the VECTOR-SIMILARITY layer of the semantic
// retriever.
//
// Per coord/docs/MEMORY_ARCHITECTURE.md §6 the §6 pipeline places vector
// similarity AFTER exact/BM25 and BEFORE graph links. §10 is emphatic: "Don't
// lead with a vector DB ... vectors are Phase 3, gated on measured lift." So
// this layer is built to be MEASURED, not trusted — and it adds ZERO runtime
// dependencies and NO bundled model.
//
// Two ways to get a vector, both dependency-free:
//
//   (a) PLUGGABLE PROVIDER (the real-adopter path). `embedWith(provider, texts)`
//       accepts any object exposing `embed(text) -> number[]`. An adopter wires
//       their own embedding service/model here. When NO provider is supplied the
//       vector path is simply OFF and the deterministic Phase-1 baseline stands
//       (graceful skip — §12 challenge 7). There is NO hard dependency on any
//       provider being present.
//
//   (b) LOCAL HASHED EMBEDDING (the measurement path). `localEmbedder()` returns
//       a provider that produces a deterministic, dependency-free embedding from
//       hashed token + char-trigram features (the "hashing trick"): each feature
//       is hashed into one of D dimensions and L2-normalized. This is a genuine
//       distributional vector usable for cosine similarity — NOT a learned model,
//       NO npm dep, NO network — purely so the eval harness CAN measure whether a
//       vector path helps at all on this corpus before anyone trusts it.
//
// HONEST FRAMING: the local hashed embedding is a weak lexical embedding (it
// captures token + sub-token overlap, not learned semantics). That is the POINT:
// it lets the harness answer "does adding a cheap vector signal beat the BM25
// baseline on the real benchmark?" with real numbers. If it doesn't, the layer
// stays OFF (recorded truthfully). It is the MEASUREMENT instrument, not a claim
// of semantic understanding.
//
// Embeddings are a DERIVED, REBUILDABLE cache (§6 principle 1): coord/memory/
// embeddings/ is gitignored. Losing it loses no authority.

const crypto = require("crypto");

// Default embedding dimensionality for the local hashed embedder. Small enough
// to stay cheap, large enough to limit hash collisions on a tiny corpus.
const DEFAULT_DIM = 256;

function tokenize(text) {
  // Reuse the same lexical surface as recall: lowercase, alnum + internal
  // hyphen/underscore tokens. (We deliberately keep this self-contained — a
  // leaf module — rather than importing recall to avoid a cycle.)
  if (typeof text !== "string" || !text) {
    return [];
  }
  return text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || [];
}

// Stable 32-bit-ish hash of a feature string -> a bucket in [0, dim).
function hashToBucket(feature, dim) {
  const h = crypto.createHash("sha1").update(feature).digest();
  // Use the first 4 bytes as an unsigned int.
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return n % dim;
}

// Sign hash (second slice of the digest) so collisions don't always add — the
// standard signed hashing trick reduces collision bias.
function hashSign(feature) {
  const h = crypto.createHash("sha1").update(`sign:${feature}`).digest();
  return (h[0] & 1) === 0 ? 1 : -1;
}

// Build a sparse->dense hashed feature vector from token unigrams + char
// trigrams of each token. L2-normalized so cosine == dot product.
function hashedEmbedding(text, dim = DEFAULT_DIM) {
  const vec = new Float64Array(dim);
  const tokens = tokenize(text);
  const addFeature = (feature) => {
    const bucket = hashToBucket(feature, dim);
    vec[bucket] += hashSign(feature);
  };
  for (const tok of tokens) {
    addFeature(`t:${tok}`);
    // char trigrams capture sub-token overlap ("repair"/"repaired").
    const padded = `^${tok}$`;
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      addFeature(`c:${padded.slice(i, i + 3)}`);
    }
  }
  // L2 normalize.
  let norm = 0;
  for (let i = 0; i < dim; i += 1) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i += 1) {
      vec[i] /= norm;
    }
  }
  return Array.from(vec);
}

// A provider is { embed(text) -> number[] }. The local provider is fully
// deterministic + dependency-free.
function localEmbedder(options = {}) {
  const dim = Number.isInteger(options.dim) && options.dim > 0 ? options.dim : DEFAULT_DIM;
  return {
    name: "local-hashed",
    dim,
    embed: (text) => hashedEmbedding(text, dim),
  };
}

// Validate a candidate provider object. Returns true iff it can be used.
function isProvider(provider) {
  return Boolean(provider && typeof provider.embed === "function");
}

// Embed many texts with a provider (or null). Returns null when no usable
// provider is present (vector path OFF — graceful skip), else an array of
// vectors aligned with `texts`.
function embedWith(provider, texts) {
  if (!isProvider(provider)) {
    return null;
  }
  return texts.map((t) => provider.embed(String(t == null ? "" : t)));
}

// Cosine similarity of two equal-length numeric vectors. Vectors from the local
// embedder are already L2-normalized, but we normalize defensively so an
// adopter-supplied provider need not pre-normalize.
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Score a corpus against a query vector. `docVectors` is aligned with `docs`.
// Returns [{ index, score }] sorted desc, deterministic tie-break by index.
function rankByVector(queryVector, docVectors) {
  if (!Array.isArray(queryVector) || !Array.isArray(docVectors)) {
    return [];
  }
  return docVectors
    .map((dv, index) => ({ index, score: cosine(queryVector, dv) }))
    .sort((x, y) => (y.score === x.score ? x.index - y.index : y.score - x.score));
}

module.exports = {
  DEFAULT_DIM,
  tokenize,
  hashedEmbedding,
  localEmbedder,
  isProvider,
  embedWith,
  cosine,
  rankByVector,
};
