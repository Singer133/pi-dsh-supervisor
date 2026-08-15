$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("pi-dsh-public-smoke-" + [Guid]::NewGuid().ToString('N'))
$dshHome = Join-Path $root 'home'
$workspace = Join-Path $root 'workspace'
$source = Join-Path $dshHome 'profiles/headless'
$fake = Join-Path $root 'fake-dsh.ps1'
$log = Join-Path $root 'args.json'

try {
    New-Item -ItemType Directory -Path $source, $workspace -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $source 'package.json'), '{"name":"fixture","private":true}' + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $source 'cordis.patch.yml'), "[]`n", [Text.UTF8Encoding]::new($false))
    @'
param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)
$Args | ConvertTo-Json -Compress | Set-Content -LiteralPath $env:PI_DSH_FAKE_LOG -Encoding utf8
exit 0
'@ | Set-Content -LiteralPath $fake -Encoding utf8
    $env:PI_DSH_FAKE_LOG = $log

    & pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '..\scripts\run-dsh.ps1') `
        -Task 'synthetic task' -Workspace $workspace -DshHome $dshHome -DshCommand $fake
    if ($LASTEXITCODE -ne 0) { throw "run-dsh wrapper failed: $LASTEXITCODE" }

    $args = @(Get-Content -LiteralPath $log -Raw | ConvertFrom-Json)
    $profileIndex = [Array]::IndexOf([string[]]$args, '--profile')
    if ($profileIndex -lt 0 -or $args[$profileIndex + 1] -notmatch '^headless-pi-\d+-[0-9a-f]{32}$') {
        throw 'isolated profile argument missing'
    }
    if (-not ($args -contains 'synthetic task')) { throw 'task argument missing' }
    $profiles = Get-ChildItem -LiteralPath (Join-Path $dshHome 'profiles') -Directory -Filter 'headless-pi-*' -ErrorAction SilentlyContinue
    if ($profiles) { throw 'isolated profile was not cleaned after normal exit' }

    & pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '..\scripts\run-dsh-web.ps1') `
        -DshHome $dshHome -LockDshHome $dshHome -Workspace $workspace -Port 38881 -DshCommand $fake -LockTimeoutSeconds 0
    if ($LASTEXITCODE -ne 0) { throw "run-dsh-web wrapper failed: $LASTEXITCODE" }
    $webArgs = @(Get-Content -LiteralPath $log -Raw | ConvertFrom-Json)
    if (-not ($webArgs -contains '--profile') -or -not ($webArgs -contains 'web') -or -not ($webArgs -contains '--host') -or -not ($webArgs -contains '--port') -or -not ($webArgs -contains '38881')) {
        throw 'Web launcher arguments missing'
    }

    . (Join-Path $PSScriptRoot '..\scripts\headless-lock.ps1')
    $heldLock = New-HeadlessWorkspaceLock -DshHome $dshHome -Workspace $workspace -TimeoutSeconds 0
    try {
        $busyOutput = & pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '..\scripts\run-dsh.ps1') `
            -Task 'must not run' -Workspace $workspace -DshHome $dshHome -DshCommand $fake -LockTimeoutSeconds 0 2>&1
        $busyExit = $LASTEXITCODE
        if ($busyExit -eq 0) { throw 'same-workspace headless lock contention was not rejected' }
        if (-not (($busyOutput | Out-String) -match 'Workspace is busy')) { throw 'headless lock contention diagnostic missing' }
        $webBusyOutput = & pwsh -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '..\scripts\run-dsh-web.ps1') `
            -DshHome $dshHome -LockDshHome $dshHome -Workspace $workspace -Port 38882 -DshCommand $fake -LockTimeoutSeconds 0 2>&1
        $webBusyExit = $LASTEXITCODE
        if ($webBusyExit -eq 0) { throw 'same-workspace Web lock contention was not rejected' }
        if (-not (($webBusyOutput | Out-String) -match 'Workspace is busy')) { throw 'Web lock contention diagnostic missing' }
    } finally {
        Close-HeadlessWorkspaceLock -Lock $heldLock
    }

    $other = Join-Path $root 'other-workspace'
    New-Item -ItemType Directory -Path $other -Force | Out-Null
    $otherLock = New-HeadlessWorkspaceLock -DshHome $dshHome -Workspace $other -TimeoutSeconds 0
    Close-HeadlessWorkspaceLock -Lock $otherLock

    'run-dsh smoke: PASS'
} finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:PI_DSH_FAKE_LOG -ErrorAction SilentlyContinue
}
