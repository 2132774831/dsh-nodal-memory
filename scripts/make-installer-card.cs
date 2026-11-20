// 本地记忆 · 安装卡片
//
// 之前的问题：自解压 stub 把程序直接解到"安装包所在的文件夹"，
// 用户双击完发现一堆文件散在桌面上。
//
// 现在做成像样的安装向导：
//   1. 显示默认安装路径（%LOCALAPPDATA%\dsh-local-memory-app），也能自己选
//   2. 点「安装」→ 解压内置 payload 到那个路径 → 建桌面快捷方式
//   3. 装完在同一张卡片上出现两个按钮：下载 MCP / 安装到 DSH
//
// 编译（由 build-exe.ps1 调用）：
//   csc /target:winexe /out:setup.exe /resource:payload.zip,payload.zip
//       /r:System.IO.Compression.FileSystem.dll /r:System.IO.Compression.dll
//       /r:System.Windows.Forms.dll /r:System.Drawing.dll make-installer-card.cs
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

static class InstallerCard
{
    static readonly string DefaultTarget = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "dsh-local-memory-app");

    static Form form;
    static TextBox pathBox;
    static Button browseBtn;
    static Button installBtn;
    static ProgressBar bar;
    static Label status;
    static Panel donePanel;
    static Button mcpBtn;
    static Button dshBtn;
    static Button finishBtn;
    static Label doneTitle;
    static string installedTo = null;

    [STAThread]
    static void Main()
    {
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "lm-install-trace.log"), DateTime.Now.ToString("s") + " boot args=" + string.Join("|", Environment.GetCommandLineArgs()) + "\r\n"); } catch { }
        // 自动化安装（给自己测安装流程用）：
        //   setup.exe /install="D:\xx"  → 不弹窗，直接装完退出，退出码 0/1
        foreach (string a in Environment.GetCommandLineArgs())
        {
            if (a.StartsWith("/install=", StringComparison.OrdinalIgnoreCase))
            {
                string p = a.Substring("/install=".Length).Trim('"');
                Environment.Exit(SilentInstall(p) ? 0 : 1);
            }
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        form = new Form();
        form.Text = "本地记忆 · 安装";
        form.Width = 620;
        form.Height = 340;
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.MaximizeBox = false;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.BackColor = Color.FromArgb(250, 250, 252);
        form.Font = new Font("Microsoft YaHei UI", 9f);

        // ── 标题 ──
        var title = new Label();
        title.Text = "本地记忆";
        title.Font = new Font("Microsoft YaHei UI", 16f, FontStyle.Bold);
        title.ForeColor = Color.FromArgb(32, 36, 44);
        title.SetBounds(24, 20, 300, 36);
        form.Controls.Add(title);

        var sub = new Label();
        sub.Text = "本地长期记忆：数据只存本机，不联网。";
        sub.ForeColor = Color.FromArgb(110, 116, 126);
        sub.SetBounds(26, 58, 480, 22);
        form.Controls.Add(sub);

        // ── 路径选择 ──
        var lbl = new Label();
        lbl.Text = "安装位置：";
        lbl.SetBounds(26, 100, 80, 22);
        form.Controls.Add(lbl);

        pathBox = new TextBox();
        pathBox.Text = DefaultTarget;
        pathBox.SetBounds(106, 98, 380, 24);
        form.Controls.Add(pathBox);

        browseBtn = new Button();
        browseBtn.Text = "浏览…";
        browseBtn.SetBounds(494, 97, 80, 26);
        browseBtn.Click += delegate
        {
            var dlg = new FolderBrowserDialog();
            dlg.Description = "选择安装到哪个文件夹";
            if (Directory.Exists(pathBox.Text)) dlg.SelectedPath = pathBox.Text;
            if (dlg.ShowDialog() == DialogResult.OK) pathBox.Text = dlg.SelectedPath;
        };
        form.Controls.Add(browseBtn);

        // ── 进度 ──
        bar = new ProgressBar();
        bar.SetBounds(26, 140, 548, 16);
        bar.Style = ProgressBarStyle.Continuous;
        form.Controls.Add(bar);

        status = new Label();
        status.Text = "准备就绪。点「安装」开始。";
        status.ForeColor = Color.FromArgb(110, 116, 126);
        status.SetBounds(26, 162, 548, 40);
        form.Controls.Add(status);

        installBtn = new Button();
        installBtn.Text = "安装";
        installBtn.SetBounds(444, 230, 130, 34);
        installBtn.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
        installBtn.BackColor = Color.FromArgb(64, 120, 200);
        installBtn.ForeColor = Color.White;
        installBtn.FlatStyle = FlatStyle.Flat;
        installBtn.FlatAppearance.BorderSize = 0;
        installBtn.Click += delegate { DoInstall(); };
        form.Controls.Add(installBtn);

        // ── 完成页（默认隐藏） ──
        donePanel = new Panel();
        donePanel.SetBounds(0, 0, 620, 310);
        donePanel.Visible = false;
        donePanel.BackColor = Color.FromArgb(250, 250, 252);
        form.Controls.Add(donePanel);

        doneTitle = new Label();
        doneTitle.Text = "安装完成";
        doneTitle.Font = new Font("Microsoft YaHei UI", 14f, FontStyle.Bold);
        doneTitle.ForeColor = Color.FromArgb(32, 36, 44);
        doneTitle.SetBounds(24, 26, 400, 32);
        donePanel.Controls.Add(doneTitle);

        var doneHint = new Label();
        doneHint.Text = "接下来可以（可选）：";
        doneHint.ForeColor = Color.FromArgb(110, 116, 126);
        doneHint.SetBounds(26, 70, 400, 22);
        donePanel.Controls.Add(doneHint);

        mcpBtn = new Button();
        mcpBtn.Text = "下载 MCP（给其它 agent 用）";
        mcpBtn.SetBounds(26, 100, 260, 40);
        mcpBtn.Click += delegate { DoExportMcp(); };
        donePanel.Controls.Add(mcpBtn);

        dshBtn = new Button();
        dshBtn.Text = "安装到 DeepSeek Harness";
        dshBtn.SetBounds(300, 100, 250, 40);
        dshBtn.Click += delegate { DoInstallDsh(); };
        donePanel.Controls.Add(dshBtn);

        var doneStatus = new Label();
        doneStatus.Name = "doneStatus";
        doneStatus.Text = "";
        doneStatus.ForeColor = Color.FromArgb(110, 116, 126);
        doneStatus.SetBounds(26, 150, 548, 50);
        donePanel.Controls.Add(doneStatus);

        finishBtn = new Button();
        finishBtn.Text = "完成";
        finishBtn.SetBounds(444, 230, 130, 34);
        finishBtn.Click += delegate { form.Close(); };
        donePanel.Controls.Add(finishBtn);

        Application.Run(form);
    }

    static void Report(string text)
    {
        status.Text = text;
        Application.DoEvents();
    }

    /// 装之前先关掉正在运行的旧版本，否则覆盖 MemoryApp.exe / LocalMemory.exe 会报"文件被占用"
    static void StopRunningApp(string target)
    {
        string norm = Path.GetFullPath(target).TrimEnd('\\') + "\\";
        foreach (string name in new string[] { "MemoryApp", "LocalMemory" })
        {
            foreach (Process p in Process.GetProcessesByName(name))
            {
                try
                {
                    string path = p.MainModule.FileName;
                    if (path != null && Path.GetFullPath(path).StartsWith(norm, StringComparison.OrdinalIgnoreCase))
                    {
                        p.Kill();
                        p.WaitForExit(5000);
                    }
                }
                catch { }
            }
        }
        // 后端是 node 跑起来的，可能比窗口活得久：让旧版自己收尸
        string stopper = Path.Combine(target, "LocalMemory.exe");
        if (File.Exists(stopper))
        {
            try
            {
                var psi = new ProcessStartInfo();
                psi.FileName = stopper;
                psi.Arguments = "--stop";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                using (var p2 = Process.Start(psi)) { p2.WaitForExit(8000); }
            }
            catch { }
        }
        System.Threading.Thread.Sleep(600);
    }

    /// payload.zip 里程序文件在 payload\ 子目录下，要摊平到安装根目录
    static void FlattenPayload(string target)
    {
        string sub = Path.Combine(target, "payload");
        if (!Directory.Exists(sub)) return;
        foreach (string f in Directory.GetFiles(sub))
            File.Copy(f, Path.Combine(target, Path.GetFileName(f)), true);
        foreach (string d in Directory.GetDirectories(sub))
        {
            string dest = Path.Combine(target, Path.GetFileName(d));
            if (Directory.Exists(dest)) Directory.Delete(dest, true);
            Directory.Move(d, dest);
        }
        try { File.Delete(Path.Combine(target, "setup.cmd")); } catch { }
        try { Directory.Delete(sub, true); } catch { }
    }

    /// 无界面安装：解压 payload + 建快捷方式，返回是否成功
    static bool SilentInstall(string target)
    {
        try
        {
            Directory.CreateDirectory(target);
            StopRunningApp(target);   // 旧实例不关，覆盖 exe 会报"文件被占用"
            string tmpZip = Path.Combine(Path.GetTempPath(), "lm-payload-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".zip");
            var asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("payload.zip"))
            {
                if (s == null) return false;
                using (var fs = File.Create(tmpZip)) s.CopyTo(fs);
            }
            ZipFile.ExtractToDirectory(tmpZip, target);
            FlattenPayload(target);
            try { File.Delete(tmpZip); } catch { }
            RunPowerShell("-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(target, "scripts", "make-shortcut.ps1") + "\" -Root \"" + target + "\"");
            return true;
        }
        catch (Exception e)
        {
            try
            {
                File.WriteAllText(Path.Combine(Path.GetTempPath(), "lm-install-error.log"),
                    DateTime.Now.ToString("s") + "  安装失败: " + e.ToString());
            }
            catch { }
            return false;
        }
    }

    static void DoInstall()
    {
        string target = pathBox.Text.Trim();
        if (target.Length == 0) { MessageBox.Show("请先选择安装位置。"); return; }

        try
        {
            Directory.CreateDirectory(target);
        }
        catch (Exception e)
        {
            MessageBox.Show("这个位置不能写入：" + e.Message);
            return;
        }

        StopRunningApp(target);
        installBtn.Enabled = false;
        browseBtn.Enabled = false;
        pathBox.Enabled = false;
        bar.Value = 5;
        Report("正在解压程序文件…");
        Application.DoEvents();

        try
        {
            string tmpZip = Path.Combine(Path.GetTempPath(), "lm-payload-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".zip");
            var asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("payload.zip"))
            {
                if (s == null) throw new Exception("安装包损坏：缺少内置文件");
                using (var fs = File.Create(tmpZip)) s.CopyTo(fs);
            }
            bar.Value = 30;

            // 覆盖安装：先清空目标目录里的旧程序文件（保留用户数据目录不在这里，安全）
            foreach (string f in Directory.GetFiles(target)) { try { File.Delete(f); } catch { } }
            foreach (string d in Directory.GetDirectories(target))
            {
                string name = Path.GetFileName(d);
                if (name == "data") continue;   // 极端情况下旧版把数据放在这里，别删
                try { Directory.Delete(d, true); } catch { }
            }
            bar.Value = 45;

            ZipFile.ExtractToDirectory(tmpZip, target);
            FlattenPayload(target);
            bar.Value = 75;
            Report("正在创建桌面快捷方式…");
            Application.DoEvents();
            RunPowerShell("-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(target, "scripts", "make-shortcut.ps1") + "\" -Root \"" + target + "\"");
            bar.Value = 100;

            try { File.Delete(tmpZip); } catch { }

            installedTo = target;
            ShowDone(target);
        }
        catch (Exception e)
        {
            installBtn.Enabled = true;
            browseBtn.Enabled = true;
            pathBox.Enabled = true;
            bar.Value = 0;
            Report("安装失败：" + e.Message);
            MessageBox.Show("安装失败：" + e.Message);
        }
    }

    static void ShowDone(string target)
    {
        doneTitle.Text = "安装完成";
        var st = donePanel.Controls["doneStatus"] as Label;
        if (st != null) st.Text = "已安装到：" + target;
        donePanel.Visible = true;
        donePanel.BringToFront();
    }

    static void DoExportMcp()
    {
        var st = donePanel.Controls["doneStatus"] as Label;
        if (installedTo == null) return;
        var dlg = new SaveFileDialog();
        dlg.FileName = "dsh-local-memory-mcp.mjs";
        dlg.Filter = "MCP 服务器 (*.mjs)|*.mjs|所有文件 (*.*)|*.*";
        if (dlg.ShowDialog() != DialogResult.OK) return;

        string json = RunNode("export-mcp", dlg.FileName);
        if (json == null) { if (st != null) st.Text = "导出失败：找不到 Node.js"; return; }
        if (json.Contains("\"ok\":true"))
        {
            if (st != null) st.Text = "已导出到 " + dlg.FileName + "\r\n把它填进 agent 的 MCP 配置即可（command 用 node，args 填这个文件路径）。";
        }
        else if (st != null) st.Text = "导出失败：" + json;
    }

    static void DoInstallDsh()
    {
        var st = donePanel.Controls["doneStatus"] as Label;
        if (installedTo == null) return;
        if (st != null) st.Text = "正在装进 DeepSeek Harness…";
        Application.DoEvents();

        string json = RunNode("install-dsh");
        if (json == null) { if (st != null) st.Text = "失败：找不到 Node.js（请先装 Node 18+ 或 DSH）"; return; }
        if (json.Contains("\"ok\":true"))
        {
            if (st != null) st.Text = "已装进 DeepSeek Harness。重启 DSH 后生效。";
        }
        else if (st != null) st.Text = "安装失败：" + json;
    }

    static string RunNode(params string[] args)
    {
        string node = FindNode();
        if (node == null) return null;
        var psi = new ProcessStartInfo();
        psi.FileName = node;
        var sb = new StringBuilder();
        sb.Append('"').Append(Path.Combine(installedTo, "scripts", "post-install.mjs")).Append('"');
        foreach (string a in args) sb.Append(' ').Append('"').Append(a).Append('"');
        psi.Arguments = sb.ToString();
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        try
        {
            using (var p = Process.Start(psi))
            {
                string outText = p.StandardOutput.ReadToEnd();
                p.WaitForExit(60000);
                return outText;
            }
        }
        catch { return null; }
    }

    static void RunPowerShell(string args)
    {
        try
        {
            var psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments = args;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (var p = Process.Start(psi)) { p.WaitForExit(30000); }
        }
        catch { }
    }

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
        string dshHome = Environment.GetEnvironmentVariable("DSH_HOME");
        if (string.IsNullOrEmpty(dshHome))
            dshHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        string[] cands = new string[]
        {
            @"C:\Program Files\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"),
            Path.Combine(dshHome, @"dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"),
        };
        foreach (string c in cands) { try { if (File.Exists(c)) return c; } catch { } }
        return null;
    }
}
