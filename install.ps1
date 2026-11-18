param([switch]$Disable, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer\select-python.ps1')
$bridgePython = Resolve-BridgePython
# Host-started shells inherit the default CODEXHOST_DATA_DIR; only other locations stop here.
& $bridgePython (Join-Path $PSScriptRoot 'installer\bridge_config.py') --check-roots
if ($LASTEXITCODE -ne 0) { throw 'A custom CodexHost plugin/data location is set; inspect the active runtime before installing.' }
if ($Disable -or $Uninstall) {
    & $bridgePython (Join-Path $PSScriptRoot 'installer\disable.py')
    if ($LASTEXITCODE -ne 0) { throw '停用未完成，请查看错误信息；用户数据已保留。' }
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
# Plugins run in the shared background Host; reopening the desktop window keeps the old code.
Write-Host 'Installed. To activate: finish running tasks, run "codexhost stop" (bin\codexhost.exe under the Host root), then open CodexHost. Check with: node .\plugin\diagnose.mjs (plugin-activation: current).'
