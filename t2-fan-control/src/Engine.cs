// T2 Fan Control - control loop, sensor names and program entry point.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace T2Fans
{
    class FanCfg
    {
        public int Mode;                 // 0 auto, 1 constant, 2 sensor based
        public int Rpm = 3000;
        public string Sensor = "@CPU";
        public int Low = 50;
        public int High = 85;
    }

    class SensorItem
    {
        public string Key;
        public string Name;
        public override string ToString() { return Name; }
    }

    class Snapshot
    {
        public int Fans;
        public double[] Ac, Mn, Mx, Tg;
        public int[] Md;
        public List<SensorItem> Sensors;
        public double[] Temps;
        public double Cpu, Gpu;
        public bool Paused;
        public string Fatal;
    }

    static class Names
    {
        static readonly Dictionary<string, string> Map = Build();
        static Dictionary<string, string> Build()
        {
            Dictionary<string, string> m = new Dictionary<string, string>();
            m["TC0P"] = "CPU proximity"; m["TCMX"] = "CPU hottest point"; m["TCSA"] = "CPU system agent";
            m["TC0E"] = "CPU package 1"; m["TC0F"] = "CPU package 2";
            for (int i = 1; i <= 8; i++) m["TC" + i + "C"] = "CPU core " + i;
            m["TG0P"] = "GPU proximity"; m["TG1P"] = "GPU proximity 2"; m["TGDD"] = "GPU diode";
            m["TGVP"] = "GPU VRM"; m["TPCD"] = "Platform controller";
            m["TB0T"] = "Battery"; m["TB1T"] = "Battery 1"; m["TB2T"] = "Battery 2";
            m["TM0P"] = "Memory proximity"; m["Tm0P"] = "Mainboard"; m["TW0P"] = "Wi-Fi";
            m["Th1H"] = "Heatpipe 1"; m["Th2H"] = "Heatpipe 2";
            m["Ts0P"] = "Palm rest"; m["Ts1P"] = "Palm rest 2"; m["TH0X"] = "SSD";
            m["TaLC"] = "Airflow left"; m["TaRC"] = "Airflow right";
            m["TA0V"] = "Ambient air";
            m["TTLD"] = "Thunderbolt left"; m["TTRD"] = "Thunderbolt right";
            return m;
        }
        public static string Get(string key)
        {
            string n;
            return Map.TryGetValue(key, out n) ? n : key;
        }
    }

    class Engine
    {
        public readonly object Sync = new object();
        public readonly FanCfg[] Cfg = new FanCfg[8];
        public event Action<Snapshot> Updated;

        Thread _thread;
        volatile bool _stop;
        volatile bool _force = true;
        readonly AutoResetEvent _wake = new AutoResetEvent(false);
        Smc _smc;
        int _fans;
        double[] _mn, _mx, _lastTg;
        int[] _badTemp;
        List<SensorItem> _sensors = new List<SensorItem>();
        List<string> _cores = new List<string>();
        string _gpuKey;
        bool _paused;

        public Engine() { for (int i = 0; i < Cfg.Length; i++) Cfg[i] = new FanCfg(); }

        public void Start()
        {
            _thread = new Thread(Run);
            _thread.IsBackground = true;
            _thread.Name = "smc";
            _thread.Start();
        }

        /// <summary>Stops the loop and hands the fans back to the system.</summary>
        public void Stop()
        {
            if (_thread == null) return;
            _stop = true;
            _wake.Set();
            _thread.Join(5000);
            _thread = null;
        }

        public void Wake(bool force) { if (force) _force = true; _wake.Set(); }

        void Post(Snapshot s) { Action<Snapshot> h = Updated; if (h != null) h(s); }

        static bool MacsFanControlRunning()
        {
            try
            {
                Process[] p = Process.GetProcessesByName("MacsFanControl");
                bool any = p.Length > 0;
                foreach (Process x in p) x.Dispose();
                return any;
            }
            catch { return false; }
        }

        double ReadChecked(string key, double lo, double hi)
        {
            for (int i = 0; i < 3; i++)
            {
                double v = _smc.ReadNumber(key);
                if (!double.IsNaN(v) && v >= lo && v <= hi) return v;
                Thread.Sleep(5);
            }
            return double.NaN;
        }

        double ReadTemp(string key)
        {
            if (key == "@CPU")
            {
                double max = double.NaN;
                foreach (string c in _cores)
                {
                    double v = ReadChecked(c, 1, 125);
                    if (!double.IsNaN(v) && (double.IsNaN(max) || v > max)) max = v;
                }
                return double.IsNaN(max) ? ReadChecked("TC0P", 1, 125) : max;
            }
            return ReadChecked(key, 1, 125);
        }

        void Run()
        {
            try
            {
                _smc = new Smc();
                for (int i = 0; i < 5 && _fans == 0; i++) { _fans = Math.Min(_smc.FanCount(), Cfg.Length); if (_fans == 0) Thread.Sleep(100); }
                if (_fans == 0) throw new SmcException("The SMC reports no fans.");
                _mn = new double[_fans]; _mx = new double[_fans]; _lastTg = new double[_fans]; _badTemp = new int[_fans];
                for (int i = 0; i < _fans; i++)
                {
                    _mn[i] = ReadChecked("F" + i + "Mn", 300, 10000);
                    _mx[i] = ReadChecked("F" + i + "Mx", 300, 10000);
                    if (double.IsNaN(_mn[i]) || double.IsNaN(_mx[i]) || _mn[i] >= _mx[i])
                        throw new SmcException("Could not read the speed limits of fan " + i + ".");
                    _lastTg[i] = -1;
                }
                Discover();
            }
            catch (Exception ex)
            {
                Snapshot f = new Snapshot();
                f.Fatal = ex.Message;
                Post(f);
                if (_smc != null) _smc.Dispose();
                return;
            }

            while (!_stop)
            {
                try { Cycle(); } catch { }
                _wake.WaitOne(2000);
            }

            // hand control back to the SMC
            if (!MacsFanControlRunning())
            {
                for (int i = 0; i < _fans; i++)
                    for (int t = 0; t < 3; t++) { if (_smc.SetFanManual(i, false)) break; Thread.Sleep(20); }
            }
            _smc.Dispose();
        }

        void Discover()
        {
            int count = _smc.KeyCount();
            List<string> keys = new List<string>();
            for (int i = 0; i < count && !_stop; i++)
            {
                string k = _smc.KeyAt(i);
                if (k == null) k = _smc.KeyAt(i);
                if (k == null || k[0] != 'T') continue;
                bool okName = true;
                foreach (char c in k) if (!char.IsLetterOrDigit(c)) okName = false;
                if (!okName) continue;
                KeyInfo ki = _smc.GetInfo(k);
                if (ki == null || (ki.Type != "sp78" && ki.Type != "flt ")) continue;
                double v = ReadChecked(k, 5, 120);
                if (double.IsNaN(v)) continue;
                keys.Add(k);
            }
            for (int i = 1; i <= 16; i++) { string c = "TC" + i + "C"; if (keys.Contains(c)) _cores.Add(c); }
            _gpuKey = keys.Contains("TGDD") ? "TGDD" : (keys.Contains("TG0P") ? "TG0P" : null);
            SensorItem cpu = new SensorItem(); cpu.Key = "@CPU"; cpu.Name = "CPU hottest core";
            _sensors.Add(cpu);
            foreach (string k in keys) { SensorItem s = new SensorItem(); s.Key = k; s.Name = Names.Get(k); _sensors.Add(s); }
        }

        void Cycle()
        {
            Snapshot s = new Snapshot();
            s.Fans = _fans; s.Mn = _mn; s.Mx = _mx; s.Sensors = _sensors;
            s.Ac = new double[_fans]; s.Tg = new double[_fans]; s.Md = new int[_fans];
            s.Temps = new double[_sensors.Count];

            bool paused = MacsFanControlRunning();
            if (_paused && !paused) _force = true;
            _paused = paused;
            s.Paused = paused;
            bool force = _force; _force = false;

            Dictionary<string, double> temps = new Dictionary<string, double>();
            for (int i = 0; i < _sensors.Count; i++)
            {
                s.Temps[i] = ReadTemp(_sensors[i].Key);
                temps[_sensors[i].Key] = s.Temps[i];
            }
            s.Cpu = s.Temps.Length > 0 ? s.Temps[0] : double.NaN;
            s.Gpu = double.NaN;
            if (_gpuKey != null) temps.TryGetValue(_gpuKey, out s.Gpu);

            for (int i = 0; i < _fans; i++)
            {
                s.Ac[i] = ReadChecked("F" + i + "Ac", 0, 12000);
                s.Tg[i] = ReadChecked("F" + i + "Tg", 0, 12000);
                double md = ReadChecked("F" + i + "Md", 0, 1);
                s.Md[i] = double.IsNaN(md) ? -1 : (int)md;
                if (paused) continue;

                FanCfg c;
                lock (Sync) { c = new FanCfg(); c.Mode = Cfg[i].Mode; c.Rpm = Cfg[i].Rpm; c.Sensor = Cfg[i].Sensor; c.Low = Cfg[i].Low; c.High = Cfg[i].High; }

                double target = double.NaN;
                if (c.Mode == 1) target = c.Rpm;
                else if (c.Mode == 2)
                {
                    double t;
                    if (!temps.TryGetValue(c.Sensor, out t)) t = ReadTemp(c.Sensor);
                    if (double.IsNaN(t))
                    {
                        // sensor unreadable: keep last speed briefly, then fail safe to automatic
                        if (++_badTemp[i] < 3 && _lastTg[i] > 0) target = _lastTg[i];
                    }
                    else
                    {
                        _badTemp[i] = 0;
                        double span = Math.Max(1, c.High - c.Low);
                        double f = Math.Max(0, Math.Min(1, (t - c.Low) / span));
                        target = _mn[i] + f * (_mx[i] - _mn[i]);
                        target = Math.Round(target / 50.0) * 50.0;
                    }
                }

                if (double.IsNaN(target))
                {
                    // automatic (or fail-safe): make sure the SMC is in charge
                    if (s.Md[i] != 0 || force) { if (_smc.SetFanManual(i, false)) s.Md[i] = 0; }
                    _lastTg[i] = -1;
                    continue;
                }

                target = Math.Max(_mn[i], Math.Min(_mx[i], target));
                bool needMode = s.Md[i] != 1;
                bool needTg = force || needMode || _lastTg[i] < 0 || Math.Abs(target - _lastTg[i]) >= 50
                              || (!double.IsNaN(s.Tg[i]) && Math.Abs(s.Tg[i] - _lastTg[i]) > 2);
                if (needMode) { if (_smc.SetFanManual(i, true)) s.Md[i] = 1; }
                if (needTg)
                {
                    if (_smc.SetFanTarget(i, (float)target)) { _lastTg[i] = target; s.Tg[i] = target; }
                }
            }
            Post(s);
        }
    }

    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            using (EventWaitHandle quit = new EventWaitHandle(false, EventResetMode.AutoReset, "T2FanControl.Exit"))
            using (Mutex single = new Mutex(true, "T2FanControl.SingleInstance", out created))
            {
                // "T2FanControl.exe --exit" asks the running copy to quit cleanly (fans back to automatic)
                if (Array.IndexOf(args, "--exit") >= 0) { if (!created) quit.Set(); return; }
                if (!created) return;
                bool tray = Array.IndexOf(args, "--tray") >= 0;
                try { SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                MainWindow form = new MainWindow(tray);
                ThreadPool.RegisterWaitForSingleObject(quit, delegate
                {
                    try { form.BeginInvoke(new Action(form.ExitNow)); } catch { }
                }, null, -1, true);
                Application.Run(form);
            }
        }
    }
}
