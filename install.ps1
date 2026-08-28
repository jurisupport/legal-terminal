Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

[Net.ServicePointManager]::SecurityProtocol = `
  [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$installerUrl = 'https://github.com/jurisupport/legal-terminal/releases/latest/download/install-windows.ps1'
$installerPath = Join-Path ([IO.Path]::GetTempPath()) 'legal-terminal-install.ps1'

Invoke-WebRequest -Uri $installerUrl -UseBasicParsing -OutFile $installerPath
Invoke-Expression (Get-Content -LiteralPath $installerPath -Raw -Encoding UTF8)
