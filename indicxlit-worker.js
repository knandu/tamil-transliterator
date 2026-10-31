"use strict";
const PAD = 1, EOS = 2, UNK = 3, MAXIMUM_PREFIX = 128;
// FP32 score arithmetic keeps beam ordering stable at the model boundary.
const f32 = Math.fround;
let encoder, decoder, sourceIds, targetSymbols, initialization;
let stage = "Not loaded", latestRequest = 0;
let queue = Promise.resolve();
const cache = new Map();
const timings = {};

function status(message) {
  stage = message;
  self.postMessage({ type: "status", stage });
}
async function asset(name) {
  const response = await fetch(`assets/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response;
}
async function initialize() {
  if (initialization) return initialization;
  initialization = (async () => {
    const started = performance.now();
    status("Loading runtime");
    importScripts("runtime/ort.wasm.min.js");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = new URL("runtime/", self.location.href).href;
    ort.env.logLevel = "warning";
    timings.runtimeScriptMs = performance.now() - started;
    status("Loading vocabulary");
    const vocabularyStart = performance.now();
    const source = await (await asset("source-vocab.json")).json();
    targetSymbols = await (await asset("target-vocab.json")).json();
    if (!Array.isArray(source) || !Array.isArray(targetSymbols) ||
        !source.every(symbol => typeof symbol === "string") ||
        !targetSymbols.every(symbol => typeof symbol === "string"))
      throw new Error("Invalid vocabulary arrays.");
    sourceIds = new Map(source.map((symbol, index) => [symbol, index]));
    if (!sourceIds.has("__ta__")) throw new Error("Missing Tamil language token.");
    timings.vocabularyMs = performance.now() - vocabularyStart;
    status("Loading models");
    const modelStart = performance.now();
    const encoderBytes = await (await asset("indicxlit-encoder.onnx")).arrayBuffer();
    const decoderBytes = await (await asset("indicxlit-decoder.onnx")).arrayBuffer();
    timings.modelFetchMs = performance.now() - modelStart;
    status("Creating encoder session");
    const encoderStart = performance.now();
    const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    encoder = await ort.InferenceSession.create(encoderBytes, options);
    timings.encoderSessionMs = performance.now() - encoderStart;
    status("Creating decoder session");
    const decoderStart = performance.now();
    decoder = await ort.InferenceSession.create(decoderBytes, options);
    timings.decoderSessionMs = performance.now() - decoderStart;
    timings.initializeMs = performance.now() - started;
    stage = "Ready";
    return {
      timings, versions: ort.env.versions, executionProvider: "wasm", threads: 1,
      userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      contracts: {
        encoder: { inputs: encoder.inputMetadata, outputs: encoder.outputMetadata },
        decoder: { inputs: decoder.inputMetadata, outputs: decoder.outputMetadata }
      }
    };
  })();
  return initialization;
}

function logSoftmax(logits, offset, count) {
  let maximum = -Infinity;
  for (let i = 0; i < count; i++) maximum = Math.max(maximum, logits[offset + i]);
  let sum = 0;
  for (let i = 0; i < count; i++)
    sum = f32(sum + f32(Math.exp(f32(logits[offset + i] - maximum))));
  const normalizer = f32(maximum + f32(Math.log(sum)));
  return Float32Array.from({ length: count }, (_, i) => f32(logits[offset + i] - normalizer));
}
function normalizeCandidate(text) {
  return text.normalize("NFC").replace(/\u200c+$/, "");
}
async function generateRaw(word, beamSize) {
  // Beam selection uses a 2x-beam shortlist, flattened-index ties, initial EOS suppression
  // and ignored masks, with length-normalized final scores.
  // Keep ordered raw Top-8 stable for tests\transliteration-corpus.json.
  stage = "Running encoder";
  const source = [sourceIds.get("__ta__"), ...Array.from(word, c => sourceIds.get(c) ?? UNK), EOS];
  const output = await encoder.run({
    src_tokens: new ort.Tensor("int64", BigInt64Array.from(source, BigInt), [1, source.length])
  });
  const encoded = output.encoder_out, mask = output.encoder_padding_mask;
  const sourceLength = encoded.dims[0], hiddenSize = encoded.dims[2];
  let beams = [{ tokens: [EOS], score: 0 }], ignored = Array(beamSize).fill(false);
  const finalized = [];
  for (let step = 0; step < MAXIMUM_PREFIX - 1; step++) {
    stage = `Running decoder (step ${step})`;
    const beamCount = beams.length;
    const prefixes = BigInt64Array.from(beams.flatMap(beam => beam.tokens), BigInt);
    const repeated = new Float32Array(sourceLength * beamCount * hiddenSize);
    for (let position = 0; position < sourceLength; position++)
      for (let beam = 0; beam < beamCount; beam++)
        repeated.set(encoded.data.subarray(position * hiddenSize, (position + 1) * hiddenSize),
          (position * beamCount + beam) * hiddenSize);
    const repeatedMask = new Uint8Array(sourceLength * beamCount);
    for (let beam = 0; beam < beamCount; beam++) repeatedMask.set(mask.data, beam * sourceLength);
    const decoded = await decoder.run({
      prev_output_tokens: new ort.Tensor("int64", prefixes, [beamCount, step + 1]),
      encoder_out: new ort.Tensor("float32", repeated, [sourceLength, beamCount, hiddenSize]),
      encoder_padding_mask: new ort.Tensor("bool", repeatedMask, [beamCount, sourceLength])
    });
    const logits = decoded.logits, vocabularySize = logits.dims[2], expansions = [];
    for (let beam = 0; beam < (step === 0 ? 1 : beamCount); beam++) {
      const offset = (beam * (step + 1) + step) * vocabularySize;
      const probabilities = logSoftmax(logits.data, offset, vocabularySize);
      probabilities[PAD] = -Infinity;
      if (step === 0) probabilities[EOS] = -Infinity;
      for (let token = 0; token < vocabularySize; token++)
        expansions.push({ beam, token, score: f32(beams[beam].score + probabilities[token]) });
    }
    const candidateCount = Math.min(beamSize * 2, expansions.length - 1);
    const candidates = expansions.sort((a, b) =>
      b.score - a.score || (a.beam * vocabularySize + a.token) - (b.beam * vocabularySize + b.token)
    ).slice(0, candidateCount);
    for (let rank = 0; rank < Math.min(beamSize, candidates.length); rank++) {
      const candidate = candidates[rank];
      if (candidate.token === EOS && !ignored[rank])
        finalized.push({
          tokens: [...beams[candidate.beam].tokens.slice(1), EOS],
          score: f32(candidate.score / (step + 1))
        });
    }
    if (finalized.length >= beamSize) break;
    const active = candidates.map((candidate, rank) => ({
      candidate, rank, activeMask: rank + (
        candidate.token === EOS || (rank < beamSize && ignored[rank]) ? candidateCount : 0)
    })).sort((a, b) => a.activeMask - b.activeMask || a.rank - b.rank).slice(0, beamSize);
    ignored = active.map(item => item.activeMask >= candidateCount);
    if (ignored.every(Boolean)) break;
    beams = active.map(({ candidate }) => ({
      tokens: [...beams[candidate.beam].tokens, candidate.token], score: candidate.score
    }));
  }
  return finalized.slice(0, beamSize).sort((a, b) => b.score - a.score).map(beam => {
    const end = beam.tokens.indexOf(EOS);
    return { text: beam.tokens.slice(0, end < 0 ? undefined : end).map(token => targetSymbols[token]).join(""), score: beam.score };
  });
}

function queueWorkerRequest({ data }) {
  // Supersede queued work immediately; already-running inference finishes and may warm the cache.
  if (data.type === "transliterate") latestRequest = Math.max(latestRequest, data.id);
  queue = queue.then(async () => {
    try {
      if (data.type === "initialize") {
        const details = await initialize();
        self.postMessage({ type: "ready", id: data.id, ...details });
      } else if (data.type === "transliterate") {
        if (!Number.isSafeInteger(data.id) || data.id < 1) throw new Error("Invalid request ID.");
        if (data.id < latestRequest) {
          self.postMessage({ type: "cancelled", id: data.id });
          return;
        }
        const roman = typeof data.roman === "string" ? data.roman.trim() : "";
        if (!/^[A-Za-z]{1,80}$/.test(roman)) {
          self.postMessage({ type: "error", id: data.id, code: "invalid_roman_word", stage: "Validation",
            message: "Enter one Roman word of 1 to 80 letters." });
          return;
        }
        const limit = data.limit ?? 8;
        if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Candidate limit must be 1 to 8.");
        await initialize();
        const key = `${limit}:${roman.toLowerCase()}`;
        const started = performance.now();
        let raw = !data.uncached && cache.get(key);
        const cached = Boolean(raw);
        if (!raw) {
          raw = await generateRaw(roman.toLowerCase(), limit);
          cache.set(key, raw);
          if (cache.size > 512) cache.delete(cache.keys().next().value);
        }
        const candidates = [...new Set(raw.map(candidate => normalizeCandidate(candidate.text))
          .filter(text => /[\u0b80-\u0bff]/.test(text)))].slice(0, limit);
        if (candidates.length === 0) throw new Error("IndicXlit produced no Tamil candidates.");
        stage = "Ready";
        self.postMessage({ type: "result", id: data.id, roman, raw, candidates, cached,
          source: "IndicXlit raw",
          elapsedMs: performance.now() - started,
          resources: performance.getEntriesByType("resource").map(entry => ({
            url: entry.name, bytes: entry.decodedBodySize
          })) });
      } else throw new Error(`Unknown worker message: ${data.type}`);
    } catch (error) {
      self.postMessage({ type: "error", id: data.id, stage, message: String(error.stack || error) });
    }
  });
}
self.onmessage = queueWorkerRequest;
