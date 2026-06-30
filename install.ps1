param(
  [switch]$NoAuth,
  [switch]$NoDeps,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

if ($Help) {
  Write-Host @'
Thinkless Windows installer

Usage:
  irm https://wici.ai/thinkless/install.ps1 | iex

Environment:
  THINKLESS_RELEASE_REPO          Release repository, default wici-ai/thinkless
  THINKLESS_RELEASE_BASE          Override release asset base URL
  THINKLESS_TARBALL_URL           Override thinkless.tgz URL
  THINKLESS_WINDOWS_INSTALL_DEPS  Set to 0 to skip winget/npm dependency install
  THINKLESS_AUTH_ONBOARDING       Set to 0 to skip auth prompts
'@
  exit 0
}

function Write-Step([string]$Message) {
  Write-Host "thinkless install: $Message"
}

function Write-Warn([string]$Message) {
  Write-Warning "thinkless install: $Message"
}

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Checked([string]$File, [string[]]$Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $File $($Arguments -join ' ')"
  }
}

function Split-PathList([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return @() }
  return $Value -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
}

function Prepend-CurrentPath([string[]]$Dirs) {
  $existing = Split-PathList $env:Path
  $prepend = @()
  foreach ($dir in $Dirs) {
    if ([string]::IsNullOrWhiteSpace($dir)) { continue }
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    if ($existing -contains $dir -or $prepend -contains $dir) { continue }
    $prepend += $dir
  }
  if ($prepend.Count -gt 0) {
    $env:Path = (($prepend + $existing) -join ';')
  }
}

function Add-UserPath([string[]]$Dirs) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = Split-PathList $current
  $changed = $false
  foreach ($dir in $Dirs) {
    if ([string]::IsNullOrWhiteSpace($dir)) { continue }
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    if ($parts -contains $dir) { continue }
    $parts += $dir
    $changed = $true
  }
  if ($changed) {
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    Write-Step 'added command paths to the user PATH for new PowerShell sessions'
  }
}

function Get-NpmGlobalPrefix {
  if (-not (Test-Command npm)) { return $null }
  try {
    $prefix = (& npm prefix -g 2>$null | Select-Object -First 1)
    if (-not [string]::IsNullOrWhiteSpace($prefix)) { return $prefix.Trim() }
  } catch {
    return $null
  }
  return $null
}

