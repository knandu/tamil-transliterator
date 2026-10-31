"use strict";
window.runRegression = async function () {
  const worker = new Worker("../indicxlit-worker.js");
  let sequence = 0;
  const pending = new Map();
  const call = message => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...message, id });
  });
  worker.onmessage = ({ data }) => {
    if (data.type === "status") return;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.type === "error") request.reject(Object.assign(new Error(data.message), { code: data.code }));
    else request.resolve(data);
  };
  worker.onerror = event => {
    for (const request of pending.values()) request.reject(new Error(event.message));
    pending.clear();
  };
  const started = performance.now();
  try {
    const response = await fetch("transliteration-corpus.json");
    if (!response.ok) throw new Error(`Validation corpus: HTTP ${response.status}`);
    const fixture = await response.json();
    const initialization = await call({ type: "initialize" });
    const cases = [];
    for (const expected of fixture.cases) {
      const actual = await call({ type: "transliterate", roman: expected.roman, limit: fixture.beamSize, uncached: true });
      const compare = (expectedRows, result) => {
        const ordered = JSON.stringify(expectedRows.map(item => item.text)) === JSON.stringify(result.map(item => item.text));
        const maxScoreDifference = Math.max(0, ...expectedRows.map((item, index) => Math.abs(item.score - (result[index]?.score ?? Infinity))));
        return { passed: ordered && maxScoreDifference <= fixture.scoreTolerance, ordered, maxScoreDifference };
      };
      cases.push({ roman: expected.roman, raw: compare(expected.raw, actual.raw), elapsedMs: actual.elapsedMs });
    }
    const invalid = [];
    for (const expected of fixture.invalid) {
      try {
        await call({ type: "transliterate", roman: expected.roman });
        invalid.push({ roman: expected.roman, passed: false });
      } catch (error) { invalid.push({ roman: expected.roman, passed: error.code === expected.code }); }
    }
    const warm = await call({ type: "transliterate", roman: "vendum", uncached: true });
    const cached = await call({ type: "transliterate", roman: "vendum" });
    const runtimeMatches = initialization.versions.web === fixture.runtime;
    const cacheBehavior = warm.cached === false && cached.cached === true;
    const resources = cached.resources.map(item => item.url);
    const localNeuralOnly = resources.every(url => new URL(url).origin === location.origin &&
      !url.includes("ta-unigram") && !new URL(url).pathname.startsWith("/api/"));
    return { passed: cases.every(item => item.raw.passed) && invalid.every(item => item.passed) &&
        runtimeMatches && cacheBehavior && localNeuralOnly,
      initialization, cases, invalid, warm, cached, runtimeMatches, cacheBehavior, localNeuralOnly,
      totalMs: performance.now() - started,
      requests: performance.getEntriesByType("resource").map(entry => entry.name) };
  } catch (error) { return { passed: false, error: String(error.stack || error) }; }
  finally { worker.terminate(); }
};
document.getElementById("run").addEventListener("click", async () => {
  document.getElementById("output").textContent = JSON.stringify(await window.runRegression(), null, 2);
});
