[CmdletBinding()]
param(
  [string]$Repository = "https://github.com/svl33333/codex-with-chatgpt.git",
  [string]$Ref = "v0.1.3-svl.5",
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
    throw "Required command '$Name' was not found. Install it before bootstrapping the runtime."
  }
}

Require-Command "git"
Require-Command "corepack"
Require-Command "node"

$refDirectory = $Ref -replace "[^A-Za-z0-9._-]", "-"
if ([string]::IsNullOrWhiteSpace($refDirectory)) { throw "Ref must not be empty." }
$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
$versionDirectory = Join-Path $resolvedRoot $refDirectory
$manifestPath = Join-Path $resolvedRoot "runtime.json"
New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null

if (Test-Path (Join-Path $versionDirectory ".git")) {
  $existingRemote = ((& git -C $versionDirectory remote get-url origin 2>$null) | Out-String).Trim()
  if ($existingRemote -and $existingRemote -ne $Repository) {
    throw "Ref directory already belongs to another repository: $versionDirectory"
  }
} elseif (Test-Path $versionDirectory) {
  throw "Ref directory exists but is not a git checkout: $versionDirectory"
} else {
  Invoke-Checked "git" @("clone", "--branch", $Ref, "--depth", "1", $Repository, $versionDirectory) $resolvedRoot
}

$status = ((& git -C $versionDirectory status --porcelain 2>$null) | Out-String).Trim()
if ($status) { throw "Pinned runtime checkout is dirty; refusing to build over local changes: $versionDirectory" }
Invoke-Checked "corepack" @("pnpm", "install", "--frozen-lockfile") $versionDirectory
Invoke-Checked "corepack" @("pnpm", "build") $versionDirectory
Invoke-Checked "node" @("bin/c2c.js", "--version") $versionDirectory

$skillScript = Join-Path $versionDirectory "scripts\install-codex-c2c-skill.ps1"
if (-not (Test-Path -LiteralPath $skillScript)) { throw "Pinned runtime does not contain its Codex Skill installer." }
$shell = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
if (-not $shell) { $shell = (Get-Command powershell -ErrorAction Stop).Source }
Invoke-Checked $shell @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $skillScript, "-SourceSkill", (Join-Path $versionDirectory "skill\SKILL.md"), "-Repository", $Repository, "-Ref", $Ref, "-Commit", ((& git -C $versionDirectory rev-parse HEAD).Trim())) $versionDirectory

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
$manifest = [ordered]@{
  schemaVersion = 1
  repository = $Repository
  ref = $Ref
  commit = $commit
  checkout = $versionDirectory
  launcher = $launcherPath
  updatedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Output ("Installed custom C2C {0} at {1}`nLauncher: {2}`nManifest: {3}" -f $Ref, $versionDirectory, $launcherPath, $manifestPath)
