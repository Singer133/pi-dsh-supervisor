param(
    [Parameter(Mandatory = $true)]
    [string]$DshHome,
    [ValidateRange(1, 65535)]
    [int]$Port,
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
    throw "DSH_HOME does not exist: $DshHome"
}
$resolvedHome = [IO.Path]::GetFullPath($DshHome)
$env:DSH_HOME = $resolvedHome
$command = Get-Command $DshCommand -ErrorAction Stop
& $command.Source --profile $Profile --host 127.0.0.1 --port $Port
exit $LASTEXITCODE
