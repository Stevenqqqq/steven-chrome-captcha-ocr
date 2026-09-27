param(
    [string]$PythonExecutable = "python",
    [string]$Version = "",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RepoPrefix = $RepoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

function Get-SafeChildPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $FullPath = [IO.Path]::GetFullPath($Path)
    if (-not $FullPath.StartsWith($RepoPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to modify a path outside the repository: $FullPath"
    }
    return $FullPath
}

function Remove-SafeDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)

    $FullPath = Get-SafeChildPath -Path $Path
    if (Test-Path -LiteralPath $FullPath) {
        Remove-Item -LiteralPath $FullPath -Recurse -Force
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList
    )

    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code $LASTEXITCODE`: $FilePath $($ArgumentList -join ' ')"
    }
}

Set-Location -LiteralPath $RepoRoot

$Manifest = Get-Content -LiteralPath (Join-Path $RepoRoot "extension\manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$ManifestVersion = [string]$Manifest.version
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $ManifestVersion
} elseif ($Version -ne $ManifestVersion) {
    throw "Release version $Version does not match extension version $ManifestVersion."
}
if ($Version -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "Invalid release version: $Version"
}

$RequiredFusionFiles = @("config.json", "crop.onnx", "direct.onnx", "light_reranker.npz", "reranker.npz")
foreach ($FileName in $RequiredFusionFiles) {
    $ModelPath = Join-Path $RepoRoot "models\fusion_v7\$FileName"
    if (-not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) {
        throw "Required fusion model file is missing: $ModelPath"
    }
}

if (-not $SkipTests) {
    Invoke-Checked -FilePath $PythonExecutable -ArgumentList @(
        "-B", "-m", "unittest", "discover", "-s", "tests", "-p", "test*.py", "-v"
    )
    Invoke-Checked -FilePath "node" -ArgumentList @(
        "--test",
        "tests\test_background.js",
        "tests\test_captcha_image.js",
        "tests\test_detect_helpers.js",
        "tests\test_feedback_helpers.js",
        "tests\test_popup_startup.js"
    )
    Invoke-Checked -FilePath "node" -ArgumentList @("--check", "extension\popup.js")
}

$BuildRoot = Get-SafeChildPath -Path (Join-Path $RepoRoot "build\pyinstaller")
$PyInstallerDist = Get-SafeChildPath -Path (Join-Path $RepoRoot "dist\pyinstaller")
$ReleaseOutput = Get-SafeChildPath -Path (Join-Path $RepoRoot "dist\release")
$PackageName = "StevenCaptchaOCR-Windows-x64-v$Version"
$ReleaseRoot = Get-SafeChildPath -Path (Join-Path $ReleaseOutput $PackageName)
$ZipPath = Get-SafeChildPath -Path (Join-Path $ReleaseOutput "$PackageName.zip")
$ChecksumPath = Get-SafeChildPath -Path (Join-Path $ReleaseOutput "$PackageName.sha256.txt")

Remove-SafeDirectory -Path $BuildRoot
Remove-SafeDirectory -Path $PyInstallerDist
Remove-SafeDirectory -Path $ReleaseRoot
New-Item -ItemType Directory -Path $BuildRoot, $PyInstallerDist, $ReleaseOutput -Force | Out-Null
Remove-Item -LiteralPath $ZipPath, $ChecksumPath -Force -ErrorAction SilentlyContinue

Invoke-Checked -FilePath $PythonExecutable -ArgumentList @(
    "-m", "PyInstaller",
    "--clean",
    "--noconfirm",
    "--workpath", $BuildRoot,
    "--distpath", $PyInstallerDist,
    "packaging\StevenCaptchaOCR.spec"
)

$BundleRoot = Join-Path $PyInstallerDist "StevenCaptchaOCR"
$BundledExe = Join-Path $BundleRoot "StevenCaptchaOCR.exe"
if (-not (Test-Path -LiteralPath $BundledExe -PathType Leaf)) {
    throw "PyInstaller output is missing: $BundledExe"
}

New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null
Get-ChildItem -LiteralPath $BundleRoot | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $ReleaseRoot -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $RepoRoot "extension") -Destination (Join-Path $ReleaseRoot "extension") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "README.md") -Destination $ReleaseRoot -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "LICENSE") -Destination $ReleaseRoot -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "THIRD_PARTY_NOTICES.md") -Destination $ReleaseRoot -Force
Get-ChildItem -LiteralPath $RepoRoot -Filter "*.html" -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $ReleaseRoot -Force
}

$ChromeLauncher = Get-ChildItem -LiteralPath $RepoRoot -Filter "*Chrome*.bat" -File | Select-Object -First 1
if ($null -eq $ChromeLauncher) {
    throw "Chrome extension launcher batch file was not found."
}
Copy-Item -LiteralPath $ChromeLauncher.FullName -Destination $ReleaseRoot -Force

$TrainingRoot = Join-Path $ReleaseRoot "training"
New-Item -ItemType Directory -Path (Join-Path $TrainingRoot "samples"), (Join-Path $TrainingRoot "feedback") -Force | Out-Null

$ReleasedExe = Join-Path $ReleaseRoot "StevenCaptchaOCR.exe"
$CheckOutput = (& $ReleasedExe --check | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Packaged model check failed."
}
if ($CheckOutput -notmatch 'official' -or $CheckOutput -notmatch 'fusion_v7') {
    throw "Packaged model check did not load both official and fusion_v7 models: $CheckOutput"
}
Write-Host $CheckOutput
$RuntimeJson = (& $ReleasedExe --print-runtime-paths | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    throw "Packaged runtime path check failed."
}
$RuntimePaths = $RuntimeJson | ConvertFrom-Json
$ExpectedTrainingRoot = [IO.Path]::GetFullPath($TrainingRoot)
$ActualTrainingRoot = [IO.Path]::GetFullPath([string]$RuntimePaths.training_root)
if (-not $ActualTrainingRoot.Equals($ExpectedTrainingRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Packaged training path is incorrect: $ActualTrainingRoot"
}
if (-not [bool]$RuntimePaths.frozen) {
    throw "Packaged executable did not report frozen mode."
}

$PortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$PortProbe.Start()
$SmokePort = ([Net.IPEndPoint]$PortProbe.LocalEndpoint).Port
$PortProbe.Stop()
$ServerProcess = Start-Process -FilePath $ReleasedExe -ArgumentList @("--port", [string]$SmokePort) -WindowStyle Hidden -PassThru
try {
    $Health = $null
    for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
        if ($ServerProcess.HasExited) {
            throw "Packaged server exited before the health check completed."
        }
        try {
            $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$SmokePort/health" -TimeoutSec 1
            break
        } catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if ($null -eq $Health -or $Health.ok -ne $true) {
        throw "Packaged server health check failed."
    }
} finally {
    if (-not $ServerProcess.HasExited) {
        Stop-Process -Id $ServerProcess.Id -Force
        $ServerProcess.WaitForExit()
    }
}

Compress-Archive -LiteralPath $ReleaseRoot -DestinationPath $ZipPath -CompressionLevel Optimal -Force
$Hash = Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256
"$($Hash.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($ZipPath))" |
    Set-Content -LiteralPath $ChecksumPath -Encoding ASCII

Write-Host "Release package: $ZipPath"
Write-Host "SHA-256: $($Hash.Hash.ToLowerInvariant())"
