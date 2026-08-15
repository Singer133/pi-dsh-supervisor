param(
    [Parameter(Mandatory = $true)]
    [string]$DshHome,
    [Parameter(Mandatory = $true)]
    [string]$LockDshHome,
    [Parameter(Mandatory = $true)]
    [string]$Workspace,
    [ValidateRange(1, 65535)]
    [int]$Port,
    [ValidateRange(0, 86400)]
    [int]$LockTimeoutSeconds = 60,
    [string]$Profile = 'web',
    [string]$DshCommand = 'dsh'
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) {
    throw 'run-dsh-web.ps1 requires PowerShell 7 or later; invoke it with pwsh.'
}
if (-not $IsWindows) {
    throw 'The prototype Web profile adapter currently requires Windows.'
}
if (-not (Test-Path -LiteralPath $DshHome -PathType Container)) {
    throw 'DSH_HOME does not exist.'
}
if (-not (Test-Path -LiteralPath $LockDshHome -PathType Container)) {
    throw 'Lock DSH_HOME does not exist.'
}
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw 'Workspace does not exist.'
}

. (Join-Path $PSScriptRoot 'headless-lock.ps1')

$resolvedHome = [IO.Path]::GetFullPath($DshHome)
$resolvedLockHome = [IO.Path]::GetFullPath($LockDshHome)
$resolvedWorkspace = [IO.Path]::GetFullPath($Workspace)
$env:DSH_HOME = $resolvedHome
$lock = $null
$exitCode = 1
try {
    $lock = New-HeadlessWorkspaceLock -DshHome $resolvedLockHome -Workspace $resolvedWorkspace -TimeoutSeconds $LockTimeoutSeconds -ProfileName $Profile
    $command = Get-Command $DshCommand -ErrorAction Stop
    & $command.Source --profile $Profile --host 127.0.0.1 --port $Port
    $exitCode = $LASTEXITCODE
} finally {
    Close-HeadlessWorkspaceLock -Lock $lock
}

exit $exitCode
