(async () => {
  const editor = document.getElementById("editor");
  const expectedText = window.__failureInitialText;
  const seededNonemptyText = typeof expectedText === "string" && expectedText.length > 0 &&
    window.__failureTextAtWorkerStart === expectedText;
  const end = performance.now() + 10000;
  while (performance.now() < end && document.getElementById("status").textContent !== "Failed")
    await new Promise(resolve => setTimeout(resolve, 20));
  const error = document.getElementById("error");
  const preservedText = editor.value;
  const textUnchanged = preservedText === expectedText;
  const connectedWorkerError = window.demoDiagnostics.messages.find(data =>
    data.type === "error" && data.id === 0 && data.stage === "Loading runtime" &&
    typeof data.message === "string" && data.message.includes("runtime/ort.wasm.min.js"));
  editor.focus();
  editor.setRangeText(" still editable", editor.value.length, editor.value.length, "end");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  const stillEditable = editor.value === expectedText + " still editable";
  return { passed: seededNonemptyText && Boolean(connectedWorkerError) && textUnchanged &&
    document.getElementById("status").textContent === "Failed" &&
    !error.hidden && error.textContent.length > 0 && stillEditable,
    seededNonemptyText, expectedText, textAtWorkerStart: window.__failureTextAtWorkerStart,
    preservedText, textUnchanged, stillEditable,
    connectedWorkerError, message: error.textContent, status: document.getElementById("status").textContent };
})()
