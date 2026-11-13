using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Timers;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using System.Windows.Forms;

internal static class Program
{
    private const string ServiceName = "NexaDeskInputBroker";
    private const string ConfigPath = @"SOFTWARE\PapayasDS\NexaDesk\Input";
    private static readonly string ClientPathValue = "TrustedClientPath";
    private static readonly string AdminIdsValue = "AdminControllerIds";

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "--service")
            {
                ServiceBase.Run(new InputBrokerService());
                return 0;
            }
            if (args.Length == 3 && args[0] == "--agent")
            {
                int sessionId;
                if (!Int32.TryParse(args[1], out sessionId) || sessionId <= 0) return 2;
                return InputAgent.Run(sessionId, args[2]);
            }
            if (args.Length == 1 && args[0] == "--manage-admins")
            {
                AdminControllerForm.Run();
                return 0;
            }
            if (args.Length == 3 && args[0] == "--install-service")
            {
                Program.InstallService(args[1], args[2]);
                return 0;
            }
            if (args.Length == 1 && args[0] == "--uninstall-service")
            {
                Program.UninstallService();
                return 0;
            }
            Console.Error.WriteLine("Use --service, --agent <session> <sid>, --manage-admins, --install-service <broker-path> <client-path>, or --uninstall-service.");
            return 2;
        }
        catch (Exception ex)
        {
            BrokerLog.Write("fatal: " + ex.GetType().Name + ": " + ex.Message);
            return 1;
        }
    }

    internal static string PipeName(int sessionId) { return @"\\.\pipe\NexaDesk.Input." + sessionId; }

    internal static string GetTrustedClientPath()
    {
        using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (RegistryKey key = root.OpenSubKey(ConfigPath, false))
            return key == null ? null : key.GetValue(ClientPathValue) as string;
    }

    internal static string[] GetAdminControllerIds()
    {
        try
        {
            using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey key = root.OpenSubKey(ConfigPath, false))
                return key == null ? new string[0] : (key.GetValue(AdminIdsValue) as string[] ?? new string[0]);
        }
        catch { return new string[0]; }
    }

    internal static void EnsureConfigAcl()
    {
        using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (RegistryKey key = root.CreateSubKey(ConfigPath, RegistryKeyPermissionCheck.ReadWriteSubTree))
        {
            if (key == null) throw new InvalidOperationException("Could not create the machine input-broker settings key.");
            RegistrySecurity acl = new RegistrySecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new RegistryAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), RegistryRights.FullControl, AccessControlType.Allow));
            acl.AddAccessRule(new RegistryAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), RegistryRights.FullControl, AccessControlType.Allow));
            acl.AddAccessRule(new RegistryAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), RegistryRights.ReadKey, AccessControlType.Allow));
            key.SetAccessControl(acl);
        }
    }

    internal static void SaveAdminControllerIds(IEnumerable<string> values)
    {
        WindowsPrincipal principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
        if (!principal.IsInRole(WindowsBuiltInRole.Administrator))
            throw new UnauthorizedAccessException("Windows administrator approval is required to change NexaDesk admin controllers.");
        List<string> clean = new List<string>();
        foreach (string value in values)
        {
            string id = (value ?? "").Trim();
            if (!Regex.IsMatch(id, @"^\d{9}$")) throw new ArgumentException("Each controller ID must contain exactly 9 digits.");
            if (!clean.Contains(id)) clean.Add(id);
        }
        if (clean.Count > 100) throw new ArgumentException("A maximum of 100 admin controller IDs is allowed.");
        EnsureConfigAcl();
        using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (RegistryKey key = root.OpenSubKey(ConfigPath, true))
        {
            if (key == null) throw new InvalidOperationException("NexaDesk input service is not installed for all users.");
            if (String.IsNullOrWhiteSpace(key.GetValue(ClientPathValue) as string))
                throw new InvalidOperationException("Install NexaDesk for all users before managing admin controllers.");
            key.SetValue(AdminIdsValue, clean.ToArray(), RegistryValueKind.MultiString);
        }
    }

    internal static void InstallService(string brokerPath, string clientPath)
    {
        RequireWindowsAdministrator();
        string broker = Path.GetFullPath(brokerPath ?? "");
        string client = Path.GetFullPath(clientPath ?? "");
        string programFiles = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!broker.StartsWith(programFiles, StringComparison.OrdinalIgnoreCase) || !File.Exists(broker) ||
            !client.StartsWith(programFiles, StringComparison.OrdinalIgnoreCase) || !File.Exists(client))
            throw new InvalidOperationException("NexaDesk and its input broker must be installed under Program Files.");
        EnsureConfigAcl();
        using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
        using (RegistryKey key = root.OpenSubKey(ConfigPath, true))
        {
            if (key == null) throw new InvalidOperationException("Could not configure the NexaDesk input service.");
            key.SetValue(ClientPathValue, client, RegistryValueKind.String);
        }
        IntPtr manager = Native.OpenSCManager(null, null, Native.SC_MANAGER_CONNECT | Native.SC_MANAGER_CREATE_SERVICE);
        if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the Windows service manager.");
        IntPtr service = IntPtr.Zero;
        try
        {
            service = Native.OpenService(manager, ServiceName, Native.SERVICE_ALL_ACCESS);
            if (service != IntPtr.Zero)
            {
                StopService(service);
                if (!Native.ChangeServiceConfig(service, Native.SERVICE_WIN32_OWN_PROCESS, Native.SERVICE_AUTO_START, Native.SERVICE_ERROR_NORMAL,
                    "\"" + broker + "\" --service", null, IntPtr.Zero, null, "LocalSystem", null, "NexaDesk Elevated Input Broker"))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not update the NexaDesk service configuration.");
            }
            else
            {
                int error = Marshal.GetLastWin32Error();
                if (error != Native.ERROR_SERVICE_DOES_NOT_EXIST) throw new Win32Exception(error, "Could not open the NexaDesk service.");
                service = Native.CreateService(manager, ServiceName, "NexaDesk Elevated Input Broker", Native.SERVICE_ALL_ACCESS,
                    Native.SERVICE_WIN32_OWN_PROCESS, Native.SERVICE_AUTO_START, Native.SERVICE_ERROR_NORMAL,
                    "\"" + broker + "\" --service", null, IntPtr.Zero, null, "LocalSystem", null);
                if (service == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the NexaDesk service.");
            }
            if (!Native.StartService(service, 0, IntPtr.Zero))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != Native.ERROR_SERVICE_ALREADY_RUNNING) throw new Win32Exception(error, "Could not start the NexaDesk service.");
            }
            WaitForServiceState(service, Native.SERVICE_RUNNING, TimeSpan.FromSeconds(20));
        }
        finally
        {
            if (service != IntPtr.Zero) Native.CloseServiceHandle(service);
            Native.CloseServiceHandle(manager);
        }
    }

    internal static void UninstallService()
    {
        RequireWindowsAdministrator();
        IntPtr manager = Native.OpenSCManager(null, null, Native.SC_MANAGER_CONNECT);
        if (manager != IntPtr.Zero)
        {
            IntPtr service = Native.OpenService(manager, ServiceName, Native.SERVICE_ALL_ACCESS);
            if (service != IntPtr.Zero)
            {
                try
                {
                    StopService(service);
                    if (!Native.DeleteService(service))
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error != Native.ERROR_SERVICE_DOES_NOT_EXIST) throw new Win32Exception(error, "Could not remove the NexaDesk service.");
                    }
                }
                finally { Native.CloseServiceHandle(service); }
            }
            else if (Marshal.GetLastWin32Error() != Native.ERROR_SERVICE_DOES_NOT_EXIST)
            {
                int error = Marshal.GetLastWin32Error(); Native.CloseServiceHandle(manager);
                throw new Win32Exception(error, "Could not open the NexaDesk service for removal.");
            }
            Native.CloseServiceHandle(manager);
        }
        else if (Marshal.GetLastWin32Error() != Native.ERROR_SERVICE_DOES_NOT_EXIST)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open the Windows service manager for removal.");
        using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            root.DeleteSubKeyTree(ConfigPath, false);
    }

    private static void StopService(IntPtr service)
    {
        Native.SERVICE_STATUS status;
        if (!Native.QueryServiceStatus(service, out status)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query the NexaDesk service state.");
        if (status.currentState != Native.SERVICE_STOPPED && status.currentState != Native.SERVICE_STOP_PENDING)
            if (!Native.ControlService(service, Native.SERVICE_CONTROL_STOP, out status))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != Native.ERROR_SERVICE_NOT_ACTIVE) throw new Win32Exception(error, "Could not stop the NexaDesk service.");
            }
        WaitForServiceState(service, Native.SERVICE_STOPPED, TimeSpan.FromSeconds(20));
    }

    private static void WaitForServiceState(IntPtr service, uint expected, TimeSpan timeout)
    {
        DateTime until = DateTime.UtcNow + timeout;
        Native.SERVICE_STATUS status;
        do
        {
            if (!Native.QueryServiceStatus(service, out status)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not query the NexaDesk service state.");
            if (status.currentState == expected) return;
            Thread.Sleep(250);
        } while (DateTime.UtcNow < until);
        throw new System.TimeoutException("The NexaDesk service did not reach the expected state.");
    }

    private static void RequireWindowsAdministrator()
    {
        WindowsPrincipal principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
        if (!principal.IsInRole(WindowsBuiltInRole.Administrator))
            throw new UnauthorizedAccessException("Windows administrator approval is required for this NexaDesk service operation.");
    }

    internal static string ReadClientPath()
    {
        string path = GetTrustedClientPath();
        return String.IsNullOrWhiteSpace(path) ? null : Path.GetFullPath(path);
    }
}

