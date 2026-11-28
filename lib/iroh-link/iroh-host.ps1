# iroh-host.ps1 - remote side carrier supervisor for iroh-link.
#
# Loop every IntervalSec:
#   1. Find the real DSH webserver port: probe listening ports owned by the DSH
#      processes with GET /interconnect/link (token from credentials.yaml); the
#      port that answers HTTP 101 is the one. The port changes on every restart.
#   2. If the port changed or dumbpipe died, restart
#      `dumbpipe listen-tcp --host 127.0.0.1:<port>`.
#   3. Write the FULL ticket printed by the listener into ticket.txt; the local
#      side reads that file to start its own connector.
#
# Identity: root\secret.hex holds a fixed 32-byte IROH_SECRET so the NodeId is
# stable across restarts. BACK IT UP: replacing it changes the endpoint id.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads BOM-less .ps1 as
# ANSI; non-ASCII comments can break parsing on some code pages.
#
# Manual run (debug):
#   powershell -NoProfile -ExecutionPolicy Bypass -File iroh-host.ps1 -Root "$env:USERPROFILE\.dsh\iroh-link" -Once
# Persistent: register a scheduled task, see docs/iroh-link.md
param(
  [string]$Root = "$env:USERPROFILE\.dsh\iroh-link",
  [string]$CredFile = "",
  [string]$Binary = "",
  [string]$ProcessName = "DeepSeek Harness",
  [int]$IntervalSec = 10,
  [switch]$Once
)

$ErrorActionPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $Root | Out-Null
if (-not $CredFile) { $CredFile = "$env:USERPROFILE\.dsh\.credentials.yaml" }
if (-not $Binary) { $Binary = Join-Path $Root 'dumbpipe.exe' }

$SecretFile = Join-Path $Root 'secret.hex'
$TicketFile = Join-Path $Root 'ticket.txt'
$StateFile  = Join-Path $Root 'state.json'
$LogFile    = Join-Path $Root 'host.log'
$PidFile    = Join-Path $Root 'host.pid'
$ErrFile    = Join-Path $Root 'dumbpipe.err.log'
$OutFile    = Join-Path $Root 'dumbpipe.out.log'

function Log($m) {
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 262144) { Clear-Content $LogFile }
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $LogFile
}

# Single instance: pid file + command line check, so a scheduled task cannot
# start a second supervisor.
if (-not $Once) {
  if (Test-Path $PidFile) {
    $old = (Get-Content $PidFile -Raw)
    if ($old -match '^\d+$') {
      $op = Get-CimInstance Win32_Process -Filter "ProcessId=$($old.Trim())"
      if ($op -and $op.CommandLine -and $op.CommandLine -match 'iroh-host\.ps1') { exit 0 }
    }
  }
  Set-Content -Path $PidFile -Value $PID -Encoding ASCII
}

Log "host supervisor started pid=$PID root=$Root cred=$CredFile"
if (-not (Test-Path $SecretFile)) {
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  $b = New-Object byte[] 32
  $rng.GetBytes($b)
  [IO.File]::WriteAllText($SecretFile, (($b | ForEach-Object { $_.ToString('x2') }) -join ''), [Text.Encoding]::ASCII)
  Log 'generated new iroh identity secret'
}
$env:IROH_SECRET = (Get-Content $SecretFile -Raw).Trim()

function Get-Token {
  if (-not (Test-Path $CredFile)) { return $null }
  $m = Select-String -Path $CredFile -Pattern 'DSH_INTERCONNECT_TOKEN:\s*(\S+)'
  if ($m) { return $m.Matches[0].Groups[1].Value } else { return $null }
}

# Real DSH webserver port: a listening port owned by a DSH process whose
# /interconnect/link answers HTTP 101 with the shared token.
function Find-DshPort {
  $tok = Get-Token
  if (-not $tok) { return 0 }
  $pids = @(Get-Process -Name $ProcessName | ForEach-Object { $_.Id })
  if ($pids.Count -eq 0) { return 0 }
  $ports = @(Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess } |
    Select-Object -ExpandProperty LocalPort -Unique)
  foreach ($prt in $ports) {
    $code = & curl.exe -s -o NUL -w '%{http_code}' -m 3 -H 'Upgrade: websocket' -H 'Connection: Upgrade' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H ('Authorization: Bearer ' + $tok) ('http://127.0.0.1:' + $prt + '/interconnect/link') 2>$null
    if ("$code" -eq '101') { return [int]$prt }
  }
  return 0
}

# The listener prints the FULL ticket (with direct addresses and relay URL) to
# stderr. The short id-only ticket from `generate-ticket` relies on address
# lookup and does NOT connect in our network, so persist the FULL one only.
# If the banner has not appeared yet, poll briefly; never write a short ticket
# over a good one (a stale full ticket still has the relay URL).
function Wait-TicketFromLog([int]$timeoutMs = 20000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if (Test-Path $ErrFile) {
      $m = [regex]::Match((Get-Content $ErrFile -Raw), 'connect-tcp\s+(endpoint\S+)')
      if ($m.Success -and $m.Groups[1].Value.Length -gt 100) {
        $full = $m.Groups[1].Value
        [IO.File]::WriteAllText($TicketFile, $full, [Text.Encoding]::ASCII)
        return $full
      }
    }
    Start-Sleep -Milliseconds 300
  }
  if (Test-Path $TicketFile) {
    Log 'warning: listener banner not seen yet; keeping previous ticket file'
    return (Get-Content $TicketFile -Raw).Trim()
  }
  Log 'error: no ticket available (listener banner missing and no previous ticket file)'
  return ''
}

$child = $null
$curPort = 0
$ticket = ''
while ($true) {
  $p = Find-DshPort
  $alive = $false
  if ($child) { $alive = -not $child.HasExited }
  if ($p -gt 0 -and ($p -ne $curPort -or -not $alive)) {
    if ($child -and -not $child.HasExited) { Stop-Process -Id $child.Id -Force }
    Start-Sleep -Milliseconds 500
    $child = Start-Process -FilePath $Binary -ArgumentList @('listen-tcp', '--host', ("127.0.0.1:" + $p)) -PassThru -WindowStyle Hidden -RedirectStandardError $ErrFile -RedirectStandardOutput $OutFile
    $curPort = $p
    $ticket = Wait-TicketFromLog
    Log "listen-tcp -> 127.0.0.1:$p pid=$($child.Id) ticket=$($ticket.Length)chars"
  } elseif ($p -le 0) {
    Log 'DSH interconnect port not found'
  }

  $state = @{
    port       = $curPort
    pid        = $(if ($child) { $child.Id } else { 0 })
    ticket     = $ticket
    ticketFile = $TicketFile
    ts         = (Get-Date).ToString('o')
    ok         = ($p -gt 0)
  }
  $state | ConvertTo-Json -Compress | Set-Content -Path $StateFile -Encoding ASCII

  if ($Once) { break }
  Start-Sleep -Seconds $IntervalSec
}
