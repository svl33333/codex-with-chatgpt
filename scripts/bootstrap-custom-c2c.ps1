[CmdletBinding()]
param(
  [string]$Repository = "https://github.com/svl33333/codex-with-chatgpt.git",
  [string]$Ref = "v0.1.3-svl.15",
  [string]$InstallRoot = "$(Join-Path $env:LOCALAPPDATA 'codex-with-chatgpt-runtime')",
  [string]$ExpectedCommit,
  [string]$ExpectedVersion,
  [string]$ExpectedSkillSha256,
  [switch]$PassThru
)

$ErrorActionPreference = "Stop"
$arguments = @{} + $PSBoundParameters
$arguments.Ref = $Ref
& (Join-Path $PSScriptRoot 'update-custom-c2c.ps1') @arguments