internal sealed class InputBrokerService : ServiceBase
{
    private readonly Dictionary<int, Process> agents = new Dictionary<int, Process>();
    private System.Timers.Timer reconcileTimer;

    public InputBrokerService()
    {
        ServiceName = "NexaDeskInputBroker";
        CanStop = true;
        CanShutdown = true;
        CanHandleSessionChangeEvent = true;
        AutoLog = false;
    }

    protected override void OnStart(string[] args)
    {
        if (!WindowsIdentity.GetCurrent().User.IsWellKnown(WellKnownSidType.LocalSystemSid))
            throw new InvalidOperationException("The input broker must run as LocalSystem.");
        Program.EnsureConfigAcl();
        BrokerLog.Write("service started");
        ReconcileSessions();
        reconcileTimer = new System.Timers.Timer(10000);
        reconcileTimer.AutoReset = true;
        reconcileTimer.Elapsed += delegate { try { ReconcileSessions(); } catch (Exception ex) { BrokerLog.Write("session reconcile failed: " + ex.Message); } };
        reconcileTimer.Start();
    }

    protected override void OnSessionChange(SessionChangeDescription change)
    {
        try
        {
            switch (change.Reason)
            {
                case SessionChangeReason.SessionLogon:
                case SessionChangeReason.SessionUnlock:
                case SessionChangeReason.ConsoleConnect:
                case SessionChangeReason.RemoteConnect:
                    StartAgent(change.SessionId); break;
                case SessionChangeReason.SessionLogoff:
                case SessionChangeReason.SessionLock:
                case SessionChangeReason.ConsoleDisconnect:
                case SessionChangeReason.RemoteDisconnect:
                    StopAgent(change.SessionId); break;
            }
        }
        catch (Exception ex) { BrokerLog.Write("session change failed: " + ex.Message); }
    }

