[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Summary,
    [Parameter(Mandatory = $true)][ValidateSet("in_progress", "passed", "failed")][string]$Status,
    [Parameter(Mandatory = $true)][string]$Verification
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$history = Join-Path $root "data\development_log\HISTORY.jsonl"
$record = [ordered]@{
    timestamp = [DateTimeOffset]::Now.ToString("o")
    status = $Status
    summary = $Summary
    verification = $Verification
}
($record | ConvertTo-Json -Compress) | Add-Content -LiteralPath $history -Encoding utf8
Write-Host "Development log appended: $history"
