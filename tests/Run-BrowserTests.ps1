param(
    [ValidateSet('All', 'Regression', 'Editor', 'Failure', 'Offline')]
    [string]$Workflow = 'All',
    [string]$BrowserPath,
    [ValidateRange(30, 1800)][int]$TimeoutSeconds = 240
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $root 'Setup-Assets.ps1')

if (!$BrowserPath) {
    $BrowserPath = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (!$BrowserPath -or !(Test-Path -LiteralPath $BrowserPath -PathType Leaf)) {
    throw 'Edge was not found. Supply -BrowserPath with an installed Chromium browser executable.'
}
$BrowserPath = [IO.Path]::GetFullPath($BrowserPath)
$powerShellPath = (Get-Process -Id $PID).Path
$evidence = Join-Path $PSScriptRoot 'evidence\standalone'
New-Item -ItemType Directory -Force $evidence | Out-Null
$workflows = if ($Workflow -eq 'All') { @('Regression', 'Editor', 'Failure', 'Offline') } else { @($Workflow) }

function Receive-Cdp {
    $buffer = New-Object byte[] 65536
    $stream = [IO.MemoryStream]::new()
    $cancel = [Threading.CancellationTokenSource]::new(30000)
    try {
        do {
            $segment = [ArraySegment[byte]]::new($buffer)
            $received = $script:socket.ReceiveAsync($segment, $cancel.Token).GetAwaiter().GetResult()
            if ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                throw 'Browser DevTools connection closed.'
            }
            $stream.Write($buffer, 0, $received.Count)
        } until ($received.EndOfMessage)
        $message = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
        if ($null -ne $message.id) {
            $script:responses[[int]$message.id] = $message
        } elseif ($message.method -eq 'Runtime.bindingCalled' -and $message.params.name -eq '__tcNative') {
            $script:bindings.Enqueue($message.params.payload)
        }
    } finally {
        $cancel.Dispose()
        $stream.Dispose()
    }
}

