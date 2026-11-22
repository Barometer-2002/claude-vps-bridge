param(
    [switch]$Disable,
    [switch]$Uninstall,
    [switch]$WithT3,
    [switch]$WithT3Native,
    [switch]$T3Only,
    [string]$T3Home
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer\select-python.ps1')
$bridgePython = Resolve-BridgePython
$manageT3 = Join-Path $PSScriptRoot 't3\manage.mjs'
$manageT3Native = Join-Path $PSScriptRoot 't3-native\manage-native.mjs'
$t3Args = @()
if ($T3Home) { $t3Args += @('--t3-home', $T3Home) }

function Invoke-T3Manage([string]$Action) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'T3 Code integration requires Node.js 24 or newer on PATH.' }
    & $node.Source $manageT3 $Action @t3Args
    if ($LASTEXITCODE -ne 0) { throw "T3 Code adapter $Action failed." }
}

function Invoke-T3NativeManage([string]$Action) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) { throw 'T3 Code native shim requires Node.js 24 or newer on PATH.' }
    & $node.Source $manageT3Native $Action @t3Args
    if ($LASTEXITCODE -ne 0) { throw "T3 Code native shim $Action failed." }
}

# Host-started shells inherit the default CODEXHOST_DATA_DIR; only other locations stop here.
& $bridgePython (Join-Path $PSScriptRoot 'installer\bridge_config.py') --check-roots
if ($LASTEXITCODE -ne 0) { throw 'A custom CodexHost plugin/data location is set; inspect the active runtime before installing.' }
if ($Disable -or $Uninstall) {
    if ($WithT3 -or $T3Only) {
        Invoke-T3Manage 'uninstall'
    }
    if ($WithT3Native) {
        Invoke-T3NativeManage 'uninstall'
    }
    if (-not $T3Only) {
        & $bridgePython (Join-Path $PSScriptRoot 'installer\disable.py')
        if ($LASTEXITCODE -ne 0) { throw '停用未完成，请查看错误信息；用户数据已保留。' }
    }
    return
}
# Both sides are prepared and checked before switching code. State is excluded.
& $bridgePython (Join-Path $PSScriptRoot 'installer\prepare-local.py')
if ($LASTEXITCODE -ne 0) { throw 'Local dependency preparation failed; installed bridge files were not replaced.' }
& $bridgePython (Join-Path $PSScriptRoot 'installer\prepare-dependency.py')
if ($LASTEXITCODE -ne 0) { throw 'Pinned dependency preparation failed; active bridge code was not replaced.' }
# Optional MCP configuration is managed separately; upgrades never import credentials.
& $bridgePython (Join-Path $PSScriptRoot 'installer\deploy-transaction.py')
if ($LASTEXITCODE -ne 0) { throw 'Bridge transaction failed. Read its journal for rollback or recovery status.' }

if ($WithT3 -or $T3Only) {
    Invoke-T3Manage 'install'
}
if ($WithT3Native) {
    Invoke-T3NativeManage 'install'
}

if ($T3Only) {
    Write-Host 'Installed for T3 Code. Refresh Claude VPS Bridge in T3 Code (Settings -> Providers) or restart T3 Code, then check with: node .\t3\manage.mjs status'
} elseif ($WithT3) {
    Write-Host 'Installed for CodexHost and T3 Code. For CodexHost: finish running tasks, run "codexhost stop", then reopen CodexHost. For T3 Code: refresh Claude VPS Bridge in Settings -> Providers or restart T3 Code.'
} else {
    # Plugins run in the shared background Host; reopening the desktop window keeps the old code.
    Write-Host 'Installed. To activate: finish running tasks, run "codexhost stop" (bin\codexhost.exe under the Host root), then open CodexHost. Check with: node .\plugin\diagnose.mjs (plugin-activation: current).'
}
