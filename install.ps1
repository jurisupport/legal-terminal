Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-InstallerOption {
  param(
    [string]$Name,
    [object]$DefaultValue
  )

  $variable = Get-Variable -Name "LegalTerminal$Name" -ErrorAction SilentlyContinue
  if ($variable) {
    return $variable.Value
  }

  $compactEnvName = "LEGAL_TERMINAL_$($Name.ToUpperInvariant())"
  $snakeName = ($Name -creplace '([a-z0-9])([A-Z])', '$1_$2').ToUpperInvariant()
  $snakeEnvName = "LEGAL_TERMINAL_$snakeName"

  foreach ($envName in @($compactEnvName, $snakeEnvName)) {
    $envValue = [Environment]::GetEnvironmentVariable($envName)
    if ($envValue) {
      return $envValue
    }
  }

  return $DefaultValue
}

function ConvertTo-InstallerBoolean {
  param(
    [object]$Value,
    [bool]$DefaultValue
  )

  if ($null -eq $Value) {
    return $DefaultValue
  }

  if ($Value -is [bool]) {
    return $Value
  }

  $text = "$Value".Trim().ToLowerInvariant()
  if ($text -in @('1', 'true', 't', 'yes', 'y', 'on', '예', '네')) {
    return $true
  }

  if ($text -in @('0', 'false', 'f', 'no', 'n', 'off', '아니오', '아니요')) {
    return $false
  }

  return $DefaultValue
}

function Read-InstallerYesNo {
  param(
    [string]$Question,
    [bool]$DefaultYes,
    [string]$OptionName
  )

  $configured = Get-InstallerOption -Name $OptionName -DefaultValue $null
  if ($null -ne $configured) {
    return ConvertTo-InstallerBoolean -Value $configured -DefaultValue $DefaultYes
  }

  $suffix = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }

  while ($true) {
    $answer = (Read-Host "$Question $suffix").Trim().ToLowerInvariant()

    if (-not $answer) {
      return $DefaultYes
    }

    if ($answer -in @('y', 'yes', '1', 'true', '예', '네')) {
      return $true
    }

    if ($answer -in @('n', 'no', '0', 'false', '아니오', '아니요')) {
      return $false
    }

    Write-Host "Y 또는 N으로 입력해 주세요."
  }
}

function Write-InstallStep {
  param([string]$Message)
  Write-Host "[legal-terminal] $Message"
}

function Enable-ModernTls {
  $protocols = [Net.SecurityProtocolType]::Tls12

  try {
    $protocols = $protocols -bor [Net.SecurityProtocolType]::Tls13
  } catch {
    # TLS 1.3 is not available on older Windows PowerShell/.NET builds.
  }

  [Net.ServicePointManager]::SecurityProtocol = $protocols
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = @($machinePath, $userPath, $env:Path) -join ';'
}

function Test-InstallerCommand {
  param([string[]]$Names)

  foreach ($name in $Names) {
    if (Get-Command $name -ErrorAction SilentlyContinue) {
      return $true
    }
  }

  return $false
}

function Get-InstallerCommand {
  param([string[]]$Names)

  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }

  return $null
}

function Get-AssetName {
  param([string]$SelectedChannel)

  if ($SelectedChannel -eq 'portable') {
    return 'legal-terminal-portable.exe'
  }

  return 'legal-terminal-Setup.exe'
}

function Get-ReleaseBaseUrl {
  param([string]$SelectedVersion)

  if ($SelectedVersion -eq 'latest') {
    return 'https://github.com/jurisupport/legal-terminal/releases/latest/download'
  }

  $tag = $SelectedVersion
  if (-not $tag.StartsWith('v')) {
    $tag = "v$tag"
  }

  return "https://github.com/jurisupport/legal-terminal/releases/download/$tag"
}

function Resolve-DownloadPath {
  param(
    [string]$RequestedDestination,
    [string]$AssetName,
    [string]$SelectedChannel
  )

  if ($RequestedDestination) {
    if ((Test-Path $RequestedDestination) -and (Get-Item $RequestedDestination).PSIsContainer) {
      return Join-Path $RequestedDestination $AssetName
    }

    return $RequestedDestination
  }

  if ($SelectedChannel -eq 'portable') {
    $downloads = Join-Path $env:USERPROFILE 'Downloads'
    return Join-Path $downloads $AssetName
  }

  $tempRoot = Join-Path ([IO.Path]::GetTempPath()) 'legal-terminal'
  return Join-Path $tempRoot $AssetName
}

