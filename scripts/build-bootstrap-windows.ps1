param([switch]$TestsOnly)
$ErrorActionPreference = 'Stop'
$framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$compiler = Join-Path $framework 'csc.exe'
$temporary = Join-Path $env:RUNNER_TEMP ('fbd-bootstrap-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $references = @('System.dll', 'System.Core.dll', 'System.Net.Http.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll') | ForEach-Object { '/reference:' + (Join-Path $framework $_) }
  $tests = Join-Path $temporary 'BootstrapTests.exe'
  $core = (Resolve-Path 'bootstrap/windows/Installer.cs').Path
  $testSource = (Resolve-Path 'bootstrap/windows/Tests.cs').Path
  $program = (Resolve-Path 'bootstrap/windows/Program.cs').Path
  $manifest = (Resolve-Path 'bootstrap/windows/app.manifest').Path
  & $compiler /nologo /codepage:65001 /target:exe "/out:$tests" $references $core $testSource
  if ($LASTEXITCODE -ne 0) { throw 'Bootstrap test compilation failed' }
  & $tests
  if ($LASTEXITCODE -ne 0) { throw 'Bootstrap tests failed' }
  if ($TestsOnly) {
    & $compiler /nologo /codepage:65001 /target:winexe /platform:anycpu "/win32manifest:$manifest" "/out:$temporary\Setup.exe" $references $core $program
    if ($LASTEXITCODE -ne 0) { throw 'Bootstrap UI compilation failed' }
    return
  }
  Add-Type -AssemblyName System.Drawing
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path 'release/win-unpacked/Fixed By Design.exe'))
  $iconPath = Join-Path $temporary 'bootstrap.ico'
  $stream = [System.IO.File]::Create($iconPath)
  try { $icon.Save($stream) } finally { $stream.Dispose(); $icon.Dispose() }
  $output = Join-Path (Resolve-Path 'release').Path 'FBD-Launcher-Setup-windows-x64.exe'
  & $compiler /nologo /codepage:65001 /target:winexe /platform:anycpu /optimize+ "/win32manifest:$manifest" "/win32icon:$iconPath" "/out:$output" $references $core $program
  if ($LASTEXITCODE -ne 0) { throw 'Bootstrap compilation failed' }
  $installed = Join-Path $temporary 'installed'
  $version = (Get-Content package.json -Raw | ConvertFrom-Json).version
  $setup = (Resolve-Path "release/FBD-Launcher-$version-windows-x64.exe")
  $process = Start-Process -FilePath $setup -ArgumentList @('/S', "/D=$installed") -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw "Native NSIS installation failed: $($process.ExitCode)" }
  $expected = (Get-FileHash 'release/win-unpacked/resources/app.asar' -Algorithm SHA256).Hash
  $actual = (Get-FileHash (Join-Path $installed 'resources/app.asar') -Algorithm SHA256).Hash
  if ($expected -ne $actual) { throw 'Installed payload differs from the packaged application' }
  Write-Host 'Native Windows NSIS installation smoke passed; no account or game launched.'
  $uninstaller = Join-Path $installed 'Uninstall Fixed By Design.exe'
  $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw 'Smoke installation cleanup failed' }
} finally {
  Remove-Item -LiteralPath $temporary -Recurse -Force
}
