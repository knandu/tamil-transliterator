# Validation

Validation answers three practical questions: does browser execution produce
the expected transliteration results, does asynchronous inference respect
editing intent, and can the committed artifact execute locally as documented?

The suite combines a fixed transliteration corpus, real browser interaction,
a connected-worker initialization failure and inference with the static host
stopped. Each claim below names its mechanism and its boundary.

## Reproduce the qualification

From a clone in any directory, run:

```powershell
.\tests\Run-BrowserTests.ps1
```

The runner performs four workflows: **Regression**, **Editor**, **Failure** and
**Offline**. It calls the optional standalone integrity verifier automatically.
To inspect assets independently:

```powershell
.\Setup-Assets.ps1
```

That script verifies SHA-256 hashes of the committed models, vocabularies,
helper, runtime and notices. It neither installs nor repairs assets. An
integrity failure requires restoring the identified Git-tracked file.

For a focused workflow:

```powershell
.\tests\Run-BrowserTests.ps1 -Workflow Regression
.\tests\Run-BrowserTests.ps1 -Workflow Editor
.\tests\Run-BrowserTests.ps1 -Workflow Failure
.\tests\Run-BrowserTests.ps1 -Workflow Offline
```

The qualified environment is Windows and Edge. The runner locates Edge or
accepts an installed Chromium executable through `-BrowserPath`. Supplying
another browser path is not a claim that its behavior has been qualified.
`-TimeoutSeconds` controls the workflow bound, defaulting to 240 seconds.

### Isolation and result handling

The PowerShell runner starts its own loopback `Serve.ps1` on an available
port. Each workflow gets a new headless browser profile, a 1440x1000 viewport
and a DevTools connection. Browser background networking is disabled; external
requests use an unreachable proxy, with loopback bypassed.

The Editor workflow uses trusted DevTools input where browser-native editing
matters, alongside deterministic DOM/worker fixtures for precise state tests.
The runner stops its owned processes and removes its exact temporary
directories.

Detailed JSON goes to ignored `tests/evidence/standalone/`:
`Regression.json`, `Editor.json`, `Failure.json` and `Offline.json`. Results
include capture time, browser user agent, PowerShell version, OS and viewport.
Infrastructure failure throws and may leave a result file from a different
invocation; judge the command's exit status, not a stale JSON file alone.

[tests/validation-results.json](tests/validation-results.json) is a compact
committed qualification snapshot. The executable workflows and corpus are
the reproducible record; ignored logs or an author's machine are not inputs.

## 1. Expected transliteration outputs and ordering

Files:

```text
tests/transliteration-corpus.json
tests/browser-regression.html
tests/browser-regression.js
tests/RegressionWorkflow.js
```

The corpus contains 30 Roman-word cases with eight expected raw `{text, score}`
rows each, plus six invalid-input cases. It pins the four model/vocabulary
hashes, ORT Web version 1.23.2, beam width eight and absolute score tolerance
`1e-4`.

For each valid case, the browser worker executes uncached inference. The test
requires exact candidate strings and order, then checks every raw score
against the tolerance. Case names, durations and maximum score differences
are reported rather than hidden behind a single aggregate pass.

The invalid cases cover empty input, whitespace, multiple words, digits,
Tamil input and an 81-letter word. Each must return `invalid_roman_word`.
Additional assertions check the actual ORT version, distinguish an uncached
request from its cache hit, and inspect worker resource origins and paths.

To inspect this check interactively, start `.\Serve.ps1`, open
`http://127.0.0.1:17841/tests/browser-regression.html` and click **Run regression**.
This diagnostic page is intentionally separate from the typing screen.

### What the corpus establishes

It is an expected-output regression suite for the prepared FP32 graphs and
browser decoder. It establishes ordered browser execution for those cases,
not linguistic correctness of every ranked proposal or an upstream training
claim. Raw expected ordering is checked separately from UI normalization.

The fixture's capture provenance is an implementation detail: its expected
rows were captured using a separate C# decoder over the same prepared graphs.
That decoder and the graph-preparation tooling are not repository dependencies
or included regeneration tools. The fixed corpus supports regression
reproduction; it does not establish checkpoint-to-ONNX conversion fidelity.
Asset hashes identify the exact graphs under test.

## 2. Editing correctness and async ownership

`tests/EditorWorkflow.js` runs 139 named assertions against the typing page.
The output preserves those names so their substance is inspectable.

| Boundary | Exercised behavior |
|---|---|
| Explicit acceptance | Inference leaves Roman text provisional; 1-8, click, 0, Space, punctuation and both Enter modes have distinct outcomes. |
| Continued editing | Literal 0 followed by more letters, ordinary editing, selections, paste, mixed text and native undo. |
| Re-edit | Roman exploration versus Tamil transaction, remembered/canonical spelling, Tamil replacement, literal retention and exact Esc rollback. |
| Ownership | Stale responses, moved caret, changed source text, dismissal and mode changes cannot authorize an abandoned composition. |
| Deferred Space | Acceptance during loading/running inference, continued typing, word/separator ownership, range shifting and cancellation. |
| Worker behavior | Real model output, request serialization and cached results. |
| Failure surfaces | Missing helper guidance and independently missing worker assets produce visible diagnostic outcomes. |
| Instrumentation | Commit counts and timing categories distinguish suggestions, literal acceptance, cached results and measured conversions. |

Some state cases use controlled delayed or synthetic worker responses. That
is useful for testing ownership deterministically, but not proof that a real
connected worker failure preserves existing text. The next workflow supplies
that separate evidence.

