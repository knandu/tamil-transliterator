"use strict";
const editor = document.getElementById("editor");
const modeButton = document.getElementById("mode");
const statusLabel = document.getElementById("status");
const failure = document.getElementById("error");
const candidates = document.getElementById("candidates");
const literalCandidate = document.getElementById("literal-candidate");
const popup = document.getElementById("candidate-popup");
let worker, modelReady = false, tamilEnabled = true;
// Revisions invalidate composition ownership before a request exists; IDs identify dispatched worker requests.
let requestSequence = 0, compositionRevision = 0, compositionTimer;
let composition;
let popupSource, selectedIndex = 0, dismissedComposition;
// Deferred Space preserves pending acceptance while typing continues; provenance preserves Roman source for re-edit.
let pendingSpaceCommits = [], activeSpaceRequest, expectedSelection, workerFailed = false;
let romanOrigins = [], trackedValue = editor.value;
// Only Tamil re-editing has a rollback value; normal exploration belongs to composition.
let reedit;

function showError(message) {
  failure.hidden = false;
  failure.textContent = message;
}
function rankCandidates(candidates) {
  // Optional local adaptation belongs here, not in the worker's neural beam search.
  return candidates;
}
function requestCandidates(source) {
  recordCandidateDispatch(source.id);
  worker.postMessage({ type: "transliterate", id: source.id, roman: source.lookupRoman, limit: 8 });
}
function trackDocumentEdits() {
  // Typing, paste and native undo/redo can bypass controller replacements.
  // Diff the observed text to keep provenance, queued words and re-edit ranges consistent.
  const value = editor.value;
  if (value === trackedValue) return;
  let start = 0, oldEnd = trackedValue.length, newEnd = value.length;
  while (start < oldEnd && start < newEnd && trackedValue[start] === value[start]) start++;
  while (oldEnd > start && newEnd > start && trackedValue[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  // Only unaffected ranges retain their original Roman spelling after an edit.
  romanOrigins = romanOrigins.flatMap(entry => {
    if (entry.end <= start) return [entry];
    if (entry.start >= oldEnd) return [{ ...entry, start: entry.start + delta, end: entry.end + delta }];
    return [];
  });
  // A queued word owns its trailing Space too; removing that separator cancels acceptance.
  pendingSpaceCommits = pendingSpaceCommits.flatMap(entry => {
    if (entry.end + 1 <= start) return [entry];
    if (entry.start >= oldEnd) return [{ ...entry, start: entry.start + delta, end: entry.end + delta }];
    return [];
  }).filter(validPendingWord);
  if (activeSpaceRequest) activeSpaceRequest = pendingSpaceCommits.find(entry => entry.id === activeSpaceRequest.id);
  if (reedit) {
    if (start >= reedit.start && oldEnd <= reedit.end && /^[A-Za-z]*$/.test(value.slice(start, newEnd))) {
      reedit.end += delta;
      reedit.value = value;
    } else reedit = null;
  }
  trackedValue = value;
}
function validPendingWord(source) {
  return editor.value.slice(source.start, source.end) === source.roman &&
    editor.value[source.end] === " " && !/[A-Za-z]/.test(editor.value[source.start - 1] || "");
}
function cancelPendingSpaces() {
  if (!pendingSpaceCommits.length) return;
  pendingSpaceCommits = [];
  activeSpaceRequest = null;
  expectedSelection = null;
  if (modelReady) statusLabel.textContent = "Ready";
}
function dispatchNextSpaceCommit() {
  if (activeSpaceRequest || !pendingSpaceCommits.length || !modelReady) return;
  const source = pendingSpaceCommits[0];
  source.id = ++requestSequence;
  activeSpaceRequest = source;
  statusLabel.textContent = "Running";
  requestCandidates(source);
}
function deferSpaceCommit() {
  const word = detectComposition();
  if (!worker || workerFailed || !word || !compositionMatches(composition) ||
    compositionMatches(dismissedComposition) || (composition.id && composition.compositionRevision !== compositionRevision)) return false;
  clearTimeout(compositionTimer);
  replaceRange(word.end, word.end, " ");
  pendingSpaceCommits.push({ ...word });
  updateComposition();
  return true;
}
function commitPendingSpace(data) {
  const source = activeSpaceRequest;
  pendingSpaceCommits = pendingSpaceCommits.filter(entry => entry.id !== source.id);
  activeSpaceRequest = null;
  if (!tamilEnabled || !validPendingWord(source)) {
    diagnostics.discardedResults++;
    updateComposition();
    return;
  }
  const text = rankCandidates(data.candidates)[0], delta = text.length - source.roman.length;
  // Inference may finish after further typing; preserve the current selection around the replacement.
  const mapCaret = at => at <= source.start ? at : at >= source.end ? at + delta : source.start + text.length;
  const start = mapCaret(editor.selectionStart), end = mapCaret(editor.selectionEnd);
  diagnostics.lastResult = data;
  reedit = null;
  replaceRange(source.start, source.end, text);
  romanOrigins.push({ start: source.start, end: source.start + text.length,
    roman: source.roman, tamil: text, representation: source.representation });
  editor.setSelectionRange(start, end);
  recordTamilCommit();
  updateComposition();
}
function detectComposition() {
  if (!tamilEnabled || editor.selectionStart !== editor.selectionEnd) return null;
  const caret = editor.selectionStart, value = editor.value;
  let start = caret, end = caret;
  while (start > 0 && /[A-Za-z]/.test(value[start - 1])) start--;
  while (end < value.length && /[A-Za-z]/.test(value[end])) end++;
  if (start === end || end - start > 80) return null;
  const roman = value.slice(start, end);
  const representation = reedit?.start === start && reedit.end === end
    ? reedit.representation : "literal";
  const lookupRoman = representation === "compact" ? window.TamilRecompose.expandCompact(roman) : roman;
  return { start, end, roman, lookupRoman, representation, caret, value };
}
function compositionMatches(source) {
  const word = detectComposition();
  return word && source && source.value === word.value && source.start === word.start &&
    source.end === word.end && source.roman === word.roman && source.lookupRoman === word.lookupRoman &&
    source.caret === word.caret;
}
function clearCandidates(keepPopup = false) {
  popupSource = null;
  selectedIndex = 0;
  editor.removeAttribute("aria-activedescendant");
  popup.toggleAttribute("data-updating", keepPopup);
  candidates.setAttribute("aria-busy", String(keepPopup));
  literalCandidate.hidden = !keepPopup;
  if (keepPopup) {
    for (const button of candidates.children) button.disabled = true;
    positionPopup();
  } else {
    popup.hidden = true;
    editor.setAttribute("aria-expanded", "false");
    candidates.replaceChildren();
  }
}
function hasCurrentCandidates() {
  return popupSource && popupSource.id === composition?.id &&
    popupSource.compositionRevision === compositionRevision && compositionMatches(popupSource);
}
function literalComposition() {
  return !popup.hidden && !literalCandidate.hidden && compositionMatches(composition) &&
    (hasCurrentCandidates() || popup.hasAttribute("data-updating")) ? composition : null;
}
function candidateButtons() {
  // Array positions drive arrow navigation; the final row's displayed hotkey is always 0.
  return [...candidates.children, literalCandidate];
}
function showCandidatePopup(texts, source) {
  popupSource = { ...source };
  selectedIndex = 0;
  popup.removeAttribute("data-updating");
  candidates.setAttribute("aria-busy", "false");
  for (const [index, text] of texts.entries()) {
    let button = candidates.children[index];
    if (!button) {
      button = document.createElement("button");
      button.addEventListener("pointerdown", event => event.preventDefault());
      button.addEventListener("click", () => {
        if (button.parentElement === candidates && !button.disabled && hasCurrentCandidates())
          commitTamil(button.textContent, popupSource);
      });
      candidates.append(button);
    }
    button.disabled = false;
    button.type = "button";
    button.textContent = text;
    button.id = `candidate-${source.id}-${index}`;
    button.dataset.index = index + 1;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === 0));
    button.setAttribute("aria-label", `${index + 1}. ${text}`);
  }
  while (candidates.children.length > texts.length) candidates.lastElementChild.remove();
  popup.scrollTop = 0;
  positionPopup();
}
function positionPopup() {
  const source = hasCurrentCandidates() ? popupSource : popup.hasAttribute("data-updating") ? composition : null;
  if (!source) return;
  literalCandidate.hidden = false;
  literalCandidate.textContent = source.roman;
  literalCandidate.setAttribute("aria-label", `0. ${source.roman}`);
  const { left, top, height, lineHeight, bounds } = getTextareaCaret(editor, source.caret);
  // Scroll offsets are integer-rounded, while mirrored glyph positions can be fractional.
  popup.hidden = left < bounds.left + editor.clientLeft - 1 || left > bounds.left + editor.clientLeft + editor.clientWidth + 1 ||
    top + height <= bounds.top + editor.clientTop || top >= bounds.top + editor.clientTop + editor.clientHeight ||
    top + height <= 0 || top >= window.innerHeight;
  editor.setAttribute("aria-expanded", String(!popup.hidden));
  if (popup.hidden) {
    editor.removeAttribute("aria-activedescendant");
    return;
  }
  popup.style.maxWidth = `${Math.max(0, window.innerWidth - 16)}px`;
  popup.style.maxHeight = `${Math.max(0, Math.min(400, window.innerHeight - 16))}px`;
  const below = top + lineHeight + 4;
  const belowSpace = Math.max(0, window.innerHeight - below - 8), aboveSpace = Math.max(0, top - 12);
  const placeBelow = popup.getBoundingClientRect().height <= belowSpace || belowSpace >= aboveSpace;
  popup.style.maxHeight = `${Math.min(400, placeBelow ? belowSpace : aboveSpace)}px`;
  const popupBounds = popup.getBoundingClientRect();
  popup.style.left = `${Math.max(8, Math.min(left, window.innerWidth - popupBounds.width - 8))}px`;
  popup.style.top = `${Math.max(8, placeBelow ? below : top - popupBounds.height - 4)}px`;
  if (hasCurrentCandidates()) selectCandidate(selectedIndex);
}
function selectCandidate(index) {
  selectedIndex = index;
  candidateButtons().forEach((button, at) => button.setAttribute("aria-selected", String(at === index)));
  const button = candidateButtons()[index];
  popup.querySelector(".popup-help").textContent =
    `1–8 Tamil · 0 Roman · ↑/↓ choose\nSpace accepts · Esc ${currentReedit() ? "restores Tamil" : "closes"}`;
  editor.setAttribute("aria-activedescendant", button.id);
  if (button.offsetTop < popup.scrollTop) popup.scrollTop = button.offsetTop;
  else if (button.offsetTop + button.offsetHeight > popup.scrollTop + popup.clientHeight)
    popup.scrollTop = button.offsetTop + button.offsetHeight - popup.clientHeight;
}
function updateComposition(explore = false) {
  trackDocumentEdits();
  if (reedit && (reedit.value !== editor.value ||
    editor.selectionStart < reedit.start || editor.selectionEnd > reedit.end))
    reedit = null;
  if (!explore && dismissedComposition?.literal && compositionMatches(dismissedComposition)) return;
  if (!explore && hasCurrentCandidates()) {
    positionPopup();
    return;
  }
  clearTimeout(compositionTimer);
  dismissedComposition = null;
  compositionRevision++;
  const previous = composition;
  composition = detectComposition();
  const sameWord = composition && previous && composition.start === previous.start &&
    previous.value.slice(0, previous.start) === composition.value.slice(0, composition.start) &&
    previous.value.slice(previous.end) === composition.value.slice(composition.end);
  // Reuse disabled rows only within the same word; they cannot commit an outdated spelling.
  const keepPopup = !pendingSpaceCommits.length && !popup.hidden && sameWord &&
    composition.roman !== previous.roman;
  clearCandidates(keepPopup);
  expectedSelection = { start: editor.selectionStart, end: editor.selectionEnd };
  diagnostics.activeWord = composition?.roman || "None";
  if (pendingSpaceCommits.length) {
    dispatchNextSpaceCommit();
    return;
  }
  if (!composition) {
    if (modelReady) statusLabel.textContent = "Ready";
    return;
  }
  composition.explored = explore || Boolean(sameWord && previous.explored) || Boolean(reedit);
  if (!modelReady) return;
  const source = { ...composition, compositionRevision };
  compositionTimer = setTimeout(() => {
    if (!compositionMatches(source) || source.compositionRevision !== compositionRevision) return;
    source.id = ++requestSequence;
    composition = source;
    statusLabel.textContent = "Running";
    requestCandidates(source);
  }, 140);
}
function commitTamil(text, source, suffix = "") {
  if (!compositionMatches(source) || source.compositionRevision !== compositionRevision || source.id !== composition?.id) {
    clearCandidates();
    return false;
  }
  reedit = null;
  clearCandidates();
  replaceRange(source.start, source.end, text + suffix);
  romanOrigins.push({ start: source.start, end: source.start + text.length,
    roman: source.roman, tamil: text, representation: source.representation });
  recordTamilCommit();
  updateComposition();
  return true;
}
function replaceRange(start, end, text) {
  // Prefer native insertText for undo; fall back to the range API if it returns false.
  editor.focus();
  editor.setSelectionRange(start, end);
  // Native insertText dispatches input synchronously; callers still refresh after completing their own state changes.
  if (!document.execCommand("insertText", false, text))
    editor.setRangeText(text, start, end, "end");
  trackDocumentEdits();
}
function markChoicesExplored() {
  composition.explored = true;
  if (popupSource) {
    popupSource.explored = true;
    selectCandidate(selectedIndex);
  }
}
function beginReedit() {
  if (!window.TamilRecompose) {
    showError("Roman re-editing helper is unavailable. Restore assets/tamil-recompose.js from this repository and reload.");
    return;
  }
  trackDocumentEdits();
  if (!tamilEnabled) toggleMode();
  const value = editor.value, selectionStart = editor.selectionStart, selectionEnd = editor.selectionEnd;
  const isTamil = window.TamilRecompose.isTamilWordCharacter;
  let start = selectionStart, end = selectionEnd;
  const tamil = start === end
    ? isTamil(value[start - 1]) || isTamil(value[start])
    : [...value.slice(start, end)].every(isTamil);
  const isWordCharacter = tamil ? isTamil : character => /^[A-Za-z]$/.test(character || "");
  if (start === end) {
    while (start > 0 && isWordCharacter(value[start - 1])) start--;
    while (end < value.length && isWordCharacter(value[end])) end++;
  }
  const originalText = value.slice(start, end);
  if (!originalText || ![...originalText].every(isWordCharacter)) return;
  if (!tamil) {
    editor.setSelectionRange(end, end);
    const word = detectComposition();
    if (!word) return;
    if (hasCurrentCandidates()) markChoicesExplored();
    else updateComposition(true);
    return;
  }
  const remembered = romanOrigins.find(entry => entry.start === start && entry.end === end && entry.tamil === originalText);
  const canonical = window.TamilRecompose.fromTamil(originalText);
  const roman = remembered?.roman || canonical.compact;
  if (!roman) {
    showError("That Tamil word cannot be represented safely as Roman composition.");
    return;
  }
  reedit = null;
  replaceRange(start, end, roman);
  reedit = {
    start, end: start + roman.length, value: editor.value, originalText, originalRoman: roman,
    representation: remembered?.representation || "compact"
  };
  updateComposition(true);
}
function currentReedit() {
  const active = reedit;
  if (!active?.originalText || active.value !== editor.value ||
    editor.selectionStart < active.start || editor.selectionEnd > active.end) return null;
  return active;
}
function restoreOriginalTamil() {
  const active = currentReedit();
  if (!active) return false;
  reedit = null;
  replaceRange(active.start, active.end, active.originalText);
  romanOrigins.push({ start: active.start, end: active.start + active.originalText.length,
    roman: active.originalRoman, tamil: active.originalText, representation: active.representation });
  const caret = active.start + active.originalText.length;
  editor.setSelectionRange(caret, caret);
  updateComposition();
  return true;
}
function commitRoman(source, suffix = "") {
  if (!source || source !== literalComposition()) return false;
  reedit = null;
  clearTimeout(compositionTimer);
  compositionRevision++;
  clearCandidates();
  if (suffix) replaceRange(source.end, source.end, suffix);
  editor.focus({ preventScroll: true });
  editor.setSelectionRange(source.end + suffix.length, source.end + suffix.length);
  composition = detectComposition();
  // Retaining the caret in a literal word must not immediately start transliterating it again.
  dismissedComposition = { ...composition, literal: true };
  if (modelReady) statusLabel.textContent = "Ready";
  return true;
}
function toggleMode() {
  cancelPendingSpaces();
  tamilEnabled = !tamilEnabled;
  modeButton.textContent = `Tamil input: ${tamilEnabled ? "on" : "off"} (F6)`;
  modeButton.setAttribute("aria-pressed", String(tamilEnabled));
  updateComposition();
}
function cancelComposition() {
  if (restoreOriginalTamil()) return true;
  if (popup.hidden || (!hasCurrentCandidates() && !popup.hasAttribute("data-updating"))) return false;
  composition.explored = false;
  dismissedComposition = composition;
  clearTimeout(compositionTimer);
  compositionRevision++;
  clearCandidates();
  reedit = null;
  if (modelReady) statusLabel.textContent = "Ready";
  return true;
}
function commitNumberedChoice(key) {
  if (key === "0") return commitRoman(literalComposition());
  if (!/^[1-8]$/.test(key) || popup.hidden || !hasCurrentCandidates()) return false;
  const button = candidates.children[Number(key) - 1];
  return Boolean(button && commitTamil(button.textContent, popupSource));
}
function acceptSelectedChoice(key) {
  const suffix = key === "Enter" ? popupSource.explored ? " " : "\n" : key;
  const index = key === "Enter" && !popupSource.explored ? 0 : selectedIndex;
  if (index === candidates.children.length) return commitRoman(literalComposition(), suffix);
  return commitTamil(candidates.children[index].textContent, popupSource, suffix);
}
function handleEditorKeyDown(event) {
  if (event.isComposing) return;
  const hadPendingSpaces = pendingSpaceCommits.length > 0;
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Escape"].includes(event.key) ||
    ((event.ctrlKey || event.metaKey) && (event.code === "Space" || ["a", "z", "y"].includes(event.key.toLowerCase()))))
    cancelPendingSpaces();
  if (event.key === "F6" && !event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    toggleMode();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.code === "Space") {
    event.preventDefault();
    beginReedit();
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key === "Escape" && !event.shiftKey) {
    const cancelled = cancelComposition();
    if (hadPendingSpaces || cancelled) event.preventDefault();
    return;
  }
  if (!event.shiftKey && commitNumberedChoice(event.key)) {
    event.preventDefault();
    return;
  }
  if (event.key === " " && !event.shiftKey && !hasCurrentCandidates() && deferSpaceCommit()) {
    event.preventDefault();
    return;
  }
  if (popup.hidden || !hasCurrentCandidates()) return;
  const punctuation = /^\p{P}$/u.test(event.key);
  if (event.shiftKey && !punctuation) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    markChoicesExplored();
    selectCandidate((selectedIndex + step + candidateButtons().length) % candidateButtons().length);
  } else if (event.key === "Enter" || event.key === " " || punctuation) {
    if (acceptSelectedChoice(event.key)) event.preventDefault();
  }
}
function handleEditorSelection() {
  if (document.activeElement !== editor) return;
  if (pendingSpaceCommits.length && (editor.selectionStart !== expectedSelection?.start || editor.selectionEnd !== expectedSelection?.end)) {
    cancelPendingSpaces();
    updateComposition();
    return;
  }
  const word = detectComposition();
  if ((composition && !compositionMatches(composition)) || (!composition && word)) updateComposition();
}
function handleWorkerMessage({ data }) {
  recordWordResponse(data);
  diagnostics.messages.push(data);
  if (diagnostics.messages.length > 100) diagnostics.messages.shift();
  if (data.type === "status") { statusLabel.textContent = data.stage; return; }
  if (data.type === "ready") {
    modelReady = true;
    diagnostics.initialization = data;
    statusLabel.textContent = "Ready";
    updateComposition();
  } else if (data.type === "result") {
    if (data.id === activeSpaceRequest?.id) {
      commitPendingSpace(data);
      return;
    }
    // Reject old request IDs, edit revisions and source ranges before any popup or commit.
    if (pendingSpaceCommits.length || data.id !== composition?.id || composition.compositionRevision !== compositionRevision || !compositionMatches(composition)) {
      diagnostics.discardedResults++;
      return;
    }
    diagnostics.lastResult = data;
    showCandidatePopup(rankCandidates(data.candidates), composition);
    statusLabel.textContent = "Ready";
  } else if (data.type === "cancelled" && data.id === activeSpaceRequest?.id) {
    pendingSpaceCommits = pendingSpaceCommits.filter(entry => entry.id !== data.id);
    activeSpaceRequest = null;
    showError("Pending transliteration was cancelled. The Roman word was left unchanged.");
    updateComposition();
  } else if (data.type === "error") {
    if (data.id === activeSpaceRequest?.id) {
      pendingSpaceCommits = pendingSpaceCommits.filter(entry => entry.id !== data.id);
      activeSpaceRequest = null;
      showError(`${data.stage}: ${data.message}. The Roman word was left unchanged.`);
      updateComposition();
      return;
    }
    if (data.id === 0 || data.id === composition?.id) {
      if (data.id === 0) {
        modelReady = false;
        workerFailed = true;
        cancelPendingSpaces();
      }
      clearCandidates();
      statusLabel.textContent = "Failed";
      showError(`${data.stage}: ${data.message}`);
    }
  }
}
function handleWorkerFailure(event) {
  clearPendingWordMeasurements();
  modelReady = false;
  workerFailed = true;
  cancelPendingSpaces();
  clearCandidates();
  statusLabel.textContent = "Failed";
  showError(`Worker failed: ${event.message}. Your text is unchanged.`);
}
function startModelWorker() {
  try {
    worker = new Worker("indicxlit-worker.js");
    worker.onmessage = handleWorkerMessage;
    worker.onerror = handleWorkerFailure;
    worker.postMessage({ type: "initialize", id: 0 });
  } catch (error) {
    workerFailed = true;
    statusLabel.textContent = "Failed";
    showError(`Unable to start local worker: ${error.message}. Your text is unchanged.`);
  }
}

editor.addEventListener("input", () => updateComposition());
editor.addEventListener("input", recordTyping);
editor.addEventListener("click", () => updateComposition());
editor.addEventListener("pointerdown", () => cancelPendingSpaces());
editor.addEventListener("blur", () => cancelPendingSpaces());
editor.addEventListener("keydown", recordTypingKeyDown);
editor.addEventListener("keydown", handleEditorKeyDown);
editor.addEventListener("keyup", () => recordTypingKeyUp());
editor.addEventListener("keyup", event => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) &&
    !compositionMatches(composition)) updateComposition();
});
literalCandidate.addEventListener("pointerdown", event => event.preventDefault());
literalCandidate.addEventListener("click", () => commitRoman(literalComposition()));
editor.addEventListener("scroll", () => positionPopup(), { passive: true });
window.addEventListener("scroll", () => positionPopup(), { passive: true });
window.addEventListener("resize", () => positionPopup());
new ResizeObserver(() => positionPopup()).observe(editor);
document.addEventListener("selectionchange", () => handleEditorSelection());
modeButton.addEventListener("click", () => toggleMode());
startModelWorker();
editor.focus({ preventScroll: true });
updateComposition();
