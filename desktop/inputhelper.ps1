try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'AboveNormal' } catch { }   # stay responsive while the PC is busy encoding the screen
# NexaDesk input helper: reads whitelisted commands from stdin and injects mouse/keyboard events.
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
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
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