    protected override void OnStop()
    {
        if (reconcileTimer != null) { reconcileTimer.Stop(); reconcileTimer.Dispose(); reconcileTimer = null; }
        foreach (int id in new List<int>(agents.Keys)) StopAgent(id);
        BrokerLog.Write("service stopped");
    }

    protected override void OnShutdown() { OnStop(); }

    private void ReconcileSessions()
    {
        HashSet<int> active = new HashSet<int>();
        IntPtr info = IntPtr.Zero; int count = 0;
        if (!Native.WTSEnumerateSessions(IntPtr.Zero, 0, 1, out info, out count))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSEnumerateSessions failed");
        try
        {
            int size = Marshal.SizeOf(typeof(Native.WTS_SESSION_INFO));
            for (int i = 0; i < count; i++)
            {
                Native.WTS_SESSION_INFO row = (Native.WTS_SESSION_INFO)Marshal.PtrToStructure(IntPtr.Add(info, i * size), typeof(Native.WTS_SESSION_INFO));
                if (row.SessionId > 0 && row.State == Native.WTS_CONNECTSTATE_CLASS.WTSActive)
                {
                    active.Add(row.SessionId);
                    StartAgent(row.SessionId);
                }
            }
        }
        finally { Native.WTSFreeMemory(info); }
        foreach (int existing in new List<int>(agents.Keys)) if (!active.Contains(existing)) StopAgent(existing);
    }

