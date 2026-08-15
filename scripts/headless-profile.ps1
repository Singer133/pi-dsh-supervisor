function Write-HeadlessUtf8NoBom {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Content
    )

    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function New-HeadlessIsolatedProfile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DshHome
    )

    $token = [Guid]::NewGuid().ToString('N')
    $name = "headless-pi-$PID-$token"
    $profilesRoot = Join-Path $DshHome 'profiles'
    $sourceDir = Join-Path $profilesRoot 'headless'
    $profileDir = Join-Path $profilesRoot $name
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

    try {
        # Preserve the installed headless profile's user patch and out-of-tree
        # dependencies, but never copy its generated cordis.yml. DSH will write
        # that root into this unique directory, removing the startup race.
        $sourceManifest = Join-Path $sourceDir 'package.json'
        if (Test-Path -LiteralPath $sourceManifest -PathType Leaf) {
            Copy-Item -LiteralPath $sourceManifest -Destination (Join-Path $profileDir 'package.json') -Force
        } else {
            $manifest = [ordered]@{
                name = "dsh-profile-$name"
                private = $true
                dependencies = [ordered]@{}
                dsh = [ordered]@{
                    profile = [ordered]@{
                        bundles = @(
                            '@deepseek-ai/dsh-base',
                            '@deepseek-ai/dsh-headless'
                        )
                    }
                }
            }
            Write-HeadlessUtf8NoBom (Join-Path $profileDir 'package.json') (($manifest | ConvertTo-Json -Depth 8) + "`n")
        }

        $sourcePatch = Join-Path $sourceDir 'cordis.patch.yml'
        if (Test-Path -LiteralPath $sourcePatch -PathType Leaf) {
            Copy-Item -LiteralPath $sourcePatch -Destination (Join-Path $profileDir 'cordis.patch.yml') -Force
        } else {
            Write-HeadlessUtf8NoBom (Join-Path $profileDir 'cordis.patch.yml') "[]`n"
        }

        $sourceWorkspace = Join-Path $sourceDir 'pnpm-workspace.yaml'
        if (Test-Path -LiteralPath $sourceWorkspace -PathType Leaf) {
            Copy-Item -LiteralPath $sourceWorkspace -Destination (Join-Path $profileDir 'pnpm-workspace.yaml') -Force
        } else {
            Write-HeadlessUtf8NoBom (Join-Path $profileDir 'pnpm-workspace.yaml') "packages:`n  - .`n`nnodeLinker: hoisted`nautoInstallPeers: false`n"
        }

        $sourceModules = Join-Path $sourceDir 'node_modules'
        if (Test-Path -LiteralPath $sourceModules -PathType Container) {
            New-Item -ItemType Junction -Path (Join-Path $profileDir 'node_modules') -Target $sourceModules -ErrorAction Stop | Out-Null
        }

        return [pscustomobject]@{
            Name = $name
            Directory = $profileDir
        }
    } catch {
        $nodeModules = Join-Path $profileDir 'node_modules'
        if (Test-Path -LiteralPath $nodeModules) {
            $entry = Get-Item -LiteralPath $nodeModules -Force -ErrorAction SilentlyContinue
            if ($entry -and $entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
                Remove-Item -LiteralPath $nodeModules -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
}

function Remove-HeadlessIsolatedProfile {
    param(
        [Parameter(Mandatory = $false)]
        [psobject]$Profile,
        [Parameter(Mandatory = $true)]
        [string]$DshHome
    )

    if ($null -eq $Profile -or [string]::IsNullOrWhiteSpace($Profile.Directory)) { return }
    $profilesRoot = [IO.Path]::GetFullPath((Join-Path $DshHome 'profiles')).TrimEnd([char[]]@('\', '/'))
    $profileDir = [IO.Path]::GetFullPath($Profile.Directory).TrimEnd([char[]]@('\', '/'))
    $expectedPrefix = "$profilesRoot\"
    if (-not $profileDir.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { return }
    if ($Profile.Name -notmatch '^headless-pi-\d+-[0-9a-f]{32}$') { return }
    $nodeModules = Join-Path $profileDir 'node_modules'
    if (Test-Path -LiteralPath $nodeModules) {
        $entry = Get-Item -LiteralPath $nodeModules -Force -ErrorAction SilentlyContinue
        if ($entry -and $entry.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
            Remove-Item -LiteralPath $nodeModules -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction SilentlyContinue
}
