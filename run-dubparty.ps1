$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$defaultDataRoot = Join-Path $projectRoot ".dubparty-data\projects"
if ([string]::IsNullOrWhiteSpace($env:DUBPARTY_DATA_DIR)) { $env:DUBPARTY_DATA_DIR = $defaultDataRoot }
$runtimeRoot = Join-Path $projectRoot ".runtime"
$nodeRoot = Join-Path $runtimeRoot "node"
$pythonRoot = Join-Path $runtimeRoot "python"
$nodePath = Join-Path $nodeRoot "node.exe"
$npmCmd = Join-Path $nodeRoot "npm.cmd"
$pythonPath = Join-Path $pythonRoot "python.exe"
$vitePath = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
$stdinFile = Join-Path $env:TEMP "dubparty-stdin-$PID.txt"
$backendProcess = $null
$frontendProcess = $null

$nodeVersion = "22.14.0"
$pythonVersion = "3.12.8"
$nodeArchive = "node-v$nodeVersion-win-x64.zip"
$pythonArchive = "python-$pythonVersion-embed-amd64.zip"
$nodeUrl = "https://nodejs.org/dist/v$nodeVersion/$nodeArchive"
$pythonUrl = "https://www.python.org/ftp/python/$pythonVersion/$pythonArchive"
$pipUrl = "https://bootstrap.pypa.io/get-pip.py"

function Download-File([string]$Url, [string]$Destination) {
    Write-Host "Downloading $Url ..." -ForegroundColor Cyan
    Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}

function Ensure-Runtime {
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    $nodeArchivePath = Join-Path $runtimeRoot $nodeArchive
    if (-not (Test-Path $nodePath)) {
        Download-File $nodeUrl $nodeArchivePath
        $nodeExtract = Join-Path $runtimeRoot "node-extract"
        if (Test-Path $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
        Expand-Archive -LiteralPath $nodeArchivePath -DestinationPath $nodeExtract -Force
        $extractedNode = Join-Path $nodeExtract "node-v$nodeVersion-win-x64"
        New-Item -ItemType Directory -Path $nodeRoot -Force | Out-Null
        Copy-Item -Path (Join-Path $extractedNode "*") -Destination $nodeRoot -Recurse -Force
        Remove-Item -LiteralPath $nodeExtract,$nodeArchivePath -Recurse -Force -ErrorAction SilentlyContinue
    }

    $pythonArchivePath = Join-Path $runtimeRoot $pythonArchive
    if (-not (Test-Path $pythonPath)) {
        Download-File $pythonUrl $pythonArchivePath
        New-Item -ItemType Directory -Path $pythonRoot -Force | Out-Null
        Expand-Archive -LiteralPath $pythonArchivePath -DestinationPath $pythonRoot -Force
        Remove-Item -LiteralPath $pythonArchivePath -Force
    }

    if (-not (Test-Path $npmCmd)) { throw "Portable Node.js was downloaded, but npm.cmd is missing." }
    if (-not (Test-Path $pythonPath)) { throw "Portable Python was downloaded, but python.exe is missing." }

    $pthFile = Join-Path $pythonRoot "python312._pth"
    if (Test-Path $pthFile) {
        $pthText = Get-Content -Raw $pthFile
        if ($pthText -notmatch '(?m)^import site\s*$') {
            Add-Content -LiteralPath $pthFile -Value "`nimport site`n"
        }
    }
    $pipModule = Join-Path $pythonRoot "Lib\site-packages\pip"
    if (-not (Test-Path $pipModule)) {
        $pipScript = Join-Path $runtimeRoot "get-pip.py"
        Download-File $pipUrl $pipScript
        & $pythonPath $pipScript --disable-pip-version-check --no-warn-script-location
        if ($LASTEXITCODE -ne 0) { throw "Could not install Python packages bootstrap." }
        Remove-Item -LiteralPath $pipScript -Force -ErrorAction SilentlyContinue
    }

    $frontendLock = Join-Path $projectRoot "package-lock.json"
    $frontendStamp = Join-Path $runtimeRoot "frontend-deps.sha256"
    $frontendHash = (Get-FileHash -LiteralPath $frontendLock -Algorithm SHA256).Hash
    $viteEntry = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
    $installedFrontendHash = if (Test-Path $frontendStamp) { (Get-Content -Raw $frontendStamp).Trim() } else { "" }
    if (-not (Test-Path $viteEntry) -or $installedFrontendHash -ne $frontendHash) {
        Write-Host "Installing frontend dependencies..." -ForegroundColor Cyan
        & $npmCmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
        Set-Content -LiteralPath $frontendStamp -Value $frontendHash -NoNewline
    }
    $fastapiModule = Join-Path $pythonRoot "Lib\site-packages\fastapi"
    $multipartModule = Join-Path $pythonRoot "Lib\site-packages\python_multipart"
    $backendRequirements = Join-Path $projectRoot "backend\requirements.txt"
    $backendStamp = Join-Path $runtimeRoot "backend-deps.sha256"
    $backendHash = (Get-FileHash -LiteralPath $backendRequirements -Algorithm SHA256).Hash
    $installedBackendHash = if (Test-Path $backendStamp) { (Get-Content -Raw $backendStamp).Trim() } else { "" }
    if (-not (Test-Path $fastapiModule) -or -not (Test-Path $multipartModule) -or $installedBackendHash -ne $backendHash) {
        Write-Host "Installing backend dependencies..." -ForegroundColor Cyan
        & $pythonPath -m pip install --disable-pip-version-check --no-warn-script-location -r $backendRequirements
        if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }
        Set-Content -LiteralPath $backendStamp -Value $backendHash -NoNewline
    }
}