    private void StartAgent(int sessionId)
    {
        if (sessionId <= 0 || String.IsNullOrWhiteSpace(Program.ReadClientPath())) return;
        Process old;
        if (agents.TryGetValue(sessionId, out old))
        {
            try { if (!old.HasExited) return; old.Dispose(); } catch { }
            agents.Remove(sessionId);
        }

        IntPtr userToken = IntPtr.Zero;
        try
        {
            if (!Native.WTSQueryUserToken((uint)sessionId, out userToken)) return;
            string userSid;
            using (WindowsIdentity identity = new WindowsIdentity(userToken)) userSid = identity.User.Value;
            if (String.IsNullOrWhiteSpace(userSid)) return;
            Process agent = LaunchSystemAgent(sessionId, userSid);
            if (agent != null)
            {
                agents[sessionId] = agent;
                BrokerLog.Write("started interactive input agent for session " + sessionId);
            }
        }
        catch (Exception ex) { BrokerLog.Write("could not start session " + sessionId + " agent: " + ex.Message); }
        finally { if (userToken != IntPtr.Zero) Native.CloseHandle(userToken); }
    }

    private static Process LaunchSystemAgent(int sessionId, string userSid)
    {
        IntPtr source = IntPtr.Zero, primary = IntPtr.Zero;
        Native.PROCESS_INFORMATION pi = new Native.PROCESS_INFORMATION();
        try
        {
            const uint tokenRights = Native.TOKEN_QUERY | Native.TOKEN_DUPLICATE | Native.TOKEN_ASSIGN_PRIMARY | Native.TOKEN_ADJUST_SESSIONID;
            if (!Native.OpenProcessToken(Process.GetCurrentProcess().Handle, tokenRights, out source))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenProcessToken failed");
            if (!Native.DuplicateTokenEx(source, Native.MAXIMUM_ALLOWED, IntPtr.Zero, Native.SECURITY_IMPERSONATION_LEVEL.SecurityImpersonation, Native.TOKEN_TYPE.TokenPrimary, out primary))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed");
            if (!Native.SetTokenInformation(primary, Native.TOKEN_INFORMATION_CLASS.TokenSessionId, ref sessionId, sizeof(int)))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "SetTokenInformation failed");

            string exe = Process.GetCurrentProcess().MainModule.FileName;
            StringBuilder command = new StringBuilder("\"" + exe + "\" --agent " + sessionId + " " + userSid);
            Native.STARTUPINFO startup = new Native.STARTUPINFO(); startup.cb = Marshal.SizeOf(typeof(Native.STARTUPINFO)); startup.lpDesktop = @"winsta0\default";
            const uint flags = Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_NO_WINDOW;
            if (!Native.CreateProcessAsUser(primary, exe, command, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, Path.GetDirectoryName(exe), ref startup, out pi))
                throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser failed");
            return Process.GetProcessById((int)pi.dwProcessId);
        }
        finally
        {
            if (pi.hThread != IntPtr.Zero) Native.CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) Native.CloseHandle(pi.hProcess);
            if (primary != IntPtr.Zero) Native.CloseHandle(primary);
            if (source != IntPtr.Zero) Native.CloseHandle(source);
        }
    }

    private void StopAgent(int sessionId)
    {
        Process process;
        if (!agents.TryGetValue(sessionId, out process)) return;
        agents.Remove(sessionId);
        try { if (!process.HasExited) process.Kill(); } catch { }
        try { process.Dispose(); } catch { }
    }
}

internal static class InputAgent
{
    private const int ErrorPipeConnected = 535;
    private static readonly Regex InputCommand = new Regex(@"^(M \d{1,5} \d{1,5}|[DU] [lrm]|W -?\d{1,4}|K \d{1,3} [01] [01]|T \d{1,5}|R -?\d{1,4} -?\d{1,4})$", RegexOptions.Compiled);

