(async () => {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async test => {
    const end = performance.now() + 15000;
    while (performance.now() < end) { if (test()) return; await pause(20); }
    throw new Error("Local inference timed out");
  };
  try {
    await until(() => window.demoDiagnostics.lastResult?.candidates.length === 8);
    window.offlineReady = true;
    // The standalone harness stops its own Serve.ps1 during this bounded window.
    await pause(12000);
    let serverReachable = true;
    try { await fetch(`assets/source-vocab.json?offline=${Date.now()}`); }
    catch { serverReachable = false; }
    if (serverReachable) throw new Error("Stop the static server after window.offlineReady is true.");
    const editor = document.getElementById("editor");
    editor.focus();
    editor.value = "pudhiya";
    editor.setSelectionRange(7, 7);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    await until(() => window.demoDiagnostics.lastResult?.roman === "pudhiya");
    const result = window.demoDiagnostics.lastResult;
    const tamilCandidates = result.candidates.length > 0 &&
      result.candidates.every(text => typeof text === "string" && /[\u0b80-\u0bff]/.test(text));
    return { passed: result.cached === false && tamilCandidates && editor.value === "pudhiya",
      staticServerReachable: serverReachable, tamilCandidates, result,
      initialization: window.demoDiagnostics.initialization };
  } catch (error) { return { passed: false, error: String(error.stack || error) }; }
})()