function Assert-PortFree([int]$Port) {
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try {
        $probe.Start()
    }
    catch {
        throw "Port $Port is already in use. Close the existing DubParty session and retry."
    }
    finally {
        $probe.Stop()
    }
}

function Stop-ManagedProcess($Process) {
    if ($null -eq $Process) { return $true }
    try {
        if (-not $Process.HasExited) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F 2>$null | Out-Null
            if (-not $Process.HasExited) { $Process.Kill() }
            $null = $Process.WaitForExit(5000)
        }
        return $Process.HasExited
    }
    catch {
        Write-Host "Could not stop process $($Process.Id): $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

try {
    Assert-PortFree 8765
    Assert-PortFree 1420
    Ensure-Runtime
    [System.IO.File]::WriteAllText($stdinFile, "")

    Write-Host "Starting backend..." -ForegroundColor Cyan
    $backendProcess = Start-Process -FilePath $pythonPath `
        -ArgumentList @("-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", "8765") `
        -WorkingDirectory $projectRoot -NoNewWindow -RedirectStandardInput $stdinFile -PassThru

    $backendReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($backendProcess.HasExited) { throw "Backend stopped during startup. Check the Python dependencies." }
        try {
            $null = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 1
            $backendReady = $true
            break
        }
        catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $backendReady) { throw "Backend did not respond on 127.0.0.1:8765 within 10 seconds." }

    Write-Host "Starting frontend..." -ForegroundColor Cyan
    $viteArguments = '"' + $vitePath + '" --host 127.0.0.1 --port 1420 --strictPort'
    $frontendProcess = Start-Process -FilePath $nodePath `
        -ArgumentList $viteArguments -WorkingDirectory $projectRoot -NoNewWindow -RedirectStandardInput $stdinFile -PassThru

    $frontendReady = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($frontendProcess.HasExited) { throw "Vite stopped during startup." }
        try {
            $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:1420" -TimeoutSec 1
            $frontendReady = $true
            break
        }
        catch { Start-Sleep -Milliseconds 250 }
    }
    if (-not $frontendReady) { throw "Frontend did not respond on 127.0.0.1:1420 within 10 seconds." }

    Write-Host "DubParty is running. Open http://127.0.0.1:1420 in your browser." -ForegroundColor Green
    Write-Host "Type status to check services or exit to stop DubParty."

    while ($true) {
        if ($backendProcess.HasExited) { throw "Backend stopped unexpectedly." }
        if ($frontendProcess.HasExited) { throw "Frontend stopped unexpectedly." }
        $command = Read-Host "DubParty"
        if ($command -match '^\s*exit\s*$') { break }
        if ($command -match '^\s*status\s*$') {
            $backendStatus = "offline"
            $frontendStatus = "offline"
            try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:8765/api/health" -TimeoutSec 2; $backendStatus = "online" } catch { }
            try { $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:1420" -TimeoutSec 2; $frontendStatus = "online" } catch { }
            Write-Host "Backend: $backendStatus (http://127.0.0.1:8765) | Frontend: $frontendStatus (http://127.0.0.1:1420)"
        }
        else {
            Write-Host "Commands: status, exit"
        }
    }
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
finally {
    $frontendStopped = Stop-ManagedProcess $frontendProcess
    $backendStopped = Stop-ManagedProcess $backendProcess
    if (Test-Path $stdinFile) {
        try { Remove-Item -LiteralPath $stdinFile -Force -ErrorAction Stop }
        catch { Write-Host "Could not remove temporary input file: $($_.Exception.Message)" -ForegroundColor Yellow }
    }
    if ($frontendStopped -and $backendStopped) {
        Write-Host "DubParty stopped." -ForegroundColor DarkGray
    }
    else {
        Write-Host "One or more processes could not be stopped. Check ports 1420 and 8765." -ForegroundColor Red
    }
}