    internal static int Run(int sessionId, string userSid)
    {
        try
        {
            WindowsIdentity current = WindowsIdentity.GetCurrent();
            if (!current.User.IsWellKnown(WellKnownSidType.LocalSystemSid)) return 3;
            int processSession;
            if (!Native.ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out processSession) || processSession != sessionId) return 4;
            string expectedClient = Program.ReadClientPath();
            if (String.IsNullOrWhiteSpace(expectedClient) || !Regex.IsMatch(userSid, @"^S-1-(?:\d+-)+\d+$")) return 5;
            RunPipeLoop(sessionId, userSid, expectedClient);
            return 0;
        }
        catch (Exception ex) { BrokerLog.Write("interactive agent stopped: " + ex.GetType().Name + ": " + ex.Message); return 1; }
    }

    private static void RunPipeLoop(int sessionId, string userSid, string expectedClient)
    {
        while (true)
        {
            IntPtr securityDescriptor = IntPtr.Zero, pipe = IntPtr.Zero;
            try
            {
                string sddl = "D:P(A;;GA;;;SY)(A;;GRGW;;;" + userSid + ")S:(ML;;NW;;;LW)";
                if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, 1, out securityDescriptor, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "could not build the input-pipe access rule");
                Native.SECURITY_ATTRIBUTES attributes = new Native.SECURITY_ATTRIBUTES();
                attributes.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)); attributes.lpSecurityDescriptor = securityDescriptor;
                pipe = Native.CreateNamedPipe(Program.PipeName(sessionId), Native.PIPE_ACCESS_DUPLEX,
                    Native.PIPE_TYPE_BYTE | Native.PIPE_READMODE_BYTE | Native.PIPE_WAIT | Native.PIPE_REJECT_REMOTE_CLIENTS,
                    1, 4096, 4096, 0, ref attributes);
                if (pipe == Native.INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateNamedPipe failed");
                bool connected = Native.ConnectNamedPipe(pipe, IntPtr.Zero);
                if (!connected && Marshal.GetLastWin32Error() != ErrorPipeConnected) continue;
                if (!IsTrustedClient(pipe, sessionId, userSid, expectedClient)) continue;
                HandleClient(pipe, sessionId);
            }
            finally
            {
                if (pipe != IntPtr.Zero && pipe != Native.INVALID_HANDLE_VALUE)
                {
                    try { Native.DisconnectNamedPipe(pipe); } catch { }
                    Native.CloseHandle(pipe);
                }
                if (securityDescriptor != IntPtr.Zero) Native.LocalFree(securityDescriptor);
            }
        }
    }

    private static bool IsTrustedClient(IntPtr pipe, int sessionId, string userSid, string expectedClient)
    {
        uint pid; int clientSession;
        if (!Native.GetNamedPipeClientProcessId(pipe, out pid) || !Native.ProcessIdToSessionId(pid, out clientSession) || clientSession != sessionId) return false;
        IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero) return false;
        try
        {
            StringBuilder image = new StringBuilder(32768); int capacity = image.Capacity;
            if (!Native.QueryFullProcessImageName(process, 0, image, ref capacity)) return false;
            if (!String.Equals(Path.GetFullPath(image.ToString()), expectedClient, StringComparison.OrdinalIgnoreCase)) return false;
            IntPtr token;
            if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY, out token)) return false;
            try { using (WindowsIdentity identity = new WindowsIdentity(token)) return identity.User != null && identity.User.Value == userSid; }
            finally { Native.CloseHandle(token); }
        }
        finally { Native.CloseHandle(process); }
    }

    private static void HandleClient(IntPtr pipe, int sessionId)
    {
        HashSet<string> heldKeys = new HashSet<string>();
        HashSet<string> heldButtons = new HashSet<string>();
        try
        {
            using (SafeFileHandle safe = new SafeFileHandle(pipe, false))
            using (FileStream stream = new FileStream(safe, FileAccess.ReadWrite, 4096, false))
            using (StreamReader reader = new StreamReader(stream, Encoding.UTF8, false, 1024, true))
            using (StreamWriter writer = new StreamWriter(stream, new UTF8Encoding(false), 1024, true))
            {
                string start = reader.ReadLine();
                if (start == null || !Regex.IsMatch(start, @"^C \d{9}$")) return;
                string controllerId = start.Substring(2);
                if (!IsAdminController(controllerId)) { writer.WriteLine("STANDARD"); writer.Flush(); return; }
                writer.WriteLine("ADMIN"); writer.Flush();
                string line;
                DateTime lastAccessCheck = DateTime.UtcNow;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.Length > 80 || !InputCommand.IsMatch(line)) continue;
                    if ((DateTime.UtcNow - lastAccessCheck).TotalSeconds >= 1)
                    {
                        lastAccessCheck = DateTime.UtcNow;
                        if (!IsAdminController(controllerId)) { writer.WriteLine("REVOKED"); writer.Flush(); return; }
                    }
                    Send(line, heldKeys, heldButtons);
                }
            }
        }
        finally { ReleaseHeld(sessionId, heldKeys, heldButtons); }
    }

    private static bool IsAdminController(string id)
    {
        foreach (string entry in Program.GetAdminControllerIds()) if (String.Equals(entry, id, StringComparison.Ordinal)) return true;
        return false;
    }

    private static void Send(string command, HashSet<string> heldKeys, HashSet<string> heldButtons)
    {
        string[] p = command.Split(' ');
        switch (p[0])
        {
            case "M": SendMouse(0x8001, Int32.Parse(p[1]), Int32.Parse(p[2]), 0); break;
            case "R": SendMouse(0x0001, Int32.Parse(p[1]), Int32.Parse(p[2]), 0); break;
            case "D": SendMouse(ButtonFlag(p[1], true), 0, 0, 0); heldButtons.Add(p[1]); break;
            case "U": SendMouse(ButtonFlag(p[1], false), 0, 0, 0); heldButtons.Remove(p[1]); break;
            case "W": SendMouse(0x0800, 0, 0, unchecked((uint)Int32.Parse(p[1]))); break;
            case "K":
                uint flags = p[2] == "0" ? 0x0002u : 0u;
                if (p[3] == "1") flags |= 0x0001u;
                ushort vk = (ushort)Int32.Parse(p[1]);
                SendKey(vk, 0, flags);
                string keyId = vk + " " + p[3];
                if (p[2] == "1") heldKeys.Add(keyId); else heldKeys.Remove(keyId);
                break;
            case "T":
                ushort ch = (ushort)Int32.Parse(p[1]);
                SendKey(0, ch, 0x0004u); SendKey(0, ch, 0x0006u); break;
        }
    }

    private static void ReleaseHeld(int sessionId, HashSet<string> heldKeys, HashSet<string> heldButtons)
    {
        foreach (string key in heldKeys)
        {
            try { string[] p = key.Split(' '); SendKey((ushort)Int32.Parse(p[0]), 0, 0x0002u | (p[1] == "1" ? 0x0001u : 0u)); }
            catch { }
        }
        foreach (string button in heldButtons)
        {
            try { SendMouse(ButtonFlag(button, false), 0, 0, 0); }
            catch { }
        }
        if (heldKeys.Count > 0 || heldButtons.Count > 0) BrokerLog.Write("released held input after controller disconnect in session " + sessionId);
    }

    private static uint ButtonFlag(string name, bool down)
    {
        if (name == "l") return down ? 0x0002u : 0x0004u;
        if (name == "r") return down ? 0x0008u : 0x0010u;
        return down ? 0x0020u : 0x0040u;
    }

    private static void SendMouse(uint flags, int x, int y, uint data)
    {
        Native.INPUT input = new Native.INPUT(); input.type = 0;
        input.u.mi = new Native.MOUSEINPUT(); input.u.mi.dx = x; input.u.mi.dy = y; input.u.mi.mouseData = data; input.u.mi.dwFlags = flags;
        SendInput(input);
    }

    private static void SendKey(ushort vk, ushort scan, uint flags)
    {
        Native.INPUT input = new Native.INPUT(); input.type = 1;
        input.u.ki = new Native.KEYBDINPUT(); input.u.ki.wVk = vk; input.u.ki.wScan = scan; input.u.ki.dwFlags = flags;
        SendInput(input);
    }

    private static void SendInput(Native.INPUT input)
    {
        if (Native.SendInput(1, new Native.INPUT[] { input }, Marshal.SizeOf(typeof(Native.INPUT))) != 1)
            BrokerLog.Write("SendInput rejected an admin-controller event in session " + Process.GetCurrentProcess().SessionId);
    }
}

