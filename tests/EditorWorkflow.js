(async () => {
  const checks = [];
  const assert = (condition, name) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (test, name) => {
    const end = performance.now() + 15000;
    while (performance.now() < end) { if (test()) return; await pause(20); }
    throw new Error(`Timeout: ${name}`);
  };
  let nativeSequence = 0;
  const nativePending = new Map();
  window.__tcNativeDone = (id, error) => {
    const job = nativePending.get(id);
    nativePending.delete(id);
    setTimeout(() => { if (error) job.reject(new Error(error)); else job.resolve(); }, 20);
  };
  const native = actions => new Promise((resolve, reject) => {
    const id = String(++nativeSequence);
    nativePending.set(id, { resolve, reject });
    window.__tcNative(JSON.stringify({ id, actions }));
  });
  const editor = document.getElementById("editor");
  const popup = document.getElementById("candidate-popup");
  const romanOption = document.getElementById("literal-candidate");
  const commits = () => Number(document.getElementById("word-count").textContent);
  const observedDispatches = new Map(), observedLive = [];
  let observedCached = 0;
  const buttons = () => [...document.querySelectorAll("#candidates button:not(:disabled)")];
  const selected = () => [...buttons(), romanOption].findIndex(button => button.getAttribute("aria-selected") === "true");
  const key = (name, code, virtualKey, text, modifiers = 0) => native([
    { method: "Input.dispatchKeyEvent", params: {
      type: "keyDown", key: name, code, windowsVirtualKeyCode: virtualKey, modifiers,
      ...(text === undefined ? {} : { text })
    } },
    { method: "Input.dispatchKeyEvent", params: {
      type: "keyUp", key: name, code, windowsVirtualKeyCode: virtualKey, modifiers
    } }
  ]);
  const setText = (value, caret) => {
    editor.focus();
    editor.value = value;
    editor.setSelectionRange(caret, caret);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  };
  let spaceQueuedDuringLoading = false;
  try {
    assert(editor.value === "" && document.activeElement === editor && editor.placeholder.length > 0,
      "Demo opens with an empty, focused textbox and an example");
    assert(!document.querySelector('a[href="tests/browser-regression.html"]'),
      "The typing screen keeps regression tooling separate");
    assert(document.title === "தமிழில் எழுதுக — Type Tamil" &&
      document.querySelector("h1").textContent === document.title, "Tamil-first title matches the document title");
    assert(!document.getElementById("diagnostics") &&
      !document.getElementById("ranked") && !document.body.textContent.toLowerCase().includes("dictionary"),
      "Runtime diagnostics stay internal and the runnable UX has no dictionary controls or text");
    assert(commits() === 0 && document.getElementById("typing-stats").textContent === "—" &&
      document.getElementById("inference-stats").textContent === "—",
      "Performance board starts at zero commits with neutral unmeasured averages");
    const post = worker.postMessage.bind(worker), receive = worker.onmessage;
    worker.postMessage = message => {
      if (message.type === "transliterate") observedDispatches.set(message.id, performance.now());
      post(message);
    };
    worker.onmessage = event => {
      const data = event.data, started = observedDispatches.get(data.id);
      if (["result", "cancelled", "error"].includes(data.type)) {
        observedDispatches.delete(data.id);
        if (started !== undefined && data.type === "result") {
          if (data.cached) observedCached++;
          else observedLive.push(performance.now() - started);
        }
      }
      receive.call(worker, event);
    };
    spaceQueuedDuringLoading = !window.demoDiagnostics.initialization;
    setText("vanakkam", 8);
    await key(" ", "Space", 32, " ");
    assert(editor.value === "vanakkam " && popup.hidden, "Space can be queued immediately after opening the demo");
    await native([{ method: "Input.insertText", params: { text: "tail" } }]);
    await until(() => window.demoDiagnostics.messages.some(data => data.type === "result" &&
      data.roman === "vanakkam" && editor.value === `${data.candidates[0]} tail`), "startup Space acceptance");
    assert(editor.selectionStart === editor.value.length, "Model loading and deferred acceptance preserve continued typing");
    assert(commits() === 1, "Deferred Space counts one successfully committed word");
    await pause(40);
    const syntheticEditCount = window.demoDiagnostics.typing?.edits || 0;
    const loadedText = "prefix vendum suffix";
    setText(loadedText, 13);
    assert(editor.value === loadedText, "Editor is editable during initialization");
    await until(() => buttons().length === 8, "raw candidates");
    assert(editor.value === loadedText, "Inference never automatically modifies text");
    assert(commits() === 1, "Candidate generation and ordinary typing do not count as transliterated words");
    assert(window.demoDiagnostics.lastResult.source === "IndicXlit raw", "Default runs without dictionary");
    assert(window.demoDiagnostics.typing?.edits === syntheticEditCount, "Synthetic setup edits do not add user-typing samples");
    const beforeResources = window.demoDiagnostics.lastResult.resources;
    assert(!beforeResources.some(item => item.url.includes("ta-unigram")), "Raw mode never fetches dictionary");
    assert(!popup.hidden && selected() === 0, "Caret popup visibly opens with default candidate selected");
    assert(!romanOption.hidden && romanOption.textContent === "vendum" && romanOption.dataset.index === "0" &&
      getComputedStyle(romanOption).borderTopStyle === "solid" &&
      getComputedStyle(romanOption).borderTopWidth !== "0px",
      "Normal composition shows the exact Roman word as option 0 below a divider");
    assert(buttons().every((button, index) => button.dataset.index === String(index + 1)),
      "Neural options retain exact visible numbering 1–8");
    assert(getComputedStyle(buttons()[0]).backgroundColor !== getComputedStyle(buttons()[1]).backgroundColor,
      "Default candidate has a distinct visible highlight");
    const editorBounds = editor.getBoundingClientRect(), firstBounds = popup.getBoundingClientRect();
    const editorStyle = getComputedStyle(editor), measure = document.createElement("canvas").getContext("2d");
    measure.font = `${editorStyle.fontSize} ${editorStyle.fontFamily}`;
    const caretLeft = editorBounds.left + parseFloat(editorStyle.borderLeftWidth) +
      parseFloat(editorStyle.paddingLeft) + measure.measureText(loadedText.slice(0, 13)).width;
    assert(Math.abs(firstBounds.left - caretLeft) < 3 &&
      firstBounds.top > editorBounds.top && firstBounds.top < editorBounds.top + 2 * parseFloat(editorStyle.lineHeight),
      "Popup anchors to the actual first-line caret, not the textarea bottom");
    assert(buttons()[7].getBoundingClientRect().bottom <= firstBounds.bottom &&
      popup.scrollHeight <= popup.clientHeight + 1, "All eight choices and their keyboard hint fit without scrolling at normal viewport size");
    const unchangedRows = [...buttons()];
    editor.dispatchEvent(new Event("click"));
    assert(unchangedRows.every((row, index) => row === buttons()[index]) && !popup.hidden,
      "Clicking an unchanged caret leaves its choices in place");
    const stableRows = [...document.getElementById("candidates").children];
    let hiddenUpdates = 0;
    const stableObserver = new MutationObserver(() => { if (popup.hidden) hiddenUpdates++; });
    stableObserver.observe(popup, { attributes: true, attributeFilter: ["hidden"] });
    await native([{ method: "Input.insertText", params: { text: "a" } }]);
    assert(!popup.hidden && buttons().length === 0 && stableRows.every(row => row.disabled && row.isConnected),
      "Typing keeps the popup visible while making outdated choices non-committable");
    await native([{ method: "Input.insertText", params: { text: "a" } }]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "vendumaa", "in-place candidate update");
    assert(stableRows.every((row, index) => row === buttons()[index]) && hiddenUpdates === 0,
      "Successive edits update the same candidate rows without hide/show flashes");
    stableObserver.disconnect();
    await native([{ method: "Input.insertText", params: { text: "a" } }]);
    await until(() => composition?.id && observedDispatches.has(composition.id), "in-flight choice update");
    const cancelledUpdateId = composition.id, discardedBeforeCancellation = window.demoDiagnostics.discardedResults;
    await key("Escape", "Escape", 27);
    assert(document.getElementById("status").textContent === "Ready" && popup.hidden,
      "Escape dismisses an in-flight choice update and restores Ready");
    await until(() => window.demoDiagnostics.messages.some(data => data.type === "result" && data.id === cancelledUpdateId),
      "cancelled choice update result");
    assert(document.getElementById("status").textContent === "Ready" && popup.hidden &&
      window.demoDiagnostics.discardedResults === discardedBeforeCancellation + 1,
      "A cancelled choice update completes without changing Ready or reopening the popup");
    await key(" ", "Space", 32, " ");
    await pause(300);
    assert(editor.value === "prefix vendumaaa  suffix" && popup.hidden,
      "Escape during a choice update cancels it and keeps subsequent Space native");
    setText(loadedText, 13);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "vendum", "restored initial composition");
    editor.setSelectionRange(10, 10);
    editor.dispatchEvent(new Event("click"));
    await until(() => buttons().length === 8, "middle-word caret candidates");
    assert(popup.getBoundingClientRect().left < firstBounds.left - 20,
      "Popup follows a caret moved within the same Roman word");
    const expected = buttons()[1].textContent;
    const beforeMouseCommit = commits();
    const clickBounds = buttons()[1].getBoundingClientRect();
    await native(["mousePressed", "mouseReleased"].map(type => ({
      method: "Input.dispatchMouseEvent", params: {
        type, x: clickBounds.left + clickBounds.width / 2, y: clickBounds.top + clickBounds.height / 2,
        button: "left", clickCount: 1
      }
    })));
    assert(editor.value === `prefix ${expected} suffix`, "Trusted mouse commit replaces only the exact source range");
    assert(commits() === beforeMouseCommit + 1, "A successful mouse acceptance counts one word");
    assert(editor.selectionStart === 7 + expected.length && editor.selectionEnd === editor.selectionStart,
      "Commit places caret after replacement");
    await native([{ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 } }]);
    assert(editor.value === loadedText, "Native undo restores only candidate replacement");
    await native([{ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "y", code: "KeyY", modifiers: 2, windowsVirtualKeyCode: 89 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "y", code: "KeyY", modifiers: 2, windowsVirtualKeyCode: 89 } }]);
    assert(editor.value === `prefix ${expected} suffix`, "Native redo restores candidate replacement");
    assert(commits() === beforeMouseCommit + 1, "Undo and redo do not count new transliteration interactions");

    setText("prefix vendum suffix", 13);
    await until(() => buttons().length === 8, "keyboard candidates");
    const request = buttons()[0].id;
    await key("ArrowUp", "ArrowUp", 38);
    assert(selected() === 8 && buttons()[0].id === request && editor.selectionStart === 13,
      "Up wraps to Roman option 0 without moving caret or refreshing request");
    await key("ArrowDown", "ArrowDown", 40);
    assert(selected() === 0, "Down wraps back to default candidate");
    await key("ArrowDown", "ArrowDown", 40);
    const keyboardCandidate = buttons()[1].textContent;
    const beforeKeyboardCommit = commits();
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === `prefix ${keyboardCandidate}  suffix` &&
      editor.selectionStart === 8 + keyboardCandidate.length && popup.hidden,
      "Enter after exploring commits selected candidate with a space and no newline");
    assert(commits() === beforeKeyboardCommit + 1, "Keyboard acceptance counts one committed word");
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === `prefix ${keyboardCandidate} \n suffix`,
      "Enter remains a native newline after candidate composition ends");
    assert(commits() === beforeKeyboardCommit + 1, "Native newline editing does not increment the word count");

    setText("vendum", 6);
    await until(() => buttons().length === 8, "arrow exploration before editing");
    await key("ArrowDown", "ArrowDown", 40);
    await native([{ method: "Input.insertText", params: { text: "a" } }]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "venduma",
      "arrow exploration after editing");
    const exploredEditedCandidate = buttons()[0].textContent;
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === `${exploredEditedCandidate} `,
      "Arrow exploration survives same-word edits without a Tamil rollback transaction");

    setText("ven", 3);
    await key(" ", "Space", 32, undefined, 2);
    await native([{ method: "Input.insertText", params: { text: "dam" } }]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "vendam",
      "pending Roman exploration");
    const pendingExploredCandidate = buttons()[0].textContent;
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === `${pendingExploredCandidate} `,
      "Ctrl+Space exploration survives edits before its first candidate request completes");

    setText("vendum", 6);
    await until(() => buttons().length === 8, "exploration before dismissal");
    await key("ArrowDown", "ArrowDown", 40);
    await key("Escape", "Escape", 27);
    await key("ArrowLeft", "ArrowLeft", 37);
    await until(() => buttons().length === 8, "fresh choices after dismissal");
    const afterDismissalCandidate = buttons()[0].textContent;
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === `${afterDismissalCandidate}\n`,
      "Escape ends normal exploration and reopened choices retain plain Enter behavior");

    setText("naan ven", 8);
    await until(() => buttons().length === 8, "plain Enter candidates");
    const plainCandidate = buttons()[0].textContent;
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === `naan ${plainCandidate}\n` && editor.selectionStart === editor.value.length,
      "Plain Enter picks first candidate and inserts a newline in the same action");
    await key("z", "KeyZ", 90, undefined, 2);
    assert(editor.value === "naan ven", "Native undo restores plain Enter candidate and newline together");

    for (const punctuation of [
      { name: ".", code: "Period", vk: 190, modifiers: 0 },
      { name: "!", code: "Digit1", vk: 49, modifiers: 8 },
      { name: "?", code: "Slash", vk: 191, modifiers: 8 }
    ]) {
      setText("prefix vendum suffix", 13);
      await until(() => buttons().length === 8, "punctuation candidates");
      if (punctuation.name === ".") await key("ArrowDown", "ArrowDown", 40);
      const punctuationCandidate = buttons()[selected()].textContent;
      await key(punctuation.name, punctuation.code, punctuation.vk, punctuation.name, punctuation.modifiers);
      assert(editor.value === `prefix ${punctuationCandidate}${punctuation.name} suffix` &&
        editor.selectionStart === 8 + punctuationCandidate.length && popup.hidden,
        `Punctuation ${punctuation.name} commits chosen candidate and preserves the typed punctuation`);
    }

    for (const number of [1, 4, 8]) {
      setText("prefix vendum suffix", 13);
      await until(() => buttons().length === 8, `numeric ${number} candidates`);
      const directCandidate = buttons()[number - 1].textContent;
      await key(String(number), `Digit${number}`, 48 + number, String(number));
      assert(editor.value === `prefix ${directCandidate} suffix` && popup.hidden &&
        editor.selectionStart === 7 + directCandidate.length,
        `Digit ${number} directly commits exactly the corresponding Tamil candidate without a separator`);
    }
    setText("vendum", 6);
    await until(() => buttons().length === 8, "normal literal numeric choice");
    const beforeLiteralSequence = requestSequence;
    await key("0", "Digit0", 48, "0");
    await pause(180);
    assert(editor.value === "vendum" && popup.hidden && romanOption.hidden &&
      editor.selectionStart === 6 && requestSequence === beforeLiteralSequence &&
      document.getElementById("mode").getAttribute("aria-pressed") === "true",
      "Digit 0 commits the literal normal word without adding a digit, inference request or mode change");
    await key(" ", "Space", 32, " ");
    await native([{ method: "Input.insertText", params: { text: "naalai" } }]);
    await until(() => buttons().length === 8, "next word after literal numeric choice");
    const followingTamil = buttons()[0].textContent;
    await key(" ", "Space", 32, " ");
    assert(editor.value === `vendum ${followingTamil} `,
      "The next Roman word still accepts Tamil normally after literal option 0");
    for (const acceptance of [
      { name: " ", code: "Space", vk: 32, text: " ", suffix: " " },
      { name: "Enter", code: "Enter", vk: 13, text: "\r", suffix: " " },
      { name: ".", code: "Period", vk: 190, text: ".", suffix: "." }
    ]) {
      setText("vendum", 6);
      await until(() => buttons().length === 8, "arrow-selected Roman option");
      await key("ArrowUp", "ArrowUp", 38);
      assert(selected() === 8, "Arrow navigation highlights literal option 0");
      await key(acceptance.name, acceptance.code, acceptance.vk, acceptance.text);
      assert(editor.value === `vendum${acceptance.suffix}` && popup.hidden,
        `Literal option 0 preserves existing ${acceptance.code} acceptance semantics`);
    }
    for (let number = 0; number <= 9; number++) await key(String(number), `Digit${number}`, 48 + number, String(number));
    assert(editor.value === "vendum.0123456789", "All digits 0–9 remain ordinary text when no popup/composition is active");
    setText("vendum", 6);
    await key("4", "Digit4", 52, "4");
    assert(editor.value === "vendum4" && popup.hidden, "A digit remains ordinary input while choices have not yet appeared");

    setText("vendum", 6);
    await until(() => buttons().length === 8, "Ctrl+Space Roman choices");
    const ctrlSpaceCandidate = buttons()[0].textContent;
    await key(" ", "Space", 32, undefined, 2);
    assert(editor.value === "vendum" && buttons().length === 8, "Ctrl+Space explores Roman choices without changing text");
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === `${ctrlSpaceCandidate} `, "Ctrl+Space exploration makes Enter commit with a space");

    setText("prefix vendum suffix", 13);
    await until(() => buttons().length === 8, "source provenance candidate");
    const sourceCandidate = buttons()[0].textContent;
    await key(" ", "Space", 32, " ");
    editor.setSelectionRange(0, 0);
    await native([{ method: "Input.insertText", params: { text: "new " } }]);
    editor.setSelectionRange(11 + sourceCandidate.length, 11 + sourceCandidate.length);
    await key(" ", "Space", 32, undefined, 2);
    assert(editor.value === "new prefix vendum  suffix" && editor.selectionStart === 17,
      "Ctrl+Space restores exact session Roman source after surrounding edits shift the word");
    await key("Backspace", "Backspace", 8);
    await native([{ method: "Input.insertText", params: { text: "m" } }]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "vendum", "edited Roman recomposition");
    assert(editor.value === "new prefix vendum  suffix", "Re-editing and inference leave surrounding text unchanged");
    await key("ArrowDown", "ArrowDown", 40);
    const recomposedCandidate = buttons()[1].textContent;
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === `new prefix ${recomposedCandidate}   suffix`,
      "Ctrl+Space exploration persists while editing Roman text and Enter still inserts a space");
    const acceptedReedit = editor.value;
    await key("Escape", "Escape", 27);
    assert(editor.value === acceptedReedit && popup.hidden && romanOption.hidden &&
      editor.selectionStart === 12 + recomposedCandidate.length,
      "Accepting a selected Tamil replacement finishes re-editing and leaves no rollback or popup");

    const importedWord = "\u0b95\u0bbe\u0ba3\u0bcd";
    const importedText = `left ${importedWord} right`;
    setText(importedText, 5 + importedWord.length);
    await key(" ", "Space", 32, undefined, 2);
    await until(() => buttons().length === 8, "numeric re-edit Tamil candidates");
    const numberedReeditTamil = buttons()[3].textContent;
    await key("4", "Digit4", 52, "4");
    await key("Escape", "Escape", 27);
    assert(editor.value === `left ${numberedReeditTamil} right` && popup.hidden &&
      editor.selectionStart === 5 + numberedReeditTamil.length,
      "Digit 4 commits its exact re-edit Tamil replacement and ends the rollback transaction");
    const beforeRomanReedit = commits();
    setText(importedText, 5 + importedWord.length);
    await key(" ", "Space", 32, undefined, 2);
    await until(() => buttons().length === 8, "numeric re-edit Roman option");
    await key("0", "Digit0", 48, "0");
    await key("Escape", "Escape", 27);
    assert(editor.value === "left kAN right" && popup.hidden && editor.selectionStart === 8 &&
      document.getElementById("mode").getAttribute("aria-pressed") === "true",
      "Digit 0 keeps exact re-edit Roman text and ends rollback without disabling Tamil");
    setText(importedText, 5 + importedWord.length);
    await key(" ", "Space", 32, undefined, 2);
    assert(editor.value === "left kAN right" && popup.hidden, "Tamil re-editing starts before its choices arrive");
    await key("Escape", "Escape", 27);
    await pause(250);
    assert(editor.value === importedText && popup.hidden && editor.selectionStart === 5 + importedWord.length,
      "One immediate Escape restores Tamil and cancels pending re-edit choices");
    await key(" ", "Space", 32, undefined, 2);
    assert(editor.value === "left kAN right" && editor.selectionStart === 8,
      "Ctrl+Space romanizes pasted Tamil using the existing canonical helper");
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "kaaN", "expanded canonical model lookup");
    assert(window.demoDiagnostics.lastResult.raw.length === 8,
      "Compact canonical vowels expand before lookup without replacing the model's raw Top-8");
    assert(!romanOption.hidden && romanOption.textContent === "kAN" &&
      !document.getElementById("candidates").contains(romanOption) &&
      popup.querySelector(".popup-help").textContent.includes("Esc restores Tamil"),
      "Re-edit popup offers literal option 0 and explains single-Esc rollback");
    await key("Escape", "Escape", 27);
    assert(editor.value === importedText && popup.hidden && editor.selectionStart === 5 + importedWord.length,
      "One Escape closes visible re-edit choices and restores exact original Tamil and caret");
    assert(commits() === beforeRomanReedit, "Roman re-editing and original Tamil restoration do not count as new transliterations");
    editor.setSelectionRange(5, 5 + importedWord.length);
    await key(" ", "Space", 32, undefined, 2);
    assert(editor.value === "left kAN right", "Ctrl+Space supports an explicitly selected Tamil word");
    await until(() => buttons().length === 8, "selected Tamil recomposition");
    await key("Backspace", "Backspace", 8);
    await until(() => buttons().length === 8, "changed canonical recomposition");
    await key("Escape", "Escape", 27);
    assert(editor.value === importedText && editor.selectionStart === 5 + importedWord.length &&
      editor.selectionEnd === 5 + importedWord.length, "Re-edit cancellation restores exact Tamil with the caret after it even after Roman edits");

    await key(" ", "Space", 32, undefined, 2);
    await until(() => buttons().length === 8, "literal re-edit choices");
    await native([{ method: "Input.insertText", params: { text: "sX" } }]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "kaaNsX", "modified literal re-edit choices");
    const keptText = editor.value, keepSequence = requestSequence;
    const keepBounds = romanOption.getBoundingClientRect();
    await native(["mousePressed", "mouseReleased"].map(type => ({
      method: "Input.dispatchMouseEvent", params: {
        type, x: keepBounds.left + keepBounds.width / 2, y: keepBounds.top + keepBounds.height / 2,
        button: "left", clickCount: 1
      }
    })));
    editor.dispatchEvent(new Event("click"));
    await pause(200);
    assert(editor.value === keptText && keptText === "left kANsX right" &&
      popup.hidden && romanOption.hidden && buttons().length === 0 &&
      editor.selectionStart === 10 && editor.selectionEnd === 10 &&
      document.activeElement === editor && requestSequence === keepSequence,
      "Clicking option 0 keeps the exact edited spelling, cleans up the caret/popup and starts no inference");
    assert(document.getElementById("mode").getAttribute("aria-pressed") === "true" &&
      commits() === beforeRomanReedit, "Literal option 0 leaves Tamil mode on and is not counted as a Tamil transliteration");
    await key("Escape", "Escape", 27);
    assert(editor.value === keptText, "Esc cannot roll back a finished literal re-edit transaction");
    await native([{ method: "Input.insertText", params: { text: " vendum" } }]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "vendum", "typing after literal choice");
    assert(romanOption.textContent === "vendum" && editor.value === "left kANsX vendum right",
      "Ordinary Tamil candidate generation resumes for the next word after option 0");

    setText(importedText, 5 + importedWord.length);
    await key(" ", "Space", 32, undefined, 2);
    await until(() => buttons().length === 8, "in-flight rollback starting choices");
    await native([{ method: "Input.insertText", params: { text: "thamizhilpaadugiren" } }]);
    await until(() => composition?.id && observedDispatches.has(composition.id), "in-flight rollback request");
    const rollbackId = composition.id, discardedBeforeRollback = window.demoDiagnostics.discardedResults;
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => window.demoDiagnostics.messages.some(data => data.type === "result" && data.id === rollbackId),
      "late rollback inference result");
    assert(editor.value === importedText && popup.hidden && romanOption.hidden &&
      editor.selectionStart === 5 + importedWord.length &&
      window.demoDiagnostics.discardedResults > discardedBeforeRollback,
      "A real in-flight re-edit result arriving after Esc cannot replace restored Tamil or reopen choices");

    await key(" ", "Space", 32, undefined, 2);
    await until(() => buttons().length === 8, "in-flight literal starting choices");
    await native([{ method: "Input.insertText", params: { text: "pazhankavithaigal" } }]);
    await until(() => composition?.id && observedDispatches.has(composition.id), "in-flight literal request");
    const keptPendingText = editor.value, keptPendingId = composition.id, keptPendingSequence = requestSequence;
    const discardedBeforeKeep = window.demoDiagnostics.discardedResults;
    romanOption.click();
    await until(() => window.demoDiagnostics.messages.some(data => data.type === "result" && data.id === keptPendingId),
      "late literal inference result");
    await pause(180);
    assert(editor.value === keptPendingText && popup.hidden && romanOption.hidden &&
      editor.selectionStart === keptPendingText.indexOf(" right") &&
      editor.selectionEnd === editor.selectionStart && requestSequence === keptPendingSequence &&
      window.demoDiagnostics.discardedResults > discardedBeforeKeep &&
      document.getElementById("mode").getAttribute("aria-pressed") === "true",
      "A real in-flight result after option 0 cannot alter Roman text, reopen choices or start another request");

    setText(importedText, 5 + importedWord.length);
    editor.setSelectionRange(0, importedText.length);
    await key(" ", "Space", 32, undefined, 2);
    assert(editor.value === importedText && popup.hidden, "Ctrl+Space never rewrites a mixed-word selection");
    setText(importedText, 5 + importedWord.length);
    await key(" ", "Space", 32, undefined, 2);
    await until(() => buttons().length === 8, "re-edit before surrounding change");
    const oldReeditChoice = buttons()[0];
    editor.setSelectionRange(0, 0);
    await native([{ method: "Input.insertText", params: { text: "safe " } }]);
    oldReeditChoice.click();
    await key("Escape", "Escape", 27);
    assert(editor.value === "safe left kAN right",
      "Surrounding edits expire both old re-edit choices and original-word restoration");

    setText("naan ven", 8);
    await until(() => buttons().length === 8, "space candidates");
    const spaceCandidate = buttons()[0].textContent;
    await key(" ", "Space", 32, " ");
    assert(editor.value === `naan ${spaceCandidate} ` && editor.selectionStart === editor.value.length,
      "Space commits default candidate and inserts the natural typing space");
    await key("z", "KeyZ", 90, undefined, 2);
    assert(editor.value === "naan ven", "One native undo restores word and acceptance space together");

    setText("vendum", 6);
    await until(() => buttons().length === 8, "escape candidates");
    await key("Escape", "Escape", 27);
    await pause(180);
    assert(editor.value === "vendum" && popup.hidden && buttons().length === 0,
      "Escape dismisses choices without changing or automatically recommitting Roman text");
    await key(" ", "Space", 32, " ");
    assert(editor.value === "vendum ", "Space is native when choices were dismissed");
    setText("amma", 4);
    let acceptedPopupFlashes = 0;
    const pendingWords = new Set(["amma", "maruthuvamanai", "kaadhalan", "vendum"]);
    const pendingObserver = new MutationObserver(() => {
      if (!popup.hidden && pendingWords.has(window.demoDiagnostics.activeWord))
        acceptedPopupFlashes++;
    });
    pendingObserver.observe(popup, { attributes: true, attributeFilter: ["hidden"] });
    await key(" ", "Space", 32, " ");
    assert(editor.value === "amma " && popup.hidden, "Fast Space inserts its separator while waiting without showing choices");
    await until(() => window.demoDiagnostics.lastResult.roman === "amma" &&
      editor.value === `${window.demoDiagnostics.lastResult.candidates[0]} `, "deferred first-candidate Space");
    assert(popup.hidden && acceptedPopupFlashes === 0, "Fast Space automatically commits first candidate without rendering the popup");

    const inFlightWord = "maruthuvamanai";
    setText(inFlightWord, inFlightWord.length);
    await until(() => document.getElementById("status").textContent === "Running", "Space during active inference");
    await key(" ", "Space", 32, " ");
    await until(() => window.demoDiagnostics.lastResult.roman === inFlightWord &&
      editor.value === `${window.demoDiagnostics.lastResult.candidates[0]} `, "in-flight Space acceptance");
    assert(popup.hidden && acceptedPopupFlashes === 0, "Space also accepts an already-running request without flashing choices");

    const spaceActions = [
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 } }
    ];
    const beforeRapidCommits = commits();
    setText("prefix kaadhalan suffix", 16);
    await native([
      ...spaceActions, { method: "Input.insertText", params: { text: "amma" } },
      ...spaceActions, { method: "Input.insertText", params: { text: "vendum" } },
      ...spaceActions, { method: "Input.insertText", params: { text: "tail" } }
    ]);
    const firstResult = roman => window.demoDiagnostics.messages.filter(data => data.type === "result" && data.roman === roman).at(-1);
    const rapidExpected = () => ["kaadhalan", "amma", "vendum"].every(word => firstResult(word))
      ? `prefix ${firstResult("kaadhalan").candidates[0]} ${firstResult("amma").candidates[0]} ${firstResult("vendum").candidates[0]} tail suffix`
      : null;
    await until(() => rapidExpected() && editor.value === rapidExpected(), "multiple deferred words");
    assert(editor.selectionStart === editor.value.length - " suffix".length &&
      editor.selectionEnd === editor.selectionStart, "Deferred commits preserve following typing and its caret");
    assert(acceptedPopupFlashes === 0, "Rapid consecutive Space acceptances serialize without rendering accepted words");
    assert(commits() === beforeRapidCommits + 3, "Three deferred Space acceptances count three words, not their requests");
    pendingObserver.disconnect();
    await key("z", "KeyZ", 90, undefined, 2);
    assert(editor.value === `prefix ${firstResult("kaadhalan").candidates[0]} ${firstResult("amma").candidates[0]} vendum tail suffix`,
      "Undoing a deferred conversion preserves later typing and already-inserted spaces");

    const beforeCancelledCommits = commits();
    setText("athigaaram", 10);
    await native([...spaceActions,
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 } }
    ]);
    await until(() => firstResult("athigaaram"), "cancelled deferred result");
    assert(editor.value === "athigaaram " && popup.hidden, "Escape cancels deferred acceptance and leaves the typed Roman word intact");
    setText("vaazhkkai", 9);
    await native([...spaceActions,
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 } }
    ]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "vaazhkkai", "deleted deferred separator");
    assert(editor.value === "vaazhkkai", "Deleting the acceptance space cancels deferred conversion of that word");
    setText("nanbargal", 9);
    await native([...spaceActions,
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 } }
    ]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "nanbargal", "manually moved pending caret");
    assert(editor.value === "nanbargal " && editor.selectionStart === 9, "Manual caret navigation cancels deferred acceptance");
    setText("paadalgal", 9);
    await key(" ", "Space", 32, " ");
    editor.setRangeText("X", 0, 1, "preserve");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => firstResult("paadalgal"), "edited pending source");
    assert(editor.value === "Xaadalgal " && popup.hidden, "Changing an authorized source range rejects its deferred result");
    setText("kavithai", 8);
    await native([...spaceActions,
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "F6", code: "F6", windowsVirtualKeyCode: 117 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "F6", code: "F6", windowsVirtualKeyCode: 117 } }
    ]);
    await until(() => firstResult("kavithai"), "mode-cancelled pending word");
    assert(editor.value === "kavithai " && document.getElementById("mode").getAttribute("aria-pressed") === "false",
      "F6 cancels deferred acceptance rather than converting after Tamil mode is off");
    await key("F6", "F6", 117);
    setText("payanam", 7);
    await native([...spaceActions,
      { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 } },
      { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "z", code: "KeyZ", modifiers: 2, windowsVirtualKeyCode: 90 } }
    ]);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "payanam", "undone pending separator");
    assert(editor.value === "payanam", "Undo cancels pending acceptance without later reconverting the word");
    assert(commits() === beforeCancelledCommits, "Cancelled and edited pending compositions do not count as committed words");

    setText("vendum amma", 6);
    await until(() => buttons().length === 8, "keyboard stale candidates");
    editor.setSelectionRange(11, 11);
    await key("Enter", "Enter", 13, "\r");
    assert(editor.value === "vendum amma\n", "Enter never commits choices belonging to a different caret composition");
    setText("vendum\namma", 6);
    await until(() => buttons().length === 8, "modified navigation candidates");
    await key("ArrowDown", "ArrowDown", 40, undefined, 8);
    assert(editor.selectionStart !== editor.selectionEnd && buttons().length === 0,
      "Shift+Down remains native selection and dismisses old choices");
    setText("\u0b85\n\u0b86", 3);
    await key("ArrowUp", "ArrowUp", 38);
    assert(editor.selectionStart === 1, "Up remains normal textarea navigation without candidates");
    await key("ArrowDown", "ArrowDown", 40);
    assert(editor.selectionStart === 3, "Down remains normal textarea navigation without candidates");

    setText("vendum amma", 6);
    await until(() => buttons().length === 8, "candidate before caret move");
    editor.setSelectionRange(10, 10);
    editor.dispatchEvent(new Event("click"));
    assert(buttons().length === 0, "Caret movement immediately clears old candidates");
    await until(() => buttons().length > 0 && window.demoDiagnostics.lastResult.roman === "amma", "new word");
    const expired = buttons()[0];
    const beforeExpiredCommit = commits();
    setText("vendum changed", 6);
    expired.click();
    assert(editor.value === "vendum changed", "Detached stale candidate cannot modify changed text");
    assert(commits() === beforeExpiredCommit, "A stale candidate cannot increment the committed word count");
    editor.setSelectionRange(0, 6);
    editor.dispatchEvent(new Event("click"));
    assert(buttons().length === 0, "Selection is preserved and does not trigger word replacement");

    const wrapText = "hello ".repeat(8) + "vendum";
    setText(wrapText, wrapText.length);
    await until(() => buttons().length === 8, "geometry candidates");
    const wideTop = popup.getBoundingClientRect().top;
    editor.style.width = "240px";
    await until(() => popup.getBoundingClientRect().top > wideTop + 30, "textarea resize and wrapping");
    assert(editor.value === wrapText && !popup.hidden,
      "Textarea resize repositions popup at wrapped caret without modifying text");
    const pageTop = popup.getBoundingClientRect().top;
    document.body.style.minHeight = "1800px";
    window.scrollTo(0, 40);
    await until(() => Math.abs(popup.getBoundingClientRect().top - (pageTop - 40)) < 3, "page scroll");
    assert(!popup.hidden, "Page scrolling keeps popup adjacent to the editor caret");
    window.scrollTo(0, 0);
    document.body.style.removeProperty("min-height");
    editor.style.height = "100px";
    const scrollText = "\u0ba4\u0bae\u0bbf\u0bb4\u0bcd\n".repeat(12) + "vendum";
    setText(scrollText, scrollText.length);
    editor.scrollTop = editor.scrollHeight;
    await until(() => buttons().length === 8 && !popup.hidden, "visible scrolled composition");
    const scrollBounds = popup.getBoundingClientRect();
    assert(scrollBounds.top > editor.getBoundingClientRect().top &&
      scrollBounds.top < editor.getBoundingClientRect().bottom + 45,
      "Textarea scroll offset anchors popup to visible caret, not the unscrolled line");
    editor.scrollTop = 0;
    await until(() => popup.hidden, "offscreen caret");
    assert(editor.getAttribute("aria-expanded") === "false", "Popup hides when composing caret scrolls out of view");
    editor.scrollTop = editor.scrollHeight;
    await until(() => !popup.hidden, "caret scrolled back into view");
    assert(selected() === 0, "Scrolling back restores the same selected choices without new inference");

    editor.wrap = "off";
    const horizontalText = "hello ".repeat(30) + "vendum";
    setText(horizontalText, horizontalText.length);
    editor.scrollLeft = 0;
    await until(() => buttons().length === 8 && popup.hidden, "horizontally offscreen caret");
    editor.scrollLeft = editor.scrollWidth;
    await until(() => !popup.hidden, "horizontal scroll tracking");
    assert(popup.getBoundingClientRect().left > editor.getBoundingClientRect().left,
      "Horizontal scrolling tracks an unwrapped textarea caret");
    await native([{ method: "Emulation.setDeviceMetricsOverride", params: {
      width: 480, height: 520, deviceScaleFactor: 1, mobile: false
    } }]);
    await until(() => !popup.hidden && popup.getBoundingClientRect().right <= window.innerWidth - 7 &&
      popup.getBoundingClientRect().bottom <= editor.getBoundingClientRect().top + 30, "small viewport popup");
    assert(popup.getBoundingClientRect().top >= 8,
      "Short/narrow viewport keeps choices onscreen above caret instead of covering the active word");
    await key("ArrowUp", "ArrowUp", 38);
    const lastChoice = romanOption.getBoundingClientRect();
    assert(selected() === 8 && lastChoice.top >= popup.getBoundingClientRect().top &&
      lastChoice.bottom <= popup.getBoundingClientRect().bottom,
      "Selected literal option 0 scrolls into view in constrained popup");
    await key("ArrowUp", "ArrowUp", 38);
    const lastTamil = buttons()[7].getBoundingClientRect();
    assert(selected() === 7 && lastTamil.top >= popup.getBoundingClientRect().top &&
      lastTamil.bottom <= popup.getBoundingClientRect().bottom,
      "Arrow navigation from literal option 0 reaches Tamil option 8 and keeps it visible");
    await native([{ method: "Emulation.setDeviceMetricsOverride", params: {
      width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false
    } }]);
    editor.wrap = "soft";
    editor.style.removeProperty("width");
    editor.style.removeProperty("height");
    editor.scrollLeft = 0;
    editor.scrollTop = 0;

    setText("thiruvananthapuram", "thiruvananthapuram".length);
    await until(() => document.getElementById("status").textContent === "Running", "long-word inference");
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 10);
    await native([{ method: "Input.insertText", params: { text: " extra" } }]);
    await pause(500);
    clearInterval(heartbeat);
    assert(editor.value === "thiruvananthapuram extra", "Trusted typing works during model execution");
    assert(heartbeats >= 10, "UI event loop remains responsive during inference");
    await until(() => buttons().length > 0 && window.demoDiagnostics.lastResult.roman === "extra", "newest request");
    assert(window.demoDiagnostics.discardedResults > 0, "In-flight stale inference result is discarded");
    document.getElementById("mode").click();
    setText("", 0);
    const editsBeforeBurst = window.demoDiagnostics.typing?.edits || 0;
    await native(Array.from({ length: 140 }, () => ({ method: "Input.insertText", params: { text: "x" } })));
    await until(() => window.demoDiagnostics.typing?.edits >= editsBeforeBurst + 140, "trusted typing stats");
    const typing = window.demoDiagnostics.typing;
    assert(editor.value === "x".repeat(140) && typing.samples === 128 &&
      [typing.lastMs, typing.p95Ms, typing.maxMs].every(value => Number.isFinite(value) && value >= 0) &&
      typing.p95Ms <= typing.maxMs, "Typing stats measure trusted edits and retain only the last 128 samples");
    const expectedTypingMean = typingSamples.reduce((sum, value) => sum + value, 0) / typingSamples.length;
    assert(Math.abs(typing.averageMs - expectedTypingMean) < 1e-9 &&
      document.getElementById("typing-stats").textContent === `${expectedTypingMean.toFixed(1)} ms average`,
      "Editor response displays the arithmetic mean of the existing trusted edit measurements");
    assert(JSON.stringify([...document.querySelectorAll("#stats dt")].map(node => node.textContent)) ===
      JSON.stringify(["Words transliterated", "Editor response", "Word transliteration"]) &&
      !/cache|p95|maximum|samples|WASM|frame|candidate|worker/i.test(document.getElementById("stats").textContent),
      "Visible board presents only completed words and two plain averages");
    const help = document.querySelector("body > details");
    help.open = true;
    assert(!document.getElementById("diagnostics") && !document.getElementById("result-detail"),
      "Opening keyboard help does not expose internal profiling details");
    help.open = false;
    document.getElementById("mode").click();
    setText("amma", 4);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "F6", bubbles: true, cancelable: true }));
    assert(document.getElementById("mode").getAttribute("aria-pressed") === "false", "F6 toggles focused editor off");
    await pause(200);
    assert(buttons().length === 0 && editor.value === "amma", "Off mode leaves normal editing untouched");
    const liveBeforeCache = window.demoDiagnostics.wordTransliteration.completed;
    const wordMeanBeforeCache = document.getElementById("inference-stats").textContent;
    const commitsBeforeCache = commits();
    document.getElementById("mode").click();
    await until(() => buttons().length > 0, "clickable mode toggle");
    assert(window.demoDiagnostics.lastResult.cached &&
      window.demoDiagnostics.wordTransliteration.completed === liveBeforeCache &&
      document.getElementById("inference-stats").textContent === wordMeanBeforeCache && commits() === commitsBeforeCache,
      "Cached candidate retrieval changes neither the live neural average nor committed word count");

    setText("vendum", 6);
    await until(() => buttons().length === 8 && window.demoDiagnostics.lastResult.roman === "vendum", "identity-ranked candidates");
    const modelCandidates = [...new Set(window.demoDiagnostics.lastResult.raw
      .map(candidate => candidate.text.normalize("NFC").replace(/\u200c+$/, ""))
      .filter(text => /[\u0b80-\u0bff]/.test(text)))].slice(0, 8);
    assert(JSON.stringify(buttons().map(button => button.textContent)) === JSON.stringify(modelCandidates),
      "Identity ranking boundary displays normalized raw Top-8 in unchanged order");

    const resources = [...performance.getEntriesByType("resource").map(entry => entry.name),
      ...window.demoDiagnostics.lastResult.resources.map(entry => entry.url)];
    assert(resources.every(url => new URL(url).origin === location.origin && !new URL(url).pathname.startsWith("/api/")),
      "All page and worker resources are local static files; no inference API");
    assert(!resources.some(url => url.includes("ta-unigram")) &&
      !window.demoDiagnostics.messages.some(data => data.type === "dictionary-ready" || /dictionary/i.test(data.stage || "")),
      "Full editing session loads no dictionary asset and emits no dictionary runtime status");
    await native([{ method: "Network.enable", params: {} },
      { method: "Network.setBlockedURLs", params: { urls: ["*"] } }]);
    setText("pudhiya", 7);
    await until(() => buttons().length > 0 && window.demoDiagnostics.lastResult.roman === "pudhiya", "network-blocked inference");
    assert(window.demoDiagnostics.lastResult.cached === false, "New uncached inference succeeds with all browser networking blocked");

    assert(window.demoDiagnostics.lastResult.resources.every(item => resources.includes(item.url)),
      "Offline inference issues no additional worker fetches");
    await native([{ method: "Network.setBlockedURLs", params: { urls: [] } }]);
    const brokenWorker = new Worker("tests/missing-assets-worker.js");
    const failureResult = new Promise(resolve => {
      brokenWorker.onmessage = ({ data }) => { if (data.type === "error") resolve(data); };
    });
    brokenWorker.postMessage({ type: "initialize", id: 0 });
    const broken = await Promise.race([failureResult, pause(10000).then(() => { throw new Error("Missing asset failure timed out"); })]);
    brokenWorker.terminate();
    assert(broken.type === "error" && broken.stage && broken.message, "Network/missing-asset initialization failure is explicit");
    assert(editor.value === "pudhiya", "The independent missing-assets worker leaves the editor unchanged");
    const observedMean = observedLive.reduce((sum, value) => sum + value, 0) / observedLive.length;
    const wordTiming = window.demoDiagnostics.wordTransliteration;
    assert(observedCached > 0 && wordTiming.completed === observedLive.length &&
      Math.abs(wordTiming.averageMs - observedMean) < 1 &&
      document.getElementById("inference-stats").textContent === `${wordTiming.averageMs.toFixed(1)} ms average`,
      "Word average matches independently measured dispatch-to-result live requests, excluding cache and failures");
    const savedRecompose = window.TamilRecompose;
    try {
      window.TamilRecompose = undefined;
      beginReedit();
      const helperFailure = document.getElementById("error");
      assert(!helperFailure.hidden && helperFailure.textContent.includes(
        "Restore assets/tamil-recompose.js from this repository and reload.") && editor.value === "pudhiya",
        "Missing re-edit helper directs restoration of the committed file and preserves text");
    } finally { window.TamilRecompose = savedRecompose; }
    return { passed: true, checks, heartbeats, spaceQueuedDuringLoading,
      performanceBoard: { committedWords: commits(), observedLive: observedLive.length, observedCached, observedMean },
      diagnostics: window.demoDiagnostics, resources,
      memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null };
  } catch (error) { return { passed: false, checks, error: String(error.stack || error), diagnostics: window.demoDiagnostics }; }
})()