The suite targets meaningful interaction branches rather than using assertion
count as a quality score. Its confidence comes from the invariants checked and
the combination of real model execution with controlled asynchronous cases.

### Worker-supersession qualification

Separate real-worker qualification observed supersession during
initialization. After initialization, a three-request burst executed all three
uncached requests. These observations are distinct from the Editor workflow's
ownership assertions and do not establish latest-request-only execution.

Worker supersession is a bounded work-reduction optimization: requests
buffered for delivery or executing in CPU/WASM may still run after newer work
is posted. Stale-document safety is validated through controller ownership
rejection, not guaranteed worker cancellation.

## 3. Connected-worker initialization failure preserves text

The Failure workflow creates an isolated temporary copy of the runnable page
and assets, omitting only `runtime/ort.wasm.min.js`. The repository itself
remains intact.

A test-only worker-constructor wrapper seeds nonempty mixed Tamil/Roman,
multiline text and records its exact value immediately before delegating to
the native browser Worker constructor. It neither substitutes inference nor
posts a synthetic error. The production page starts its real connected worker,
whose `importScripts` fails for the missing runtime.

`tests/FailureWorkflow.js` requires all of these:

| Check | Required outcome |
|---|---|
| Existing content | A nonempty expected seed exactly matches text recorded at native worker startup. |
| Actual failure | The page diagnostics contain that connected worker's initialization error, request ID 0. |
| Text preservation | The entire textarea equals the expected seed, including Tamil and newline. |
| Visibility | Status is **Failed** and the visible error contains a message. |
| Continued editing | Appending a suffix produces exactly the seed plus that suffix. |

Expected text, text at worker startup and preserved text are recorded in the
JSON result. This proves preservation during **connected-worker runtime
initialization failure**. It does not generalize to every browser crash,
resource exhaustion, mid-decoding failure or active re-edit failure.

The independent broken-worker assertion in the Editor workflow is not used
as evidence for this stronger connected-worker claim.

## 4. Uncached inference with the static host stopped

`tests/OfflineWorkflow.js` initializes the real page and obtains the initial
word's candidates. The runner then stops its static server.

A cache-busting vocabulary fetch must reject, establishing that the host is
unreachable. The workflow requests a different word, `pudhiya`, and requires:

| Check | Required outcome |
|---|---|
| Request | A new word with `cached === false`. |
| Output | Nonempty candidates, every candidate containing Tamil-block characters. |
| Authority | Editor text remains the provisional Roman word. |

This demonstrates inference from resident runtime/model state rather than a
cache hit or hidden backend. It is not a cold-page reload test: browser startup
still needs the committed assets served, and there is no service-worker
installation or offline reload cache.

## 5. Timing observations, not a benchmark claim

The committed snapshot reports timings from its actual qualification run:

| Measurement | Scope |
|---|---|
| Initialization | Runtime import, vocabulary/model fetch and both session creations. |
| Corpus median and slowest | Worker-reported uncached execution across the 30 cases at beam width eight. |
| Warm uncached `vendum` | Full candidate generation with initialized sessions and cache lookup bypassed. |
| Cached `vendum` | Lookup of that raw result, not model decoding. |

All reported generation observations use full beam width eight. They are not
greedy-decoding timings. Worker-reported execution time is also not end-to-end
keystroke latency: it excludes the controller debounce, main-thread rendering
and user acceptance. A recorded 0 ms cache hit means below timer resolution,
not zero work.

Initialization is a fresh browser-session observation, not a promise of cold
OS filesystem caches. One qualification run is not a statistically controlled
performance benchmark, and hardware/browser/load affect results.
`navigator.hardwareConcurrency` describes exposed logical concurrency, not
the number of WASM threads; the runtime is configured for one.

The visible Local performance board shows successful committed-word count,
editor-response average and word-transliteration/request average. The request
average measures dispatch-to-result elapsed time for completed uncached neural
requests, including results that become stale and are not displayed or
committed. Cache hits, cancelled requests and failures are excluded. The
committed-word count is a separate metric.

The board does not break out initialization, cache latency or individual
processing stages; internal instrumentation is separate from these visible
metrics. Interaction averages depend on the user's word mix and are
diagnostics, not a throughput score. Optional page heap readings exclude
worker/WASM allocations and cannot establish total model memory usage.

## Claim and evidence limits

| Claim | Evidence and limit |
|---|---|
| Standalone execution | Tracked models/runtime/helper, hash verification and self-contained loopback/browser workflows. Arbitrary path handling is script-relative. |
| Browser execution correctness | Fixed expected raw outputs/order and score tolerance; not an exhaustive transliteration-quality corpus. |
| Async correctness | Real interactions plus targeted deterministic stale/delayed cases; not every browser scheduling interleaving. |
| Failure preservation | Exact nonempty-text preservation for missing-runtime initialization of the connected worker. |
| Resident local inference | Uncached Tamil output with a demonstrated unreachable static host; not cold reload persistence. |
| Model provenance | Pinned adapted assets and upstream attribution; preparation tooling and upstream checkpoint fidelity validation are not included. |
| Browser/platform coverage | Qualified Windows/Edge path. Other engines, mobile IMEs and fallback undo behavior remain unqualified. |
| Deployment | Relative static asset layout; deployed GitHub Pages hosting is outside the recorded qualification. |

The repository demonstrates a bounded browser execution and interaction
artifact. The evidence should be read at those boundaries, not expanded into
claims about model research, broad language quality or product readiness.