function Refresh-CommandPath {
  $common = @()
  if ($env:APPDATA) { $common += (Join-Path $env:APPDATA 'npm') }
  if ($env:LOCALAPPDATA) {
    $common += (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd')
    $common += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links')
  }
  if ($env:ProgramFiles) { $common += (Join-Path $env:ProgramFiles 'Git\cmd') }
  if (${env:ProgramFiles(x86)}) { $common += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd') }
  $npmPrefix = Get-NpmGlobalPrefix
  if ($npmPrefix) { $common += $npmPrefix }
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (($common + (Split-PathList $userPath) + (Split-PathList $machinePath) + (Split-PathList $env:Path)) | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function DependencyInstallEnabled {
  if ($NoDeps) { return $false }
  $flag = $env:THINKLESS_WINDOWS_INSTALL_DEPS
  if ([string]::IsNullOrWhiteSpace($flag)) { return $true }
  return -not @('0', 'false', 'no', 'off').Contains($flag.ToLowerInvariant())
}

function Install-WingetPackage([string]$Id, [string]$DisplayName) {
  if (-not (DependencyInstallEnabled)) {
    Write-Warn "$DisplayName is missing. Install it manually or rerun without -NoDeps."
    return
  }
  if (-not (Test-Command winget)) {
    throw "$DisplayName is missing and winget is not available. Install $DisplayName manually, then rerun this installer."
  }
  Write-Step "installing $DisplayName with winget"
  Invoke-Checked 'winget' @(
    'install',
    '--id', $Id,
    '--exact',
    '--source', 'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--silent'
  )
  Refresh-CommandPath
}

function Ensure-CommandViaWinget([string]$Command, [string]$PackageId, [string]$DisplayName) {
  Refresh-CommandPath
  if (Test-Command $Command) { return }
  Install-WingetPackage $PackageId $DisplayName
  Refresh-CommandPath
  if (-not (Test-Command $Command)) {
    throw "$DisplayName installed but '$Command' is not on PATH. Open a new PowerShell window and rerun this installer."
  }
}

function Ensure-NpmCommand([string]$Command, [string]$PackageName) {
  Refresh-CommandPath
  if (Test-Command $Command) { return }
  if (-not (DependencyInstallEnabled)) {
    Write-Warn "$Command is missing. Install it manually with: npm install -g $PackageName"
    return
  }
  Write-Step "installing $Command with npm"
  Invoke-Checked 'npm' @('install', '-g', '--foreground-scripts', '--ignore-scripts=false', $PackageName)
  Refresh-CommandPath
  if (-not (Test-Command $Command)) {
    throw "$Command was installed but is not on PATH. Open a new PowerShell window and rerun this installer."
  }
}

function Resolve-ReleaseBase {
  if (-not [string]::IsNullOrWhiteSpace($env:THINKLESS_RELEASE_BASE)) {
    return $env:THINKLESS_RELEASE_BASE.TrimEnd('/')
  }
  $repo = if ([string]::IsNullOrWhiteSpace($env:THINKLESS_RELEASE_REPO)) { 'wici-ai/thinkless' } else { $env:THINKLESS_RELEASE_REPO }
  try {
    $headers = @{ 'User-Agent' = 'thinkless-windows-installer' }
    $latest = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
    if ($latest.tag_name) {
      return "https://github.com/$repo/releases/download/$($latest.tag_name)"
    }
  } catch {
    Write-Warn "could not resolve latest release through GitHub API; falling back to latest/download"
  }
  return "https://github.com/$repo/releases/latest/download"
}

function Download-ThinklessTarball([string]$Destination) {
  $releaseBase = Resolve-ReleaseBase
  $url = if ([string]::IsNullOrWhiteSpace($env:THINKLESS_TARBALL_URL)) { "$releaseBase/thinkless.tgz" } else { $env:THINKLESS_TARBALL_URL }
  Write-Step "downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $Destination -UseBasicParsing
}

function Test-Interactive {
  if ($env:CI) { return $false }
  if (-not [Environment]::UserInteractive) { return $false }
  return $true
}

function AuthOnboardingEnabled {
  if ($NoAuth) { return $false }
  $flag = $env:THINKLESS_AUTH_ONBOARDING
  if ([string]::IsNullOrWhiteSpace($flag)) { return $true }
  return -not @('0', 'false', 'no', 'off').Contains($flag.ToLowerInvariant())
}

function Test-CodexAuth {
  return -not [string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY) -or (Test-Path -LiteralPath (Join-Path $HOME '.codex\auth.json'))
}

function Test-ClaudeAuth {
  return -not [string]::IsNullOrWhiteSpace($env:ANTHROPIC_API_KEY) -or (Test-Path -LiteralPath (Join-Path $HOME '.claude\.credentials.json'))
}

function Test-GhAuth {
  if (-not (Test-Command gh)) { return $false }
  & gh auth status *> $null
  return $LASTEXITCODE -eq 0
}

function Ask-Yes([string]$Question) {
  if (-not (Test-Interactive)) { return $false }
  $answer = Read-Host "$Question [y/N]"
  return @('y', 'yes').Contains($answer.Trim().ToLowerInvariant())
}

function Run-AuthOnboarding {
  Write-Step 'auth onboarding status'
  $codexReady = Test-CodexAuth
  $ghReady = Test-GhAuth
  $claudeReady = Test-ClaudeAuth

  if ($codexReady) { Write-Step 'Codex auth file/env detected' } else { Write-Step 'Codex auth is not configured; setup command: codex login' }
  if ($ghReady) { Write-Step 'GitHub CLI auth detected' } else { Write-Step 'GitHub CLI auth is not configured; setup command: gh auth login' }
  if ($claudeReady) { Write-Step 'Claude auth file/env detected' } else { Write-Step 'Claude auth is not configured; setup command: claude' }

  if (-not (AuthOnboardingEnabled)) {
    Write-Step 'auth onboarding skipped. To finish setup, run: codex login, gh auth login, claude'
    return
  }
  if (-not (Test-Interactive)) {
    Write-Step 'auth onboarding requires an interactive PowerShell session. To finish setup, run: codex login, gh auth login, claude'
    return
  }

  if (-not $codexReady -and (Ask-Yes 'Sign in to Codex now?')) {
    & codex login
  }
  if (-not $ghReady -and (Ask-Yes 'Sign in to GitHub CLI now?')) {
    & gh auth login
  }
  if (-not $claudeReady -and (Ask-Yes 'Sign in to Claude Code now?')) {
    Write-Step 'Claude opens an interactive session; exit with /exit or Ctrl-D after login.'
    & claude
  }
}

function Verify-RequiredCommands {
  Refresh-CommandPath
  $required = @('node', 'npm', 'git', 'gh', 'thinkless', 'codex', 'claude')
  $missing = @()
  foreach ($command in $required) {
    if (-not (Test-Command $command)) { $missing += $command }
  }
  if ($missing.Count -gt 0) {
    throw "installed, but missing required commands on PATH: $($missing -join ', '). Open a new PowerShell window or add npm/GitHub/Git command directories to PATH."
  }
  & node --version *> $null
  & npm --version *> $null
  & thinkless --version *> $null
  & codex --version *> $null
  & claude --version *> $null
  & gh --version *> $null
  Write-Step 'verified node, npm, git, thinkless, codex, claude, and gh on PATH'
}

if ($PSVersionTable.PSEdition -eq 'Core') {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} else {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11
}

Refresh-CommandPath
Ensure-CommandViaWinget 'node' 'OpenJS.NodeJS.LTS' 'Node.js LTS'
Ensure-CommandViaWinget 'git' 'Git.Git' 'Git'
Ensure-CommandViaWinget 'gh' 'GitHub.cli' 'GitHub CLI'
Refresh-CommandPath

if (-not (Test-Command npm)) {
  throw "npm is required. Install Node.js LTS, open a new PowerShell window, and rerun this installer."
}

Ensure-NpmCommand 'codex' '@openai/codex'
Ensure-NpmCommand 'claude' '@anthropic-ai/claude-code'

$temp = Join-Path ([IO.Path]::GetTempPath()) ("thinkless-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $pkg = Join-Path $temp 'thinkless.tgz'
  Download-ThinklessTarball $pkg
  Write-Step 'installing Thinkless globally with npm'
  Invoke-Checked 'npm' @('install', '-g', '--foreground-scripts', '--ignore-scripts=false', $pkg)
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}

Refresh-CommandPath
$pathDirs = @((Join-Path $env:APPDATA 'npm'))
$npmPrefix = Get-NpmGlobalPrefix
if ($npmPrefix) { $pathDirs += $npmPrefix }
Add-UserPath $pathDirs

Verify-RequiredCommands
Run-AuthOnboarding

if ((Test-CodexAuth) -and (Test-ClaudeAuth) -and (Test-GhAuth)) {
  Write-Step "complete. Run 'thinkless' to start."
} else {
  Write-Step "installed; auth is pending. Finish Codex, Claude, and GitHub CLI auth, then run 'thinkless'."
}
