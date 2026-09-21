<#
.SYNOPSIS
AeroDT local credential store: report what is configured and import keys into it.

The store is %LOCALAPPDATA%\AeroDT\credentials\, deliberately outside the
repository. Secrets are never written into the project tree, printed, or logged;
this tool reports only presence, length and a short fingerprint.

.EXAMPLE
project_support\tools\credentials.ps1
.EXAMPLE
project_support\tools\credentials.ps1 -CesiumFromUnrealConfig D:\path\Config\DefaultGame.ini
#>
[CmdletBinding(DefaultParameterSetName = 'Status')]
param(
    # Unreal DefaultGame.ini holding IonAccessToken (Cesium for Unreal projects).
    [Parameter(ParameterSetName = 'ImportCesiumUnreal', Mandatory)]
    [string]$CesiumFromUnrealConfig,
    # JSON file holding accessToken.
    [Parameter(ParameterSetName = 'ImportCesiumJson', Mandatory)]
    [string]$CesiumFromJson,
    # JSON file holding clientId and clientSecret.
    [Parameter(ParameterSetName = 'ImportOpenSky', Mandatory)]
    [string]$OpenSkyFromJson
)

$ErrorActionPreference = 'Stop'
$store = Join-Path $env:LOCALAPPDATA 'AeroDT\credentials'
$keys = @(
    [pscustomobject]@{ Name = 'cesium';  File = 'cesium.json';  Fields = @('accessToken');              Env = @('AERODT_CESIUM_ION_TOKEN');                                Purpose = 'Cesium ion: World Terrain (asset 1) and OSM Buildings (96188)' }
    [pscustomobject]@{ Name = 'opensky'; File = 'opensky.json'; Fields = @('clientId', 'clientSecret'); Env = @('AERODT_OPENSKY_CLIENT_ID', 'AERODT_OPENSKY_CLIENT_SECRET'); Purpose = 'OpenSky: live aircraft collection' }
)

function Get-Fingerprint([string]$value) {
    # Length plus a truncated hash. Never enough to reconstruct the secret.
    $bytes = [Text.Encoding]::UTF8.GetBytes($value)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') } finally { $sha.Dispose() }
    "len=$($value.Length) sha256=$($hash.Substring(0, 8))"
}

function Write-Store([string]$file, [hashtable]$document) {
    if (-not (Test-Path -LiteralPath $store)) { New-Item -ItemType Directory -Path $store -Force | Out-Null }
    $path = Join-Path $store $file
    if (Test-Path -LiteralPath $path) {
        $backup = "$path.replaced-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item -LiteralPath $path -Destination $backup
        Write-Host "기존 파일을 보존했다: $backup"
    }
    # Out-File -Encoding utf8 emits a BOM on Windows PowerShell; write plain UTF-8.
    [IO.File]::WriteAllText($path, ($document | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Write-Host "기록했다: $path"
    return $path
}

switch ($PSCmdlet.ParameterSetName) {
    'ImportCesiumUnreal' {
        if (-not (Test-Path -LiteralPath $CesiumFromUnrealConfig)) { throw "구성 파일을 찾을 수 없다: $CesiumFromUnrealConfig" }
        $line = Select-String -LiteralPath $CesiumFromUnrealConfig -Pattern '^\s*IonAccessToken\s*=\s*(.+)$' | Select-Object -First 1
        if (-not $line) { throw "IonAccessToken 항목이 없다: $CesiumFromUnrealConfig" }
        $token = $line.Matches[0].Groups[1].Value.Trim().Trim('"')
        if (-not $token) { throw 'IonAccessToken 값이 비어 있다' }
        Write-Store 'cesium.json' @{ accessToken = $token } | Out-Null
    }
    'ImportCesiumJson' {
        $token = (Get-Content -LiteralPath $CesiumFromJson -Raw | ConvertFrom-Json).accessToken
        if (-not $token) { throw "accessToken 항목이 없다: $CesiumFromJson" }
        Write-Store 'cesium.json' @{ accessToken = $token.Trim() } | Out-Null
    }
    'ImportOpenSky' {
        $document = Get-Content -LiteralPath $OpenSkyFromJson -Raw | ConvertFrom-Json
        if (-not $document.clientId -or -not $document.clientSecret) { throw "clientId/clientSecret 항목이 없다: $OpenSkyFromJson" }
        Write-Store 'opensky.json' @{ clientId = $document.clientId.Trim(); clientSecret = $document.clientSecret.Trim() } | Out-Null
    }
}

Write-Host ''
Write-Host "인증 저장소: $store"
Write-Host '(값은 출력하지 않는다. 길이와 지문만 표시한다.)'
foreach ($key in $keys) {
    Write-Host ''
    Write-Host "[$($key.Name)] $($key.Purpose)"
    foreach ($name in $key.Env) {
        $value = [Environment]::GetEnvironmentVariable($name)
        $state = if ($value) { "설정됨 · $(Get-Fingerprint $value)" } else { '없음' }
        Write-Host "  환경변수 $name : $state"
    }
    $path = Join-Path $store $key.File
    if (-not (Test-Path -LiteralPath $path)) {
        Write-Host "  파일 $($key.File) : 없음 → 이 연결은 비활성화된 채 실행된다"
        continue
    }
    $document = $null
    try { $document = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
    catch { Write-Host "  파일 $($key.File) : JSON 해석 실패 ($($_.Exception.Message))"; continue }
    $missing = $key.Fields | Where-Object { -not $document.$_ }
    if ($missing) { Write-Host "  파일 $($key.File) : 항목 누락 ($($missing -join ', '))"; continue }
    foreach ($field in $key.Fields) { Write-Host "  파일 $($key.File) $field : $(Get-Fingerprint $document.$field)" }
}
Write-Host ''
Write-Host '환경변수 쌍이 완전하면 파일보다 우선한다. 변경 후에는 서버를 재시작해야 적용된다.'
