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
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint type);
  [DllImport("user32.dll")] public static extern short GetKeyState(int vk);
  // real key press WITH scan code (console windows such as cmd / PowerShell / Windows Terminal need it; keybd_event without a scan code is ignored by them)
  public static void Key(byte vk, uint f) {
    IN[] a = new IN[1];
    a[0].type = 1; a[0].u.ki.vk = vk; a[0].u.ki.scan = (ushort)MapVirtualKey(vk, 0); a[0].u.ki.flags = f;
    SendInput(1, a, Marshal.SizeOf(typeof(IN)));
  }
  // typed character: as a normal key press when the keyboard layout has it (works everywhere), otherwise as a Unicode character
  public static void Char(ushort ch) {
    short r = VkKeyScan((char)ch);
    int sh = (r >> 8) & 0xFF;
    bool caps = (GetKeyState(0x14) & 1) != 0;
    if (r == -1 || ch < 32 || (sh & ~1) != 0 || (caps && char.IsLetter((char)ch))) { Unicode(ch); return; }
    byte vk = (byte)(r & 0xFF);
    if (sh == 1) Key(0x10, 0);
    Key(vk, 0); Key(vk, 2);
    if (sh == 1) Key(0x10, 2);
  }
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
      'K' { $f = 0; if ($p[2] -eq '0') { $f = 2 }; if ($p[3] -eq '1') { $f = $f -bor 1 }; [NX]::Key([byte][int]$p[1], [uint32]$f) }
      'T' { [NX]::Char([uint16][int]$p[1]) }
      'R' { [NX]::mouse_event(0x0001, [int]$p[1], [int]$p[2], 0, [UIntPtr]::Zero) }   # relative move (trackpad mode)
    }
  } catch { }
}
