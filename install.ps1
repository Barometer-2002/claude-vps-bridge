param(
    [switch]$Disable,
    [switch]$Uninstall,
    [switch]$WithT3,
    [switch]$WithT3Native,
    [switch]$T3Only,
    [switch]$WithAcp,
    [switch]$AcpOnly,
    [switch]$Standalone,
    [string]$T3Home,
    [string]$ShimDir,
    [string]$AcpDir
)
$ErrorActionPreference = 'Stop'
$manageT3Native = Join-Path $PSScriptRoot 't3-native\manage-native.mjs'
$manageAcp = Join-Path $PSScriptRoot 'acp\manage-acp.mjs'
$t3Args = @()
if ($T3Home) { $t3Args += @('--t3-home', $T3Home) }
if ($ShimDir) { $t3Args += @('--shim-dir', $ShimDir) }
$acpArgs = @()
if ($AcpDir) { $acpArgs += @('--acp-dir', $AcpDir) }
if ($ShimDir) { $acpArgs += @('--shim-dir', $ShimDir) }
$includeT3 = [bool]($T3Only -or $WithT3 -or $WithT3Native)
$includeAcp = [bool]($AcpOnly -or $WithAcp)

function Resolve-PreferredNode {
    if ($script:PreferredNode) { return $script:PreferredNode }
    try {
        if (-not $script:BridgePythonForNode) {
            . (Join-Path $PSScriptRoot 'installer\select-python.ps1')
            $script:BridgePythonForNode = Resolve-BridgePython
        }
        $raw = & $script:BridgePythonForNode (Join-Path $PSScriptRoot 'installer\bridge_config.py') --node 2>$null
        if ($LASTEXITCODE -eq 0 -and $raw) {
            $candidate = ([string]$raw).Trim()
            if ($candidate -and (Test-Path -LiteralPath $candidate)) {
                $script:PreferredNode = $candidate
                return $candidate
            }
        }
    } catch {
    }
    return $null
}

function Invoke-NodeManager([string]$ScriptPath, [string]$Label, [string]$Action, [string[]]$ExtraArgs) {
    $nodePath = Resolve-PreferredNode
    if (-not $nodePath) {
        $node = Get-Command node -ErrorAction SilentlyContinue
        if ($node) { $nodePath = $node.Source }
    }
    if (-not $nodePath) { throw "$Label requires Node.js 24 or newer (bridge nodeExecutable or on PATH)." }
    & $nodePath $ScriptPath $Action @ExtraArgs
    if ($LASTEXITCODE -ne 0) { throw "$Label $Action failed." }
}

if (($T3Only -or $AcpOnly) -and ($Disable -or $Uninstall)) {
    if ($includeT3) { Invoke-NodeManager $manageT3Native 'T3 Code native shim' 'uninstall' $t3Args }
    if ($includeAcp) { Invoke-NodeManager $manageAcp 'Standard ACP wrapper' 'uninstall' $acpArgs }
    return
}

. (Join-Path $PSScriptRoot 'installer\select-python.ps1')
$bridgePython = Resolve-BridgePython

# Host-started shells inherit the default CODEXHOST_DATA_DIR; only other locations stop here.
& $bridgePython (Join-Path $PSScriptRoot 'installer\bridge_config.py') --check-roots
if ($LASTEXITCODE -ne 0) { throw 'A custom CodexHost plugin/data location is set; inspect the active runtime before installing.' }
if ($Disable -or $Uninstall) {
    if ($includeT3) {
        Invoke-NodeManager $manageT3Native 'T3 Code native shim' 'uninstall' $t3Args
    }
    if ($includeAcp) {
        Invoke-NodeManager $manageAcp 'Standard ACP wrapper' 'uninstall' $acpArgs
    }
    & $bridgePython (Join-Path $PSScriptRoot 'installer\disable.py')
    if ($LASTEXITCODE -ne 0) { throw '停用未完成，请查看错误信息；用户数据已保留。' }
    return
}
$configModeRaw = & $bridgePython (Join-Path $PSScriptRoot 'installer\bridge_config.py') --mode
if ($LASTEXITCODE -ne 0) { throw 'Failed to inspect bridge configuration mode; run installer\configure.py first.' }
$configMode = ([string]$configModeRaw).Trim()
if ($Standalone -and $configMode -eq 'codexhost') {
    throw 'Cannot pass -Standalone when bridge configuration targets CodexHost (hostRoot is set). Clear hostRoot or omit -Standalone.'
}
$standaloneMode = ($configMode -eq 'standalone') -or (($Standalone -or $AcpOnly) -and $configMode -ne 'codexhost')

# Both sides are prepared and checked before switching code. State is excluded.
& $bridgePython (Join-Path $PSScriptRoot 'installer\prepare-local.py')
if ($LASTEXITCODE -ne 0) { throw 'Local dependency preparation failed; installed bridge files were not replaced.' }
if (-not $standaloneMode) {
    & $bridgePython (Join-Path $PSScriptRoot 'installer\prepare-dependency.py')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned dependency preparation failed; active bridge code was not replaced.' }
}
# Optional MCP configuration is managed separately; upgrades never import credentials.
& $bridgePython (Join-Path $PSScriptRoot 'installer\deploy-transaction.py')
if ($LASTEXITCODE -ne 0) { throw 'Bridge transaction failed. Read its journal for rollback or recovery status.' }

if ($includeT3) {
    Invoke-NodeManager $manageT3Native 'T3 Code native shim' 'install' $t3Args
}
if ($includeAcp) {
    Invoke-NodeManager $manageAcp 'Standard ACP wrapper' 'install' $acpArgs
}

if ($T3Only -and $includeAcp) {
    Write-Host 'Installed for T3 Code (native shim) and standard ACP wrapper. Check with: node .\t3-native\manage-native.mjs status && node .\acp\manage-acp.mjs status'
} elseif ($AcpOnly) {
    Write-Host 'Installed standard ACP wrapper (Claude VPS). Check with: node .\acp\manage-acp.mjs status'
} elseif ($T3Only) {
    Write-Host 'Installed for T3 Code (Claude VPS native claudeAgent shim). Refresh Providers in T3 Code or restart T3 Code, then check with: node .\t3-native\manage-native.mjs status'
} elseif ($standaloneMode -and -not $includeT3 -and -not $includeAcp) {
    Write-Host 'Installed standalone Claude VPS bridge (no CodexHost adapter required). Check with: node .\plugin\diagnose.mjs'
} elseif ($includeT3 -or $includeAcp) {
    Write-Host 'Installed for CodexHost and requested Claude VPS integrations. For CodexHost: finish running tasks, run "codexhost stop", then reopen CodexHost.'
} else {
    # Plugins run in the shared background Host; reopening the desktop window keeps the old code.
    Write-Host 'Installed. To activate: finish running tasks, run "codexhost stop" (bin\codexhost.exe under the Host root), then open CodexHost. Check with: node .\plugin\diagnose.mjs (plugin-activation: current).'
}
