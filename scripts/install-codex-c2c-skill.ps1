[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceSkill,
  [string]$Destination = "$(if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills\codex-with-chatgpt' } else { Join-Path $HOME '.codex\skills\codex-with-chatgpt' })",
  [string]$Repository = "https://github.com/svl33333/codex-with-chatgpt.git",
  [string]$Ref = "v0.1.3-svl.15",
  [string]$Commit,
  [switch]$PassThru
)

$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($SourceSkill)
$destination = [IO.Path]::GetFullPath($Destination)
$skillPath = Join-Path $destination 'SKILL.md'
$metadataPath = Join-Path $destination 'c2c-skill-source.json'

function Assert-OrdinaryPath([string]$Path) {
  $cursor = $Path
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing a linked installation path: $cursor"
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}

function Read-Git([string]$Directory, [string[]]$Arguments) {
  $output = & git -C $Directory @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Cannot verify existing Skill source: $Directory" }
  return ($output | Out-String).Trim()
}

function Write-SkillFile($Previous, [byte[]]$Bytes) {
  Assert-OrdinaryPath $Previous.Path
  $isNewFile = $null -eq $Previous.Bytes
  $writePath = if ($isNewFile) { $Previous.Path + '.pending-' + [guid]::NewGuid().ToString('N') } else { $Previous.Path }
  $mode = if ($isNewFile) { [IO.FileMode]::CreateNew } else { [IO.FileMode]::Open }
  $stream = [IO.File]::Open($writePath, $mode, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
  try {
    $current = New-Object byte[] $stream.Length
    $offset = 0
    while ($offset -lt $current.Length) {
      $count = $stream.Read($current, $offset, $current.Length - $offset)
      if ($count -eq 0) { throw "Cannot read the complete Skill target: $writePath" }
      $offset += $count
    }
    if (-not $isNewFile -and [Convert]::ToBase64String($current) -ne [Convert]::ToBase64String($Previous.Bytes)) {
      throw "Skill target changed before write; preserving it: $($Previous.Path)"
    }
    try {
      $stream.Position = 0
      $stream.SetLength(0)
      $stream.Write($Bytes, 0, $Bytes.Length)
      $stream.Flush()
    } catch {
      $failure = $_
      if ($isNewFile) { throw "New Skill file was not installed: $failure; incomplete staged bytes retained at $writePath" }
      try {
        $stream.Position = 0
        $stream.SetLength(0)
        $stream.Write($Previous.Bytes, 0, $Previous.Bytes.Length)
        $stream.Flush()
      } catch {
        $backupPath = $Previous.Path + '.c2c-rollback-' + [guid]::NewGuid().ToString('N')
        try { [IO.File]::WriteAllBytes($backupPath, $Previous.Bytes) }
        catch { throw "Skill write failed: $failure; restoration failed: $_; additional backup failed at $backupPath" }
        throw "Skill write failed: $failure; restoration failed: $_; original bytes retained at $backupPath"
      }
      throw "Skill write failed; original bytes restored through the locked file: $failure"
    }
  } finally { $stream.Dispose() }
  if ($isNewFile) { [IO.File]::Move($writePath, $Previous.Path) }
  return [pscustomobject]@{ Path = $Previous.Path; Before = $Previous.Bytes; Written = $Bytes }
}

function Restore-SkillFile($Written) {
  Assert-OrdinaryPath $Written.Path
  if (-not (Test-Path -LiteralPath $Written.Path -PathType Leaf) -or
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($Written.Path)) -ne [Convert]::ToBase64String($Written.Written)) {
    throw "Skill target changed after write; preserving it: $($Written.Path)"
  }
  if ($null -eq $Written.Before) { Remove-Item -LiteralPath $Written.Path }
  else { [void](Write-SkillFile ([pscustomobject]@{ Path = $Written.Path; Bytes = $Written.Written }) $Written.Before) }
}