function Save-ReleaseAsset {
  param(
    [string]$Url,
    [string]$TargetPath
  )

  $targetDir = Split-Path -Parent $TargetPath
  New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

  $oldProgressPreference = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'

  try {
    $request = @{
      Uri = $Url
      OutFile = $TargetPath
    }

    if ($PSVersionTable.PSVersion.Major -lt 6) {
      $request.UseBasicParsing = $true
    }

    Invoke-WebRequest @request
  } catch {
    $webRequestError = $_
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue

    if (-not $curl) {
      throw $webRequestError
    }

    Write-InstallStep 'Invoke-WebRequest failed; retrying with curl.exe.'
    & $curl.Source -fL $Url -o $TargetPath

    if ($LASTEXITCODE -ne 0) {
      throw "curl.exe failed with exit code $LASTEXITCODE."
    }
  } finally {
    $ProgressPreference = $oldProgressPreference
  }

  $downloaded = Get-Item $TargetPath
  if ($downloaded.Length -le 0) {
    throw "Downloaded file is empty: $TargetPath"
  }
}

function Install-WingetPackage {
  param(
    [string]$Id,
    [string]$Name
  )

  if (-not (Test-InstallerCommand -Names @('winget.exe', 'winget'))) {
    throw "winget을 찾을 수 없어 $Name 설치를 자동으로 진행할 수 없습니다. Microsoft Store에서 App Installer를 업데이트한 뒤 다시 실행해 주세요."
  }

  Write-InstallStep "Installing $Name with winget."
  & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements

  if (($LASTEXITCODE -ne 0) -and ($LASTEXITCODE -ne -1978335189)) {
    throw "$Name winget install failed with exit code $LASTEXITCODE."
  }

  Refresh-ProcessPath
}

function Ensure-GitForClaudeCode {
  $defaultGitBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
  $defaultGitBashX86 = Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'

  if ((Test-InstallerCommand -Names @('git.exe', 'git')) -and ((Test-Path $defaultGitBash) -or (Test-Path $defaultGitBashX86))) {
    return
  }

  Write-InstallStep 'Claude Code on native Windows uses Git for Windows. Installing it first.'
  Install-WingetPackage -Id 'Git.Git' -Name 'Git for Windows'
}

function Ensure-NpmForClaudeCode {
  if (Test-InstallerCommand -Names @('npm.cmd', 'npm')) {
    return
  }

  Write-InstallStep 'Node.js/npm is required for Claude Code. Installing Node.js LTS first.'
  Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Name 'Node.js LTS'

  if (-not (Test-InstallerCommand -Names @('npm.cmd', 'npm'))) {
    throw 'npm을 아직 찾을 수 없습니다. 새 PowerShell 창에서 다시 실행해 주세요.'
  }
}

