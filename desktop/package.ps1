$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
$index = Join-Path $build 'index.html'
$configFile = Join-Path $root '.stremio-party.firebase.local.json'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$dist = Join-Path $root 'dist'
$archive = Join-Path $dist 'Stremio-Party-Windows.zip'

if (!(Test-Path -LiteralPath $index -PathType Leaf)) {
    throw 'Build the app with its cloud Firebase config before packaging it.'
}
if (Test-Path -LiteralPath (Join-Path $build 'service-worker.js')) {
    throw 'Build with PARTY_DESKTOP_BUILD=1 before packaging the Windows app.'
}
if (!(Test-Path -LiteralPath $configFile -PathType Leaf)) {
    throw 'The local Firebase Web config is required to verify the packaged build.'
}
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) {
    throw 'The Windows .NET Framework C# compiler is required to build the launcher.'
}

$config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
$mainScript = Get-ChildItem -LiteralPath $build -Filter 'main.js' -File -Recurse | Select-Object -First 1
if (!$config.databaseURL -or !$mainScript -or !(Select-String -LiteralPath $mainScript.FullName -SimpleMatch $config.databaseURL -Quiet)) {
    throw 'The current build does not use the configured Firebase project. Build it with PARTY_FIREBASE_CONFIG before packaging.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$stageName = 'stremio-party-package-' + [Guid]::NewGuid().ToString('N')
$temp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$stage = Join-Path $temp $stageName
$package = Join-Path $stage 'Stremio Party'
$source = Join-Path $stage 'Source'

New-Item -ItemType Directory -Path $package, $source, $dist -Force | Out-Null
try {
    $launcher = Join-Path $package 'Stremio Party.exe'
    $launcherSources = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' -File | Select-Object -ExpandProperty FullName)
    & $compiler /nologo /target:winexe /optimize+ /define:TRACE /reference:System.Windows.Forms.dll /reference:System.Net.Http.dll /reference:System.Web.Extensions.dll "/out:$launcher" @launcherSources
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the Windows launcher.' }

    Copy-Item -LiteralPath $build -Destination (Join-Path $package 'app') -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'LICENSE.md'), (Join-Path $PSScriptRoot 'README.txt') -Destination $package

    $sourceFiles = git -C $root -c core.quotePath=false ls-files --cached --others --exclude-standard
    if ($LASTEXITCODE -ne 0) { throw 'Could not list the corresponding source files.' }
    foreach ($relative in ($sourceFiles | Sort-Object -Unique)) {
        $path = Join-Path $root $relative
        if (!(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
        $destination = Join-Path $source $relative
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $path -Destination $destination
    }
    [IO.Compression.ZipFile]::CreateFromDirectory($source, (Join-Path $package 'Source.zip'))

    $stagedZip = Join-Path $stage 'Stremio-Party-Windows.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($package, $stagedZip, [IO.Compression.CompressionLevel]::Optimal, $true)
    Copy-Item -LiteralPath $stagedZip -Destination $archive -Force
    Get-Item -LiteralPath $archive
}
finally {
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    if ([IO.Path]::GetDirectoryName($resolvedStage) -eq $temp.TrimEnd('\') -and [IO.Path]::GetFileName($resolvedStage) -eq $stageName) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
