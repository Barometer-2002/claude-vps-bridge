param(
    [string]$T3Home
)

$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') -T3Only -Uninstall @PSBoundParameters
