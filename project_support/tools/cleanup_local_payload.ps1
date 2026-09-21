[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Unreal,
    [switch]$Dem,
    [switch]$Handoff
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path.TrimEnd("\")

function Remove-RepositoryDirectory {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $candidate = Join-Path $repositoryRoot $RelativePath
    if (-not (Test-Path -LiteralPath $candidate)) {
        return
    }

    $resolved = (Resolve-Path -LiteralPath $candidate).Path.TrimEnd("\")
    if (-not $resolved.StartsWith(
            $repositoryRoot + "\",
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Refusing to remove a path outside the repository: $resolved"
    }

    if ($PSCmdlet.ShouldProcess($resolved, "Remove local generated/reference payload")) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}

function Remove-RepositoryFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $candidate = Join-Path $repositoryRoot $RelativePath
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        return
    }

    $resolved = (Resolve-Path -LiteralPath $candidate).Path
    if (-not $resolved.StartsWith(
            $repositoryRoot + "\",
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw "Refusing to remove a file outside the repository: $resolved"
    }

    if ($PSCmdlet.ShouldProcess($resolved, "Remove local generated/retired file")) {
        Remove-Item -LiteralPath $resolved -Force
    }
}

if ($Unreal) {
    Remove-RepositoryDirectory "digital_twin\visualization\unreal"
    Remove-RepositoryDirectory "project_support\reference\projectairsim\unreal"
    Remove-RepositoryDirectory "project_support\reference\projectairsim\packages\Blocks"
    Remove-RepositoryDirectory "project_support\environment\kp2_logo_export"
    Remove-RepositoryDirectory "project_support\build\aerodt\windows-unreal"
}

if ($Dem) {
    Remove-RepositoryDirectory "data\workspace\terrain"

    $dropDirectory = Join-Path $repositoryRoot "임시폴더"
    if (Test-Path -LiteralPath $dropDirectory) {
        Get-ChildItem -LiteralPath $dropDirectory -File -Filter "n??_e???_1arc_v3.tif" |
            ForEach-Object {
                if ($PSCmdlet.ShouldProcess($_.FullName, "Remove unused DEM source tile")) {
                    Remove-Item -LiteralPath $_.FullName -Force
                }
            }
    }
}

if ($Handoff) {
    # Active source no longer uses the retired Unreal/ProjectAirSim host path.
    Remove-RepositoryDirectory "user_application\apps\uam_native_unreal_demo"
    Remove-RepositoryDirectory "user_application\apps\uam_seoul_sim"
    Remove-RepositoryDirectory "user_application\configs\runtime"
    Remove-RepositoryDirectory "digital_twin\visualization\include"
    Remove-RepositoryDirectory "digital_twin\visualization\src"
    Remove-RepositoryDirectory "digital_twin\visualization\tests"
    Remove-RepositoryFile "digital_twin\visualization\CMakeLists.txt"
    Remove-RepositoryFile "communication\python\aerodt\communication\projectairsim_adapter.py"
    Remove-RepositoryFile "project_support\tests\regression\test_seoul_uam_deployment.py"
    Remove-RepositoryFile "project_support\tools\build_unreal_native.ps1"
    Remove-RepositoryFile "project_support\tools\build_seoul_uam_sim.ps1"
    Remove-RepositoryFile "project_support\tools\export_uam_visual_asset.ps1"

    # Only durable support documentation, tests, tools and the local environment survive.
    $supportRoot = Join-Path $repositoryRoot "project_support"
    $keptSupportDirectories = @("docs", "environment", "tests", "tools")
    Get-ChildItem -LiteralPath $supportRoot -Directory -Force |
        Where-Object { $_.Name -notin $keptSupportDirectories } |
        ForEach-Object {
            Remove-RepositoryDirectory ([System.IO.Path]::GetRelativePath($repositoryRoot, $_.FullName))
        }
    Get-ChildItem -LiteralPath $supportRoot -File -Force |
        Where-Object { $_.Name -ne "README.md" } |
        ForEach-Object {
            Remove-RepositoryFile ([System.IO.Path]::GetRelativePath($repositoryRoot, $_.FullName))
        }

    Remove-RepositoryDirectory "임시폴더"
    # Workspace simulation definitions and operator settings are durable input,
    # not disposable output. In particular, never remove vertiports.json,
    # routes.json or simulation/examples. Clean only known regenerated data.
    Remove-RepositoryDirectory "data\workspace\cache"
    Remove-RepositoryDirectory "data\workspace\collection"
    Remove-RepositoryDirectory "data\workspace\live_ingestion"
    Remove-RepositoryDirectory "data\workspace\logs"
    Remove-RepositoryDirectory "data\workspace\performance"
    Remove-RepositoryDirectory "data\workspace\physical_uam"
    Remove-RepositoryDirectory "data\workspace\simulation\runs"
    Remove-RepositoryDirectory "data\workspace\simulation\scenarios"
    Remove-RepositoryDirectory "data\development_log\evidence"
    Remove-RepositoryDirectory ".pytest_cache"
    Remove-RepositoryDirectory "__pycache__"
    Remove-RepositoryDirectory ".codeboarding"
    Remove-RepositoryDirectory "legacy"
    Remove-RepositoryDirectory "Ultralytics"
    Remove-RepositoryFile "projectairsim_client.log"
    Remove-RepositoryFile "digital_twin\model_library\detection_models\flying_objects_v1\source.pt"

    $environmentRoot = Join-Path $repositoryRoot "project_support\environment"
    $cacheDirectories = @(Get-ChildItem -LiteralPath $repositoryRoot -Directory -Recurse -Force -Filter "__pycache__" -ErrorAction SilentlyContinue |
        Where-Object {
            -not $_.FullName.StartsWith($environmentRoot + "\", [System.StringComparison]::OrdinalIgnoreCase) -and
            -not $_.FullName.StartsWith((Join-Path $repositoryRoot ".git") + "\", [System.StringComparison]::OrdinalIgnoreCase)
        })
    foreach ($cacheDirectory in $cacheDirectories) {
        Remove-RepositoryDirectory ([System.IO.Path]::GetRelativePath($repositoryRoot, $cacheDirectory.FullName))
    }

    $workspaceLogs = Join-Path $repositoryRoot "data\workspace\logs"
    if ($PSCmdlet.ShouldProcess($workspaceLogs, "Recreate empty runtime log directory")) {
        New-Item -ItemType Directory -Path $workspaceLogs -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $repositoryRoot "data\workspace\.gitkeep") -Force | Out-Null
        New-Item -ItemType File -Path (Join-Path $workspaceLogs ".gitkeep") -Force | Out-Null
    }
}