function Assert-ExistingSkill {
  Assert-OrdinaryPath $destination
  $entries = @(Get-ChildItem -LiteralPath $destination -Force -ErrorAction SilentlyContinue)
  if ($entries.Count -eq 0) { return }
  foreach ($entry in $entries) {
    if ($entry.PSIsContainer -or $entry.Name -notin @('SKILL.md', 'c2c-skill-source.json')) {
      throw "Installed-only Skill content is preserved; refusing replacement: $($entry.FullName)"
    }
    Assert-OrdinaryPath $entry.FullName
  }
  if (-not (Test-Path -LiteralPath $skillPath -PathType Leaf) -or -not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    throw "Existing Skill provenance is incomplete; refusing replacement: $destination"
  }
  $metadata = [IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
  if ($metadata.repository -ne $Repository -or $metadata.destination -ne $destination -or $metadata.commit -notmatch '^[0-9a-fA-F]{40}$' -or -not $metadata.source) {
    throw "Existing Skill provenance is unknown; refusing replacement: $destination"
  }
  $previousSource = [IO.Path]::GetFullPath([string]$metadata.source)
  Assert-OrdinaryPath $previousSource
  if (-not (Test-Path -LiteralPath $previousSource -PathType Leaf)) { throw "Existing Skill source is unavailable: $previousSource" }
  $previousRoot = Read-Git (Split-Path $previousSource -Parent) @('rev-parse', '--show-toplevel')
  if ($previousSource -ne [IO.Path]::GetFullPath((Join-Path $previousRoot 'skill\SKILL.md')) -or
      (Read-Git $previousRoot @('rev-parse', 'HEAD')) -ne $metadata.commit -or
      (Read-Git $previousRoot @('remote', 'get-url', 'origin')) -ne $Repository -or
      (Read-Git $previousRoot @('status', '--porcelain', '--', 'skill/SKILL.md'))) {
    throw "Existing Skill source identity changed; refusing replacement: $previousSource"
  }
  if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($skillPath)) -ne [Convert]::ToBase64String([IO.File]::ReadAllBytes($previousSource))) {
    throw "Manually edited Skill is preserved; refusing replacement: $skillPath"
  }
}

Assert-OrdinaryPath $source
if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or [IO.Path]::GetFileName($source) -ne 'SKILL.md') {
  throw "Pinned runtime does not contain SKILL.md: $source"
}
$content = [IO.File]::ReadAllText($source)
if ($content -notmatch '(?m)^name:\s+codex-with-chatgpt\s*$' -or $content -notmatch 'in-app browser|built-in in-app browser') {
  throw "Unexpected Codex-native Skill identity: $source"
}
Assert-ExistingSkill
if ((Test-Path -LiteralPath $metadataPath -PathType Leaf) -and (Test-Path -LiteralPath $skillPath -PathType Leaf)) {
  $installedMetadata = [IO.File]::ReadAllText($metadataPath) | ConvertFrom-Json
  if ($installedMetadata.repository -eq $Repository -and $installedMetadata.ref -eq $Ref -and $installedMetadata.commit -eq $Commit -and
      $installedMetadata.source -eq $source -and $installedMetadata.destination -eq $destination -and
      [Convert]::ToBase64String([IO.File]::ReadAllBytes($skillPath)) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($source))) {
    if (-not $PassThru) { Write-Output "Codex-only C2C Skill already installed; files unchanged: $destination" }
    return
  }
}
$previousFiles = @($skillPath, $metadataPath) | ForEach-Object {
  $bytes = $null
  if (Test-Path -LiteralPath $_ -PathType Leaf) { $bytes = [IO.File]::ReadAllBytes($_) }
  [pscustomobject]@{ Path = $_; Bytes = $bytes }
}
$metadata = [ordered]@{
  schemaVersion = 1
  repository = $Repository
  ref = $Ref
  commit = $Commit
  source = $source
  destination = $destination
  installedAt = (Get-Date).ToUniversalTime().ToString('o')
}
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$writtenFiles = @()
try {
  Assert-ExistingSkill
  $writtenFiles += Write-SkillFile $previousFiles[0] ([IO.File]::ReadAllBytes($source))
  $writtenFiles += Write-SkillFile $previousFiles[1] ([Text.Encoding]::UTF8.GetBytes(($metadata | ConvertTo-Json)))
} catch {
  $failure = $_
  $restoreFailures = @()
  foreach ($written in $writtenFiles) {
    try { Restore-SkillFile $written } catch { $restoreFailures += "$($written.Path): $($_.Exception.Message)" }
  }
  if ($restoreFailures) { throw "Skill installation failed: $failure; restoration failed: $($restoreFailures -join '; ')" }
  throw $failure
}
if ($PassThru) { $writtenFiles }
else { Write-Output ("Installed Codex-only C2C Skill at {0}`nSource: {1}" -f $destination, $source) }