internal static class AdminControllerForm
{
    internal static void Run()
    {
        WindowsPrincipal principal = new WindowsPrincipal(WindowsIdentity.GetCurrent());
        if (!principal.IsInRole(WindowsBuiltInRole.Administrator))
        {
            MessageBox.Show("Open this settings window with Windows administrator approval.", "NexaDesk admin controllers", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        if (String.IsNullOrWhiteSpace(Program.ReadClientPath()))
        {
            MessageBox.Show("The elevated input service is not installed. Run the NexaDesk Setup installer to install the all-users service.", "NexaDesk admin controllers", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        Application.EnableVisualStyles();
        Form form = new Form(); form.Text = "NexaDesk admin controllers"; form.Width = 460; form.Height = 430; form.StartPosition = FormStartPosition.CenterScreen;
        Label info = new Label(); info.Left = 18; info.Top = 14; info.Width = 405; info.Height = 62;
        info.Text = "Only these NexaDesk device IDs can control windows that are already running with elevated Windows rights. Other controllers keep normal-user input. This does not approve UAC prompts or make a Windows account an administrator.";
        ListBox list = new ListBox(); list.Left = 18; list.Top = 84; list.Width = 405; list.Height = 210;
        foreach (string id in Program.GetAdminControllerIds()) list.Items.Add(id);
        TextBox entry = new TextBox(); entry.Left = 18; entry.Top = 306; entry.Width = 190; entry.MaxLength = 9;
        Button add = new Button(); add.Left = 220; add.Top = 304; add.Width = 95; add.Text = "Add ID";
        Button remove = new Button(); remove.Left = 325; remove.Top = 304; remove.Width = 98; remove.Text = "Remove";
        Label status = new Label(); status.Left = 18; status.Top = 340; status.Width = 405; status.Height = 22;
        Button close = new Button(); close.Left = 323; close.Top = 362; close.Width = 100; close.Text = "Close"; close.DialogResult = DialogResult.Cancel;
        add.Click += delegate {
            string id = entry.Text.Trim();
            if (!Regex.IsMatch(id, @"^\d{9}$")) { status.Text = "Enter exactly 9 digits."; return; }
            if (!list.Items.Contains(id)) list.Items.Add(id);
            try { Program.SaveAdminControllerIds(ToIds(list)); status.Text = "Saved."; entry.Clear(); }
            catch (Exception ex) { status.Text = ex.Message; }
        };
        remove.Click += delegate {
            if (list.SelectedItem == null) { status.Text = "Select an ID to remove."; return; }
            list.Items.Remove(list.SelectedItem);
            try { Program.SaveAdminControllerIds(ToIds(list)); status.Text = "Saved."; }
            catch (Exception ex) { status.Text = ex.Message; }
        };
        close.Click += delegate { form.Close(); };
        form.Controls.AddRange(new Control[] { info, list, entry, add, remove, status, close }); form.AcceptButton = add; form.CancelButton = close;
        Application.Run(form);
    }

    private static string[] ToIds(ListBox list)
    {
        string[] result = new string[list.Items.Count];
        for (int i = 0; i < result.Length; i++) result[i] = list.Items[i].ToString();
        return result;
    }
}

internal static class BrokerLog
{
    private static readonly object Gate = new object();
    internal static void Write(string message)
    {
        try
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "NexaDesk", "logs");
            Directory.CreateDirectory(dir);
            string file = Path.Combine(dir, "input-broker.log");
            lock (Gate)
            {
                if (File.Exists(file) && new FileInfo(file).Length > 1024 * 1024) File.Delete(file);
                File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine, Encoding.UTF8);
            }
        }
        catch { }
    }
}

internal static class Native
{
    internal static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
    internal const uint TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_DUPLICATE = 0x0002, TOKEN_QUERY = 0x0008, TOKEN_ADJUST_SESSIONID = 0x0100, MAXIMUM_ALLOWED = 0x02000000;
    internal const uint SC_MANAGER_CONNECT = 0x0001, SC_MANAGER_CREATE_SERVICE = 0x0002, SERVICE_ALL_ACCESS = 0xF01FF;
    internal const uint SERVICE_WIN32_OWN_PROCESS = 0x00000010, SERVICE_AUTO_START = 0x00000002, SERVICE_ERROR_NORMAL = 0x00000001;
    internal const uint SERVICE_CONTROL_STOP = 0x00000001, SERVICE_STOPPED = 0x00000001, SERVICE_STOP_PENDING = 0x00000003, SERVICE_RUNNING = 0x00000004;
    internal const int ERROR_SERVICE_NOT_ACTIVE = 1062, ERROR_SERVICE_DOES_NOT_EXIST = 1060, ERROR_SERVICE_ALREADY_RUNNING = 1056;
    internal const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400, CREATE_NO_WINDOW = 0x08000000;
    internal const uint PIPE_ACCESS_DUPLEX = 0x00000003, PIPE_TYPE_BYTE = 0, PIPE_READMODE_BYTE = 0, PIPE_WAIT = 0, PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;

