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

  $suffix = if ($DefaultYes) { '[예/Y, 기본: 예]' } else { '[아니요/N, 기본: 아니요]' }

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

    Write-Host "예(Y) 또는 아니요(N)로 입력해 주세요."
  }
}

function Write-InstallStep {
  param([string]$Message)
  Write-Host "[legal-terminal] $Message"
}

function Format-ByteSize {
  param([long]$Bytes)

  if ($Bytes -ge 1GB) {
    return '{0:N1} GB' -f ($Bytes / 1GB)
  }

  if ($Bytes -ge 1MB) {
    return '{0:N1} MB' -f ($Bytes / 1MB)
  }

  if ($Bytes -ge 1KB) {
    return '{0:N1} KB' -f ($Bytes / 1KB)
  }

  return "$Bytes B"
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

  $tempPath = "$TargetPath.download"
  if (Test-Path $tempPath) {
    Remove-Item -Force -Path $tempPath
  }

  $activity = '다운로드 중'

  try {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.AllowAutoRedirect = $true
    $request.UserAgent = 'legal-terminal-installer'

    $response = $request.GetResponse()
    $responseStream = $null
    $fileStream = $null

    try {
      $totalBytes = [long]$response.ContentLength
      $responseStream = $response.GetResponseStream()
      $fileStream = [System.IO.File]::Create($tempPath)
      $buffer = New-Object byte[] (1024 * 1024)
      $downloadedBytes = [long]0

      while ($true) {
        $read = $responseStream.Read($buffer, 0, $buffer.Length)
        if ($read -le 0) {
          break
        }

        $fileStream.Write($buffer, 0, $read)
        $downloadedBytes += $read

        $progress = @{
          Activity = $activity
          Status = if ($totalBytes -gt 0) {
            "$(Format-ByteSize $downloadedBytes) / $(Format-ByteSize $totalBytes)"
          } else {
            "$(Format-ByteSize $downloadedBytes) 다운로드됨"
          }
        }

        if ($totalBytes -gt 0) {
          $progress.PercentComplete = [Math]::Min(100, [int](($downloadedBytes * 100) / $totalBytes))
        }

        Write-Progress @progress
      }
    } finally {
      if ($fileStream) {
        $fileStream.Dispose()
      }

      if ($responseStream) {
        $responseStream.Dispose()
      }

      if ($response) {
        $response.Dispose()
      }

      Write-Progress -Activity $activity -Completed
    }

    Move-Item -Force -Path $tempPath -Destination $TargetPath
  } catch {
    $downloadError = $_
    Write-Progress -Activity $activity -Completed

    if (Test-Path $tempPath) {
      Remove-Item -Force -Path $tempPath
    }

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue

    if (-not $curl) {
      throw $downloadError
    }

    Write-InstallStep '기본 다운로드 방식이 실패해서 curl.exe로 다시 시도합니다.'
    & $curl.Source -fL --progress-bar $Url -o $TargetPath

    if ($LASTEXITCODE -ne 0) {
      throw "curl.exe 다운로드가 실패했습니다. 종료 코드: $LASTEXITCODE"
    }
  }

  $downloaded = Get-Item $TargetPath
  if ($downloaded.Length -le 0) {
    throw "다운로드된 파일이 비어 있습니다: $TargetPath"
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

  Write-InstallStep "winget으로 $Name 설치 중입니다."
  & winget install --id $Id --exact --silent --accept-package-agreements --accept-source-agreements

  if (($LASTEXITCODE -ne 0) -and ($LASTEXITCODE -ne -1978335189)) {
    throw "$Name winget 설치가 실패했습니다. 종료 코드: $LASTEXITCODE"
  }

  Refresh-ProcessPath
}

function Ensure-GitForClaudeCode {
  $defaultGitBash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
  $defaultGitBashX86 = Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'

  if ((Test-InstallerCommand -Names @('git.exe', 'git')) -and ((Test-Path $defaultGitBash) -or (Test-Path $defaultGitBashX86))) {
    return
  }

  Write-InstallStep 'Windows에서 Claude Code를 쓰려면 Git for Windows가 필요합니다. 먼저 설치합니다.'
  Install-WingetPackage -Id 'Git.Git' -Name 'Git for Windows'
}

function Ensure-NpmForClaudeCode {
  if (Test-InstallerCommand -Names @('npm.cmd', 'npm')) {
    return
  }

  Write-InstallStep 'Claude Code 설치에 Node.js/npm이 필요합니다. Node.js LTS를 먼저 설치합니다.'
  Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -Name 'Node.js LTS'

  if (-not (Test-InstallerCommand -Names @('npm.cmd', 'npm'))) {
    throw 'npm을 아직 찾을 수 없습니다. 새 PowerShell 창에서 다시 실행해 주세요.'
  }
}

function Update-ClaudeCode {
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $npm = Get-InstallerCommand -Names @('npm.cmd', 'npm')
    if ($npm) {
      Write-InstallStep 'npm으로 Claude Code를 최신 버전으로 업데이트합니다.'
      & $npm install -g '@anthropic-ai/claude-code@latest' 2>&1 | ForEach-Object { Write-Host $_ }
    } else {
      Write-InstallStep 'claude update로 Claude Code를 업데이트합니다.'
      & (Get-InstallerCommand -Names @('claude.cmd', 'claude')) update 2>&1 | ForEach-Object { Write-Host $_ }
    }
    if ($LASTEXITCODE -ne 0) {
      Write-InstallStep '업데이트가 실패해 기존 버전을 유지합니다.'
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  Refresh-ProcessPath
  $claudeVersion = & (Get-InstallerCommand -Names @('claude.cmd', 'claude')) --version 2>$null
  Write-InstallStep "현재 Claude Code 버전: $claudeVersion"
}

function Ensure-ClaudeCode {
  if (Test-InstallerCommand -Names @('claude.cmd', 'claude')) {
    $claude = Get-InstallerCommand -Names @('claude.cmd', 'claude')
    $claudeVersion = & $claude --version 2>$null
    Write-InstallStep "Claude Code를 찾았습니다: $claude ($claudeVersion)"

    # 설치 여부만 확인하고 넘어가면 구버전이 계속 남는다 — 최신화 여부를 묻는다.
    $shouldUpdateClaude = Read-InstallerYesNo `
      -Question 'Claude Code를 최신 버전으로 업데이트할까요?' `
      -DefaultYes $true `
      -OptionName 'UpdateClaude'

    if ($shouldUpdateClaude) {
      Update-ClaudeCode
    } else {
      Write-InstallStep '기존 Claude Code 버전을 유지합니다.'
    }
    return
  }

  $shouldInstallClaude = Read-InstallerYesNo `
    -Question 'Claude Code가 설치되어 있지 않습니다. legal-terminal의 AI 터미널 기능에 필요합니다. 지금 설치할까요?' `
    -DefaultYes $true `
    -OptionName 'InstallClaude'

  if (-not $shouldInstallClaude) {
    Write-InstallStep 'Claude Code 설치를 건너뜁니다.'
    return
  }

  Ensure-GitForClaudeCode
  Ensure-NpmForClaudeCode

  $npm = Get-InstallerCommand -Names @('npm.cmd', 'npm')
  if (-not $npm) {
    throw 'npm을 찾을 수 없어 Claude Code를 설치할 수 없습니다.'
  }

  Write-InstallStep 'npm으로 Claude Code를 설치합니다.'
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  try {
    & $npm install -g '@anthropic-ai/claude-code' 2>&1 | ForEach-Object { Write-Host $_ }

    if ($LASTEXITCODE -ne 0) {
      throw "Claude Code npm 설치가 실패했습니다. 종료 코드: $LASTEXITCODE"
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  Refresh-ProcessPath

  if (Test-InstallerCommand -Names @('claude.cmd', 'claude')) {
    $claudeVersion = & (Get-InstallerCommand -Names @('claude.cmd', 'claude')) --version 2>$null
    Write-InstallStep "Claude Code 설치를 확인했습니다. $claudeVersion"
  } else {
    Write-InstallStep 'Claude Code 설치는 끝났지만 현재 PowerShell 창에서는 아직 claude 명령을 찾지 못했습니다. legal-terminal에서 찾지 못하면 새 PowerShell 창을 열어 다시 확인해 주세요.'
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
      if ($settings -match 'jurisupport-plugins|songmu-legal|korean-law|pretool_data_protection') {
        return $true
      }
    } catch {
      # 설정 파일을 읽지 못하면 알 수 없음으로 보고 사용자에게 물어본다.
    }
  }

  return $false
}

function Invoke-JuriSupportPluginsBootstrap {
  param([bool]$ShouldInstall)

  if (-not $ShouldInstall) {
    Write-InstallStep 'jurisupport-plugins 준비 과정을 건너뜁니다.'
    return
  }

  $bootstrapUrl = 'https://raw.githubusercontent.com/jurisupport/jurisupport-plugins/main/windows-bootstrap.ps1'
  $bootstrapPath = Join-Path ([IO.Path]::GetTempPath()) 'jurisupport-windows-bootstrap.ps1'

  Write-InstallStep 'jurisupport-plugins Windows 준비 스크립트를 내려받습니다.'
  Write-InstallStep $bootstrapUrl
  Save-ReleaseAsset -Url $bootstrapUrl -TargetPath $bootstrapPath

  $powerShell = Get-InstallerCommand -Names @('powershell.exe', 'powershell')
  if (-not $powerShell) {
    throw 'powershell.exe를 찾을 수 없어 jurisupport-plugins 준비 스크립트를 실행할 수 없습니다.'
  }

  Write-InstallStep 'jurisupport-plugins 준비 스크립트를 실행합니다.'
  $previousSkipLawyerProfile = $env:JURISUPPORT_SKIP_LAWYER_PROFILE
  $previousSkipLegalTerminal = $env:JURISUPPORT_SKIP_LEGAL_TERMINAL

  try {
    $env:JURISUPPORT_SKIP_LAWYER_PROFILE = '1'
    $env:JURISUPPORT_SKIP_LEGAL_TERMINAL = '1'
    & $powerShell -NoProfile -ExecutionPolicy Bypass -File $bootstrapPath
  } finally {
    if ($null -eq $previousSkipLawyerProfile) {
      Remove-Item Env:JURISUPPORT_SKIP_LAWYER_PROFILE -ErrorAction SilentlyContinue
    } else {
      $env:JURISUPPORT_SKIP_LAWYER_PROFILE = $previousSkipLawyerProfile
    }

    if ($null -eq $previousSkipLegalTerminal) {
      Remove-Item Env:JURISUPPORT_SKIP_LEGAL_TERMINAL -ErrorAction SilentlyContinue
    } else {
      $env:JURISUPPORT_SKIP_LEGAL_TERMINAL = $previousSkipLegalTerminal
    }
  }

  if ($LASTEXITCODE -ne 0) {
    throw "jurisupport-plugins 준비 스크립트가 실패했습니다. 종료 코드: $LASTEXITCODE"
  }

  Refresh-ProcessPath
}

function Test-LawyerProfilePluginInstalled {
  if (-not (Test-InstallerCommand -Names @('claude.cmd', 'claude'))) {
    return $false
  }

  try {
    $claude = Get-InstallerCommand -Names @('claude.cmd', 'claude')
    $plugins = & $claude plugin list 2>$null | Out-String
    return $plugins -match 'jurisupport-lawyer-profile'
  } catch {
    return $false
  }
}

function Invoke-LawyerProfilePluginInstaller {
  if (Test-LawyerProfilePluginInstalled) {
    # 설치 스크립트 재실행이 곧 업데이트다 — 설치 여부만 보고 건너뛰지 않는다.
    $shouldUpdate = Read-InstallerYesNo `
      -Question '변호사 강점찾기 플러그인이 이미 설치되어 있습니다. 최신 버전으로 업데이트할까요?' `
      -DefaultYes $true `
      -OptionName 'UpdateLawyerProfile'

    if (-not $shouldUpdate) {
      Write-InstallStep '기존 변호사 강점찾기 플러그인을 유지합니다.'
      return
    }
  } else {
    $shouldInstall = Read-InstallerYesNo `
      -Question '변호사 강점찾기 플러그인을 설치할까요?' `
      -DefaultYes $true `
      -OptionName 'InstallLawyerProfile'

    if (-not $shouldInstall) {
      Write-InstallStep '변호사 강점찾기 플러그인 설치를 건너뜁니다.'
      return
    }
  }

  $previousSkipJuriSupport = $env:JURISUPPORT_LAWYER_PROFILE_SKIP_JURISUPPORT
  $previousSkipLegalTerminal = $env:JURISUPPORT_LAWYER_PROFILE_SKIP_LEGAL_TERMINAL
  $previousConnectMcp = $env:JURISUPPORT_CONNECT_MCP

  try {
    $env:JURISUPPORT_LAWYER_PROFILE_SKIP_JURISUPPORT = '1'
    $env:JURISUPPORT_LAWYER_PROFILE_SKIP_LEGAL_TERMINAL = '1'
    $env:JURISUPPORT_CONNECT_MCP = '0'
    Write-InstallStep '변호사 강점찾기 플러그인 설치 스크립트를 실행합니다.'
    irm https://raw.githubusercontent.com/jurisupport/jurisupport-lawyer-profile-plugin/main/install.ps1 | iex
  } finally {
    if ($null -eq $previousSkipJuriSupport) {
      Remove-Item Env:JURISUPPORT_LAWYER_PROFILE_SKIP_JURISUPPORT -ErrorAction SilentlyContinue
    } else {
      $env:JURISUPPORT_LAWYER_PROFILE_SKIP_JURISUPPORT = $previousSkipJuriSupport
    }

    if ($null -eq $previousSkipLegalTerminal) {
      Remove-Item Env:JURISUPPORT_LAWYER_PROFILE_SKIP_LEGAL_TERMINAL -ErrorAction SilentlyContinue
    } else {
      $env:JURISUPPORT_LAWYER_PROFILE_SKIP_LEGAL_TERMINAL = $previousSkipLegalTerminal
    }

    if ($null -eq $previousConnectMcp) {
      Remove-Item Env:JURISUPPORT_CONNECT_MCP -ErrorAction SilentlyContinue
    } else {
      $env:JURISUPPORT_CONNECT_MCP = $previousConnectMcp
    }
  }
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw '이 설치 스크립트는 Windows 전용입니다.'
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'legal-terminal Windows 배포판은 64비트 Windows가 필요합니다.'
}

$Channel = [string](Get-InstallerOption -Name 'Channel' -DefaultValue 'setup')
$Version = [string](Get-InstallerOption -Name 'Version' -DefaultValue 'latest')
$DestinationOption = Get-InstallerOption -Name 'Destination' -DefaultValue $null
$InstallerArgsOption = Get-InstallerOption -Name 'InstallerArgs' -DefaultValue @()

if (($Channel -ne 'setup') -and ($Channel -ne 'portable')) {
  throw "잘못된 채널입니다: '$Channel'. 'setup' 또는 'portable'을 사용해 주세요."
}

Write-InstallStep 'Windows 설치를 시작합니다.'
Write-InstallStep '진행 순서: Claude Code 확인 → legal-terminal 설치 → jurisupport-plugins 추천 → 변호사 강점찾기 추천'
Write-InstallStep '추가 도구나 추천 구성요소가 필요하면 물어본 뒤 진행합니다.'

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

Ensure-ClaudeCode

$assetName = Get-AssetName -SelectedChannel $Channel
$releaseBaseUrl = Get-ReleaseBaseUrl -SelectedVersion $Version
$downloadUrl = "$releaseBaseUrl/$assetName"
$downloadPath = Resolve-DownloadPath `
  -RequestedDestination $Destination `
  -AssetName $assetName `
  -SelectedChannel $Channel

Write-InstallStep "$assetName 내려받는 중입니다. PowerShell 창에 진행률이 표시됩니다."
Write-InstallStep $downloadUrl
Save-ReleaseAsset -Url $downloadUrl -TargetPath $downloadPath
Write-InstallStep "다운로드 완료: $downloadPath"

if (Get-Command Unblock-File -ErrorAction SilentlyContinue) {
  Unblock-File -Path $downloadPath
}

if ($Channel -eq 'portable') {
  Write-InstallStep "포터블 앱을 저장했습니다: $downloadPath"
  Start-Process -FilePath $downloadPath | Out-Null
} else {
  Write-InstallStep '설치 파일을 실행합니다. 열리는 설치 창의 안내에 따라 마무리해 주세요.'
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
    throw "설치 파일이 오류로 종료되었습니다. 종료 코드: $($process.ExitCode)"
  }
}

Write-InstallStep '설치가 끝났습니다.'

$juriSupportOption = Get-InstallerOption -Name 'InstallJuriSupport' -DefaultValue $null

if ($null -ne $juriSupportOption) {
  $shouldInstallJuriSupport = ConvertTo-InstallerBoolean -Value $juriSupportOption -DefaultValue $false
} elseif (Test-JuriSupportPluginsInstalled) {
  # 설치 여부만 보고 건너뛰면 구버전이 계속 남는다 — 최신화 여부를 물어 준비 스크립트를 재실행한다.
  $shouldInstallJuriSupport = Read-InstallerYesNo `
    -Question 'jurisupport-plugins가 이미 설치되어 있습니다. 최신 버전으로 업데이트할까요?' `
    -DefaultYes $true `
    -OptionName 'UpdateJuriSupport'
} else {
  $shouldInstallJuriSupport = Read-InstallerYesNo `
    -Question 'jurisupport-plugins(송무 플러그인/검색 도구)를 설치할까요?' `
    -DefaultYes $true `
    -OptionName 'InstallJuriSupport'
}

Invoke-JuriSupportPluginsBootstrap -ShouldInstall $shouldInstallJuriSupport
Invoke-LawyerProfilePluginInstaller