function Send-Cdp([string]$Method, [hashtable]$Parameters = @{}) {
    $id = ++$script:nextId
    $json = @{ id = $id; method = $Method; params = $Parameters } | ConvertTo-Json -Depth 30 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $cancel = [Threading.CancellationTokenSource]::new(30000)
    try {
        $null = $script:socket.SendAsync([ArraySegment[byte]]::new($bytes),
            [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
        while (!$script:responses.ContainsKey($id)) { Receive-Cdp }
        $response = $script:responses[$id]
        $script:responses.Remove($id)
        if ($response.error) { throw "$Method failed: $($response.error | ConvertTo-Json -Compress)" }
        return $response.result
    } finally { $cancel.Dispose() }
}

function Evaluate-Cdp([string]$Expression) {
    $result = Send-Cdp 'Runtime.evaluate' @{ expression = $Expression; returnByValue = $true }
    if ($result.exceptionDetails) {
        throw "Browser evaluation failed: $($result.exceptionDetails | ConvertTo-Json -Depth 10 -Compress)"
    }
    return $result.result.value
}

function Invoke-NativeBindings {
    while ($script:bindings.Count) {
        $job = $script:bindings.Dequeue() | ConvertFrom-Json
        foreach ($action in $job.actions) {
            $parameters = @{}
            foreach ($property in $action.params.PSObject.Properties) { $parameters[$property.Name] = $property.Value }
            $null = Send-Cdp $action.method $parameters
        }
        $jobId = ConvertTo-Json -InputObject ([string]$job.id) -Compress
        $null = Evaluate-Cdp "window.__tcNativeDone($jobId, null)"
    }
}

foreach ($name in $workflows) {
    $temporary = Join-Path ([IO.Path]::GetTempPath()) ("indicxlit-browser-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    $server = $null
    $browser = $null
    $script:socket = $null
    $script:nextId = 0
    $script:responses = @{}
    $script:bindings = [Collections.Generic.Queue[string]]::new()
    try {
        # Reserve a free loopback port without assuming the checkout or working directory.
        $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
        $probe.Start()
        $port = $probe.LocalEndpoint.Port
        $probe.Stop()
        $url = "http://127.0.0.1:$port/"
        $serveRoot = $root
        if ($name -eq 'Failure') {
            # An isolated copy intentionally omits only the runtime script.
            $serveRoot = Join-Path $temporary 'missing-runtime'
            New-Item -ItemType Directory -Path $serveRoot | Out-Null
            foreach ($file in @('Serve.ps1', 'index.html', 'styles.css', 'app.js',
                    'indicxlit-worker.js', 'textarea-caret.js', 'performance.js')) {
                Copy-Item -LiteralPath (Join-Path $root $file) -Destination $serveRoot
            }
            Copy-Item -LiteralPath (Join-Path $root 'assets') -Destination $serveRoot -Recurse
            $fixtureRuntime = Join-Path $serveRoot 'runtime'
            New-Item -ItemType Directory -Path $fixtureRuntime | Out-Null
            foreach ($file in @('ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm')) {
                Copy-Item -LiteralPath (Join-Path $root "runtime\$file") -Destination $fixtureRuntime
            }
        }
        $servePath = Join-Path $serveRoot 'Serve.ps1'
        $server = Start-Process -FilePath $powerShellPath -ArgumentList @(
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$servePath`"", '-Port', $port
        ) -PassThru -RedirectStandardOutput (Join-Path $temporary 'server.log') `
            -RedirectStandardError (Join-Path $temporary 'server-error.log')
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            $connection = [Net.Sockets.TcpClient]::new()
            try {
                $connection.Connect('127.0.0.1', $port)
                $listening = $true
            } catch [Net.Sockets.SocketException] { $listening = $false }
            finally { $connection.Dispose() }
            if ($server.HasExited) {
                throw "Static server exited: $(Get-Content -LiteralPath (Join-Path $temporary 'server-error.log') -Raw)"
            }
            if (!$listening) { Start-Sleep -Milliseconds 50 }
        } until ($listening -or [DateTime]::UtcNow -gt $deadline)
        if (!$listening) { throw 'Static server did not start.' }

        $profile = Join-Path $temporary 'profile'
        $browser = Start-Process -FilePath $BrowserPath -ArgumentList @(
            '--headless=new', '--remote-debugging-port=0', "--user-data-dir=`"$profile`"",
            '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost',
            '--window-size=1440,1000', 'about:blank'
        ) -PassThru -RedirectStandardOutput (Join-Path $temporary 'browser.log') `
            -RedirectStandardError (Join-Path $temporary 'browser-error.log')
        $activePort = Join-Path $profile 'DevToolsActivePort'
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while (!(Test-Path -LiteralPath $activePort) -and [DateTime]::UtcNow -lt $deadline) {
            if ($browser.HasExited) { throw 'Headless browser exited before opening DevTools.' }
            Start-Sleep -Milliseconds 50
        }
        if (!(Test-Path -LiteralPath $activePort)) { throw 'Browser DevTools did not start.' }
        $debugPort = (Get-Content -LiteralPath $activePort)[0]
        $targets = Invoke-RestMethod "http://127.0.0.1:$debugPort/json/list" -TimeoutSec 10
        $target = $targets | Where-Object type -eq 'page' | Select-Object -First 1
        if (!$target.webSocketDebuggerUrl) { throw 'Browser has no inspectable page.' }
        $script:socket = [Net.WebSockets.ClientWebSocket]::new()
        $connectCancel = [Threading.CancellationTokenSource]::new(10000)
        try {
            $null = $script:socket.ConnectAsync([Uri]$target.webSocketDebuggerUrl,
                $connectCancel.Token).GetAwaiter().GetResult()
        } finally { $connectCancel.Dispose() }
        $null = Send-Cdp 'Page.enable'
        $null = Send-Cdp 'Runtime.enable'
        $null = Send-Cdp 'Runtime.addBinding' @{ name = '__tcNative' }
        $null = Send-Cdp 'Emulation.setFocusEmulationEnabled' @{ enabled = $true }
        $null = Send-Cdp 'Emulation.setDeviceMetricsOverride' @{
            width = 1440; height = 1000; deviceScaleFactor = 1; mobile = $false
        }
        if ($name -eq 'Failure') {
            # Record nonempty user content at the real browser-worker construction boundary.
            $null = Send-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = @'
(() => {
  Object.defineProperty(window, "__failureInitialText", {
    value: "Tamil: \u0ba8\u0bbe\u0ba9\u0bcd. Roman: naan tamil.\nKeep this second line intact."
  });
  const BrowserWorker = window.Worker;
  window.Worker = class extends BrowserWorker {
    constructor(...args) {
      const editor = document.getElementById("editor");
      if (!editor) throw new Error("Failure fixture has no editor.");
      editor.value = window.__failureInitialText;
      editor.setSelectionRange(editor.value.length, editor.value.length);
      window.__failureTextAtWorkerStart = editor.value;
      super(...args);
    }
  };
})();
'@ }
        }
        $page = if ($name -eq 'Regression') { $url + 'tests/browser-regression.html' } else { $url }
        $null = Send-Cdp 'Page.navigate' @{ url = $page }
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        $ready = if ($name -eq 'Regression') { "typeof window.runRegression === 'function'" } else {
            "!!document.getElementById('editor')"
        }
        while (!(Evaluate-Cdp "document.readyState === 'complete' && ($ready)")) {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Demo page did not load.' }
            Start-Sleep -Milliseconds 20
        }
        if ($name -eq 'Offline') {
            $null = Evaluate-Cdp @"
(() => {
const editor = document.getElementById('editor');
editor.value = 'vendum';
editor.setSelectionRange(6, 6);
editor.dispatchEvent(new Event('input', { bubbles: true }));
})();
"@
        }
        $workflowPath = Join-Path $PSScriptRoot ($name + 'Workflow.js')
        $source = Get-Content -LiteralPath $workflowPath -Raw -Encoding UTF8
        $null = Evaluate-Cdp @"
window.__standaloneResult = undefined;
Promise.resolve($source).then(
  result => { window.__standaloneResult = result; },
  error => { window.__standaloneResult = { passed: false, error: String(error.stack || error) }; }
);
"@
        $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
        do {
            Invoke-NativeBindings
            if ($name -eq 'Offline' -and $server -and (Evaluate-Cdp 'window.offlineReady === true')) {
                Stop-Process -Id $server.Id
                $server.WaitForExit()
                $server.Dispose()
                $server = $null
            }
            $result = Evaluate-Cdp 'window.__standaloneResult'
            if ([DateTime]::UtcNow -gt $deadline) { throw "$name workflow timed out." }
            if ($null -eq $result) { Start-Sleep -Milliseconds 20 }
        } until ($null -ne $result)
        $result | Add-Member -NotePropertyName qualification -NotePropertyValue ([ordered]@{
            capturedAtUtc = [DateTime]::UtcNow.ToString('o')
            workflow = $name
            userAgent = Evaluate-Cdp 'navigator.userAgent'
            powerShellVersion = $PSVersionTable.PSVersion.ToString()
            os = [Environment]::OSVersion.VersionString
            viewport = @{ width = 1440; height = 1000 }
        })
        $result | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath (Join-Path $evidence "$name.json") -Encoding UTF8
        if (!$result.passed) { throw "$name failed. See $evidence\$name.json. $($result.error)" }
        Write-Host "$name passed."
    } finally {
        if ($script:socket) { $script:socket.Dispose() }
        if ($browser) {
            if (!$browser.HasExited) { Stop-Process -Id $browser.Id; $browser.WaitForExit() }
            $browser.Dispose()
        }
        if ($server) {
            if (!$server.HasExited) { Stop-Process -Id $server.Id; $server.WaitForExit() }
            $server.Dispose()
        }
        # This exact, newly-created profile directory belongs only to this test run.
        Remove-Item -LiteralPath $temporary -Recurse -Force
    }
}