function Ensure-ClaudeCode {
  if (Test-InstallerCommand -Names @('claude.cmd', 'claude')) {
    $claude = Get-InstallerCommand -Names @('claude.cmd', 'claude')
    Write-InstallStep "Claude Code found: $claude"
    return
  }

  $shouldInstallClaude = Read-InstallerYesNo `
    -Question 'Claude Code가 설치되어 있지 않습니다. 먼저 설치할까요?' `
    -DefaultYes $true `
    -OptionName 'InstallClaude'

  if (-not $shouldInstallClaude) {
    Write-InstallStep 'Skipping Claude Code installation.'
    return
  }

  Ensure-GitForClaudeCode
  Ensure-NpmForClaudeCode

  $npm = Get-InstallerCommand -Names @('npm.cmd', 'npm')
  if (-not $npm) {
    throw 'npm을 찾을 수 없어 Claude Code를 설치할 수 없습니다.'
  }

  Write-InstallStep 'Installing Claude Code with npm.'
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  try {
    & $npm install -g '@anthropic-ai/claude-code' 2>&1 | ForEach-Object { Write-Host $_ }

    if ($LASTEXITCODE -ne 0) {
      throw "Claude Code npm install failed with exit code $LASTEXITCODE."
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  Refresh-ProcessPath

  if (Test-InstallerCommand -Names @('claude.cmd', 'claude')) {
    $claudeVersion = & (Get-InstallerCommand -Names @('claude.cmd', 'claude')) --version 2>$null
    Write-InstallStep "Claude Code installed. $claudeVersion"
  } else {
    Write-InstallStep 'Claude Code installed, but this PowerShell session cannot find claude yet. Open a new PowerShell window if legal-terminal cannot find it.'
  }
}

function Test-JuriSupportPluginsInstalled {
  $repoDir = Join-Path $env:USERPROFILE 'jurisupport-plugins'
  if (Test-Path (Join-Path $repoDir 'install.sh')) {
    return $true
  }

  $settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
  if (Test-Path $settingsPath) {
    try {
      $settings = Get-Content -Raw -Path $settingsPath
      if ($settings -match 'jurisupport|songmu-legal|korean-law') {
        return $true
      }
    } catch {
      # Treat unreadable settings as unknown and fall back to asking the user.
    }
  }

  return $false
}

function Invoke-JuriSupportPluginsBootstrap {
  param([bool]$ShouldInstall)

  if (-not $ShouldInstall) {
    Write-InstallStep 'Skipping jurisupport-plugins bootstrap.'
    return
  }

  $bootstrapUrl = 'https://raw.githubusercontent.com/jurisupport/jurisupport-plugins/main/windows-bootstrap.ps1'
  $bootstrapPath = Join-Path ([IO.Path]::GetTempPath()) 'jurisupport-windows-bootstrap.ps1'

  Write-InstallStep 'Downloading jurisupport-plugins Windows bootstrap.'
  Write-InstallStep $bootstrapUrl
  Save-ReleaseAsset -Url $bootstrapUrl -TargetPath $bootstrapPath

  $powerShell = Get-InstallerCommand -Names @('powershell.exe', 'powershell')
  if (-not $powerShell) {
    throw 'powershell.exe를 찾을 수 없어 jurisupport-plugins bootstrap을 실행할 수 없습니다.'
  }

  Write-InstallStep 'Starting jurisupport-plugins bootstrap before legal-terminal setup.'
  & $powerShell -NoProfile -ExecutionPolicy Bypass -File $bootstrapPath

  if ($LASTEXITCODE -ne 0) {
    throw "jurisupport-plugins bootstrap failed with exit code $LASTEXITCODE."
  }

  Refresh-ProcessPath
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'This installer is for Windows only.'
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'legal-terminal Windows releases require 64-bit Windows.'
}

$Channel = [string](Get-InstallerOption -Name 'Channel' -DefaultValue 'setup')
$Version = [string](Get-InstallerOption -Name 'Version' -DefaultValue 'latest')
$DestinationOption = Get-InstallerOption -Name 'Destination' -DefaultValue $null
$InstallerArgsOption = Get-InstallerOption -Name 'InstallerArgs' -DefaultValue @()

if (($Channel -ne 'setup') -and ($Channel -ne 'portable')) {
  throw "Invalid channel '$Channel'. Use 'setup' or 'portable'."
}

if ($DestinationOption) {
  $Destination = [string]$DestinationOption
} else {
  $Destination = $null
}

if ($InstallerArgsOption) {
  $InstallerArgs = @($InstallerArgsOption)
} else {
  $InstallerArgs = @()
}

Enable-ModernTls
Refresh-ProcessPath

$juriSupportOption = Get-InstallerOption -Name 'InstallJuriSupport' -DefaultValue $null

if ($null -ne $juriSupportOption) {
  $shouldInstallJuriSupport = ConvertTo-InstallerBoolean -Value $juriSupportOption -DefaultValue $false
} elseif (Test-JuriSupportPluginsInstalled) {
  Write-InstallStep 'jurisupport-plugins already appears installed; skipping bootstrap.'
  $shouldInstallJuriSupport = $false
} else {
  $shouldInstallJuriSupport = Read-InstallerYesNo `
    -Question 'jurisupport-plugins(송무 플러그인/검색 도구)가 설치되어 있지 않은 것 같습니다. 설치할까요?' `
    -DefaultYes $true `
    -OptionName 'InstallJuriSupport'
}

if ($shouldInstallJuriSupport) {
  Invoke-JuriSupportPluginsBootstrap -ShouldInstall $true

  if (-not (Test-InstallerCommand -Names @('claude.cmd', 'claude'))) {
    Ensure-ClaudeCode
  }
} else {
  Invoke-JuriSupportPluginsBootstrap -ShouldInstall $false
  Ensure-ClaudeCode
}

$assetName = Get-AssetName -SelectedChannel $Channel
$releaseBaseUrl = Get-ReleaseBaseUrl -SelectedVersion $Version
$downloadUrl = "$releaseBaseUrl/$assetName"
$downloadPath = Resolve-DownloadPath `
  -RequestedDestination $Destination `
  -AssetName $assetName `
  -SelectedChannel $Channel

Write-InstallStep "Downloading $assetName"
Write-InstallStep $downloadUrl
Save-ReleaseAsset -Url $downloadUrl -TargetPath $downloadPath

if (Get-Command Unblock-File -ErrorAction SilentlyContinue) {
  Unblock-File -Path $downloadPath
}

if ($Channel -eq 'portable') {
  Write-InstallStep "Saved portable app to $downloadPath"
  Start-Process -FilePath $downloadPath | Out-Null
  return
}

Write-InstallStep 'Starting setup. Follow the installer prompts to finish.'
$startProcessArgs = @{
  FilePath = $downloadPath
  Wait = $true
  PassThru = $true
}

if ($InstallerArgs.Count -gt 0) {
  $startProcessArgs.ArgumentList = $InstallerArgs
}

$process = Start-Process @startProcessArgs

if ($process.ExitCode -ne 0) {
  throw "Setup exited with code $($process.ExitCode)."
}

Write-InstallStep 'Done.'
