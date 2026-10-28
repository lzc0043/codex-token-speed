param([switch]$Headless)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$source = @'
using System;
using System.Drawing;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Globalization;
using System.Drawing.Imaging;
public class MeterIcon : PictureBox {
    public float ImageAlpha = 1;
    protected override void OnPaint(PaintEventArgs e) {
        if (Image == null) return;
        using (var attributes = new ImageAttributes()) {
            var matrix = new ColorMatrix(); matrix.Matrix33 = ImageAlpha;
            attributes.SetColorMatrix(matrix);
            e.Graphics.DrawImage(Image, ClientRectangle, 0, 0, Image.Width, Image.Height, GraphicsUnit.Pixel, attributes);
        }
    }
}
public class TokenSpeedOverlay : Form {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, out bool value, uint flags);
    readonly Label speedField, unitField, cacheField;
    readonly Font numberFont, labelFont;
    readonly MeterIcon gaugeIcon, cacheIcon;
    readonly float scale;
    readonly Color numberColor, mutedColor = Color.FromArgb(140, 140, 140);
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly Mutex mutex;
    readonly bool headless;
    volatile string text = "";
    string lastInput, renderedText = "";
    volatile bool ended;
    bool ownsDisplay;
    bool disposed;
    bool? reportedVisible;
    string activity = "idle";
    bool speedFresh, animating, muted;
    void ReportVisibility(bool visible) {
        if (!ownsDisplay || reportedVisible == visible) return;
        reportedVisible = visible; Console.WriteLine(visible ? "display-visible" : "display-hidden"); Console.Out.Flush();
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020; return p; }
    }
    int Px(int value) { return (int)Math.Round(value * scale); }
    Point? MeterLocation(Rect r) {
        // shortcut: reserve control space geometrically until Codex exposes a composer slot.
        int contentWidth = Math.Min(Px(800), r.Right-r.Left-Px(48));
        int left = r.Left + (r.Right-r.Left-contentWidth)/2 + Px(150);
        int right = r.Left + (r.Right-r.Left+contentWidth)/2 - Px(320);
        return right-left < Width ? (Point?)null : new Point((left+right-Width)/2, r.Bottom-Height-Px(27));
    }
    float BaselineOffset(Font font) {
        return (Px(22) - font.GetHeight(DeviceDpi)) / 2f + font.SizeInPoints * DeviceDpi / 72f * font.FontFamily.GetCellAscent(font.Style) / font.FontFamily.GetEmHeight(font.Style);
    }
    Label Field(string value, int x, int width, bool numeric) {
        var view = new Label();
        view.AutoSize = false; view.BackColor = Color.Transparent;
        view.Font = numeric ? numberFont : labelFont; view.ForeColor = numeric ? numberColor : mutedColor;
        view.TextAlign = ContentAlignment.MiddleLeft;
        int y = Px(2) + (numeric ? (int)Math.Round(BaselineOffset(labelFont) - BaselineOffset(numberFont)) : 0);
        view.SetBounds(Px(x), y, Px(width), Px(22)); view.Text = value; Controls.Add(view); return view;
    }
    MeterIcon AddIcon(string root, string name, int x) {
        Image image;
        using (var source = Image.FromFile(System.IO.Path.Combine(root, name + ".png"))) image = new Bitmap(source);
        var view = new MeterIcon(); view.BackColor = Color.Transparent; view.Image = image;
        float textCenter = Px(2) + BaselineOffset(labelFont) - numberFont.SizeInPoints * DeviceDpi / 72f * 0.35f;
        view.SetBounds(Px(x), (int)Math.Round(textCenter-Px(7)), Px(14), Px(14));
        view.TabStop = false; Controls.Add(view); return view;
    }
    public TokenSpeedOverlay(bool suppressWindow, string iconRoot) {
        headless = suppressWindow;
        scale = DeviceDpi / 96f; AutoScaleMode = AutoScaleMode.None;
        labelFont = new Font("Segoe UI", 9);
        numberFont = new Font("Consolas", 9);
        if (numberFont.Name != "Consolas") { numberFont.Dispose(); numberFont = new Font(FontFamily.GenericMonospace, 9); }
        bool dark = Convert.ToInt32(Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1)) == 0;
        numberColor = dark ? Color.FromArgb(204, 204, 204) : Color.FromArgb(102, 102, 102);
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
        BackColor = Color.Magenta; TransparencyKey = BackColor; AllowTransparency = true; ClientSize = new Size(Px(248), Px(26));
        AccessibleName = "Codex Token Speed: approximate t/s and cache hit rate";
        FormClosed += (sender, e) => Application.ExitThread();
        speedField = Field("", 22, 48, true); unitField = Field("t/s", 72, 22, false);
        Field("\u00b7", 98, 8, false); Field("\u4f1a\u8bdd\u7f13\u5b58", 128, 54, false);
        cacheField = Field("", 186, 54, true);
        gaugeIcon = AddIcon(iconRoot, "gauge", 4); cacheIcon = AddIcon(iconRoot, "database", 110);
        if (headless) {
            if (MeterLocation(new Rect { Left = 0, Top = 0, Right = Px(650), Bottom = Px(900) }) != null) throw new InvalidOperationException("Narrow metrics must be hidden");
            foreach (int width in new[] { 800, 1100, 1512, 2400 }) {
                var r = new Rect { Left = -Px(300), Top = 0, Right = Px(width-300), Bottom = Px(900) };
                Point? point = MeterLocation(r);
                int content = Math.Min(Px(800), Px(width-48));
                if (point == null || point.Value.X < r.Left+(Px(width)-content)/2+Px(150) || point.Value.X+Width > r.Left+(Px(width)+content)/2-Px(320) || point.Value.Y+Height != r.Bottom-Px(27)) throw new InvalidOperationException("Metrics overlap reserved controls");
            }
        }
        string user = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        string home = Environment.GetEnvironmentVariable("CODEX_HOME") ?? System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
        string key;
        using (var hash = System.Security.Cryptography.SHA256.Create()) {
            key = BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(System.IO.Path.GetFullPath(home).ToUpperInvariant()))).Replace("-", "");
        }
        mutex = new Mutex(false, "Local\\CodexTokenSpeed-" + user + "-" + key);
        var reader = new Thread(() => {
            try { string line; while ((line = Console.ReadLine()) != null) if (line.Length <= 512) text = line; }
            finally { ended = true; }
        });
        reader.IsBackground = true; reader.Start();
        timer.Interval = 200; timer.Tick += Tick; timer.Start();
    }
    bool Number(string value, double max) {
        double parsed;
        return Double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed) && !Double.IsNaN(parsed) && !Double.IsInfinity(parsed) && parsed >= 0 && parsed <= max;
    }
    void UpdateActivity() {
        bool animations;
        animating = activity == "generating" && SystemParametersInfo(0x1042, 0, out animations, 0) && animations;
        gaugeIcon.ImageAlpha = animating ? (float)(0.8 + 0.2 * Math.Sin(Stopwatch.GetTimestamp() / (double)Stopwatch.Frequency * Math.PI / 0.9)) : 1;
        gaugeIcon.Invalidate();
        muted = activity == "tool" || (activity == "generating" && !speedFresh);
        speedField.ForeColor = muted ? Color.FromArgb((numberColor.R+mutedColor.R)/2, (numberColor.G+mutedColor.G)/2, (numberColor.B+mutedColor.B)/2) : numberColor;
        AccessibleDescription = activity + (speedFresh ? "; recent approximate speed" : "; previous approximate speed");
    }
    void ApplyReading(string input) {
        var frame = input.Split('\t');
        bool valid = frame.Length == 3 && Array.IndexOf(new[] { "idle", "generating", "tool", "complete" }, frame[1]) >= 0 && (frame[2] == "0" || frame[2] == "1");
        input = valid ? frame[0] : "";
        activity = valid ? frame[1] : "idle"; speedFresh = valid && frame[2] == "1";
        string speed = "", cache = "", prefix = "\u4f1a\u8bdd\u7f13\u5b58 ";
        var parts = input.Split(new[] { "   \u00b7   " }, StringSplitOptions.None);
        if (parts.Length == 2 && parts[0].EndsWith(" t/s", StringComparison.Ordinal) && parts[1].StartsWith(prefix, StringComparison.Ordinal)) {
            speed = parts[0].Substring(0, parts[0].Length - 4); cache = parts[1].Substring(prefix.Length);
            bool validSpeed = speed == "--" || Number(speed, Double.MaxValue);
            bool validCache = cache == "--" || (cache.EndsWith("%", StringComparison.Ordinal) && Number(cache.Substring(0, cache.Length - 1), 100));
            if (!validSpeed || !validCache) { speed = ""; cache = ""; }
        }
        if (speed.Length == 0 || cache.Length == 0) { activity = "idle"; speedFresh = false; }
        speedField.Text = speed; cacheField.Text = cache;
        speedField.Width = Math.Min(Px(48), TextRenderer.MeasureText(speed, numberFont, Size.Empty, TextFormatFlags.NoPadding).Width+Px(6));
        speedField.Left = unitField.Left-speedField.Width;
        gaugeIcon.Left = speedField.Left-Px(18);
        UpdateActivity();
        renderedText = speed.Length == 0 || cache.Length == 0 ? "" : speedField.Text + " t/s   \u00b7   " + prefix + cacheField.Text;
        var widths = new string[10]; int iconCount = 0;
        foreach (Control view in Controls) if (view is PictureBox) iconCount++;
        for (int i = 0; i < 10; i++) widths[i] = TextRenderer.MeasureText(i.ToString(CultureInfo.InvariantCulture), numberFont).Width.ToString(CultureInfo.InvariantCulture);
        Console.WriteLine(String.Format(CultureInfo.InvariantCulture,
            "display-layout\t{{\"speedX\":{0},\"speedWidth\":{1},\"cacheGroupX\":{2},\"cacheX\":{3},\"cacheWidth\":{4},\"digitWidths\":[{5}],\"iconCount\":{6},\"fontSize\":{7},\"speedBaseline\":{8},\"unitBaseline\":{9},\"bottomInset\":27,\"unitX\":{10},\"speedGroupEnd\":{11},\"iconEnd\":{12},\"iconCenter\":{13},\"textCenter\":{14},\"activity\":\"{15}\",\"speedFresh\":{16},\"muted\":{17},\"animating\":{18},\"pulseAlpha\":{19}}}",
            speedField.Left, speedField.Width, cacheIcon.Left, cacheField.Left, cacheField.Width, String.Join(",", widths), iconCount, numberFont.SizeInPoints,
            speedField.Top + BaselineOffset(numberFont), unitField.Top + BaselineOffset(labelFont), unitField.Left, Px(98), gaugeIcon.Right,
            gaugeIcon.Top+gaugeIcon.Height/2f, Px(2)+BaselineOffset(labelFont)-numberFont.SizeInPoints*DeviceDpi/72f*0.35f,
            activity, speedFresh ? "true" : "false", muted ? "true" : "false", animating ? "true" : "false", gaugeIcon.ImageAlpha));
        Console.WriteLine("display-text\t" + renderedText); Console.Out.Flush();
    }
    void Tick(object sender, EventArgs e) {
        if (ended) { timer.Stop(); Close(); Application.ExitThread(); return; }
        if (!ownsDisplay) {
            try { ownsDisplay = mutex.WaitOne(0); } catch (AbandonedMutexException) { ownsDisplay = true; }
            if (ownsDisplay) { Console.WriteLine("display-owner"); Console.Out.Flush(); }
        }
        if (ownsDisplay && lastInput != text) {
            lastInput = text; ApplyReading(text);
        }
        if (ownsDisplay) UpdateActivity();
        var h = GetForegroundWindow(); uint id; GetWindowThreadProcessId(h, out id);
        bool codex = false;
        try {
            string name = Process.GetProcessById((int)id).ProcessName;
            codex = name.Equals("Codex", StringComparison.OrdinalIgnoreCase) || name.Equals("ChatGPT", StringComparison.OrdinalIgnoreCase);
        } catch (Exception) { codex = false; }
        Rect r;
        if (!ownsDisplay || headless || renderedText.Length == 0 || !codex || IsIconic(h) || !GetWindowRect(h, out r) || r.Right-r.Left < Px(500)) { Hide(); ReportVisibility(false); return; }
        Point? location = MeterLocation(r);
        if (location == null) { Hide(); ReportVisibility(false); return; }
        Location = location.Value;
        if (!Visible) Show();
        ReportVisibility(Visible);
    }
    protected override void Dispose(bool disposing) {
        if (disposing && !disposed) {
            disposed = true; timer.Dispose(); if (ownsDisplay) mutex.ReleaseMutex(); mutex.Dispose();
            gaugeIcon.Image.Dispose(); cacheIcon.Image.Dispose(); numberFont.Dispose(); labelFont.Dispose();
        }
        base.Dispose(disposing);
    }
    public static void Run(bool headless, string iconRoot) {
        SetProcessDPIAware(); Application.EnableVisualStyles();
        using (var form = new TokenSpeedOverlay(headless, iconRoot)) { Application.Run(); }
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing
[TokenSpeedOverlay]::Run($Headless.IsPresent, (Join-Path (Split-Path $PSScriptRoot -Parent) 'assets/icons'))
