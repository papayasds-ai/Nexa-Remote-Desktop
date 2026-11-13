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
  private static DateTime _lastReport = DateTime.MinValue;
  private static readonly object _reportLock = new object();
  public static bool Mouse(uint flags, int dx, int dy, uint data) {
    IN[] a = new IN[1]; a[0].type = 0; a[0].u.mi.dx = dx; a[0].u.mi.dy = dy; a[0].u.mi.data = data; a[0].u.mi.flags = flags;
    return SendInput(1, a, Marshal.SizeOf(typeof(IN))) == 1;
  }
  public static bool Key(byte vk, uint flags) {
    IN[] a = new IN[1]; a[0].type = 1; a[0].u.ki.vk = vk; a[0].u.ki.flags = flags;
    return SendInput(1, a, Marshal.SizeOf(typeof(IN))) == 1;
  }
  public static void Unicode(ushort ch) {
    IN[] a = new IN[2];
    a[0].type = 1; a[0].u.ki.scan = ch; a[0].u.ki.flags = 4;
    a[1].type = 1; a[1].u.ki.scan = ch; a[1].u.ki.flags = 6;
    if (SendInput(2, a, Marshal.SizeOf(typeof(IN))) != 2) throw new InvalidOperationException("Unicode input was rejected");
  }
  public static bool ShouldReportFailure() {
    lock (_reportLock) {
      if (DateTime.UtcNow - _lastReport < TimeSpan.FromSeconds(2)) return false;
      _lastReport = DateTime.UtcNow; return true;
    }
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
      'M' { if (-not [NX]::Mouse(0x8001, [int]$p[1], [int]$p[2], 0) -and [NX]::ShouldReportFailure()) { [Console]::Error.WriteLine('NX_INPUT_REJECTED|mouse move') } }
      'D' { if (-not [NX]::Mouse($btn[$p[1]][0], 0, 0, 0) -and [NX]::ShouldReportFailure()) { [Console]::Error.WriteLine('NX_INPUT_REJECTED|mouse button down') } }
      'U' { if (-not [NX]::Mouse($btn[$p[1]][1], 0, 0, 0) -and [NX]::ShouldReportFailure()) { [Console]::Error.WriteLine('NX_INPUT_REJECTED|mouse button up') } }
      'W' { if (-not [NX]::Mouse(0x800, 0, 0, [uint32]([int]$p[1])) -and [NX]::ShouldReportFailure()) { [Console]::Error.WriteLine('NX_INPUT_REJECTED|mouse wheel') } }
      'K' { $f = 0; if ($p[2] -eq '0') { $f = 2 }; if ($p[3] -eq '1') { $f = $f -bor 1 }; if (-not [NX]::Key([byte][int]$p[1], $f) -and [NX]::ShouldReportFailure()) { [Console]::Error.WriteLine('NX_INPUT_REJECTED|keyboard') } }
      'T' { [NX]::Unicode([uint16][int]$p[1]) }
      'R' { if (-not [NX]::Mouse(0x0001, [int]$p[1], [int]$p[2], 0) -and [NX]::ShouldReportFailure()) { [Console]::Error.WriteLine('NX_INPUT_REJECTED|relative mouse move') } }   # relative move (trackpad mode)
    }
  } catch { if ([NX]::ShouldReportFailure()) { [Console]::Error.WriteLine('NX_INPUT_ERROR|' + $_.Exception.GetType().Name) } }
}
