# Architecture

The engineering question is whether Tamil transliteration can execute
on-device inside a browser using ONNX Runtime Web/WASM. The execution path is
straightforward; the correctness boundary is more demanding: an asynchronous
result can satisfy a prior acceptance, but must not authorize mutation of a
composition the user has changed or abandoned.

This document explains the responsibilities and invariants. Launch and
attribution are in [README.md](README.md); executable evidence and limits are
in [VALIDATION.md](VALIDATION.md).

## Responsibility map

| Boundary | Owner | Responsibility |
|---|---|---|
| Browser UI | `index.html`, `styles.css`, `textarea-caret.js` | Native text editing, visible status, mode and choices; popup positioning. |
| Controller | `app.js` | Detect composition, authorize requests/results and own every document mutation. |
| Worker | `indicxlit-worker.js` | Initialize assets, serialize model work, cache results and report structured outcomes. |
| ONNX execution | Bundled ORT Web/WASM and FP32 models | Execute encoder/decoder tensors on the WASM CPU provider. |
| Candidate presentation | Worker normalization; controller `rankCandidates` and popup | Turn raw model rows into usable suggestions without granting them document authority. |
| Re-edit and rollback | Controller plus `assets/tamil-recompose.js` | Reconsider Tamil through Roman spelling as a reversible transaction. |

```text
textarea keystroke
    -> detectComposition / updateComposition
    -> owned request snapshot
    -> requestCandidates
    -> worker queue -> encoder -> decoder beam search
    -> raw Top-8 -> normalized display candidates
    -> handleWorkerMessage -> ownership check
    -> identity rankCandidates -> showCandidatePopup
    -> explicit acceptance -> replaceRange
```

`performance.js` records local diagnostics and interaction timings. It is
instrumentation, not a second owner of composition or document state.

## 1. Browser UI: preserve ordinary editing

The document is a native textarea. Selection, paste, deletion and browser
undo remain normal editing operations. The UI adds a mode switch, status,
candidate popup and local performance board around that primitive.

This matters because the document has many possible edit paths. Correctness
cannot depend on all changes passing through a custom editor command system.
The controller observes external edits as well as its own replacements.

`textarea-caret.js` supplies popup coordinates. Candidate rows show up to eight
Tamil suggestions and a separate literal Roman row. The visible distinction
is deliberate: **1-8 are model proposals; 0 is user input**.

## 2. Controller: document and asynchronous ownership

### Composition detection

`detectComposition` recognizes one ASCII Roman word of 1-80 letters at a
collapsed caret. Detection includes the whole word when the caret is in its
middle. A 140 ms debounce avoids dispatching on every rapid keystroke.

`updateComposition` captures the document value, word range, visible Roman
spelling, model lookup spelling and caret. Those values define which
composition a result belongs to; the Roman word alone is insufficient.

### Request identity is not document authority

Two counters serve different purposes:

| Value | Meaning |
|---|---|
| `compositionRevision` | Invalidates composition ownership, including during the debounce window before dispatch. |
| Request ID | Identifies a dispatched worker request and its response. |

`handleWorkerMessage` accepts a result only for a matching dispatched request
whose composition still passes `compositionMatches`. That comparison checks
the captured document, range, spellings and caret.

A response for the same Roman letters at a different location is stale. So is
a response whose request ID matches but whose document changed while the
worker was running. Navigation, dismissal and mode changes also invalidate
the relevant interaction.

The worker may finish obsolete computation; the controller decides whether
its result is still presentable or committable. Cache warming therefore does
not imply permission to change the document.

### Explicit mutation and pending Space

Ordinary inference only displays choices. `commitTamil`, `commitRoman` and
`replaceRange` handle acceptance. Numbered/click acceptance adds no separator;
Space, punctuation and Enter supply their documented suffixes.

Space is also meaningful while a result is pending. `deferSpaceCommit` captures
the whole word and inserts the user's space at its end. A pending entry owns
that word **and its trailing separator**, not the entire evolving document.
`dispatchNextSpaceCommit` serializes these acceptances.

`commitPendingSpace` replaces only a still-valid owned word. It maps the
current selection around the replacement so continued typing is preserved.
Editing the source word or its separator invalidates that acceptance.
Navigation, Escape, mode changes, blur/pointer interaction, re-edit and undo
cancel pending acceptance rather than committing into an abandoned context.

This path is more involved than ordinary popup display because the user's
acceptance precedes completion of the model work. Its complexity represents
interaction semantics, not another inference architecture.

### Edits and provenance

`trackDocumentEdits` observes changes that can bypass controller replacement,
including paste and native undo/redo. A changed-range diff shifts unaffected
Roman-origin and pending-word ranges and discards overlapping ownership.

`replaceRange` prefers native `execCommand("insertText")` to retain undo
behavior. If that command returns false, it uses `setRangeText`; that fallback's
undo behavior is outside the qualified Edge path.

## 3. Worker: serialized execution and bounded state

`queueWorkerRequest` is the only worker message entry point. Initialization
loads the committed runtime, vocabularies and two graphs, then creates encoder
and decoder sessions. Status messages describe initialization stages; results
and errors identify their request.

The worker validates one trimmed Roman word of 1-80 ASCII letters and a
candidate limit of 1-8. The controller requests eight. The lowercase word and
limit form the raw-result cache key.

