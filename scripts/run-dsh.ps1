param(
    [Parameter(Mandatory = $true)]
    [string]$Task,
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [string]$DshHome,
    [string]$DshCommand = 'dsh',
    [string]$Patch,
    [string]$ProfileName = '',
    [ValidateRange(0, 86400)]
    [int]$LockTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw 'run-dsh.ps1 requires PowerShell 7 or later; invoke it with pwsh.'
}
if (-not $IsWindows) {
    throw 'The prototype profile adapter currently requires Windows junction support.'
}

. (Join-Path $PSScriptRoot 'headless-lock.ps1')
. (Join-Path $PSScriptRoot 'headless-profile.ps1')

function Resolve-DshHome([string]$Explicit) {
    $value = if ($Explicit) { $Explicit } elseif ($env:DSH_HOME) { $env:DSH_HOME } else { $null }
    if (-not $value) { throw 'DSH_HOME is required; the prototype refuses legacy home fallback.' }
    return [IO.Path]::GetFullPath($value)
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "Workspace does not exist: $Workspace"
}
$resolvedWorkspace = [IO.Path]::GetFullPath($Workspace)
$resolvedHome = Resolve-DshHome $DshHome
$env:DSH_HOME = $resolvedHome
if ($Patch -and -not (Test-Path -LiteralPath $Patch -PathType Leaf)) {
    throw "Patch does not exist: $Patch"
}
if ($ProfileName -and $ProfileName -notmatch '^headless-pi-(?:\d+-)?[0-9a-f]{32}$') {
    throw "Invalid isolated profile name: $ProfileName"
}

$lock = $null
$profile = $null
$exitCode = 1
try {
    $lock = New-HeadlessWorkspaceLock -DshHome $resolvedHome -Workspace $resolvedWorkspace -TimeoutSeconds $LockTimeoutSeconds
    $profile = New-HeadlessIsolatedProfile -DshHome $resolvedHome -ProfileName $ProfileName
    $command = Get-Command $DshCommand -ErrorAction Stop
    $arguments = @('--profile', $profile.Name)
    if ($Patch) { $arguments += @('--patch', [IO.Path]::GetFullPath($Patch)) }
    $arguments += $Task

    Push-Location -LiteralPath $resolvedWorkspace
    try {
        & $command.Source @arguments
        $exitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
} finally {
    Remove-HeadlessIsolatedProfile -Profile $profile -DshHome $resolvedHome
    Close-HeadlessWorkspaceLock -Lock $lock
}

exit $exitCode
