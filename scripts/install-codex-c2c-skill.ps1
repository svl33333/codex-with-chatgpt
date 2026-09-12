[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceSkill,
  [string]$Destination = "$(if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'skills\codex-with-chatgpt' } else { Join-Path $HOME '.codex\skills\codex-with-chatgpt' })",
  [string]$Repository = "https://github.com/svl33333/codex-with-chatgpt.git",
  [string]$Ref = "v0.1.3-svl.3",
  [string]$Commit
)

$ErrorActionPreference = "Stop"
$source = [IO.Path]::GetFullPath($SourceSkill)
$destination = [IO.Path]::GetFullPath($Destination)
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
  throw "Pinned runtime does not contain the Codex Skill: $source"
}
if ([IO.Path]::GetFileName($source) -ne "SKILL.md") {
  throw "Skill source must point to SKILL.md: $source"
}

$content = Get-Content -Raw -LiteralPath $source
if ($content -notmatch "(?m)^name:\s+codex-with-chatgpt\s*$") {
  throw "Unexpected Skill identity; refusing to install: $source"
}
if ($content -notmatch "in-app browser|built-in in-app browser") {
  throw "Codex-native browser contract is missing; refusing to install: $source"
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
Set-Content -LiteralPath (Join-Path $destination "SKILL.md") -Value $content -Encoding utf8
$manifest = [ordered]@{
  schemaVersion = 1
  repository = $Repository
  ref = $Ref
  commit = $Commit
  source = $source
  destination = $destination
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $destination "c2c-skill-source.json") -Encoding utf8
Write-Output ("Installed Codex-only C2C Skill at {0}`nSource: {1}" -f $destination, $source)
