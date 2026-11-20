// 本地记忆 · 原生窗口版（WebView2）
//
// 为什么不是"打开浏览器"：
//   浏览器有地址栏、标签页、书签栏，看起来就不是个软件。
//   这里用 Windows 自带的 WebView2（Edge 内核，Win10/11 普遍预装）
//   把同一个界面嵌进我们自己的窗口里 —— 用户看到的是一个独立的桌面应用。
//
// 它仍然复用现有后端（node app/server.mjs），所以数据、插件、MCP 全部一致。
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    static Process server;
    static string baseUrl = null;
    static Label status;
    static WebView2 web;
    static Form form;
    static NotifyIcon tray;
    static bool reallyExit = false;
    static Mutex singleMutex = null;
    static EventWaitHandle showSignal = null;
    // 单实例用的名字。Local\ 前缀 = 只在本机当前登录会话内生效，正好。
    const string SingleMutexName = @"Local\dsh-local-memory-app-single";
    const string ShowSignalName = @"Local\dsh-local-memory-app-show";

    static string ExeDir { get { return Path.GetDirectoryName(Application.ExecutablePath); } }

    static string DshHome
    {
        get
        {
            string env = Environment.GetEnvironmentVariable("DSH_HOME");
            if (!string.IsNullOrEmpty(env)) return env;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        }
    }

    /// node 可能在：PATH / 常见安装目录 / DSH 自带的 runtime
    static string FindNode()
    {
        string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in pathVar.Split(';'))
        {
            try
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                string c = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(c)) return c;
            }
            catch { }
        }
        string[] cands = new string[]
        {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"),
            Path.Combine(DshHome, @"dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\DeepSeek Harness\resources\runtime\node\node.exe"),
        };
        foreach (string c in cands) { try { if (File.Exists(c)) return c; } catch { } }
        return null;
    }

    static int[] ReadState()
    {
        try
        {
            string f = Path.Combine(DshHome, "local-memory", "instance.json");
            if (!File.Exists(f)) return null;
            string txt = File.ReadAllText(f);
            Match mp = Regex.Match(txt, "\"port\"\\s*:\\s*(\\d+)");
            Match mi = Regex.Match(txt, "\"pid\"\\s*:\\s*(\\d+)");
            if (!mp.Success || !mi.Success) return null;
            return new int[] { int.Parse(mp.Groups[1].Value), int.Parse(mi.Groups[1].Value) };
        }
        catch { return null; }
    }

    static bool IsAlive(int port)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/dsh-local-memory/state");
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            using (var resp = (HttpWebResponse)req.GetResponse())
            {
                return (int)resp.StatusCode == 200;
            }
        }
        catch { return false; }
    }

    /// 返回可用的地址；失败返回 null 并给出原因
    static string EnsureServer(out string err)
    {
        err = null;
        int[] st = ReadState();
        if (st != null && IsAlive(st[0]))
            return "http://127.0.0.1:" + st[0] + "/";

        string node = FindNode();
        if (node == null) { err = "找不到 Node.js。请安装 Node 18+ 或 DeepSeek Harness。"; return null; }

        string serverJs = Path.Combine(ExeDir, "app", "server.mjs");
        if (!File.Exists(serverJs)) { err = "安装不完整：缺少 app\\server.mjs"; return null; }

        var psi = new ProcessStartInfo();
        psi.FileName = node;
        psi.Arguments = "\"" + serverJs + "\" --port 0 --host 127.0.0.1"
            + " --state \"" + Path.Combine(DshHome, "local-memory") + "\""
            + " --data \"" + DshHome + "\""
            + " --parent-pid " + Process.GetCurrentProcess().Id
            + " --idle-min 0";
        psi.WorkingDirectory = ExeDir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;

        try { server = Process.Start(psi); }
        catch (Exception e) { err = "启动后端失败：" + e.Message; return null; }

        for (int i = 0; i < 100; i++)
        {
            Thread.Sleep(200);
            st = ReadState();
            if (st != null && IsAlive(st[0]))
                return "http://127.0.0.1:" + st[0] + "/";
        }
        err = "后端启动超时（20 秒）。";
        return null;
    }

    [STAThread]
    static void Main()
    {
        // ── 单实例保护 ──
        // 之前没这段：应用已经在托盘里跑着时，再双击图标会开出第二个窗口进程。
        // 现在第二个进程只负责"把已有的那个叫到前台"，自己马上退出。
        bool createdNew;
        singleMutex = new Mutex(true, SingleMutexName, out createdNew);
        if (!createdNew)
        {
            try
            {
                EventWaitHandle ev = EventWaitHandle.OpenExisting(ShowSignalName);
                ev.Set();
                ev.Dispose();
            }
            catch { /* 老实例还没准备好信号就静默退出，不打扰用户 */ }
            return;
        }

        Application.EnableVisualStyles();

        form = new Form();
        form.Text = "本地记忆";
        form.Width = 1280;
        form.Height = 880;
        form.MinimumSize = new Size(900, 600);
        form.StartPosition = FormStartPosition.CenterScreen;
        form.BackColor = Color.FromArgb(20, 22, 26);

        status = new Label();
        status.Text = "正在启动…";
        status.ForeColor = Color.FromArgb(180, 186, 196);
        status.Dock = DockStyle.Fill;
        status.TextAlign = ContentAlignment.MiddleCenter;
        status.Font = new Font("Microsoft YaHei UI", 11f);
        form.Controls.Add(status);

        form.Shown += delegate
        {
            string err;
            string url = EnsureServer(out err);
            if (url == null)
            {
                status.Text = "启动失败：" + err;
                status.ForeColor = Color.FromArgb(230, 120, 120);
                return;
            }
            baseUrl = url;
            StartWeb();
        };

        // 点 X 只是收进托盘（后台继续跑），真退出走托盘右键菜单 —— 和常见桌面软件一致
        form.FormClosing += delegate(object s, FormClosingEventArgs e)
        {
            // 只有"真的要退出"（托盘菜单/系统关机）才放行；
            // 其余一律收进托盘继续跑。注意点 X 是 UserClosing，
            // 而从别的进程发 WM_CLOSE 会被标成 TaskManagerClosing，
            // 所以这里不能只判断 UserClosing，否则会被误杀。
            bool allowClose = reallyExit
                || e.CloseReason == CloseReason.WindowsShutDown
                || e.CloseReason == CloseReason.ApplicationExitCall;
            if (!allowClose)
            {
                e.Cancel = true;
                try { form.Hide(); } catch { }
                try
                {
                    tray.ShowBalloonTip(2500, "本地记忆", "还在后台运行。右键托盘图标可以退出。", ToolTipIcon.Info);
                }
                catch { }
            }
        };

        // 最小化也收进托盘
        form.Resize += delegate
        {
            if (form.WindowState == FormWindowState.Minimized) form.Hide();
        };

        SetupTray();

        // 再点一次图标时，由这里把窗口叫回来（可能收在托盘里、也可能最小化了）
        showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, ShowSignalName);
        var listener = new Thread(delegate()
        {
            while (true)
            {
                try { showSignal.WaitOne(); }
                catch { break; }
                try
                {
                    form.BeginInvoke((Action)delegate
                    {
                        form.Show();
                        if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
                        form.Activate();
                        form.TopMost = true;
                        form.TopMost = false;   // 蹭一下置顶，把窗口真正提到前面
                    });
                }
                catch { break; }
            }
        });
        listener.IsBackground = true;
        listener.Start();

        Application.Run(form);
    }

    /// 系统托盘：关窗口后还能从这儿打开，或者真正退出
    static void SetupTray()
    {
        tray = new NotifyIcon();
        tray.Text = "本地记忆";
        try
        {
            string ico = Path.Combine(ExeDir, "icon.ico");
            if (File.Exists(ico)) tray.Icon = new Icon(ico);
        }
        catch { }
        if (tray.Icon == null) tray.Icon = SystemIcons.Application;

        var menu = new ContextMenuStrip();
        menu.Items.Add("打开主界面", null, delegate
        {
            try
            {
                form.Show();
                form.WindowState = FormWindowState.Normal;
                form.Activate();
            }
            catch { }
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("停止服务并退出", null, delegate { QuitCompletely(); });
        tray.ContextMenuStrip = menu;
        tray.Visible = true;
        tray.DoubleClick += delegate
        {
            try
            {
                form.Show();
                form.WindowState = FormWindowState.Normal;
                form.Activate();
            }
            catch { }
        };
    }

    /// 真正退出：先停后端（自己拉的就杀，别人拉的就让它自己收尸），再关界面
    static void QuitCompletely()
    {
        reallyExit = true;
        try
        {
            if (server != null && !server.HasExited) server.Kill();
        }
        catch { }
        try
        {
            // 应用的是"单实例"服务：如果它本来就在跑（插件拉起的），走它自己的 --stop
            string stopper = Path.Combine(ExeDir, "LocalMemory.exe");
            if (File.Exists(stopper))
            {
                var psi = new ProcessStartInfo();
                psi.FileName = stopper;
                psi.Arguments = "--stop";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (var p = Process.Start(psi)) { p.WaitForExit(6000); }
            }
        }
        catch { }
        try { if (tray != null) tray.Visible = false; } catch { }
        try { if (singleMutex != null) singleMutex.ReleaseMutex(); } catch { }
        try { form.Close(); } catch { }
        Application.Exit();
    }

    static void StartWeb()
    {
        status.Text = "正在加载界面…";
        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.DefaultBackgroundColor = Color.FromArgb(20, 22, 26);
        form.Controls.Add(web);
        web.BringToFront();

        web.CoreWebView2InitializationCompleted += delegate(object s, CoreWebView2InitializationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                status.Text = "WebView2 初始化失败：" + (e.InitializationException == null ? "未知" : e.InitializationException.Message);
                return;
            }
            try
            {
                // 去掉 Edge 的默认右键菜单/开发者工具痕迹，让它更像原生应用
                web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                web.CoreWebView2.Settings.IsStatusBarEnabled = false;
                web.CoreWebView2.Settings.AreDevToolsEnabled = false;
            }
            catch { }
            web.CoreWebView2.NavigationCompleted += delegate { try { status.Visible = false; } catch { } };
            web.CoreWebView2.Navigate(baseUrl);
        };

        web.EnsureCoreWebView2Async(null);
    }
}
