# NexaDesk input helper: reads whitelisted commands and injects mouse/keyboard events.
# Normal mode: commands come from stdin. Admin mode (-Dir <NexaDesk data folder>): started elevated by a scheduled task, connects to the app on 127.0.0.1.
param([string]$Dir = '')
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class NX {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, IN[] i, int size);
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct IU { [FieldOffset(0)] public MI mi; [FieldOffset(0)] public KI ki; }
  [StructLayout(LayoutKind.Sequential)] public struct IN { public uint type; public IU u; }
  public static void Unicode(ushort ch) {
    IN[] a = new IN[2];
    a[0].type = 1; a[0].u.ki.scan = ch; a[0].u.ki.flags = 4;
    a[1].type = 1; a[1].u.ki.scan = ch; a[1].u.ki.flags = 6;
    SendInput(2, a, Marshal.SizeOf(typeof(IN)));
  }
}
"@
$btn = @{ l = @(2, 4); r = @(8, 16); m = @(32, 64) }
$rx = [IO.TextReader]::Null
if ($Dir) {
  try {
    $port = [int](Get-Content -LiteralPath (Join-Path $Dir 'helper.port') -Raw).Trim()
    $tok = (Get-Content -LiteralPath (Join-Path $Dir 'helper.token') -Raw).Trim()
    $cl = New-Object Net.Sockets.TcpClient('127.0.0.1', $port)
    $st = $cl.GetStream(); $wr = New-Object IO.StreamWriter($st); $wr.NewLine = "`n"; $wr.WriteLine($tok); $wr.Flush()
    $rx = New-Object IO.StreamReader($st)
  } catch { exit 1 }
} else { $rx = [Console]::In }
$ok = '^(M \d{1,5} \d{1,5}|[DU] [lrm]|W -?\d{1,4}|K \d{1,3} [01] [01]|T \d{1,5}|R -?\d{1,4} -?\d{1,4})$'
while ($true) {
  $line = $rx.ReadLine()
  if ($null -eq $line) { break }
  if ($line -notmatch $ok) { continue }
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'M' { [NX]::mouse_event(0x8001, [int]$p[1], [int]$p[2], 0, [UIntPtr]::Zero) }
      'D' { [NX]::mouse_event($btn[$p[1]][0], 0, 0, 0, [UIntPtr]::Zero) }
      'U' { [NX]::mouse_event($btn[$p[1]][1], 0, 0, 0, [UIntPtr]::Zero) }
      'W' { [NX]::mouse_event(0x800, 0, 0, [int]$p[1], [UIntPtr]::Zero) }
      'K' { $f = 0; if ($p[2] -eq '0') { $f = 2 }; if ($p[3] -eq '1') { $f = $f -bor 1 }; [NX]::keybd_event([byte][int]$p[1], 0, $f, [UIntPtr]::Zero) }
      'T' { [NX]::Unicode([uint16][int]$p[1]) }
      'R' { [NX]::mouse_event(0x0001, [int]$p[1], [int]$p[2], 0, [UIntPtr]::Zero) }   # relative move (trackpad mode)
    }
  } catch { }
}
