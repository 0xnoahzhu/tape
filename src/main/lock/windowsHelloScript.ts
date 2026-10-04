// Windows Hello helper, run by the in-box Windows PowerShell 5.1. PowerShell is only used as a
// host for the in-box .NET Framework C# compiler: the script compiles the C# below in memory and
// hands stdin/stdout to it. No cmdlets are used (no module autoloading, no PSModulePath lookups).
//
// The C# calls Windows.Security.Credentials.UI.UserConsentVerifier through raw COM vtables, without
// the WinRT projection:
//   * RequestVerificationForWindowAsync on IUserConsentVerifierInterop, the desktop-app entry point
//     that parents the Windows Security dialog to a window we own
//     https://learn.microsoft.com/en-us/windows/win32/api/userconsentverifierinterop/nf-userconsentverifierinterop-iuserconsentverifierinterop-requestverificationforwindowasync
//     (IID and vtable order from userconsentverifierinterop.h in the Windows SDK; the header guards
//     it with NTDDI_WIN10_RS3).
//     Its documented minimum client is Windows build 22000, so the availability check also
//     activates it: where it is missing, Windows Hello is reported unsupported up front.
//   * CheckAvailabilityAsync on IUserConsentVerifierStatics
//     https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier.checkavailabilityasync
//   * IAsyncInfo / IAsyncOperation<T> (asyncinfo.idl, windows.foundation.idl)
//     https://learn.microsoft.com/en-us/windows/win32/api/asyncinfo/nn-asyncinfo-iasyncinfo
//     https://learn.microsoft.com/en-us/uwp/api/windows.foundation.iasyncoperation-1
//   * Enum values: https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverificationresult
//     and .../windows.security.credentials.ui.userconsentverifieravailability
// The IIDs of the two IAsyncOperation<enum> instances are WinRT parameterized IIDs; windowsHello.test.ts
// recomputes them from their signatures.
//
// Protocol (one ASCII line per message, space separated, "\n" terminated):
//   parent -> helper   check <id>
//                      verify <id> <hwnd as unsigned decimal> <message as base64 of UTF-8>
//                      cancel <id>
//                      (stdin EOF: cancel an open prompt, then exit)
//   helper -> parent   ready <os version> <pointer bits>          once, after compiling
//                      check <id> <UserConsentVerifierAvailability name>
//                      verify <id> <UserConsentVerificationResult name>
//                      busy <id>                                 a verification is already open
//                      error <id> <HRESULT as 0xXXXXXXXX> <where>
//                      fatal compile <error number> line <n>     then exit code 4
// Exit codes: 0 after stdin EOF, 3 PowerShell is not in FullLanguage mode (AppLocker / WDAC),
// 4 compile error, 1 anything else.

/** Last line of the script sent over stdin. */
export const HELPER_END = '#tape-hello-end';

/**
 * The -Command argument. It reads the script from stdin up to HELPER_END and runs it, so the
 * command line stays short and plain (no -EncodedCommand, no -ExecutionPolicy). Single quotes only:
 * the argument goes through CreateProcess quoting without a shell. Execution policy does not apply
 * to -Command, but Constrained Language Mode (AppLocker / WDAC script enforcement) does: exit 3.
 */
export const HELPER_BOOTSTRAP =
  "if($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage'){exit 3};" +
  '$i=[Console]::In;$b=[Text.StringBuilder]::new();' +
  `for(;;){$l=$i.ReadLine();if($null -eq $l -or $l -eq '${HELPER_END}'){break};[void]$b.AppendLine($l)};` +
  '&([ScriptBlock]::Create($b.ToString()))';

/**
 * powershell.exe arguments. `-InputFormat None` matters: with redirected stdin the console host
 * otherwise reads stdin itself (as pipeline input for the command) concurrently with the bootstrap
 * and the C#, and lines would go to whichever reader gets them first.
 */
export const HELPER_ARGS: readonly string[] = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-InputFormat',
  'None',
  '-Command',
  HELPER_BOOTSTRAP,
];

