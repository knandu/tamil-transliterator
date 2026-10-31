"use strict";

const typingStats = document.getElementById("typing-stats");
const inferenceStats = document.getElementById("inference-stats");
const wordCount = document.getElementById("word-count");
const diagnostics = { messages: [], discardedResults: 0 };
window.demoDiagnostics = diagnostics;

let typingStart, typingFrame, pendingEdits = [], typingSamples = [], typingEdits = 0;
const candidateRequestStarts = new Map();
let committedWords = 0, liveWords = 0, liveWordMs = 0;

function recordTamilCommit() {
  wordCount.textContent = String(++committedWords);
}
function recordCandidateDispatch(id) {
  candidateRequestStarts.set(id, performance.now());
}
function clearPendingWordMeasurements() {
  candidateRequestStarts.clear();
}
function recordWordResponse(data) {
  if (!["result", "cancelled", "error"].includes(data.type)) return;
  const started = candidateRequestStarts.get(data.id);
  candidateRequestStarts.delete(data.id);
  if (started === undefined || data.type !== "result" || data.cached) return;
  // Completed neural work counts here even when its result is too old to display.
  liveWordMs += performance.now() - started;
  diagnostics.wordTransliteration = { completed: ++liveWords, totalMs: liveWordMs, averageMs: liveWordMs / liveWords };
  inferenceStats.textContent = `${diagnostics.wordTransliteration.averageMs.toFixed(1)} ms average`;
}
function recordTypingKeyDown(event) {
  if (!event.isComposing && event.isTrusted && !event.ctrlKey && !event.altKey && !event.metaKey &&
    (event.key.length === 1 || ["Backspace", "Delete", "Enter"].includes(event.key)))
    typingStart = event.timeStamp;
}
function recordTypingKeyUp() {
  typingStart = undefined;
}
function recordTyping(event) {
  if (!event.isTrusted) return;
  pendingEdits.push(typingStart ?? event.timeStamp);
  typingStart = undefined;
  if (typingFrame) return;
  typingFrame = requestAnimationFrame(() => {
    typingFrame = undefined;
    const now = performance.now();
    typingEdits += pendingEdits.length;
    typingSamples = [...typingSamples, ...pendingEdits.map(start => now - start)].slice(-128);
    pendingEdits = [];
    const ordered = [...typingSamples].sort((a, b) => a - b);
    diagnostics.typing = {
      edits: typingEdits, samples: typingSamples.length, lastMs: typingSamples.at(-1),
      averageMs: typingSamples.reduce((sum, value) => sum + value, 0) / typingSamples.length,
      p95Ms: ordered[Math.ceil(ordered.length * .95) - 1], maxMs: ordered.at(-1)
    };
    typingStats.textContent = `${diagnostics.typing.averageMs.toFixed(1)} ms average`;
  });
}