The cache holds at most 512 entries and evicts the oldest inserted key. It is
not LRU. `uncached: true` bypasses lookup for validation and measurement.

The worker serializes inference and may discard superseded work already
visible in its internal promise queue. This is an optional work-reduction
optimization, not a latest-request-wins guarantee. Requests buffered for
worker delivery or already executing in CPU/WASM may still run after a newer
request has been posted. Completed inference can populate the cache; work
discarded at the internal queue boundary receives a structured cancellation.

Document correctness does not depend on worker supersession. The controller
remains authoritative over presentation and document mutation: request
identity, composition revision, source/range ownership and caret checks reject
stale results at the relevant ownership boundary.

Serializing work keeps the two sessions and cache under one owner. It does not
promise preemptive cancellation or parallel word throughput.

Worker failures are surfaced as structured errors or browser worker errors.
The controller exposes failure rather than substituting a successful-looking
candidate result. The connected initialization-failure test establishes exact
preservation of seeded nonempty text and continued editability for that path.

## 4. ONNX Runtime execution and beam search

The author mechanically adapted the FP32 assets for ONNX Runtime compatibility.
The neural model, architecture and learned transliteration quality originate
from AI4Bharat. ORT Web/WASM originates from Microsoft.

The worker configures the WASM CPU provider with one thread, ORT proxy
disabled and graph optimization enabled. Its own Web Worker is the execution
boundary.

### Tensor contract

| Graph boundary | Tensor | Type and shape |
|---|---|---|
| Encoder input | `src_tokens` | int64 `[batch, source_length]` |
| Encoder output | `encoder_out` | float32 `[source_length, batch, 256]` |
| Encoder output | `encoder_padding_mask` | bool `[batch, source_length]` |
| Decoder input | `prev_output_tokens` | int64 `[batch, target_length]` |
| Decoder inputs | Encoder output and padding mask | Same types and shapes as encoder outputs |
| Decoder output | Logits | float32 `[batch, target_length, 806]` |

The source vocabulary has 54 symbols; the target has 806. Input is prefixed
with the Tamil language token `__ta__` and terminated with EOS. Decoder
prefixes start with EOS. PAD, EOS and UNK are IDs 1, 2 and 3.

`generateRaw` implements beam search around the decoder sessions. It uses
FP32-rounded log-softmax and score arithmetic, excludes padding, suppresses
initial EOS, selects a 2x-beam shortlist with deterministic flattened-index
ties, tracks ignored beams and length-normalizes finalized scores.

The maximum prefix is 128 tokens, bounding decoder iterations at 127.
Completed hypotheses yield ordered raw `{text, score}` rows. This is the
algorithmic hotspot: candidate search belongs at the model execution boundary,
not in keyboard handling.

## 5. Candidate presentation: policy is not inference

The worker normalizes raw text to NFC, removes trailing U+200C, retains rows
containing Tamil-block characters, deduplicates and caps display candidates.
Consequently, the UI may show fewer than eight rows even when beam width is
eight.

The controller's `rankCandidates` is an identity seam: it returns the input
order. It makes candidate policy explicit without mixing an additional score
with the worker's neural scores. It does not imply a second ranking model,
personalization system or quality improvement.

`showCandidatePopup` adds the literal Roman choice independently. Choosing 0
uses the visible Roman spelling, not an expanded model lookup spelling.
Appending letters changes that word and resumes composition; an unchanged
literal word/caret is suppressed to avoid reopening the same popup.

The division is:

| Concern | Authority |
|---|---|
| Model inference | Propose ordered hypotheses. |
| Candidate policy | Normalize, deduplicate and preserve display order. |
| User | Accept Tamil, preserve Roman, continue editing or roll back. |

## 6. Re-edit and rollback: an explicit transaction

`beginReedit` handles an existing Tamil word only after Ctrl+Space requests
reconsideration. It uses remembered Roman provenance when available, otherwise
the compact canonical helper in `assets/tamil-recompose.js`.

The controller retains the original Tamil and owned range, then presents
editable Roman spelling. Long-vowel expansion can supply a separate lookup
spelling. This distinction preserves the user's literal input while providing
the model's expected representation.

The transaction has three outcomes:

| Action | Result |
|---|---|
| Choose 1-8 | Replace the provisional Roman range with that Tamil proposal. |
| Choose 0 | Keep the literal visible Roman spelling and complete the transaction. |
| Esc | `restoreOriginalTamil` restores the exact saved Tamil while transaction ownership remains valid. |

Edits within the provisional Roman range update its ownership. Incompatible
edits invalidate the transaction rather than allowing rollback into unrelated
text. Leaving the re-edit's owned context may end the transaction and leave
the provisional Roman text. While ownership remains valid, Escape restores
the exact saved Tamil and places the caret after the restored word; arbitrary
prior caret or selection state is not reconstructed. Merely exploring a Roman
word does not create a Tamil rollback value.

The compact helper is a reconsideration representation, not a guaranteed
reconstruction of arbitrary original spelling. Remembered provenance gives a
more faithful starting point for words committed in this page session.

## Complexity shape

The runtime is seven first-party files, 1,017 physical lines. Its legitimate
hotspots are keyboard decisions, composition updates, result authorization,
pending Space and beam search.

The controller keeps closely coupled interaction decisions together. The
worker keeps numerical execution separate. The identity seam remains one
function because its current policy is one decision. Adding more layers would
not itself strengthen these correctness boundaries.
