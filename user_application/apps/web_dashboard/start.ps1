[CmdletBinding()]
param([int]$Port = 8766, [switch]$FixtureAircraft, [switch]$OpenSky)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$python = Join-Path $root "project_support\environment\web_venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $python)) {
    throw "Create project_support/environment/web_venv and install user_application/apps/web_dashboard/requirements.txt first."
}
Push-Location $root
try {
    $arguments = @("-m", "user_application.apps.web_dashboard", "--port", "$Port")
    if ($FixtureAircraft) { $arguments += "--fixture-aircraft" }
    if ($OpenSky) { $arguments += "--opensky" }
    & $python @arguments
} finally { Pop-Location }