/** C# 5 (the in-box csc of .NET Framework 4.x). Only mscorlib, combase.dll and user32.dll. */
const HELPER_CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TapeHello
{
    public sealed class HResultException : Exception
    {
        public readonly int Code;
        public readonly string Where;
        public HResultException(int code, string where) : base(where) { Code = code; Where = where; }
    }

    public static class Host
    {
        const string ClassId = "Windows.Security.Credentials.UI.UserConsentVerifier";
        // userconsentverifierinterop.h, MIDL_INTERFACE("39E050C3-4E74-441A-8DC0-B81104DF949C")
        static readonly Guid IidInterop = new Guid("39E050C3-4E74-441A-8DC0-B81104DF949C");
        // Windows.Security.Credentials.UI.IUserConsentVerifierStatics
        static readonly Guid IidStatics = new Guid("AF4F3F91-564C-4DDC-B8B5-973447627C65");
        // Windows.Foundation.IAsyncInfo
        static readonly Guid IidAsyncInfo = new Guid("00000036-0000-0000-C000-000000000046");
        // IAsyncOperation<UserConsentVerificationResult>: pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};enum(Windows.Security.Credentials.UI.UserConsentVerificationResult;i4))
        static readonly Guid IidOpResult = new Guid("FD596FFD-2318-558F-9DBE-D21DF43764A5");
        // IAsyncOperation<UserConsentVerifierAvailability>: pinterface({9fc2b0bb-e446-44e2-aa61-9cab8f636af2};enum(Windows.Security.Credentials.UI.UserConsentVerifierAvailability;i4))
        static readonly Guid IidOpAvailability = new Guid("DDD384F3-D818-5D83-AB4B-32119C28587C");

        // Vtable slots: IUnknown 0-2, IInspectable 3-5, then the interface's own methods.
        const int SlotRequestForWindow = 6;  // IUserConsentVerifierInterop.RequestVerificationForWindowAsync
        const int SlotCheckAvailability = 6; // IUserConsentVerifierStatics.CheckAvailabilityAsync
        const int SlotStatus = 7;            // IAsyncInfo: get_Id 6, get_Status 7, get_ErrorCode 8, Cancel 9, Close 10
        const int SlotErrorCode = 8;
        const int SlotCancel = 9;
        const int SlotClose = 10;
        const int SlotGetResults = 8;        // IAsyncOperation<T>: put_Completed 6, get_Completed 7, GetResults 8

        const int AsyncStarted = 0;
        const int AsyncCanceled = 2;
        const int AsyncError = 3;
        const int ResultCanceled = 6;

        static readonly string[] AvailabilityNames = { "Available", "DeviceNotPresent", "NotConfiguredForUser", "DisabledByPolicy", "DeviceBusy" };
        static readonly string[] ResultNames = { "Verified", "DeviceNotPresent", "NotConfiguredForUser", "DisabledByPolicy", "DeviceBusy", "RetriesExhausted", "Canceled" };

        [DllImport("combase.dll")] static extern int RoInitialize(int initType);
        [DllImport("combase.dll")] static extern void RoUninitialize();
        [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr activatableClassId, ref Guid iid, out IntPtr factory);
        [DllImport("combase.dll")] static extern int WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string sourceString, int length, out IntPtr hstring);
        [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr hstring);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);

        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int RequestForWindowFn(IntPtr self, IntPtr appWindow, IntPtr message, ref Guid riid, out IntPtr asyncOperation);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutPtrFn(IntPtr self, out IntPtr value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutIntFn(IntPtr self, out int value);
        [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int VoidFn(IntPtr self);

        static readonly object OutLock = new object();
        static int verifying;               // 1 while a prompt is open
        static volatile string currentId;   // id of the open prompt
        static volatile string cancelId;    // id the parent asked to cancel

        public static void Run()
        {
            Send("ready " + Environment.OSVersion.Version + " " + (IntPtr.Size * 8));
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                string[] p = line.Trim().Split(' ');
                if (p.Length < 2) continue;
                string id = p[1];
                if (p[0] == "check" && p.Length == 2) StartCheck(id);
                else if (p[0] == "verify" && p.Length == 4) StartVerify(id, p[2], p[3]);
                else if (p[0] == "cancel") cancelId = id;
                else Send("error " + id + " 0x80070057 request");
            }
            // The parent closed stdin (Tape quit or disposed the helper): close an open prompt first.
            string open = currentId;
            if (open != null)
            {
                cancelId = open;
                for (int i = 0; i < 100 && Thread.VolatileRead(ref verifying) != 0; i++) Thread.Sleep(30);
            }
        }

        static void Send(string line)
        {
            lock (OutLock)
            {
                Console.Out.Write(line + "\n");
                Console.Out.Flush();
            }
        }

        static void StartCheck(string id)
        {
            Spawn(delegate ()
            {
                try { Send("check " + id + " " + Name(AvailabilityNames, CheckAvailability())); }
                catch (Exception e) { SendError(id, e); }
            });
        }

        static void StartVerify(string id, string hwndText, string messageBase64)
        {
            ulong raw;
            if (!ulong.TryParse(hwndText, out raw)) { Send("error " + id + " 0x80070057 hwnd"); return; }
            IntPtr hwnd = new IntPtr(unchecked((long)raw));
            if (!IsWindow(hwnd)) { Send("error " + id + " 0x80070578 hwnd"); return; } // ERROR_INVALID_WINDOW_HANDLE
            string message;
            try { message = Encoding.UTF8.GetString(Convert.FromBase64String(messageBase64)); }
            catch (FormatException) { Send("error " + id + " 0x80070057 message"); return; }
            if (Interlocked.CompareExchange(ref verifying, 1, 0) != 0) { Send("busy " + id); return; }
            currentId = id;
            Spawn(delegate ()
            {
                try { Send("verify " + id + " " + Name(ResultNames, Verify(hwnd, message, id))); }
                catch (Exception e) { SendError(id, e); }
                finally
                {
                    currentId = null;
                    Interlocked.Exchange(ref verifying, 0);
                }
            });
        }

        static void SendError(string id, Exception e)
        {
            HResultException h = e as HResultException;
            if (h != null) Send("error " + id + " " + Hex(h.Code) + " " + h.Where);
            else Send("error " + id + " " + Hex(Marshal.GetHRForException(e)) + " " + e.GetType().Name);
        }

        // Every WinRT call runs on its own MTA thread, so nothing depends on the apartment or message
        // pump of the PowerShell host thread, which keeps reading stdin.
        static void Spawn(ThreadStart body)
        {
            Thread t = new Thread(delegate ()
            {
                int hr = RoInitialize(1); // RO_INIT_MULTITHREADED; S_FALSE when the CLR already did it
                try { body(); }
                finally { if (hr >= 0) RoUninitialize(); }
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
        }

        static int CheckAvailability()
        {
            // Verify() goes through the interop, which Microsoft documents from build 22000 (some
            // Windows 10 builds have it too). Probe it here, so a machine without it reports
            // E_NOINTERFACE / REGDB_E_CLASSNOTREG now instead of on the first click.
            Marshal.Release(GetFactory(IidInterop, "Interop"));
            IntPtr statics = GetFactory(IidStatics, "Statics");
            IntPtr op = IntPtr.Zero;
            try
            {
                Check(Slot<OutPtrFn>(statics, SlotCheckAvailability)(statics, out op), "CheckAvailabilityAsync");
                return Await(op, IidOpAvailability, null);
            }
            finally
            {
                if (op != IntPtr.Zero) Marshal.Release(op);
                Marshal.Release(statics);
            }
        }

        static int Verify(IntPtr hwnd, string message, string id)
        {
            IntPtr interop = GetFactory(IidInterop, "Interop");
            IntPtr text = IntPtr.Zero;
            IntPtr op = IntPtr.Zero;
            try
            {
                Check(WindowsCreateString(message, message.Length, out text), "WindowsCreateString");
                Guid riid = IidOpResult;
                Check(Slot<RequestForWindowFn>(interop, SlotRequestForWindow)(interop, hwnd, text, ref riid, out op), "RequestVerificationForWindowAsync");
                return Await(op, IidOpResult, id);
            }
            finally
            {
                if (op != IntPtr.Zero) Marshal.Release(op);
                if (text != IntPtr.Zero) WindowsDeleteString(text);
                Marshal.Release(interop);
            }
        }

        static IntPtr GetFactory(Guid iid, string what)
        {
            IntPtr classId;
            Check(WindowsCreateString(ClassId, ClassId.Length, out classId), "WindowsCreateString");
            try
            {
                IntPtr factory;
                Check(RoGetActivationFactory(classId, ref iid, out factory), "RoGetActivationFactory(" + what + ")");
                return factory;
            }
            finally { WindowsDeleteString(classId); }
        }

        // Polls IAsyncInfo instead of registering a Completed handler: no callback has to be
        // marshalled back into this process, and a 30 ms poll is invisible next to a human prompt.
        static int Await(IntPtr op, Guid typedIid, string cancelKey)
        {
            Guid infoIid = IidAsyncInfo;
            IntPtr info;
            Check(Marshal.QueryInterface(op, ref infoIid, out info), "QueryInterface(IAsyncInfo)");
            try
            {
                OutIntFn getStatus = Slot<OutIntFn>(info, SlotStatus);
                bool cancelSent = false;
                int status = AsyncStarted;
                for (;;)
                {
                    Check(getStatus(info, out status), "IAsyncInfo.Status");
                    if (status != AsyncStarted) break;
                    if (!cancelSent && cancelKey != null && cancelId == cancelKey)
                    {
                        Slot<VoidFn>(info, SlotCancel)(info);
                        cancelSent = true;
                    }
                    Thread.Sleep(30);
                }
                if (status == AsyncCanceled) return ResultCanceled;
                if (status == AsyncError)
                {
                    int code;
                    Check(Slot<OutIntFn>(info, SlotErrorCode)(info, out code), "IAsyncInfo.ErrorCode");
                    throw new HResultException(code, "operation");
                }
                // Completed: read the result through the parameterized interface, which also proves the IID.
                IntPtr typed;
                Check(Marshal.QueryInterface(op, ref typedIid, out typed), "QueryInterface(IAsyncOperation)");
                try
                {
                    int result;
                    Check(Slot<OutIntFn>(typed, SlotGetResults)(typed, out result), "GetResults");
                    return result;
                }
                finally { Marshal.Release(typed); }
            }
            finally
            {
                Slot<VoidFn>(info, SlotClose)(info);
                Marshal.Release(info);
            }
        }

        static T Slot<T>(IntPtr obj, int index) where T : class
        {
            IntPtr vtable = Marshal.ReadIntPtr(obj);
            IntPtr fn = Marshal.ReadIntPtr(vtable, index * IntPtr.Size);
            return (T)(object)Marshal.GetDelegateForFunctionPointer(fn, typeof(T));
        }

        static void Check(int hr, string where)
        {
            if (hr < 0) throw new HResultException(hr, where);
        }

        static string Hex(int hr) { return "0x" + hr.ToString("X8"); }

        static string Name(string[] names, int value)
        {
            return value >= 0 && value < names.Length ? names[value] : "Unknown" + value;
        }
    }
}
`;

/** Sent over stdin, followed by a HELPER_END line. ASCII only. */
export const HELPER_SCRIPT = [
  '$source = @' + "'",
  HELPER_CSHARP.trim(),
  "'" + '@',
  '$options = [System.CodeDom.Compiler.CompilerParameters]::new()',
  '$options.GenerateInMemory = $true',
  "$options.CompilerOptions = '/optimize+'",
  '$compiled = [Microsoft.CSharp.CSharpCodeProvider]::new().CompileAssemblyFromSource($options, $source)',
  'if ($compiled.Errors.HasErrors) {',
  '  foreach ($e in $compiled.Errors) {',
  "    if (-not $e.IsWarning) { [Console]::Out.Write('fatal compile ' + $e.ErrorNumber + ' line ' + $e.Line + [char]10) }",
  '  }',
  '  exit 4',
  '}',
  "[void]$compiled.CompiledAssembly.GetType('TapeHello.Host').GetMethod('Run').Invoke($null, $null)",
].join('\n');
