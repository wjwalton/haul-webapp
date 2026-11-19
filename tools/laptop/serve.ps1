# Serves the Globe Haul Shop Tool from the "app" folder next to this script on http://localhost:8173/
# (localhost is a secure context, so Web Bluetooth works) and opens it in Chrome or Edge (the default
# browser if neither is found).
# Nothing to install: Windows PowerShell and .NET's HttpListener. Local only; nothing is reachable
# from other computers. Close this window to stop it.
param([int]$Port = 8173, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'app'))
if (-not $root.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $root += [System.IO.Path]::DirectorySeparatorChar }
if (-not (Test-Path -LiteralPath (Join-Path $root 'index.html'))) {
  Write-Host "No app\index.html next to this script. Copy the whole laptop folder." -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.txt' = 'text/plain; charset=utf-8'
  '.bin' = 'application/octet-stream'; '.zip' = 'application/zip'
}

$prefix = "http://localhost:$Port/"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
try {
  $listener.Start()
} catch {
  Write-Host "Couldn't start the local server on port $Port ($($_.Exception.Message))." -ForegroundColor Red
  Write-Host "Is it already running in another window? Otherwise try: serve.ps1 -Port 8174"
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host ''
Write-Host "Globe Haul Shop Tool: $prefix" -ForegroundColor Green
Write-Host 'Use it in Chrome or Edge. Keep this window open while you use the app; close it to stop.'
Write-Host ''

# Chrome or Edge: the verified browsers. Firefox has no Web Bluetooth, so the default browser is the last resort.
function Find-ShopBrowser {
  $dirs = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
  foreach ($exe in @('Google\Chrome\Application\chrome.exe', 'Microsoft\Edge\Application\msedge.exe')) {
    foreach ($d in $dirs) {
      $p = Join-Path $d $exe
      if (Test-Path -LiteralPath $p) { return $p }
    }
  }
  return $null
}

if (-not $NoBrowser) {
  $browser = Find-ShopBrowser
  if ($browser) { Start-Process -FilePath $browser -ArgumentList $prefix } else { Start-Process $prefix }
}

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
      if ($path -eq '/') { $path = '/index.html' }
      $full = [System.IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      if ($ctx.Request.HttpMethod -notin @('GET', 'HEAD')) {
        $res.StatusCode = 405
      } elseif ($full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
        $bytes = [System.IO.File]::ReadAllBytes($full)
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $res.Headers['Cache-Control'] = 'no-store'
        $res.Headers['X-Content-Type-Options'] = 'nosniff'
        $res.ContentLength64 = $bytes.Length
        if ($ctx.Request.HttpMethod -eq 'GET') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
      } else {
        $res.StatusCode = 404
      }
    } catch {
      $res.StatusCode = 500
    } finally {
      $res.Close()
    }
  }
} finally {
  $listener.Stop()
}
