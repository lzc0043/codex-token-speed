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
public class TokenSpeedOverlay : Form {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint id);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    readonly Label label = new Label();
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    readonly Mutex mutex;
    readonly bool headless;
    volatile string text = "";
    volatile bool ended;
    bool ownsDisplay;
    bool disposed;
    bool? reportedVisible;
    void ReportVisibility(bool visible) {
        if (!ownsDisplay || reportedVisible == visible) return;
        reportedVisible = visible; Console.WriteLine(visible ? "display-visible" : "display-hidden"); Console.Out.Flush();
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020; return p; }
    }
    public TokenSpeedOverlay(bool suppressWindow) {
        headless = suppressWindow;
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
        BackColor = Color.Magenta; TransparencyKey = BackColor; AllowTransparency = true; Size = new Size(350, 26);
        AccessibleName = "Codex Token Speed: approximate t/s and cache hit rate";
        FormClosed += (sender, e) => Application.ExitThread();
        label.Dock = DockStyle.Fill; label.TextAlign = ContentAlignment.MiddleCenter;
        label.BackColor = Color.Transparent; label.ForeColor = Color.Gray; label.Font = new Font("Segoe UI", 9);
        Controls.Add(label);
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
    void Tick(object sender, EventArgs e) {
        if (ended) { timer.Stop(); Close(); Application.ExitThread(); return; }
        if (!ownsDisplay) {
            try { ownsDisplay = mutex.WaitOne(0); } catch (AbandonedMutexException) { ownsDisplay = true; }
            if (ownsDisplay) { Console.WriteLine("display-owner"); Console.Out.Flush(); }
        }
        if (ownsDisplay && label.Text != text) {
            label.Text = text; Console.WriteLine("display-text\t" + label.Text); Console.Out.Flush();
        }
        var h = GetForegroundWindow(); uint id; GetWindowThreadProcessId(h, out id);
        bool codex = false;
        try {
            string name = Process.GetProcessById((int)id).ProcessName;
            codex = name.Equals("Codex", StringComparison.OrdinalIgnoreCase) || name.Equals("ChatGPT", StringComparison.OrdinalIgnoreCase);
        } catch (Exception) { codex = false; }
        Rect r;
        if (!ownsDisplay || headless || text.Length == 0 || !codex || IsIconic(h) || !GetWindowRect(h, out r) || r.Right-r.Left < 500) { Hide(); ReportVisibility(false); return; }
        Location = new Point(r.Left + (r.Right-r.Left-Width)/2, r.Bottom-Height-15);
        if (!Visible) Show();
        ReportVisibility(Visible);
    }
    protected override void Dispose(bool disposing) {
        if (disposing && !disposed) {
            disposed = true; timer.Dispose(); if (ownsDisplay) mutex.ReleaseMutex(); mutex.Dispose();
        }
        base.Dispose(disposing);
    }
    public static void Run(bool headless) {
        SetProcessDPIAware(); Application.EnableVisualStyles();
        using (var form = new TokenSpeedOverlay(headless)) { Application.Run(); }
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing
[TokenSpeedOverlay]::Run($Headless.IsPresent)
