[CmdletBinding()]
param(
  [string]$Repository = "https://github.com/svl33333/codex-with-chatgpt.git",
  [string]$Ref,
  [string]$InstallRoot = "$(Join-Path $env:LOCALAPPDATA 'codex-with-chatgpt-runtime')",
  [string]$ExpectedCommit,
  [string]$ExpectedVersion,
  [string]$ExpectedSkillSha256,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'

function Invoke-Checked([string]$File, [string[]]$ArgumentList, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    & $File @ArgumentList
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

function Read-Git([string]$Directory, [string[]]$Arguments) {
  $output = & git -C $Directory @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Cannot verify runtime checkout: $Directory" }
  return ($output | Out-String).Trim()
}

function Assert-OrdinaryPath([string]$Path) {
  $cursor = $Path
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing a linked installation path: $cursor"
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}

function Read-ActivationFile([string]$Path) {
  Assert-OrdinaryPath $Path
  if ((Test-Path -LiteralPath $Path) -and -not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Activation target is not a file: $Path" }
  $bytes = $null
  if (Test-Path -LiteralPath $Path -PathType Leaf) { $bytes = [IO.File]::ReadAllBytes($Path) }
  return [pscustomobject]@{ Path = $Path; Bytes = $bytes }
}

function Test-UnchangedFile($Previous) {
  $current = Read-ActivationFile $Previous.Path
  if ($null -eq $Previous.Bytes) { return $null -eq $current.Bytes }
  return $null -ne $current.Bytes -and [Convert]::ToBase64String($Previous.Bytes) -eq [Convert]::ToBase64String($current.Bytes)
}

function Write-ActivationFile($Previous, [byte[]]$Bytes, [IO.FileStream]$OwnedFile) {
  Assert-OrdinaryPath $Previous.Path
  $isNewFile = $null -eq $Previous.Bytes
  $writePath = if ($isNewFile) { $Previous.Path + '.pending-' + [guid]::NewGuid().ToString('N') } else { $Previous.Path }
  $mode = if ($isNewFile) { [IO.FileMode]::CreateNew } else { [IO.FileMode]::Open }
  $ownershipReader = $OwnedFile
  $stream = [IO.File]::Open($writePath, $mode, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  try {
    $current = New-Object byte[] $stream.Length
    $offset = 0
    while ($offset -lt $current.Length) {
      $count = $stream.Read($current, $offset, $current.Length - $offset)
      if ($count -eq 0) { throw "Cannot read the complete activation target: $writePath" }
      $offset += $count
    }
    if ($OwnedFile) { [C2CFileRollback]::AssertSameFile($stream.SafeFileHandle, $OwnedFile) }
    if (-not $isNewFile -and [Convert]::ToBase64String($current) -ne [Convert]::ToBase64String($Previous.Bytes)) { throw "Activation target changed before write; preserving it: $($Previous.Path)" }
    try {
      $stream.Position = 0
      $stream.SetLength(0)
      $stream.Write($Bytes, 0, $Bytes.Length)
      $stream.Flush()
      if (-not $ownershipReader) {
        $ownershipReader = [IO.File]::Open($writePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        [void][C2CFileRollback]::CaptureIdentity($ownershipReader.SafeFileHandle)
      }
    } catch {
      $failure = $_
      if ($ownershipReader -and -not $OwnedFile) { $ownershipReader.Dispose(); $ownershipReader = $null }
      if ($isNewFile) {
        throw "New activation file was not installed: $failure; incomplete staged bytes retained at $writePath"
      }
      try {
        $stream.Position = 0
        $stream.SetLength(0)
        $stream.Write($Previous.Bytes, 0, $Previous.Bytes.Length)
        $stream.Flush()
      } catch {
        $backupPath = $Previous.Path + '.c2c-rollback-' + [guid]::NewGuid().ToString('N')
        try { [IO.File]::WriteAllBytes($backupPath, $Previous.Bytes) }
        catch { throw "Activation write failed: $failure; restoration failed: $_; additional backup failed at $backupPath" }
        throw "Activation write failed: $failure; restoration failed: $_; original bytes retained at $backupPath"
      }
      throw "Activation write failed; original bytes restored through the locked file: $failure"
    }
  } finally { $stream.Dispose() }
  if ($isNewFile) {
    try { [IO.File]::Move($writePath, $Previous.Path) }
    catch { $ownershipReader.Dispose(); throw }
  }
  return [pscustomobject]@{ Path = $Previous.Path; Before = $Previous.Bytes; Written = $Bytes; OwnedFile = $ownershipReader }
}

function Restore-ActivationFile($Written) {
  $current = Read-ActivationFile $Written.Path
  if ($null -eq $current.Bytes -or [Convert]::ToBase64String($current.Bytes) -ne [Convert]::ToBase64String($Written.Written)) {
    throw "Activation target changed after write; preserving it: $($Written.Path)"
  }
  if ($null -eq $Written.Before) { [C2CFileRollback]::DeleteOwnedFile($Written.Path, $Written.OwnedFile, $Written.Written) }
  else { [void](Write-ActivationFile ([pscustomobject]@{ Path = $Written.Path; Bytes = $Written.Written }) $Written.Before $Written.OwnedFile) }
}

function Assert-CandidateIdentity([string]$Directory) {
  Assert-OrdinaryPath $Directory
  if ((Read-Git $Directory @('remote', 'get-url', 'origin')) -ne $Repository) { throw "Runtime repository mismatch: $Directory" }
  $commit = Read-Git $Directory @('rev-parse', 'HEAD')
  if ($ExpectedCommit -and $commit -ne $ExpectedCommit) { throw "Runtime commit mismatch. Expected $ExpectedCommit; actual $commit." }
  if (Read-Git $Directory @('status', '--porcelain')) { throw "Runtime checkout has unknown changes: $Directory" }
  $package = [IO.File]::ReadAllText((Join-Path $Directory 'package.json')) | ConvertFrom-Json
  if (-not $package.version -or ($ExpectedVersion -and $package.version -ne $ExpectedVersion)) { throw "Runtime package version mismatch: $($package.version)" }
  $skillPath = Join-Path $Directory 'skill\SKILL.md'
  Assert-OrdinaryPath $skillPath
  $skill = [IO.File]::ReadAllText($skillPath)
  if ($skill -notmatch '(?m)^name:\s+codex-with-chatgpt\s*$' -or $skill -notmatch 'in-app browser|built-in in-app browser') { throw 'Unexpected Codex-native Skill identity.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $skillSha256 = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($skill.Replace("`r`n", "`n").Replace("`r", "`n"))))).Replace('-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
  if ($ExpectedSkillSha256 -and $skillSha256 -ne $ExpectedSkillSha256) { throw "Runtime Skill SHA mismatch. Expected $ExpectedSkillSha256; actual $skillSha256." }
  return [pscustomobject]@{ Commit = $commit; Version = [string]$package.version; SkillSha256 = $skillSha256 }
}

function Assert-DependencyLinks([string]$Directory) {
  $inspection = @'
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(process.argv[1], 'node_modules');
let relative = 'node_modules';
let links = 0;
const started = Date.now();
try {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    fs.realpathSync(root);
    throw Object.assign(new Error(), { code: 'LINKED_ROOT' });
  }
  if (!rootStat.isDirectory()) throw Object.assign(new Error(), { code: 'NOT_DIRECTORY' });
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    relative = path.relative(process.argv[1], directory);
    for (const name of fs.readdirSync(directory)) {
      const entry = path.join(directory, name);
      relative = path.relative(process.argv[1], entry);
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(entry);
        if (fs.statSync(target).isDirectory()) fs.opendirSync(target).closeSync();
        else fs.closeSync(fs.openSync(target, 'r'));
        links++;
        // Link targets can be external stores; do not enumerate their contents.
      } else if (stat.isDirectory()) pending.push(entry);
    }
  }
  console.log(`Dependency links verified: ${links}; elapsedMs: ${Date.now() - started}`);
} catch (error) {
  const code = /^[A-Z_0-9]+$/.test(error.code || '') ? error.code : 'UNREADABLE';
  console.error(`Dependency link validation failed at ${JSON.stringify(relative)} (${code})`);
  process.exit(1);
}
'@
  Invoke-Checked node @('-e', $inspection, $Directory) $Directory
}

foreach ($command in @('git', 'corepack', 'node')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "Required command '$command' was not found." }
}
if ($ExpectedCommit -and $ExpectedCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'ExpectedCommit must be a full commit SHA.' }
if ($ExpectedSkillSha256 -and $ExpectedSkillSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'ExpectedSkillSha256 must be a SHA-256.' }
$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
$manifestPath = Join-Path $resolvedRoot 'runtime.json'
$launcherPath = Join-Path $resolvedRoot 'bin\c2c-svl.cmd'
$skillDestination = [IO.Path]::GetFullPath("$(if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills\codex-with-chatgpt' } else { Join-Path $HOME '.codex\skills\codex-with-chatgpt' })")
$previousFiles = @($manifestPath, $launcherPath, (Join-Path $skillDestination 'SKILL.md'), (Join-Path $skillDestination 'c2c-skill-source.json')) | ForEach-Object { Read-ActivationFile $_ }
$manifest = $null
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) { $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json }
if (-not $Ref) {
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'No runtime manifest found; run bootstrap-custom-c2c.ps1 first or pass -Ref.' }
  $Ref = [string]$manifest.ref
}
if ([string]::IsNullOrWhiteSpace($Ref)) { throw 'Ref must not be empty.' }
$refDirectory = $Ref -replace '[^A-Za-z0-9._-]', '-'
if ($refDirectory -in @('.', '..')) { throw 'Ref cannot identify the installation root.' }
$versionDirectory = Join-Path $resolvedRoot $refDirectory
$launcher = @('@echo off', 'setlocal', ('node "%~dp0..\{0}\bin\c2c.js" %*' -f $refDirectory), 'exit /b %ERRORLEVEL%') -join "`r`n"
$launcherBytes = [Text.Encoding]::ASCII.GetBytes($launcher + "`r`n")
Assert-OrdinaryPath $versionDirectory
New-Item -ItemType Directory -Force -Path $resolvedRoot | Out-Null
$candidateDirectory = Join-Path $resolvedRoot ('.candidate-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $candidateDirectory | Out-Null
try {
  Invoke-Checked git @('init', '--quiet') $candidateDirectory
  Invoke-Checked git @('remote', 'add', 'origin', $Repository) $candidateDirectory
  Invoke-Checked git @('fetch', '--quiet', '--depth', '1', 'origin', $Ref) $candidateDirectory
  Invoke-Checked git @('checkout', '--quiet', '--detach', 'FETCH_HEAD') $candidateDirectory
  $identity = Assert-CandidateIdentity $candidateDirectory
  if (Test-Path -LiteralPath $versionDirectory) {
    $existingIdentity = Assert-CandidateIdentity $versionDirectory
    if ($existingIdentity.Commit -ne $identity.Commit) { throw "Existing version directory conflicts with fetched candidate: $versionDirectory" }
    if (-not $manifest -or $manifest.repository -ne $Repository -or $manifest.ref -ne $Ref -or $manifest.commit -ne $identity.Commit -or
        $manifest.checkout -ne $versionDirectory -or $manifest.launcher -ne $launcherPath -or $null -eq $previousFiles[1].Bytes -or
        [Convert]::ToBase64String($previousFiles[1].Bytes) -ne [Convert]::ToBase64String($launcherBytes) -or $null -eq $previousFiles[3].Bytes) {
      throw "Existing version directory is not the unchanged active installation: $versionDirectory"
    }
    $installedMetadata = [IO.File]::ReadAllText($previousFiles[3].Path) | ConvertFrom-Json
    if ($installedMetadata.source -ne (Join-Path $versionDirectory 'skill\SKILL.md') -or $installedMetadata.ref -ne $Ref -or $installedMetadata.commit -ne $identity.Commit) {
      throw "Existing active Skill identity is unknown: $skillDestination"
    }
    foreach ($previous in $previousFiles) { if (-not (Test-UnchangedFile $previous)) { throw "Activation target changed during preparation: $($previous.Path)" } }
    & (Join-Path $PSScriptRoot 'install-codex-c2c-skill.ps1') -SourceSkill (Join-Path $versionDirectory 'skill\SKILL.md') -Destination $skillDestination -Repository $Repository -Ref $Ref -Commit $identity.Commit -PassThru | Out-Null
    if (-not $PassThru) { Write-Output "Already installed; active files unchanged. Existing generated code was not executed or verified. Fetched candidate retained at: $candidateDirectory" }
    return
  }
  # pnpm junctions can contain absolute paths, so do not relocate a built checkout.
  [IO.Directory]::Move($candidateDirectory, $versionDirectory)
  $candidateDirectory = $versionDirectory
  if ($PassThru) {
    Invoke-Checked corepack @('pnpm', 'install', '--frozen-lockfile') $candidateDirectory | Out-Host
    Invoke-Checked corepack @('pnpm', 'build') $candidateDirectory | Out-Host
  } else {
    Invoke-Checked corepack @('pnpm', 'install', '--frozen-lockfile') $candidateDirectory
    Invoke-Checked corepack @('pnpm', 'build') $candidateDirectory
  }
  $builtIdentity = Assert-CandidateIdentity $candidateDirectory
  if ($builtIdentity.Commit -ne $identity.Commit -or $builtIdentity.SkillSha256 -ne $identity.SkillSha256 -or $builtIdentity.Version -ne $identity.Version) { throw 'Runtime candidate changed during build.' }
  if ($PassThru) { Assert-DependencyLinks $candidateDirectory | Out-Host }
  else { Assert-DependencyLinks $candidateDirectory }
  $versionOutput = (Invoke-Checked node @('bin/c2c.js', '--version') $candidateDirectory | Out-String).Trim()
  if ($versionOutput -ne $identity.Version) { throw "Built CLI version mismatch: $versionOutput" }
  $activationIdentity = Assert-CandidateIdentity $candidateDirectory
  if ($activationIdentity.Commit -ne $identity.Commit -or $activationIdentity.SkillSha256 -ne $identity.SkillSha256 -or $activationIdentity.Version -ne $identity.Version) { throw 'Runtime candidate changed before activation.' }
  foreach ($previous in $previousFiles) {
    if (-not (Test-UnchangedFile $previous)) { throw "Activation target changed during preparation: $($previous.Path)" }
  }
  $rollbackDirectory = Join-Path $resolvedRoot ('.rollback-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $rollbackDirectory | Out-Null
  for ($index = 0; $index -lt $previousFiles.Count; $index++) {
    if ($null -ne $previousFiles[$index].Bytes) { [IO.File]::WriteAllBytes((Join-Path $rollbackDirectory "$index.bin"), $previousFiles[$index].Bytes) }
  }
  $writtenFiles = @()
  $handoffFiles = $false
  try {
    # Older candidate installers overwrite edits; use this updater's reviewed installer for every ref.
    $skillScript = Join-Path $PSScriptRoot 'install-codex-c2c-skill.ps1'
    $writtenFiles += & $skillScript -SourceSkill (Join-Path $versionDirectory 'skill\SKILL.md') -Destination $skillDestination -Repository $Repository -Ref $Ref -Commit $identity.Commit -PassThru
    New-Item -ItemType Directory -Force -Path (Split-Path $launcherPath -Parent) | Out-Null
    $writtenFiles += Write-ActivationFile $previousFiles[1] $launcherBytes
    $newManifest = [ordered]@{ schemaVersion = 1; repository = $Repository; ref = $Ref; commit = $identity.Commit; checkout = $versionDirectory; launcher = $launcherPath; updatedAt = (Get-Date).ToUniversalTime().ToString('o') }
    $writtenFiles += Write-ActivationFile $previousFiles[0] ([Text.Encoding]::UTF8.GetBytes(($newManifest | ConvertTo-Json)))
    $handoffFiles = [bool]$PassThru
  } catch {
    $failure = $_
    $restoreFailures = @()
    foreach ($written in $writtenFiles) {
      try {
        Restore-ActivationFile $written
      } catch { $restoreFailures += "$($written.Path): $($_.Exception.Message)" }
    }
    if ($restoreFailures) { throw "Activation failed: $failure; partial rollback, restoration failed; residual paths: $($restoreFailures -join '; '); rollback snapshots retained at $rollbackDirectory" }
    throw "Activation failed; this updater's completed writes restored: $failure; backup retained at $rollbackDirectory"
  } finally {
    if (-not $handoffFiles) {
      foreach ($written in $writtenFiles) { if ($written.OwnedFile) { $written.OwnedFile.Dispose() } }
    }
  }
  if ($PassThru) { $writtenFiles }
  else { Write-Output ("Updated custom C2C {0} ({1}) at {2}`nLauncher: {3}`nManifest: {4}" -f $Ref, $identity.Commit, $versionDirectory, $launcherPath, $manifestPath) }
} catch {
  throw "$_`nPrepared candidate retained at: $candidateDirectory"
}
