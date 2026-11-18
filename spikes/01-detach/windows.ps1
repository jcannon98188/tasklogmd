param(
  [Parameter(Mandatory)][ValidateSet('watch','close','list')][string]$Mode,
  [string]$OutFile,
  [string]$Title,
  [string]$Exclude,
  [int]$Seconds = 120
)
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static List<string> Snapshot(bool visibleOnly) {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (visibleOnly && !IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      r.Add(h.ToInt64() + "|" + pid + "|" + c + "|" + t);
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
"@

if ($Mode -eq 'list') {
  Write-Output (([W]::Snapshot($true) | ForEach-Object { $_.Split('|')[0] }) -join ',')
} elseif ($Mode -eq 'watch') {
  # Log every visible top-level window that appears after the baseline snapshot.
  $seen = @{}
  foreach ($s in [W]::Snapshot($true)) { $seen[$s.Split('|')[0]] = $true }
  Set-Content -Path $OutFile -Value "READY" -Encoding utf8
  $end = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $end) {
    foreach ($s in [W]::Snapshot($true)) {
      $p = $s.Split('|')
      if (-not $seen.ContainsKey($p[0])) {
        $seen[$p[0]] = $true
        $name = (Get-Process -Id ([int]$p[1]) -ErrorAction SilentlyContinue).ProcessName
        Add-Content -Path $OutFile -Value ("NEW|" + (Get-Date).ToString('o') + "|" + $s + "|" + $name) -Encoding utf8
      }
    }
    Start-Sleep -Milliseconds 40
  }
} else {
  # Close the window whose title matches, exactly as the X button does (WM_CLOSE).
  # With -Exclude (hwnds that existed before the launch), close any new visible terminal window instead.
  $hit = $false
  $ex = @{}
  foreach ($h in ($Exclude -split ',')) { if ($h) { $ex[$h] = $true } }
  foreach ($s in [W]::Snapshot($true)) {
    $p = $s.Split('|')
    $byTitle = ($Title -and $p.Length -ge 4 -and $p[3] -like "*$Title*")
    $byNew = ($Exclude -and -not $ex.ContainsKey($p[0]) -and $p[2] -match 'CASCADIA_HOSTING_WINDOW_CLASS|ConsoleWindowClass')
    if ($byTitle -or $byNew) {
      [void][W]::PostMessage([IntPtr][int64]$p[0], 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
      $hit = $true
      Write-Output ("closed " + $s)
    }
  }
  if (-not $hit) { Write-Output "no-window-found" }
}
