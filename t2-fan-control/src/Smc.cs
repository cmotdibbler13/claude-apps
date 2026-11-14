// Apple T2 SMC access for Windows (Boot Camp), using the memory-mapped SMC
// interface (ACPI device APP0001) through the inpoutx64 driver.
// Protocol follows the Linux applesmc T2 (iomem) implementation.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace T2Fans
{
    public sealed class SmcException : Exception
    {
        public SmcException(string msg) : base(msg) { }
    }

    public sealed class KeyInfo
    {
        public string Key;
        public int Len;
        public string Type;   // e.g. "flt ", "ui8 ", "fpe2"
    }

    public sealed class Smc : IDisposable
    {
        const long SMC_PHYS = 0xFE0B0000L;      // ACPI\APP0001 memory resource
        const int SMC_SIZE = 0x10000;

        const int REG_DATA = 0x0000;
        const int REG_KEY = 0x0078;
        const int REG_LEN = 0x007D;
        const int REG_SMCID = 0x007E;
        const int REG_CMD = 0x007F;
        const int REG_STATUS = 0x4005;
        const byte DONE_BIT = 0x20;

        const byte CMD_READ = 0x10;
        const byte CMD_WRITE = 0x11;
        const byte CMD_INDEX = 0x12;
        const byte CMD_TYPE = 0x13;

        const uint IOCTL_MAP = 0x9C40201C;      // inpoutx64 IOCTL_WINIO_MAPPHYSTOLIN
        const uint IOCTL_UNMAP = 0x9C402020;    // inpoutx64 IOCTL_WINIO_UNMAPPHYSADDR

        [StructLayout(LayoutKind.Sequential)]
        struct PhysMap
        {
            public IntPtr SectionHandle;
            public UIntPtr Size;
            public IntPtr PhysAddr;
            public IntPtr LinAddr;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DeviceIoControl(IntPtr h, uint code, ref PhysMap inBuf, int inLen, ref PhysMap outBuf, int outLen, out int ret, IntPtr ov);

        IntPtr _dev = new IntPtr(-1);
        IntPtr _base = IntPtr.Zero;
        PhysMap _map;
        readonly object _lock = new object();
        Mutex _mutex;
        readonly Dictionary<string, KeyInfo> _info = new Dictionary<string, KeyInfo>();

        public Smc()
        {
            string model = Convert.ToString(Microsoft.Win32.Registry.GetValue(
                @"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\BIOS", "SystemManufacturer", ""));
            if (model.IndexOf("Apple", StringComparison.OrdinalIgnoreCase) < 0)
                throw new SmcException("This is not an Apple computer.");

            _dev = CreateFileW(@"\\.\inpoutx64", 0xC0000000, 3, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
            if (_dev == new IntPtr(-1))
                throw new SmcException("Cannot open the inpoutx64 driver (error " + Marshal.GetLastWin32Error() +
                    "). It is installed with Macs Fan Control / InpOut32 and must be running.");

            _map = new PhysMap();
            _map.Size = new UIntPtr((uint)SMC_SIZE);
            _map.PhysAddr = new IntPtr(SMC_PHYS);
            int ret;
            if (!DeviceIoControl(_dev, IOCTL_MAP, ref _map, Marshal.SizeOf(typeof(PhysMap)), ref _map, Marshal.SizeOf(typeof(PhysMap)), out ret, IntPtr.Zero)
                || _map.LinAddr == IntPtr.Zero)
            {
                int err = Marshal.GetLastWin32Error();
                Dispose();
                throw new SmcException("Could not map the SMC memory window (error " + err + ").");
            }
            _base = new IntPtr(_map.LinAddr.ToInt64() + SMC_PHYS - _map.PhysAddr.ToInt64());

            try { bool created; _mutex = new Mutex(false, @"Global\AppleSmcAccess", out created); }
            catch { _mutex = null; }

            // Sanity checks before trusting the window (same as Linux).
            if (R8(REG_STATUS) == 0xFF) { Dispose(); throw new SmcException("SMC window not responding (status 0xFF)."); }
            byte[] ldkn = new byte[1];
            int rc = ReadRaw(CMD_READ, KeyCode("LDKN"), ldkn, 1);
            if (rc != 0 || ldkn[0] < 2) { Dispose(); throw new SmcException("SMC did not answer correctly (LDKN rc=" + rc + ")."); }
        }

        public void Dispose()
        {
            lock (_lock)
            {
                if (_base != IntPtr.Zero)
                {
                    int ret;
                    DeviceIoControl(_dev, IOCTL_UNMAP, ref _map, Marshal.SizeOf(typeof(PhysMap)), ref _map, Marshal.SizeOf(typeof(PhysMap)), out ret, IntPtr.Zero);
                    _base = IntPtr.Zero;
                }
                if (_dev != new IntPtr(-1)) { CloseHandle(_dev); _dev = new IntPtr(-1); }
            }
        }

        // ---- raw register access ----
        byte R8(int off) { return Marshal.ReadByte(_base, off); }
        void W8(int off, byte v) { Marshal.WriteByte(_base, off, v); }
        void W32(int off, uint v) { Marshal.WriteInt32(_base, off, unchecked((int)v)); }

        static uint KeyCode(string key)
        {
            if (key.Length != 4) throw new ArgumentException("SMC key must be 4 characters");
            return (uint)key[0] | ((uint)key[1] << 8) | ((uint)key[2] << 16) | ((uint)key[3] << 24);
        }

        void ClearStatus() { if (R8(REG_STATUS) != 0) W8(REG_STATUS, 0); }

        bool WaitDone()
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (true)
            {
                if ((R8(REG_STATUS) & DONE_BIT) != 0) return true;
                long ms = sw.ElapsedMilliseconds;
                if (ms > 250) return false;
                if (ms < 2) Thread.SpinWait(200); else Thread.Sleep(1);
            }
        }

        bool Enter()
        {
            if (_mutex == null) return true;
            try { return _mutex.WaitOne(1000); }
            catch (AbandonedMutexException) { return true; }
        }
        void Leave() { if (_mutex != null) { try { _mutex.ReleaseMutex(); } catch { } } }

        // returns 0 on success, -1 timeout, -2 length mismatch, -3 busy, >0 SMC error byte
        int ReadRaw(byte cmd, uint key, byte[] buf, int len)
        {
            lock (_lock)
            {
                if (_base == IntPtr.Zero) return -1;
                if (!Enter()) return -3;
                try
                {
                    ClearStatus();
                    W32(REG_KEY, key);
                    W8(REG_SMCID, 0);
                    W8(REG_CMD, cmd);
                    if (!WaitDone()) return -1;
                    byte err = R8(REG_CMD);
                    if (err != 0) return err;
                    if (cmd == CMD_READ && R8(REG_LEN) != len) return -2;
                    for (int i = 0; i < len; i++) buf[i] = R8(REG_DATA + i);
                    return 0;
                }
                finally { Leave(); }
            }
        }

        int WriteRaw(uint key, byte[] buf, int len)
        {
            lock (_lock)
            {
                if (_base == IntPtr.Zero) return -1;
                if (!Enter()) return -3;
                try
                {
                    ClearStatus();
                    W32(REG_KEY, key);
                    for (int i = 0; i < len; i++) W8(REG_DATA + i, buf[i]);
                    W8(REG_LEN, (byte)len);
                    W8(REG_SMCID, 0);
                    W8(REG_CMD, CMD_WRITE);
                    if (!WaitDone()) return -1;
                    return R8(REG_CMD);
                }
                finally { Leave(); }
            }
        }

        // ---- public API ----
        public KeyInfo GetInfo(string key)
        {
            KeyInfo ki;
            lock (_info) { if (_info.TryGetValue(key, out ki)) return ki; }
            byte[] b = new byte[8];
            int rc = ReadRaw(CMD_TYPE, KeyCode(key), b, 8);
            if (rc != 0) return null;
            ki = new KeyInfo();
            ki.Key = key;
            ki.Len = b[5];
            ki.Type = new string(new char[] { (char)b[0], (char)b[1], (char)b[2], (char)b[3] });
            if (ki.Len < 1 || ki.Len > 32) return null;
            lock (_info) { _info[key] = ki; }
            return ki;
        }

        public byte[] RawInfo(string key)
        {
            byte[] b = new byte[8];
            int rc = ReadRaw(CMD_TYPE, KeyCode(key), b, 8);
            return rc == 0 ? b : null;
        }

        public byte[] ReadBytes(string key)
        {
            KeyInfo ki = GetInfo(key);
            if (ki == null) return null;
            byte[] b = new byte[ki.Len];
            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (ReadRaw(CMD_READ, KeyCode(key), b, ki.Len) == 0) return b;
            }
            return null;
        }

        /// <summary>Reads a numeric key; NaN if unavailable.</summary>
        public double ReadNumber(string key)
        {
            KeyInfo ki = GetInfo(key);
            if (ki == null) return double.NaN;
            byte[] b = ReadBytes(key);
            if (b == null) return double.NaN;
            string t = ki.Type;
            if (t == "flt " && b.Length == 4) return BitConverter.ToSingle(b, 0);
            if (t.StartsWith("ui") || t == "flag")
            {
                ulong v = 0;
                for (int i = 0; i < b.Length; i++) v = (v << 8) | b[i];
                return v;
            }
            if ((t.StartsWith("fp") || t.StartsWith("sp")) && b.Length == 2)
            {
                int frac = Convert.ToInt32(t.Substring(3, 1), 16);
                int raw = (b[0] << 8) | b[1];
                if (t[0] == 's') raw = (short)raw;
                return raw / (double)(1 << frac);
            }
            return double.NaN;
        }

        public int KeyCount()
        {
            byte[] b = new byte[4];
            if (ReadRaw(CMD_READ, KeyCode("#KEY"), b, 4) != 0) return 0;
            return (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
        }

        public int LastRc;

        public string KeyAt(int index)
        {
            // index is sent big-endian in the key-name register
            uint k = ((uint)index >> 24) | (((uint)index >> 8) & 0xFF00) | (((uint)index << 8) & 0xFF0000) | ((uint)index << 24);
            byte[] b = new byte[4];
            LastRc = ReadRaw(CMD_INDEX, k, b, 4);
            if (LastRc != 0) return null;
            return Encoding.ASCII.GetString(b);
        }

        /// <summary>Writes are restricted to the fan mode and fan target keys.</summary>
        bool WriteFanKey(string key, byte[] data)
        {
            bool ok = key.Length == 4 && key[0] == 'F' && key[1] >= '0' && key[1] <= '9' &&
                      (key.EndsWith("Md") || key.EndsWith("Tg"));
            if (!ok) throw new SmcException("Refusing to write SMC key " + key);
            for (int attempt = 0; attempt < 2; attempt++)
            {
                if (WriteRaw(KeyCode(key), data, data.Length) == 0) return true;
            }
            return false;
        }

        public int FanCount()
        {
            double n = ReadNumber("FNum");
            return double.IsNaN(n) ? 0 : (int)n;
        }

        public bool SetFanManual(int fan, bool manual)
        {
            return WriteFanKey("F" + fan + "Md", new byte[] { (byte)(manual ? 1 : 0) });
        }

        public bool SetFanTarget(int fan, float rpm)
        {
            KeyInfo ki = GetInfo("F" + fan + "Tg");
            if (ki == null || ki.Type != "flt " || ki.Len != 4) return false;
            return WriteFanKey("F" + fan + "Tg", BitConverter.GetBytes(rpm));
        }
    }
}
