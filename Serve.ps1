param([ValidateRange(1024,65535)][int]$Port = 17841)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot) + [IO.Path]::DirectorySeparatorChar
$listener = [Net.HttpListener]::new()
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Static files only: http://127.0.0.1:$Port/ (Ctrl+C to stop)"
$mime = @{
    '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
    '.mjs' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
    '.json' = 'application/json'; '.wasm' = 'application/wasm'
}
try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        try {
            $relative = [Uri]::UnescapeDataString($context.Request.Url.AbsolutePath).TrimStart('/').Replace('/', '\')
            if (!$relative) { $relative = 'index.html' }
            $path = [IO.Path]::GetFullPath((Join-Path $root $relative))
            if (!$path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or
                !(Test-Path -LiteralPath $path -PathType Leaf)) {
                $context.Response.StatusCode = 404
            } elseif ($context.Request.HttpMethod -notin @('GET','HEAD')) {
                $context.Response.StatusCode = 405
            } else {
                $extension = [IO.Path]::GetExtension($path)
                $context.Response.ContentType = if ($mime.ContainsKey($extension)) { $mime[$extension] } else { 'application/octet-stream' }
                $context.Response.Headers['Cache-Control'] = 'no-store'
                $context.Response.Headers['X-Content-Type-Options'] = 'nosniff'
                $context.Response.Headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'"
                $context.Response.ContentLength64 = (Get-Item -LiteralPath $path).Length
                if ($context.Request.HttpMethod -eq 'GET') {
                    $file = [IO.File]::OpenRead($path)
                    try { $file.CopyTo($context.Response.OutputStream) } finally { $file.Dispose() }
                }
            }
        } catch {
            Write-Warning "Static request failed: $($_.Exception.Message)"
            $context.Response.Abort()
        } finally { $context.Response.Close() }
    }
} finally { $listener.Stop(); $listener.Close() }
