$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
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
    volatile string text = "\u2248 -- t/s   \u00b7   \u7f13\u5b58\u547d\u4e2d --";
    volatile bool ended;
    bool ownsDisplay;
    bool disposed;
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x00000080 | 0x00000020; return p; }
    }
    public TokenSpeedOverlay() {
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
        BackColor = Color.FromArgb(36, 36, 36); Opacity = 0.94; Size = new Size(350, 26);
        AccessibleName = "Codex Token Speed: approximate t/s and cache hit rate";
        FormClosed += (sender, e) => Application.ExitThread();
        label.Dock = DockStyle.Fill; label.TextAlign = ContentAlignment.MiddleCenter;
        label.ForeColor = Color.Gainsboro; label.Font = new Font("Segoe UI", 10);
        Controls.Add(label);
        string user = System.Security.Principal.WindowsIdentity.GetCurrent().User.Value;
        mutex = new Mutex(false, "Local\\CodexTokenSpeed-" + user);
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
        var h = GetForegroundWindow(); uint id; GetWindowThreadProcessId(h, out id);
        bool codex = false;
        try {
            string name = Process.GetProcessById((int)id).ProcessName;
            codex = name.Equals("Codex", StringComparison.OrdinalIgnoreCase) || name.Equals("ChatGPT", StringComparison.OrdinalIgnoreCase);
        } catch (Exception) { codex = false; }
        Rect r;
        if (!ownsDisplay || !codex || IsIconic(h) || !GetWindowRect(h, out r) || r.Right-r.Left < 500) { Hide(); return; }
        label.Text = text; Location = new Point(r.Left + (r.Right-r.Left-Width)/2, r.Bottom-Height-5);
        if (!Visible) Show();
    }
    protected override void Dispose(bool disposing) {
        if (disposing && !disposed) {
            disposed = true; timer.Dispose(); if (ownsDisplay) mutex.ReleaseMutex(); mutex.Dispose();
        }
        base.Dispose(disposing);
    }
    public static void Run() {
        SetProcessDPIAware(); Application.EnableVisualStyles();
        using (var form = new TokenSpeedOverlay()) { Application.Run(); }
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies System.Windows.Forms, System.Drawing
[TokenSpeedOverlay]::Run()
