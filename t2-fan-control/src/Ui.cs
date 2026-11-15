// T2 Fan Control - main window (custom drawn, Six Minutes On palette).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace T2Fans
{
    static class Theme
    {
        public static readonly Color Deep = Color.FromArgb(0x03, 0x07, 0x0c);
        public static readonly Color Bg = Color.FromArgb(0x09, 0x1a, 0x2e);
        public static readonly Color Card = Color.FromArgb(0x0d, 0x24, 0x40);
        public static readonly Color Raised = Color.FromArgb(0x14, 0x30, 0x4f);
        public static readonly Color Ink = Color.FromArgb(0xea, 0xeb, 0xed);
        public static readonly Color Muted = Color.FromArgb(0xa3, 0xad, 0xb8);
        public static readonly Color Faint = Color.FromArgb(0x7d, 0x86, 0x90);
        public static readonly Color Brass = Color.FromArgb(0xd5, 0xa8, 0x67);
        public static readonly Color OnBrass = Color.FromArgb(0x1a, 0x12, 0x06);
        public static readonly Color Tide = Color.FromArgb(0x86, 0xbf, 0xdb);
        public static readonly Color Rule = Color.FromArgb(0x24, 0x39, 0x5a);
        public static readonly Color RuleStrong = Color.FromArgb(0x64, 0x7b, 0x98);
        public static readonly Color Olive = Color.FromArgb(0xa3, 0xa8, 0x73);
        public static readonly Color Copper = Color.FromArgb(0xc9, 0x8a, 0x62);
        public static readonly Color Rose = Color.FromArgb(0xd9, 0x8f, 0x9a);
        public static readonly Color Hot = Color.FromArgb(0xe2, 0x67, 0x5b);

        static readonly bool HasInter = FontExists("Inter");
        static bool FontExists(string name)
        {
            try
            {
                using (InstalledFontCollection c = new InstalledFontCollection())
                    foreach (FontFamily f in c.Families) if (f.Name == name) return true;
            }
            catch { }
            return false;
        }
        public static Font Make(float px, bool strong)
        {
            if (HasInter) return new Font("Inter", px, strong ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel);
            return new Font(strong ? "Segoe UI Semibold" : "Segoe UI", px, FontStyle.Regular, GraphicsUnit.Pixel);
        }

        public static Color TempColor(double t, Color normal)
        {
            if (double.IsNaN(t)) return Faint;
            return t >= 95 ? Hot : (t >= 80 ? Copper : normal);
        }
    }

    class DarkColors : ProfessionalColorTable
    {
        public override Color MenuItemSelected { get { return Theme.Raised; } }
        public override Color MenuItemSelectedGradientBegin { get { return Theme.Raised; } }
        public override Color MenuItemSelectedGradientEnd { get { return Theme.Raised; } }
        public override Color MenuItemPressedGradientBegin { get { return Theme.Raised; } }
        public override Color MenuItemPressedGradientEnd { get { return Theme.Raised; } }
        public override Color MenuItemBorder { get { return Theme.RuleStrong; } }
        public override Color MenuBorder { get { return Theme.Rule; } }
        public override Color ToolStripDropDownBackground { get { return Theme.Card; } }
        public override Color ImageMarginGradientBegin { get { return Theme.Card; } }
        public override Color ImageMarginGradientMiddle { get { return Theme.Card; } }
        public override Color ImageMarginGradientEnd { get { return Theme.Card; } }
        public override Color SeparatorDark { get { return Theme.Rule; } }
        public override Color SeparatorLight { get { return Theme.Card; } }
    }

    class DarkRenderer : ToolStripProfessionalRenderer
    {
        public DarkRenderer() : base(new DarkColors()) { }
        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e) { e.ArrowColor = Theme.Ink; base.OnRenderArrow(e); }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) { e.TextColor = Theme.Ink; base.OnRenderItemText(e); }
    }

    class Hit
    {
        public RectangleF R;
        public Action Click;
        public Action<float> Drag;
    }

    class Sample
    {
        public DateTime T;
        public double Cpu, Gpu;
        public double[] Fan;
    }

    class MainWindow : Form
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string RunName = "T2FanControl";
        const float W = 1080, H = 780;

        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        readonly Engine _engine = new Engine();
        readonly NotifyIcon _tray = new NotifyIcon();
        readonly List<Hit> _hits = new List<Hit>();
        readonly List<Sample> _history = new List<Sample>();
        readonly Dictionary<Color, SolidBrush> _brushes = new Dictionary<Color, SolidBrush>();
        readonly StringFormat _fmt;
        readonly Font _fLabel = Theme.Make(10.5f, true), _fSmall = Theme.Make(11.5f, false), _fBody = Theme.Make(12.5f, false),
                      _fBodyStrong = Theme.Make(12.5f, true), _fMid = Theme.Make(20f, true), _fBig = Theme.Make(30f, true), _fTitle = Theme.Make(22f, true);
        readonly string _model;
        float _s = 1f;
        Snapshot _snap;
        string _fatal;
        Hit _drag;
        bool _hover, _startHidden, _exiting, _stopped, _startup;
        int _range = 300;
        IntPtr _iconHandle = IntPtr.Zero;
        int _iconTemp = -999;

        static string SettingsPath
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "T2FanControl", "settings.txt"); }
        }

        public MainWindow(bool startHidden)
        {
            _startHidden = startHidden;
            _fmt = new StringFormat(StringFormat.GenericTypographic);
            _fmt.FormatFlags |= StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoWrap;
            _model = Convert.ToString(Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\BIOS", "SystemProductName", "Mac"));

            Text = "T2 Fan Control";
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Bg;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);

            using (Graphics g = CreateGraphics()) _s = g.DpiX / 96f;
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            _s = Math.Min(_s, Math.Min((wa.Height - 60) / H, (wa.Width - 40) / W));
            ClientSize = new Size((int)Math.Round(W * _s), (int)Math.Round(H * _s));
            Icon = MakeAppIcon();

            ContextMenuStrip menu = NewMenu();
            menu.Items.Add("Show T2 Fan Control", null, delegate { ShowWindow(); });
            menu.Items.Add("All fans automatic", null, delegate { AllAuto(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Exit (fans return to automatic)", null, delegate { ExitNow(); });
            _tray.ContextMenuStrip = menu;
            _tray.Icon = Icon;
            _tray.Text = "T2 Fan Control";
            _tray.Visible = true;
            _tray.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) ShowWindow(); };

            _startup = StartupEnabled();
            LoadSettings();
            _engine.Updated += OnEngineUpdate;
            SystemEvents.SessionEnding += delegate { StopEngine(); };
            SystemEvents.PowerModeChanged += delegate(object s, PowerModeChangedEventArgs e)
            {
                if (e.Mode == PowerModes.Resume) _engine.Wake(true);
            };
            Application.ApplicationExit += delegate { StopEngine(); };
            AppDomain.CurrentDomain.UnhandledException += delegate { StopEngine(); };
            if (!IsHandleCreated) CreateHandle();
            _engine.Start();
        }

        ContextMenuStrip NewMenu()
        {
            ContextMenuStrip m = new ContextMenuStrip();
            m.Renderer = new DarkRenderer();
            m.BackColor = Theme.Card;
            m.ForeColor = Theme.Ink;
            m.ShowImageMargin = false;
            return m;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int on = 1; DwmSetWindowAttribute(Handle, 20, ref on, 4);
                int caption = Theme.Bg.R | (Theme.Bg.G << 8) | (Theme.Bg.B << 16); DwmSetWindowAttribute(Handle, 35, ref caption, 4);
                int text = Theme.Ink.R | (Theme.Ink.G << 8) | (Theme.Ink.B << 16); DwmSetWindowAttribute(Handle, 36, ref text, 4);
            }
            catch { }
        }

        protected override void SetVisibleCore(bool value)
        {
            if (_startHidden) { _startHidden = false; value = false; }
            base.SetVisibleCore(value);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing && !_exiting) { e.Cancel = true; Hide(); return; }
            StopEngine();
            _tray.Visible = false;
            base.OnFormClosing(e);
        }

        void StopEngine()
        {
            if (_stopped) return;
            _stopped = true;
            _engine.Stop();
        }

        public void ExitNow() { _exiting = true; Close(); }
        void ShowWindow() { Show(); WindowState = FormWindowState.Normal; Activate(); }

        void AllAuto()
        {
            lock (_engine.Sync) { foreach (FanCfg c in _engine.Cfg) c.Mode = 0; }
            SaveSettings();
            _engine.Wake(true);
            Invalidate();
        }

        void Change(int fan, Action<FanCfg> change, bool save)
        {
            lock (_engine.Sync) { change(_engine.Cfg[fan]); }
            if (save) SaveSettings();
            _engine.Wake(true);
            Invalidate();
        }

        // ---- startup registration (per-user, no admin needed) ----
        static bool StartupEnabled()
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RunKey)) { return k != null && k.GetValue(RunName) != null; }
        }
        static void SetStartup(bool on)
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                if (on) k.SetValue(RunName, "\"" + Application.ExecutablePath + "\" --tray");
                else k.DeleteValue(RunName, false);
            }
            // The logon task created by "build.ps1 -Install" is a second trigger, because Windows
            // has been seen to skip the Run entry. Keep it in step with the switch.
            try
            {
                System.Diagnostics.ProcessStartInfo p = new System.Diagnostics.ProcessStartInfo(
                    "schtasks.exe", "/change /tn \"T2 Fan Control\" " + (on ? "/enable" : "/disable"));
                p.CreateNoWindow = true;
                p.UseShellExecute = false;
                System.Diagnostics.Process.Start(p);
            }
            catch { }
        }

        // ---- settings ----
        void LoadSettings()
        {
            try
            {
                if (!File.Exists(SettingsPath)) return;
                foreach (string line in File.ReadAllLines(SettingsPath))
                {
                    int eq = line.IndexOf('=');
                    if (eq < 0) continue;
                    if (line.StartsWith("range=")) { int r = int.Parse(line.Substring(eq + 1)); if (r == 60 || r == 300 || r == 1800) _range = r; continue; }
                    if (!line.StartsWith("fan")) continue;
                    int idx = int.Parse(line.Substring(3, eq - 3));
                    string[] p = line.Substring(eq + 1).Split(',');
                    if (idx < 0 || idx >= _engine.Cfg.Length || p.Length < 5) continue;
                    FanCfg c = _engine.Cfg[idx];
                    c.Mode = Math.Max(0, Math.Min(2, int.Parse(p[0])));
                    c.Rpm = int.Parse(p[1]);
                    c.Sensor = p[2];
                    c.Low = Math.Max(20, Math.Min(95, int.Parse(p[3])));
                    c.High = Math.Max(c.Low + 5, Math.Min(105, int.Parse(p[4])));
                }
            }
            catch { }
        }

        void SaveSettings()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath));
                StringBuilder sb = new StringBuilder();
                lock (_engine.Sync)
                {
                    for (int i = 0; i < _engine.Cfg.Length; i++)
                    {
                        FanCfg c = _engine.Cfg[i];
                        sb.AppendLine("fan" + i + "=" + c.Mode + "," + c.Rpm + "," + c.Sensor + "," + c.Low + "," + c.High);
                    }
                }
                sb.AppendLine("range=" + _range);
                File.WriteAllText(SettingsPath, sb.ToString());
            }
            catch { }
        }

        // ---- engine updates ----
        void OnEngineUpdate(Snapshot s)
        {
            if (IsDisposed) return;
            try { BeginInvoke(new Action<Snapshot>(Accept), s); } catch { }
        }

        void Accept(Snapshot s)
        {
            if (s.Fatal != null) { _fatal = s.Fatal; _tray.Text = "T2 Fan Control - not working"; Invalidate(); return; }
            _snap = s;
            Sample m = new Sample();
            m.T = DateTime.UtcNow; m.Cpu = s.Cpu; m.Gpu = s.Gpu; m.Fan = (double[])s.Ac.Clone();
            _history.Add(m);
            DateTime cut = m.T.AddSeconds(-1860);
            int drop = 0;
            while (drop < _history.Count && _history[drop].T < cut) drop++;
            if (drop > 0) _history.RemoveRange(0, drop);

            StringBuilder tip = new StringBuilder();
            if (!double.IsNaN(s.Cpu)) tip.Append("CPU " + s.Cpu.ToString("0") + "°C");
            if (!double.IsNaN(s.Gpu)) tip.Append("  GPU " + s.Gpu.ToString("0") + "°C");
            for (int i = 0; i < s.Fans; i++) tip.Append("  " + (double.IsNaN(s.Ac[i]) ? "?" : s.Ac[i].ToString("0")) + " rpm");
            string t = tip.ToString();
            _tray.Text = t.Length > 63 ? t.Substring(0, 63) : t;
            UpdateTrayIcon(s.Cpu);
            if (Visible) Invalidate();
        }

        // ---- drawing helpers ----
        SolidBrush B(Color c)
        {
            SolidBrush b;
            if (!_brushes.TryGetValue(c, out b)) { b = new SolidBrush(c); _brushes[c] = b; }
            return b;
        }
        float TW(Graphics g, string s, Font f) { return g.MeasureString(s, f, 100000, _fmt).Width; }
        void T(Graphics g, string s, Font f, Color c, float x, float y) { g.DrawString(s, f, B(c), x, y, _fmt); }
        void TR(Graphics g, string s, Font f, Color c, float right, float y) { g.DrawString(s, f, B(c), right - TW(g, s, f), y, _fmt); }
        void TC(Graphics g, string s, Font f, Color c, RectangleF r)
        {
            float w = TW(g, s, f);
            g.DrawString(s, f, B(c), r.X + (r.Width - w) / 2, r.Y + (r.Height - f.GetHeight(g)) / 2, _fmt);
        }
        float SpacedW(Graphics g, string s, Font f, float track)
        {
            float w = 0;
            foreach (char ch in s) w += TW(g, ch.ToString(), f) + track;
            return w - track;
        }
        // uppercase, letter-spaced label; returns its width
        float L(Graphics g, string s, Color c, float x, float y)
        {
            float cx = x;
            foreach (char ch in s)
            {
                string one = ch.ToString();
                g.DrawString(one, _fLabel, B(c), cx, y, _fmt);
                cx += TW(g, one, _fLabel) + 1.6f;
            }
            return cx - x - 1.6f;
        }
        void LR(Graphics g, string s, Color c, float right, float y) { L(g, s, c, right - SpacedW(g, s, _fLabel, 1.6f), y); }
        void LC(Graphics g, string s, Color c, RectangleF r)
        {
            float w = SpacedW(g, s, _fLabel, 1.6f);
            L(g, s, c, r.X + (r.Width - w) / 2, r.Y + (r.Height - _fLabel.GetHeight(g)) / 2);
        }
        void Box(Graphics g, RectangleF r, Color fill, Color border)
        {
            g.FillRectangle(B(fill), r);
            if (border != Color.Empty)
            {
                Brush b = B(border);
                g.FillRectangle(b, r.X, r.Y, r.Width, 1);
                g.FillRectangle(b, r.X, r.Bottom - 1, r.Width, 1);
                g.FillRectangle(b, r.X, r.Y, 1, r.Height);
                g.FillRectangle(b, r.Right - 1, r.Y, 1, r.Height);
            }
        }
        string Fit(Graphics g, string s, Font f, float max)
        {
            if (TW(g, s, f) <= max) return s;
            while (s.Length > 1 && TW(g, s + "…", f) > max) s = s.Substring(0, s.Length - 1);
            return s.TrimEnd() + "…";
        }
        void AddHit(RectangleF r, Action click) { Hit h = new Hit(); h.R = r; h.Click = click; _hits.Add(h); }
        void AddDrag(RectangleF r, Action<float> drag) { Hit h = new Hit(); h.R = r; h.Drag = drag; _hits.Add(h); }
        static string Num(double v, string fmt) { return double.IsNaN(v) ? "–" : v.ToString(fmt, CultureInfo.InvariantCulture); }

        // segmented control: selected item is brass
        void Segments(Graphics g, float x, float y, float w, float h, string[] labels, int selected, Action<int> pick)
        {
            float sw = w / labels.Length;
            for (int i = 0; i < labels.Length; i++)
            {
                int idx = i;
                RectangleF r = new RectangleF(x + i * sw, y, sw + (i < labels.Length - 1 ? 1 : 0), h);
                bool sel = i == selected;
                Box(g, r, sel ? Theme.Brass : Theme.Bg, sel ? Theme.Brass : Theme.Rule);
                LC(g, labels[i], sel ? Theme.OnBrass : Theme.Muted, r);
                AddHit(r, delegate { pick(idx); });
            }
        }

        void Button(Graphics g, RectangleF r, string label, Action click)
        {
            Box(g, r, Theme.Bg, Theme.RuleStrong);
            LC(g, label, Theme.Ink, r);
            AddHit(r, click);
        }

        void Stepper(Graphics g, float x, float y, int value, Action<int> step)
        {
            RectangleF minus = new RectangleF(x, y, 22, 26), plus = new RectangleF(x + 60, y, 22, 26), mid = new RectangleF(x + 21, y, 40, 26);
            Box(g, minus, Theme.Bg, Theme.Rule); TC(g, "−", _fBodyStrong, Theme.Muted, minus);
            Box(g, mid, Theme.Deep, Theme.Rule); TC(g, value + "°", _fBodyStrong, Theme.Ink, mid);
            Box(g, plus, Theme.Bg, Theme.Rule); TC(g, "+", _fBodyStrong, Theme.Muted, plus);
            AddHit(minus, delegate { step(-1); });
            AddHit(plus, delegate { step(1); });
        }

        // ---- painting ----
        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Theme.Bg);
            g.ScaleTransform(_s, _s);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            _hits.Clear();

            Snapshot s = _snap;
            int fans = s != null ? s.Fans : 2;

            // header
            L(g, (_model + "  ·  Apple T2 SMC").ToUpperInvariant(), Theme.Faint, 28, 20);
            T(g, "Fan Control", _fTitle, Theme.Ink, 27, 36);
            string[] tl = new string[2 + fans];
            string[] tv = new string[2 + fans];
            string[] tu = new string[2 + fans];
            Color[] tc = new Color[2 + fans];
            tl[0] = "CPU"; tv[0] = s == null ? "–" : Num(s.Cpu, "0"); tu[0] = "°C"; tc[0] = s == null ? Theme.Ink : Theme.TempColor(s.Cpu, Theme.Ink);
            tl[1] = "GPU"; tv[1] = s == null ? "–" : Num(s.Gpu, "0"); tu[1] = "°C"; tc[1] = s == null ? Theme.Ink : Theme.TempColor(s.Gpu, Theme.Ink);
            for (int i = 0; i < fans; i++)
            {
                tl[2 + i] = FanName(i, fans).ToUpperInvariant(); tv[2 + i] = s == null ? "–" : Num(s.Ac[i], "0"); tu[2 + i] = "RPM"; tc[2 + i] = Theme.Ink;
            }
            float tx = 1052 - tl.Length * 128 - (tl.Length - 1) * 10;
            for (int i = 0; i < tl.Length; i++)
            {
                RectangleF r = new RectangleF(tx + i * 138, 16, 128, 58);
                Box(g, r, Theme.Card, Theme.Rule);
                L(g, tl[i], Theme.Faint, r.X + 12, r.Y + 9);
                T(g, tv[i], _fMid, tc[i], r.X + 11, r.Y + 25);
                T(g, tu[i], _fSmall, Theme.Faint, r.X + 15 + TW(g, tv[i], _fMid), r.Y + 35);
            }

            // fan cards
            int shown = Math.Min(fans, 2);
            for (int i = 0; i < shown; i++) DrawFan(g, s, i, fans, 28, 92 + i * 212, 480, 196);

            DrawHistory(g, s, fans, 528, 92, 524, 408);
            DrawSensors(g, s, 28, 516, 1024, 204);

            // footer
            RectangleF sw = new RectangleF(28, 743, 34, 18);
            Box(g, sw, _startup ? Theme.Brass : Theme.Deep, _startup ? Theme.Brass : Theme.RuleStrong);
            g.FillRectangle(B(_startup ? Theme.OnBrass : Theme.Muted), _startup ? sw.Right - 15 : sw.X + 3, sw.Y + 3, 12, 12);
            T(g, "Start with Windows", _fBody, Theme.Muted, 72, 743);
            AddHit(new RectangleF(28, 738, 170, 28), delegate
            {
                try { SetStartup(!_startup); _startup = StartupEnabled(); } catch { }
                Invalidate();
            });

            string status; Color sc = Theme.Faint;
            if (_fatal != null) { status = "Cannot reach the fans: " + _fatal; sc = Theme.Hot; }
            else if (s == null) status = "Connecting to the SMC and finding sensors…";
            else if (s.Paused) { status = "Macs Fan Control is running — monitoring only until it is closed."; sc = Theme.Copper; }
            else status = "Fans return to automatic when this app exits.";
            T(g, Fit(g, status, _fBody, 470), _fBody, sc, 230, 743);

            Button(g, new RectangleF(1052 - 120 - 12 - 190, 737, 190, 30), "ALL FANS AUTOMATIC", delegate { AllAuto(); });
            Button(g, new RectangleF(1052 - 120, 737, 120, 30), "HIDE TO TRAY", delegate { Hide(); });
        }

        static string FanName(int i, int fans)
        {
            return fans == 2 ? (i == 0 ? "Left fan" : "Right fan") : "Fan " + (i + 1);
        }

        void DrawFan(Graphics g, Snapshot s, int i, int fans, float x, float y, float w, float h)
        {
            int fan = i;
            Box(g, new RectangleF(x, y, w, h), Theme.Card, Theme.Rule);
            L(g, FanName(i, fans).ToUpperInvariant(), Theme.Muted, x + 18, y + 16);

            FanCfg c;
            lock (_engine.Sync) { c = new FanCfg(); c.Mode = _engine.Cfg[i].Mode; c.Rpm = _engine.Cfg[i].Rpm; c.Sensor = _engine.Cfg[i].Sensor; c.Low = _engine.Cfg[i].Low; c.High = _engine.Cfg[i].High; }

            double ac = s == null ? double.NaN : s.Ac[i];
            double mn = s == null ? 0 : s.Mn[i], mx = s == null ? 1 : s.Mx[i];
            bool manual = s != null && s.Md[i] == 1;
            if (s != null) LR(g, manual ? "MANUAL" : "AUTOMATIC", manual ? Theme.Brass : Theme.Faint, x + w - 18, y + 16);

            string rpm = Num(ac, "0");
            T(g, rpm, _fBig, Theme.Ink, x + 17, y + 36);
            T(g, "RPM", _fSmall, Theme.Faint, x + 22 + TW(g, rpm, _fBig), y + 55);

            // gauge: actual speed against the fan's range, with the manual target marked
            float gx = x + 230, gy = y + 56, gw = w - 230 - 18;
            g.FillRectangle(B(Theme.Deep), gx, gy, gw, 6);
            if (s != null && !double.IsNaN(ac))
            {
                float f = (float)Math.Max(0, Math.Min(1, (ac - mn) / (mx - mn)));
                g.FillRectangle(B(Theme.Tide), gx, gy, Math.Max(2, gw * f), 6);
                if (manual && !double.IsNaN(s.Tg[i]))
                {
                    float tf = (float)Math.Max(0, Math.Min(1, (s.Tg[i] - mn) / (mx - mn)));
                    g.FillRectangle(B(Theme.Brass), gx + gw * tf - 1, gy - 5, 2, 16);
                }
                T(g, mn.ToString("0"), _fSmall, Theme.Faint, gx, gy + 13);
                TR(g, mx.ToString("0"), _fSmall, Theme.Faint, gx + gw, gy + 13);
            }

            Segments(g, x + 18, y + 96, w - 36, 30, new string[] { "AUTOMATIC", "CONSTANT", "SENSOR" }, c.Mode,
                delegate(int m) { Change(fan, delegate(FanCfg fc) { fc.Mode = m; }, true); });

            float dy = y + 142;
            if (s == null) return;
            if (c.Mode == 0)
            {
                T(g, "The Mac's own thermal management is in control.", _fBody, Theme.Faint, x + 18, dy + 5);
            }
            else if (c.Mode == 1)
            {
                RectangleF tr = new RectangleF(x + 18, dy, 330, 28);
                int val = (int)Math.Max(mn, Math.Min(mx, c.Rpm));
                float f = (float)((val - mn) / (mx - mn));
                g.FillRectangle(B(Theme.Deep), tr.X, tr.Y + 12, tr.Width, 4);
                g.FillRectangle(B(Theme.Brass), tr.X, tr.Y + 12, tr.Width * f, 4);
                g.FillRectangle(B(Theme.Brass), tr.X + (tr.Width - 10) * f, tr.Y + 4, 10, 20);
                TR(g, val + " RPM", _fBodyStrong, Theme.Ink, x + w - 18, dy + 5);
                double lo = mn, hi = mx;
                AddDrag(tr, delegate(float frac)
                {
                    int v = (int)(Math.Round((lo + frac * (hi - lo)) / 50.0) * 50);
                    v = (int)Math.Max(Math.Ceiling(lo), Math.Min(Math.Floor(hi), v));
                    Change(fan, delegate(FanCfg fc) { fc.Rpm = v; }, false);
                });
            }
            else
            {
                string name = c.Sensor;
                foreach (SensorItem it in s.Sensors) if (it.Key == c.Sensor) name = it.Name;
                RectangleF br = new RectangleF(x + 18, dy, 190, 26);
                Box(g, br, Theme.Bg, Theme.RuleStrong);
                T(g, Fit(g, name, _fBody, 150), _fBody, Theme.Ink, br.X + 10, br.Y + 5);
                TR(g, "▾", _fBody, Theme.Muted, br.Right - 9, br.Y + 5);
                AddHit(br, delegate { PickSensor(fan, br); });

                L(g, "FROM", Theme.Faint, x + 222, dy + 8);
                Stepper(g, x + 262, dy, c.Low, delegate(int d)
                {
                    Change(fan, delegate(FanCfg fc) { fc.Low = Math.Max(20, Math.Min(95, fc.Low + d * 5)); if (fc.High < fc.Low + 5) fc.High = fc.Low + 5; }, true);
                });
                L(g, "TO", Theme.Faint, x + 357, dy + 8);
                Stepper(g, x + 380, dy, c.High, delegate(int d)
                {
                    Change(fan, delegate(FanCfg fc) { fc.High = Math.Max(fc.Low + 5, Math.Min(105, fc.High + d * 5)); }, true);
                });
            }
        }

        void PickSensor(int fan, RectangleF anchor)
        {
            Snapshot s = _snap;
            if (s == null) return;
            ContextMenuStrip m = NewMenu();
            ToolStripMenuItem cpu = new ToolStripMenuItem("CPU"), gpu = new ToolStripMenuItem("GPU"), other = new ToolStripMenuItem("Board, battery and other");
            foreach (SensorItem it in s.Sensors)
            {
                string key = it.Key;
                ToolStripMenuItem mi = new ToolStripMenuItem(it.Name + (key.StartsWith("@") ? "" : "   " + key));
                mi.ForeColor = Theme.Ink;
                mi.Click += delegate { Change(fan, delegate(FanCfg fc) { fc.Sensor = key; }, true); };
                if (key == "@CPU") m.Items.Add(mi);
                else if (key.StartsWith("TC")) cpu.DropDownItems.Add(mi);
                else if (key.StartsWith("TG")) gpu.DropDownItems.Add(mi);
                else other.DropDownItems.Add(mi);
            }
            foreach (ToolStripMenuItem sub in new ToolStripMenuItem[] { cpu, gpu, other })
            {
                if (sub.DropDownItems.Count == 0) continue;
                ToolStripDropDownMenu dd = (ToolStripDropDownMenu)sub.DropDown;
                dd.Renderer = m.Renderer; dd.BackColor = Theme.Card; dd.ForeColor = Theme.Ink; dd.ShowImageMargin = false;
                m.Items.Add(sub);
            }
            m.Show(this, new Point((int)(anchor.X * _s), (int)(anchor.Bottom * _s)));
        }

        void DrawHistory(Graphics g, Snapshot s, int fans, float x, float y, float w, float h)
        {
            Box(g, new RectangleF(x, y, w, h), Theme.Card, Theme.Rule);
            L(g, "HISTORY", Theme.Muted, x + 18, y + 16);
            int[] ranges = new int[] { 60, 300, 1800 };
            Segments(g, x + w - 18 - 204, y + 10, 204, 24, new string[] { "1 MIN", "5 MIN", "30 MIN" }, Array.IndexOf(ranges, _range),
                delegate(int i) { _range = ranges[i]; SaveSettings(); Invalidate(); });

            float px = x + 54, pw = w - 54 - 18;
            DateTime now = _history.Count > 0 ? _history[_history.Count - 1].T : DateTime.UtcNow;

            // temperature plot
            float ty = y + 72, th = 136;
            float lx = L(g, "TEMPERATURE", Theme.Faint, x + 18, y + 48);
            T(g, "°C", _fSmall, Theme.Faint, x + 24 + lx, y + 46);
            float legend = x + w - 18;
            legend = Legend(g, "GPU " + (s == null ? "–" : Num(s.Gpu, "0") + "°"), Theme.Rose, legend, y + 46);
            legend = Legend(g, "CPU " + (s == null ? "–" : Num(s.Cpu, "0") + "°"), Theme.Brass, legend - 16, y + 46);
            Plot(g, px, ty, pw, th, 20, 100, 20, now,
                new Color[] { Theme.Brass, Theme.Rose },
                new Func<Sample, double>[] { delegate(Sample m) { return m.Cpu; }, delegate(Sample m) { return m.Gpu; } });

            // fan plot
            float fy = y + 258, fh = 104;
            lx = L(g, "FAN SPEED", Theme.Faint, x + 18, y + 234);
            T(g, "RPM", _fSmall, Theme.Faint, x + 24 + lx, y + 232);
            double top = 6000;
            if (s != null) { double mxx = 0; foreach (double v in s.Mx) mxx = Math.Max(mxx, v); top = Math.Ceiling(mxx / 2000.0) * 2000; }
            Color[] fc = new Color[] { Theme.Tide, Theme.Olive, Theme.Copper, Theme.Rose };
            int nf = Math.Min(fans, fc.Length);
            Color[] cols = new Color[nf];
            Func<Sample, double>[] gets = new Func<Sample, double>[nf];
            legend = x + w - 18;
            for (int i = nf - 1; i >= 0; i--)
            {
                int idx = i;
                cols[i] = fc[i];
                gets[i] = delegate(Sample m) { return idx < m.Fan.Length ? m.Fan[idx] : double.NaN; };
                string nm = fans == 2 ? (i == 0 ? "Left " : "Right ") : "Fan " + (i + 1) + " ";
                legend = Legend(g, nm + (s == null ? "–" : Num(s.Ac[i], "0")), fc[i], legend, y + 232) - 16;
            }
            Plot(g, px, fy, pw, fh, 0, top, 2000, now, cols, gets);

            string span = _range == 60 ? "1 min ago" : (_range == 300 ? "5 min ago" : "30 min ago");
            T(g, span, _fSmall, Theme.Faint, px, fy + fh + 8);
            TR(g, "now", _fSmall, Theme.Faint, px + pw, fy + fh + 8);
        }

        // right-aligned legend entry; returns its left edge
        float Legend(Graphics g, string text, Color c, float right, float y)
        {
            float w = TW(g, text, _fSmall);
            T(g, text, _fSmall, Theme.Muted, right - w, y);
            g.FillRectangle(B(c), right - w - 18, y + 7, 12, 2.5f);
            return right - w - 18;
        }

        void Plot(Graphics g, float x, float y, float w, float h, double min, double max, double step, DateTime now, Color[] colors, Func<Sample, double>[] gets)
        {
            g.FillRectangle(B(Theme.Deep), x, y, w, h);
            for (double v = min; v <= max + 0.001; v += step)
            {
                float gy = y + h - (float)((v - min) / (max - min)) * h;
                if (v > min && v < max) g.FillRectangle(B(Theme.Rule), x, gy, w, 1);
                TR(g, v.ToString("0"), _fSmall, Theme.Faint, x - 8, gy - 7);
            }
            Box(g, new RectangleF(x, y, w, h), Color.Empty, Theme.Rule);
            if (_history.Count < 2) return;

            Region old = g.Clip;
            g.SetClip(new RectangleF(x + 1, y + 1, w - 2, h - 2), CombineMode.Intersect);
            for (int k = 0; k < gets.Length; k++)
            {
                using (Pen pen = new Pen(colors[k], 1.7f))
                {
                    pen.LineJoin = LineJoin.Round;
                    List<PointF> pts = new List<PointF>();
                    foreach (Sample m in _history)
                    {
                        double age = (now - m.T).TotalSeconds;
                        if (age > _range + 5) continue;
                        double v = gets[k](m);
                        if (double.IsNaN(v))
                        {
                            if (pts.Count > 1) g.DrawLines(pen, pts.ToArray());
                            pts.Clear();
                            continue;
                        }
                        float px = x + w - (float)(age / _range) * w;
                        float py = y + h - (float)((Math.Max(min, Math.Min(max, v)) - min) / (max - min)) * (h - 4) - 2;
                        pts.Add(new PointF(px, py));
                    }
                    if (pts.Count > 1) g.DrawLines(pen, pts.ToArray());
                }
            }
            g.Clip = old;
        }

        void DrawSensors(Graphics g, Snapshot s, float x, float y, float w, float h)
        {
            Box(g, new RectangleF(x, y, w, h), Theme.Card, Theme.Rule);
            L(g, "SENSORS", Theme.Muted, x + 18, y + 16);
            if (s == null) return;
            int n = s.Sensors.Count;
            LR(g, n + " TEMPERATURES  ·  °C", Theme.Faint, x + w - 18, y + 16);
            const int cols = 5;
            int rows = (n + cols - 1) / cols;
            float rh = Math.Min(18f, (h - 48) / Math.Max(1, rows));
            float cw = (w - 36 - (cols - 1) * 24) / cols;
            for (int i = 0; i < n; i++)
            {
                int col = i / rows, row = i % rows;
                float cx = x + 18 + col * (cw + 24), cy = y + 40 + row * rh;
                double t = s.Temps[i];
                T(g, Fit(g, s.Sensors[i].Name, _fSmall, cw - 44), _fSmall, Theme.Muted, cx, cy);
                TR(g, Num(t, "0.0"), _fSmall, Theme.TempColor(t, Theme.Ink), cx + cw, cy);
            }
            for (int c = 1; c < cols && c * rows < n; c++)
                g.FillRectangle(B(Theme.Rule), x + 18 + c * (cw + 24) - 12, y + 42, 1, rows * rh - 4);
        }

        // ---- mouse ----
        Hit Find(MouseEventArgs e)
        {
            float x = e.X / _s, y = e.Y / _s;
            for (int i = _hits.Count - 1; i >= 0; i--) if (_hits[i].R.Contains(x, y)) return _hits[i];
            return null;
        }
        static float Frac(Hit h, float x) { return Math.Max(0f, Math.Min(1f, (x - h.R.X - 5) / (h.R.Width - 10))); }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            Hit h = Find(e);
            if (h == null) return;
            if (h.Drag != null) { _drag = h; h.Drag(Frac(h, e.X / _s)); }
            else h.Click();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            if (_drag != null) { _drag.Drag(Frac(_drag, e.X / _s)); return; }
            bool over = Find(e) != null;
            if (over != _hover) { _hover = over; Cursor = over ? Cursors.Hand : Cursors.Default; }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (_drag != null) { _drag = null; SaveSettings(); }
        }

        // ---- icons ----
        static Icon MakeAppIcon()
        {
            using (Bitmap bmp = new Bitmap(32, 32))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    using (Brush bg = new SolidBrush(Theme.Card)) g.FillEllipse(bg, 0, 0, 31, 31);
                    using (Brush b = new SolidBrush(Theme.Brass))
                    {
                        for (int k = 0; k < 3; k++) g.FillPie(b, 4, 4, 23, 23, k * 120 - 20, 62);
                    }
                    using (Brush c = new SolidBrush(Theme.Card)) g.FillEllipse(c, 12, 12, 7, 7);
                    using (Pen ring = new Pen(Theme.Brass, 1.5f)) g.DrawEllipse(ring, 1, 1, 29, 29);
                }
                return Icon.FromHandle(bmp.GetHicon());
            }
        }

        void UpdateTrayIcon(double temp)
        {
            if (double.IsNaN(temp)) return;
            int t = (int)Math.Round(temp);
            if (t == _iconTemp) return;
            _iconTemp = t;
            using (Bitmap bmp = new Bitmap(32, 32))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAlias;
                    Color back = t >= 95 ? Theme.Hot : (t >= 80 ? Theme.Copper : Theme.Brass);
                    using (Brush b = new SolidBrush(back)) g.FillEllipse(b, 0, 0, 31, 31);
                    StringFormat sf = new StringFormat();
                    sf.Alignment = StringAlignment.Center; sf.LineAlignment = StringAlignment.Center;
                    using (Font big = new Font("Segoe UI", t >= 100 ? 15f : 19f, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (Brush ink = new SolidBrush(Theme.OnBrass))
                        g.DrawString(t.ToString(CultureInfo.InvariantCulture), big, ink, new RectangleF(0, 1, 32, 32), sf);
                }
                IntPtr h = bmp.GetHicon();
                _tray.Icon = Icon.FromHandle(h);
                if (_iconHandle != IntPtr.Zero) DestroyIcon(_iconHandle);
                _iconHandle = h;
            }
        }
    }
}
