// Window controls drawn in the Six Minutes On... design system (Night theme):
// navy grounds, off-white ink, one brass accent, tide for keyboard focus, square corners.
// Compiled by YouTubeDownloader.ps1 with Add-Type, so it is kept to C# 5 for Windows PowerShell 5.1.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace SixMinutesOn
{
    public static class Palette
    {
        public static readonly Color Surface000 = ColorTranslator.FromHtml("#03070c"); // page ground
        public static readonly Color Surface100 = ColorTranslator.FromHtml("#091a2e"); // bands
        public static readonly Color Surface200 = ColorTranslator.FromHtml("#0d2440"); // cards, inputs
        public static readonly Color Surface300 = ColorTranslator.FromHtml("#14304f"); // hover, selected
        public static readonly Color Ink = ColorTranslator.FromHtml("#eaebed");
        public static readonly Color InkMuted = ColorTranslator.FromHtml("#a3adb8");
        public static readonly Color InkFaint = ColorTranslator.FromHtml("#7d8690");
        public static readonly Color Brass = ColorTranslator.FromHtml("#d5a867");
        public static readonly Color BrassFill = ColorTranslator.FromHtml("#d5a867");
        public static readonly Color OnBrass = ColorTranslator.FromHtml("#1a1206");
        public static readonly Color Tide = ColorTranslator.FromHtml("#86bfdb");
        public static readonly Color Rule = ColorTranslator.FromHtml("#24395a");
        public static readonly Color RuleStrong = ColorTranslator.FromHtml("#647b98");

        // Disabled = 45% opacity: the colour mixed over its background.
        public static Color Fade(Color fg, Color bg) { return Mix(fg, bg, 0.45); }
        public static Color Mix(Color fg, Color bg, double a)
        {
            return Color.FromArgb(
                (int)Math.Round(fg.R * a + bg.R * (1 - a)),
                (int)Math.Round(fg.G * a + bg.G * (1 - a)),
                (int)Math.Round(fg.B * a + bg.B * (1 - a)));
        }

        // Wide tracking is the brand's signature; GDI has none, so hair spaces stand in for it.
        public static string Track(string text)
        {
            if (string.IsNullOrEmpty(text)) return text;
            var up = text.ToUpperInvariant();
            var sb = new System.Text.StringBuilder(up.Length * 2);
            for (int i = 0; i < up.Length; i++)
            {
                if (i > 0) sb.Append('\u200A');
                sb.Append(up[i]);
            }
            return sb.ToString();
        }

        static Font ByName(string[] names, float size, FontStyle style)
        {
            var installed = new System.Drawing.Text.InstalledFontCollection();
            foreach (var n in names)
                foreach (var f in installed.Families)
                    if (string.Equals(f.Name, n, StringComparison.OrdinalIgnoreCase)) return new Font(n, size, style);
            return new Font(FontFamily.GenericSansSerif, size, style);
        }
        // Inter if it is installed (free from Google Fonts), else Segoe UI, which every Windows has.
        public static Font Regular(float size) { return ByName(new[] { "Inter", "Segoe UI" }, size, FontStyle.Regular); }
        public static Font Medium(float size) { return ByName(new[] { "Inter Medium", "Segoe UI Semibold", "Inter", "Segoe UI" }, size, FontStyle.Regular); }
        public static Font Light(float size) { return ByName(new[] { "Inter Light", "Segoe UI Light", "Inter", "Segoe UI" }, size, FontStyle.Regular); }
        public static Font Mono(float size) { return ByName(new[] { "Cascadia Mono", "Consolas" }, size, FontStyle.Regular); }
    }

    public static class Native
    {
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)] static extern int SetWindowTheme(IntPtr hwnd, string app, string idList);

        static int Ref(Color c) { return c.R | (c.G << 8) | (c.B << 16); }

        // Dark title bar (Windows 10 2004+), in surface-000 with ink text on Windows 11.
        public static void DarkTitleBar(Form f)
        {
            try
            {
                int on = 1;
                if (DwmSetWindowAttribute(f.Handle, 20, ref on, 4) != 0) DwmSetWindowAttribute(f.Handle, 19, ref on, 4);
                int caption = Ref(Palette.Surface000), text = Ref(Palette.Ink), border = Ref(Palette.Rule);
                DwmSetWindowAttribute(f.Handle, 35, ref caption, 4);
                DwmSetWindowAttribute(f.Handle, 36, ref text, 4);
                DwmSetWindowAttribute(f.Handle, 34, ref border, 4);
            }
            catch { }
        }

        // Dark scroll bars on a text box.
        public static void DarkScrollBars(Control c)
        {
            try { SetWindowTheme(c.Handle, "DarkMode_Explorer", null); } catch { }
        }
    }

    // Square button. Primary: brass fill with on-brass text, ink on hover.
    // Quiet: rule-strong outline and ink-muted text, brass outline and ink text on hover.
    public class FlatButton : Button
    {
        bool hover, down;
        public bool Primary { get; set; }

        public FlatButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            FlatStyle = FlatStyle.Flat;
            Cursor = Cursors.Hand;
            BackColor = Palette.Surface000;
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
        protected override void OnEnabledChanged(EventArgs e) { Cursor = Enabled ? Cursors.Hand : Cursors.Default; Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            var ground = Parent != null ? Parent.BackColor : Palette.Surface000;
            Color fill, border, text;
            bool lit = Enabled && (hover || down);
            if (Primary)
            {
                fill = !Enabled ? ground : (lit ? Palette.Ink : Palette.BrassFill);
                border = !Enabled ? Palette.Fade(Palette.BrassFill, ground) : fill;
                text = !Enabled ? Palette.Fade(Palette.BrassFill, ground) : Palette.OnBrass;
            }
            else
            {
                fill = ground;
                border = !Enabled ? Palette.Fade(Palette.RuleStrong, ground) : (lit ? Palette.Brass : Palette.RuleStrong);
                text = !Enabled ? Palette.Fade(Palette.InkMuted, ground) : (lit ? Palette.Ink : Palette.InkMuted);
            }
            g.Clear(fill);
            var r = ClientRectangle;
            using (var p = new Pen(border)) g.DrawRectangle(p, 0, 0, r.Width - 1, r.Height - 1);
            if (Focused && ShowFocusCues && Enabled)
                using (var p = new Pen(Palette.Tide, 2)) g.DrawRectangle(p, 1, 1, r.Width - 2, r.Height - 2);
            TextRenderer.DrawText(g, Palette.Track(Text), Font, r, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        }
    }

    // Slim progress rule: brass-fill on a surface-200 track. Busy slides a brass segment along it.
    public class SlimBar : Control
    {
        int value;
        bool busy;
        float phase;
        readonly Timer anim = new Timer();

        public SlimBar()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            TabStop = false;
            anim.Interval = 30;
            anim.Tick += delegate { phase += 0.012f; if (phase > 1.3f) phase = -0.3f; Invalidate(); };
        }
        public int Value { get { return value; } set { this.value = Math.Max(0, Math.Min(1000, value)); Invalidate(); } }
        public bool Busy
        {
            get { return busy; }
            set { busy = value; if (busy) { phase = -0.3f; anim.Start(); } else anim.Stop(); Invalidate(); }
        }
        protected override void Dispose(bool disposing) { if (disposing) anim.Dispose(); base.Dispose(disposing); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Palette.Surface200);
            using (var b = new SolidBrush(Palette.BrassFill))
            {
                if (busy)
                {
                    int w = Width / 4, x = (int)(phase * Width);
                    g.FillRectangle(b, x, 0, w, Height);
                }
                else if (value > 0)
                    g.FillRectangle(b, 0, 0, (int)(Width * (value / 1000.0)), Height);
            }
        }
    }

    // A text field: surface-200 ground, rule-strong outline, brass on hover, tide when it has focus.
    public class Field : Panel
    {
        bool hover;
        public readonly TextBox Box = new TextBox();

        public Field()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Palette.Surface200;
            Padding = new Padding(10, 0, 10, 0);
            Box.BorderStyle = BorderStyle.None;
            Box.BackColor = Palette.Surface200;
            Box.ForeColor = Palette.Ink;
            Controls.Add(Box);
            Box.GotFocus += delegate { Invalidate(); };
            Box.LostFocus += delegate { Invalidate(); };
            Box.MouseEnter += delegate { hover = true; Invalidate(); };
            Box.MouseLeave += delegate { hover = false; Invalidate(); };
            Click += delegate { Box.Focus(); };
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            Box.Font = Font;
            Box.Width = Width - Padding.Left - Padding.Right;
            Box.Location = new Point(Padding.Left, Math.Max(0, (Height - Box.Height) / 2));
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(BackColor);
            var r = ClientRectangle;
            if (Box.Focused)
                using (var p = new Pen(Palette.Tide, 2)) g.DrawRectangle(p, 1, 1, r.Width - 2, r.Height - 2);
            else
                using (var p = new Pen(hover && !Box.ReadOnly ? Palette.Brass : Palette.RuleStrong)) g.DrawRectangle(p, 0, 0, r.Width - 1, r.Height - 1);
        }
    }

    // Square check box: rule-strong box, brass when ticked, with an on-brass tick.
    public class Check : CheckBox
    {
        bool hover;
        public Check()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            Cursor = Cursors.Hand;
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnEnabledChanged(EventArgs e) { Cursor = Enabled ? Cursors.Hand : Cursors.Default; Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            var ground = Parent != null ? Parent.BackColor : Palette.Surface000;
            g.Clear(ground);
            int s = 16, y = (Height - s) / 2;
            var box = new Rectangle(2, y, s, s);
            bool lit = Enabled && hover;
            Color edge = Checked ? Palette.BrassFill : (lit ? Palette.Brass : Palette.RuleStrong);
            Color text = Checked || lit ? Palette.Ink : Palette.InkMuted;
            if (!Enabled) { edge = Palette.Fade(edge, ground); text = Palette.Fade(Palette.InkMuted, ground); }
            if (Checked)
            {
                using (var b = new SolidBrush(edge)) g.FillRectangle(b, box);
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                using (var p = new Pen(Enabled ? Palette.OnBrass : ground, 2f))
                    g.DrawLines(p, new[] { new PointF(box.X + 3.5f, box.Y + 8.5f), new PointF(box.X + 6.5f, box.Y + 11.5f), new PointF(box.X + 12.5f, box.Y + 4.5f) });
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.Default;
            }
            else
                using (var p = new Pen(edge)) g.DrawRectangle(p, box.X, box.Y, s - 1, s - 1);
            if (Focused && ShowFocusCues && Enabled)
                using (var p = new Pen(Palette.Tide, 2)) g.DrawRectangle(p, box.X - 2, box.Y - 2, s + 3, s + 3);
            var tr = new Rectangle(box.Right + 10, 0, Width - box.Right - 10, Height);
            TextRenderer.DrawText(g, Text, Font, tr, text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
        }
    }

    // A drop-down choice drawn like a quiet field: current choice and a chevron; opens a dark menu.
    public class Picker : Control
    {
        bool hover;
        readonly List<string> items = new List<string>();
        int index = -1;
        public event EventHandler SelectedChanged;

        public Picker()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.Selectable, true);
            TabStop = true;
            Cursor = Cursors.Hand;
            BackColor = Palette.Surface200;
        }
        public List<string> Items { get { return items; } }
        public string SelectedItem
        {
            get { return index >= 0 && index < items.Count ? items[index] : null; }
            set { int i = items.IndexOf(value); if (i >= 0) Select(i); }
        }
        void Select(int i)
        {
            if (i < 0 || i >= items.Count || i == index) return;
            index = i;
            AccessibleName = items[i];
            Invalidate();
            if (SelectedChanged != null) SelectedChanged(this, EventArgs.Empty);
        }
        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Cursor = Enabled ? Cursors.Hand : Cursors.Default; Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnMouseDown(MouseEventArgs e) { Focus(); if (e.Button == MouseButtons.Left) Open(); base.OnMouseDown(e); }
        protected override bool IsInputKey(Keys k) { return k == Keys.Up || k == Keys.Down || base.IsInputKey(k); }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Up) { Select(index - 1); e.Handled = true; }
            else if (e.KeyCode == Keys.Down && e.Alt) { Open(); e.Handled = true; }
            else if (e.KeyCode == Keys.Down) { Select(index + 1); e.Handled = true; }
            else if (e.KeyCode == Keys.Space || e.KeyCode == Keys.F4) { Open(); e.Handled = true; }
            base.OnKeyDown(e);
        }

        void Open()
        {
            var menu = new ContextMenuStrip();
            menu.Renderer = new DarkMenuRenderer();
            menu.ShowImageMargin = false;
            menu.BackColor = Palette.Surface200;
            menu.Font = Font;
            for (int i = 0; i < items.Count; i++)
            {
                int n = i;
                var it = new ToolStripMenuItem(items[i]);
                it.ForeColor = i == index ? Palette.Brass : Palette.Ink;
                it.AutoSize = false;
                it.Size = new Size(Width - 2, Height);
                it.Click += delegate { Select(n); };
                menu.Items.Add(it);
            }
            menu.Closed += delegate { menu.BeginInvoke(new MethodInvoker(menu.Dispose)); };
            menu.Show(this, new Point(0, Height));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            var ground = Palette.Surface200;
            g.Clear(ground);
            var r = ClientRectangle;
            bool lit = Enabled && hover;
            Color edge = !Enabled ? Palette.Fade(Palette.RuleStrong, ground) : (lit ? Palette.Brass : Palette.RuleStrong);
            Color text = !Enabled ? Palette.Fade(Palette.Ink, ground) : Palette.Ink;
            using (var p = new Pen(edge)) g.DrawRectangle(p, 0, 0, r.Width - 1, r.Height - 1);
            if (Focused && ShowFocusCues && Enabled)
                using (var p = new Pen(Palette.Tide, 2)) g.DrawRectangle(p, 1, 1, r.Width - 2, r.Height - 2);
            var tr = new Rectangle(10, 0, r.Width - 40, r.Height);
            TextRenderer.DrawText(g, SelectedItem ?? "", Font, tr, text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix | TextFormatFlags.EndEllipsis);
            // chevron
            int cx = r.Width - 18, cy = r.Height / 2;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            using (var p = new Pen(!Enabled ? Palette.Fade(Palette.Brass, ground) : Palette.Brass, 1.5f))
                g.DrawLines(p, new[] { new PointF(cx - 4.5f, cy - 2f), new PointF(cx, cy + 2.5f), new PointF(cx + 4.5f, cy - 2f) });
        }
    }

    public class DarkMenuRenderer : ToolStripRenderer
    {
        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { e.Graphics.Clear(Palette.Surface200); }
        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            using (var p = new Pen(Palette.RuleStrong)) e.Graphics.DrawRectangle(p, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
        }
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            var r = new Rectangle(Point.Empty, e.Item.Size);
            using (var b = new SolidBrush(e.Item.Selected ? Palette.Surface300 : Palette.Surface200)) e.Graphics.FillRectangle(b, r);
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            var r = new Rectangle(10, 0, e.Item.Width - 12, e.Item.Height);
            TextRenderer.DrawText(e.Graphics, e.Text, e.TextFont, r, e.Item.Selected ? Palette.Brass : e.Item.ForeColor,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        }
    }

    // A message box in the brand colours, in place of the grey Windows one.
    public static class Notice
    {
        public static void Show(IWin32Window owner, string heading, string message)
        {
            using (var f = new Form())
            {
                f.Text = "YouTube Downloader";
                f.FormBorderStyle = FormBorderStyle.FixedDialog;
                f.MinimizeBox = false; f.MaximizeBox = false; f.ShowInTaskbar = false;
                f.StartPosition = FormStartPosition.CenterParent;
                f.BackColor = Palette.Surface000;
                f.Font = Palette.Regular(10f);
                f.ClientSize = new Size(440, 190);
                f.HandleCreated += delegate { Native.DarkTitleBar(f); };

                var eyebrow = new Label();
                eyebrow.Text = Palette.Track(heading);
                eyebrow.Font = Palette.Medium(8.5f);
                eyebrow.ForeColor = Palette.Brass;
                eyebrow.SetBounds(24, 20, 392, 20);
                f.Controls.Add(eyebrow);

                var text = new Label();
                text.Text = message;
                text.ForeColor = Palette.Ink;
                text.SetBounds(24, 46, 392, 80);
                f.Controls.Add(text);

                var ok = new FlatButton();
                ok.Primary = true;
                ok.Text = "OK";
                ok.Font = Palette.Medium(9f);
                ok.DialogResult = DialogResult.OK;
                ok.SetBounds(316, 136, 100, 36);
                f.Controls.Add(ok);
                f.AcceptButton = ok; f.CancelButton = ok;
                f.ShowDialog(owner);
            }
        }
    }
}
