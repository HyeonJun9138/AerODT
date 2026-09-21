[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$vsDevCmd = "C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat"

if (-not (Test-Path -LiteralPath $vsDevCmd)) {
    throw "Visual Studio C++ developer environment not found: $vsDevCmd"
}

$buildCommand = "set VSLANG=1033 && call `"$vsDevCmd`" -arch=x64 -host_arch=x64 && " +
    "cmake --fresh --preset windows-debug && " +
    # MSVC /showIncludes may stay localized on non-English installations, which
    # can prevent Ninja from noticing header changes. This small V1 build uses a
    # clean rebuild so stale ABI objects cannot survive a contract change.
    "cmake --build --preset windows-debug --clean-first && " +
    "ctest --preset windows-debug"
& cmd.exe /d /s /c $buildCommand
if ($LASTEXITCODE -ne 0) { throw "AeroDT C++ configure/build/test failed" }

$python = Join-Path $root "project_support\environment\python_venv\Scripts\python.exe"
& $python (Join-Path $root "project_support\tests\integration\test_architecture.py")
if ($LASTEXITCODE -ne 0) { throw "Architecture integration test failed" }
