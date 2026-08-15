function Get-HeadlessWorkspaceLockKey {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Workspace
    )

    $fullPath = [IO.Path]::GetFullPath($Workspace)
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ($root -and $fullPath.Length -gt $root.Length) {
        $fullPath = $fullPath.TrimEnd([char[]]@('\', '/'))
    } elseif ($root) {
        $fullPath = $root
    }

    $normalized = $fullPath.ToUpperInvariant()
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($normalized)
        return (-join ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }))
    } finally {
        $sha.Dispose()
    }
}

function Read-HeadlessWorkspaceLockOwner {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    try {
        $raw = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return $raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function New-HeadlessWorkspaceLock {
    param(
        [Parameter(Mandatory = $true)]
        [string]$DshHome,
        [Parameter(Mandatory = $true)]
        [string]$Workspace,
        [ValidateRange(0, 86400)]
        [int]$TimeoutSeconds = 60,
        [string]$ProfileName = ''
    )

    $lockRoot = Join-Path $DshHome 'locks\headless-workspace'
    New-Item -ItemType Directory -Path $lockRoot -Force | Out-Null
    $key = Get-HeadlessWorkspaceLockKey $Workspace
    $path = Join-Path $lockRoot "$key.lock"
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $token = [Guid]::NewGuid().ToString('N')

    while ($true) {
        $stream = $null
        $locked = $false
        try {
            # FileStream.Lock is an OS-level byte-range lock. Unlike a marker
            # directory it is released automatically if this PowerShell host is
            # terminated, while the stable lock file itself remains reusable.
            $stream = [IO.FileStream]::new(
                $path,
                [IO.FileMode]::OpenOrCreate,
                [IO.FileAccess]::ReadWrite,
                [IO.FileShare]::ReadWrite
            )
            if ($stream.Length -lt 1) {
                $stream.SetLength(1)
                $stream.Flush($true)
            }
            $stream.Lock(0, 1)
            $locked = $true

            $owner = [ordered]@{
                token = $token
                pid = $PID
                startedAt = [DateTime]::UtcNow.ToString('o')
                workspace = [IO.Path]::GetFullPath($Workspace)
                profile = $ProfileName
            }
            $json = ($owner | ConvertTo-Json -Compress)
            $payload = [Text.Encoding]::UTF8.GetBytes($json + "`n")
            $stream.SetLength(0)
            $stream.Position = 0
            $stream.Write($payload, 0, $payload.Length)
            $stream.Flush($true)

            return [pscustomobject]@{
                Path = $path
                Stream = $stream
                Token = $token
                Workspace = [IO.Path]::GetFullPath($Workspace)
            }
        } catch [IO.IOException] {
            if ($locked) {
                try { $stream.Unlock(0, 1) } catch {}
                try { $stream.Dispose() } catch {}
                throw
            }
            try { $stream.Dispose() } catch {}

            if ([DateTime]::UtcNow -ge $deadline) {
                $owner = Read-HeadlessWorkspaceLockOwner $path
                $ownerText = if ($owner) {
                    "owner PID $($owner.pid), started $($owner.startedAt)"
                } else {
                    'owner metadata unavailable'
                }
                throw "Workspace is busy: $([IO.Path]::GetFullPath($Workspace)) ($ownerText; lock: $path)"
            }
            Start-Sleep -Milliseconds 250
        } catch {
            if ($locked) {
                try { $stream.Unlock(0, 1) } catch {}
            }
            try { $stream.Dispose() } catch {}
            throw
        }
    }
}

function Close-HeadlessWorkspaceLock {
    param(
        [Parameter(Mandatory = $false)]
        [psobject]$Lock
    )

    if ($null -eq $Lock -or $null -eq $Lock.Stream) { return }
    try { $Lock.Stream.Unlock(0, 1) } catch {}
    try { $Lock.Stream.Dispose() } catch {}
}
