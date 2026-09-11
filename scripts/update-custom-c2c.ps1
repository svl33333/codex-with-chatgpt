[CmdletBinding()]
param(
  [string]$Repository = "https://github.com/svl33333/codex-with-chatgpt.git",
  [string]$Ref,
  [string]$InstallRoot = "$(Join-Path $env:LOCALAPPDATA 'codex-with-chatgpt-runtime')"
)

$ErrorActionPreference = "Stop"

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory
  )
  Push-Location $WorkingDirectory
  try {
    & $File @ArgumentList
    if ($LASTEXITCODE -ne 0) {
      throw "$File $($ArgumentList -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' was not found."
  }
}

Require-Command "git"
Require-Command "corepack"
Require-Command "node"

$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
$manifestPath = Join-Path $resolvedRoot "runtime.json"
if (-not $Ref) {
  if (-not (Test-Path $manifestPath)) { throw "No runtime manifest found; run bootstrap-custom-c2c.ps1 first or pass -Ref." }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $Ref = [string]$manifest.ref
}
if ([string]::IsNullOrWhiteSpace($Ref)) { throw "Ref must not be empty." }

$refDirectory = $Ref -replace "[^A-Za-z0-9._-]", "-"
$versionDirectory = Join-Path $resolvedRoot $refDirectory
New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null

if (Test-Path (Join-Path $versionDirectory ".git")) {
  $existingRemote = (& git -C $versionDirectory remote get-url origin 2>$null).Trim()
  if ($existingRemote -and $existingRemote -ne $Repository) {
    throw "Ref directory belongs to another repository: $versionDirectory"
  }
  $status = (& git -C $versionDirectory status --porcelain).Trim()
  if ($status) { throw "Ref directory is dirty; refusing to overwrite local changes: $versionDirectory" }
  Invoke-Checked "git" @("fetch", "--depth", "1", "origin", $Ref) $versionDirectory
  Invoke-Checked "git" @("checkout", "--detach", "FETCH_HEAD") $versionDirectory
} elseif (Test-Path $versionDirectory) {
  throw "Ref directory exists but is not a git checkout: $versionDirectory"
} else {
  Invoke-Checked "git" @("clone", "--branch", $Ref, "--depth", "1", $Repository, $versionDirectory) $resolvedRoot
}

$status = (& git -C $versionDirectory status --porcelain).Trim()
if ($status) { throw "Pinned runtime checkout is dirty after fetch: $versionDirectory" }
Invoke-Checked "corepack" @("pnpm", "install", "--frozen-lockfile") $versionDirectory
Invoke-Checked "corepack" @("pnpm", "build") $versionDirectory
Invoke-Checked "node" @("bin/c2c.js", "--version") $versionDirectory

$launcherDirectory = Join-Path $resolvedRoot "bin"
New-Item -ItemType Directory -Force -Path $launcherDirectory | Out-Null
$launcherPath = Join-Path $launcherDirectory "c2c-svl.cmd"
$launcherLine = 'node "%~dp0..\{0}\bin\c2c.js" %*' -f $refDirectory
@(
  '@echo off'
  'setlocal'
  $launcherLine
  'exit /b %ERRORLEVEL%'
) | Set-Content -LiteralPath $launcherPath -Encoding ascii

$commit = (& git -C $versionDirectory rev-parse HEAD).Trim()
$newManifest = [ordered]@{
  schemaVersion = 1
  repository = $Repository
  ref = $Ref
  commit = $commit
  checkout = $versionDirectory
  launcher = $launcherPath
  updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$newManifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Output ("Updated custom C2C {0} at {1}`nLauncher: {2}`nManifest: {3}" -f $Ref, $versionDirectory, $launcherPath, $manifestPath)