    internal enum TOKEN_TYPE { TokenPrimary = 1, TokenImpersonation = 2 }
    internal enum SECURITY_IMPERSONATION_LEVEL { SecurityAnonymous, SecurityIdentification, SecurityImpersonation, SecurityDelegation }
    internal enum TOKEN_INFORMATION_CLASS { TokenSessionId = 12 }
    internal enum WTS_CONNECTSTATE_CLASS { WTSActive, WTSConnected, WTSConnectQuery, WTSShadow, WTSDisconnected, WTSIdle, WTSListen, WTSReset, WTSDown, WTSInit }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct WTS_SESSION_INFO { public int SessionId; public IntPtr pWinStationName; public WTS_CONNECTSTATE_CLASS State; }
    [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)] internal struct SERVICE_STATUS { public uint serviceType, currentState, controlsAccepted, win32ExitCode, serviceSpecificExitCode, checkPoint, waitHint; }
    [StructLayout(LayoutKind.Sequential)] internal struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] internal struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)] internal struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] internal struct INPUT { public uint type; public INPUTUNION u; }

    [DllImport("wtsapi32.dll", SetLastError = true)] internal static extern bool WTSEnumerateSessions(IntPtr hServer, int reserved, int version, out IntPtr ppSessionInfo, out int count);
    [DllImport("wtsapi32.dll")] internal static extern void WTSFreeMemory(IntPtr memory);
    [DllImport("wtsapi32.dll", SetLastError = true)] internal static extern bool WTSQueryUserToken(uint sessionId, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool DuplicateTokenEx(IntPtr existing, uint access, IntPtr attributes, SECURITY_IMPERSONATION_LEVEL level, TOKEN_TYPE type, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool SetTokenInformation(IntPtr token, TOKEN_INFORMATION_CLASS infoClass, ref int info, int length);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION processInfo);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool ProcessIdToSessionId(uint processId, out int sessionId);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern IntPtr CreateNamedPipe(string name, uint openMode, uint pipeMode, uint maxInstances, uint outBuffer, uint inBuffer, uint timeout, ref SECURITY_ATTRIBUTES attributes);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool ConnectNamedPipe(IntPtr pipe, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool DisconnectNamedPipe(IntPtr pipe);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint clientProcessId);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("kernel32.dll")] internal static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("user32.dll", SetLastError = true)] internal static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr OpenSCManager(string machine, string database, uint desiredAccess);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr OpenService(IntPtr manager, string serviceName, uint desiredAccess);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateService(IntPtr manager, string serviceName, string displayName, uint desiredAccess, uint serviceType, uint startType, uint errorControl, string binaryPath, string loadOrderGroup, IntPtr tagId, string dependencies, string serviceStartName, string password);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool ChangeServiceConfig(IntPtr service, uint serviceType, uint startType, uint errorControl, string binaryPath, string loadOrderGroup, IntPtr tagId, string dependencies, string serviceStartName, string password, string displayName);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool StartService(IntPtr service, int argumentCount, IntPtr arguments);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool QueryServiceStatus(IntPtr service, out SERVICE_STATUS status);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool ControlService(IntPtr service, uint control, out SERVICE_STATUS status);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool DeleteService(IntPtr service);
    [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool CloseServiceHandle(IntPtr handle);
}
