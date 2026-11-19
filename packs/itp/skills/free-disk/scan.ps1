# Read only: measures what takes space on this PC that can be freed, and prints one table.
# Nothing is deleted here. The free-disk skill reads the table and asks you what to free.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scan.ps1 [-Solution <folder>]
param([string]$Solution = '{{SOLUTION}}')
$ErrorActionPreference = 'SilentlyContinue'

# Size of a folder in bytes. robocopy in list mode (/L) only reads, skips links (/XJ) and is far faster than
# walking the folder in PowerShell.
function Get-Size([string]$dir) {
    if (-not (Test-Path -LiteralPath $dir)) { return 0 }
    $out = robocopy $dir 'C:\__free-disk-nowhere__' /L /S /NJH /NFL /NDL /BYTES /XJ /R:0 /W:0 2>$null
    $line = $out | Where-Object { $_ -match '^\s*Bytes\s*:' } | Select-Object -First 1
    if ($line -match ':\s*(\d+)') { return [int64]$Matches[1] }
    return 0
}
function GB([int64]$b) { '{0,6:N1} GB' -f ($b / 1GB) }
$rows = New-Object System.Collections.ArrayList
function Add-Row($key, [int64]$bytes, $what, $safe, $cost) {
    if ($bytes -lt 100MB) { return }
    [void]$rows.Add([pscustomobject]@{ Key = $key; Bytes = $bytes; Size = (GB $bytes); What = $what; Safe = $safe; Cost = $cost })
}

$c = Get-PSDrive C
Write-Output ('C: {0:N0} GB free of {1:N0} GB' -f ($c.Free / 1GB), (($c.Used + $c.Free) / 1GB))

# ---- Windows ----
$hib = Get-Item -Force C:\hiberfil.sys
if ($hib) { Add-Row 'hibernate' $hib.Length 'hiberfil.sys (hibernate file)' 'only if you never hibernate' 'no hibernate, no fast startup; needs admin: powercfg /h off' }
$me = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
Add-Row 'recycle-bin' (Get-Size "C:\`$Recycle.Bin\$me") 'your Recycle Bin' 'yes' 'gone for good'
$cut = (Get-Date).AddDays(-2)
$tmp = (Get-ChildItem $env:TEMP -Recurse -Force -File | Where-Object { $_.LastWriteTime -lt $cut -and $_.FullName -notlike "$env:TEMP\claude\*" } | Measure-Object Length -Sum).Sum
Add-Row 'temp' $tmp 'Temp files older than 2 days' 'yes (in-use files are skipped)' 'none'
if (Test-Path C:\Windows.old) { Add-Row 'windows-old' (Get-Size C:\Windows.old) 'C:\Windows.old (the Windows before an upgrade)' 'yes, if the upgrade is fine' 'no going back to the old Windows; needs Disk Cleanup as admin' }
Add-Row 'downloads' (Get-Size "$env:USERPROFILE\Downloads") 'your Downloads folder' 'you decide, file by file' 'the files'

# ---- download caches (filled again when needed) ----
Add-Row 'nuget' ((Get-Size "$env:USERPROFILE\.nuget\packages") + (Get-Size "$env:LOCALAPPDATA\NuGet\v3-cache")) 'NuGet package cache (.NET)' 'yes, when no build runs' 'the next restore downloads again'
Add-Row 'npm' (Get-Size "$env:LOCALAPPDATA\npm-cache") 'npm cache' 'yes' 'the next npm install downloads again'
Add-Row 'playwright' (Get-Size "$env:LOCALAPPDATA\ms-playwright") 'Playwright browsers' 'only if no AI browser test runs soon' 'npx playwright install again'

# ---- build output in the solution's repos (bin, obj, .angular; node_modules apart) ----
if ($Solution -and (Test-Path $Solution)) {
    # The repos inside the solution folder. The solution folder's own repo (the itp-workspace) is never touched, and
    # holding the others, it would count them twice.
    $repos = @(Get-ChildItem $Solution -Directory | Where-Object { Test-Path (Join-Path $_.FullName '.git') })
    foreach ($repo in $repos) {
        # The folders, outermost only, never inside .git or node_modules, never a link.
        $all = cmd /c "dir /s /b /ad `"$($repo.FullName)`"" 2>$null | Where-Object { $_ -match '\\(bin|obj|\.angular)$' -and $_ -notmatch '\\(\.git|node_modules)\\' }
        $outer = @($all | Sort-Object Length | Where-Object { $p = $_; -not ($all | Where-Object { $p.StartsWith("$_\") }) })
        $sum = 0
        foreach ($d in $outer) { if (-not ((Get-Item -LiteralPath $d -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { $sum += Get-Size $d } }
        Add-Row "build:$($repo.Name)" $sum "$($repo.Name): build output (bin, obj, .angular; $($outer.Count) folders)" 'yes, when nothing runs or builds from it' 'the next build is a full one (minutes)'
        $nm = Join-Path $repo.FullName 'node_modules'
        if (Test-Path $nm) { Add-Row "node_modules:$($repo.Name)" (Get-Size $nm) "$($repo.Name): node_modules" 'yes, when no dev server runs' 'npm install again (big download, minutes)' }
    }
}

# ---- Docker (its whole disk; what is inside is freed through Orchestra or docker, never by hand) ----
$vhdx = Get-ChildItem "$env:LOCALAPPDATA\Docker\wsl" -Recurse -Force -File -Filter *.vhdx
$dock = ($vhdx | Measure-Object Length -Sum).Sum
Add-Row 'docker' $dock "Docker's disk (app slots' data, the master copy, images)" 'only through orch (slots) or docker image prune' 'see orch app slots'

# ---- look, do not touch (shown so you know where the space is) ----
Add-Row 'keep:installer' (Get-Size C:\Windows\Installer) 'C:\Windows\Installer' 'no: repairs and uninstalls need it' '-'

$rows | Sort-Object Bytes -Descending | Format-Table Key, Size, What, Safe, Cost -AutoSize -Wrap | Out-String -Width 220
$canFree = ($rows | Where-Object { $_.Key -notlike 'keep:*' -and $_.Key -ne 'docker' -and $_.Key -ne 'downloads' } | Measure-Object Bytes -Sum).Sum
Write-Output ('Could be freed (safe rows, not Docker, not Downloads): about {0:N0} GB' -f ($canFree / 1GB))
