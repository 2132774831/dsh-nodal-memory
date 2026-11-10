// Local Memory launcher (GUI, no console window).
//
// Why this exists: the old shortcut pointed at start.cmd, which runs the Node
// server in the foreground. That leaves a black console window on screen, and
// closing it kills the app - users naturally close it and think the program
// is broken.
//
// This launcher is a /target:winexe program: it starts the server detached
// with CreateNoWindow, so nothing black ever appears. The server keeps running
// after the launcher exits.
//
// Usage:
//   LocalMemory.exe          start (or focus an already running instance)
//   LocalMemory.exe --stop   stop the running instance
//
// Compile (see build-dist.mjs / build-exe.ps1):
//   csc /target:winexe /out:LocalMemory.exe /r:System.Windows.Forms.dll
//       make-launcher.cs
//
// Keep this file ASCII-only (compiled by .NET Framework csc without a BOM).

using System;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

internal static class Launcher
{
    private static string ExeDir
    {
        get
        {
            try
            {
                string p = Assembly.GetExecutingAssembly().Location;
                if (!string.IsNullOrEmpty(p)) return Path.GetDirectoryName(p);
            }
            catch { }
            return Directory.GetCurrentDirectory();
        }
    }

    private static string DshHome
    {
        get
        {
            string env = Environment.GetEnvironmentVariable("DSH_HOME");
            if (!string.IsNullOrEmpty(env)) return env;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
        }
    }

    private static string StatePath
    {
        get { return Path.Combine(DshHome, "local-memory", "instance.json"); }
    }

    private static void Fail(string message)
    {
        try
        {
            MessageBox.Show(message, "Local Memory",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch { }
    }

    // ---------------------------------------------------------------- state

    private sealed class InstanceState
    {
        public int Port;
        public int Pid;
    }

    private static InstanceState ReadState()
    {
        try
        {
            if (!File.Exists(StatePath)) return null;
            string json = File.ReadAllText(StatePath);

            InstanceState st = new InstanceState();
            st.Port = ReadInt(json, "port");
            st.Pid = ReadInt(json, "pid");
            if (st.Port <= 0 || st.Pid <= 0) return null;
            return st;
        }
        catch { return null; }
    }

    /// <summary>Pull an integer field out of the tiny state JSON without a JSON library.</summary>
    private static int ReadInt(string json, string key)
    {
        string needle = "\"" + key + "\"";
        int i = json.IndexOf(needle, StringComparison.Ordinal);
        if (i < 0) return 0;
        int colon = json.IndexOf(':', i + needle.Length);
        if (colon < 0) return 0;
        int j = colon + 1;
        while (j < json.Length && (json[j] == ' ' || json[j] == '\t')) j++;
        int start = j;
        while (j < json.Length && char.IsDigit(json[j])) j++;
        if (j == start) return 0;
        int value;
        return int.TryParse(json.Substring(start, j - start), out value) ? value : 0;
    }

    private static bool IsAlive(int pid)
    {
        try
        {
            using (Process p = Process.GetProcessById(pid))
            {
                return !p.HasExited;
            }
        }
        catch { return false; }
    }

    private static bool PortResponds(int port)
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(700)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    // ----------------------------------------------------------------- node

    private static string FindNode()
    {
        // 1. PATH
        try
        {
            string pathVar = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (string dir in pathVar.Split(';'))
            {
                if (string.IsNullOrEmpty(dir)) continue;
                try
                {
                    string candidate = Path.Combine(dir.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
        }
        catch { }

        // 2. runtimes shipped with DeepSeek Harness
        string[] fixedPaths = new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"),
            Path.Combine(DshHome, @"dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Programs\DeepSeek Harness\resources\runtime\node\node.exe"),
        };
        foreach (string p in fixedPaths)
        {
            try { if (File.Exists(p)) return p; } catch { }
        }
        return null;
    }

    // ----------------------------------------------------------------- main

    [STAThread]
    private static int Main(string[] args)
    {
        bool stop = false;
        foreach (string a in args)
        {
            if (a.Equals("--stop", StringComparison.OrdinalIgnoreCase)) stop = true;
        }

        InstanceState state = ReadState();
        bool running = state != null && IsAlive(state.Pid) && PortResponds(state.Port);

        if (stop)
        {
            if (!running)
            {
                CleanRuntimeFiles();
                return 0;   // nothing to stop: treat as success
            }
            try
            {
                using (Process p = Process.GetProcessById(state.Pid)) p.Kill();
            }
            catch { }
            // Give the OS a moment to actually tear the process down before we
            // delete its runtime files.
            for (int i = 0; i < 20 && IsAlive(state.Pid); i++)
            {
                System.Threading.Thread.Sleep(100);
            }
            CleanRuntimeFiles();
            return 0;
        }

        // Already running: just bring up the UI instead of starting a second copy.
        if (running)
        {
            OpenBrowser("http://127.0.0.1:" + state.Port + "/");
            return 0;
        }

        string node = FindNode();
        if (node == null)
        {
            Fail("Node.js was not found.\r\n\r\n"
                + "Install Node.js 18+ or make sure DeepSeek Harness is installed, "
                + "then run this again.");
            return 1;
        }

        string server = Path.Combine(ExeDir, @"app\server.mjs");
        if (!File.Exists(server))
        {
            Fail("Installation looks incomplete:\r\n\r\n" + server + "\r\n\r\n"
                + "Reinstall Local Memory.");
            return 2;
        }

        StringBuilder argLine = new StringBuilder();
        argLine.Append('"').Append(server).Append("\" --open --idle-min 0");   // 用户自己打开的实例不该被闲置计时杀掉

        // First run: import the old v1 JSON library when there is no v2 db yet.
        try
        {
            string v1 = Path.Combine(DshHome, "dsh-local-memory.json");
            string v2 = Path.Combine(DshHome, "dsh-local-memory.db");
            if (File.Exists(v1) && !File.Exists(v2)) argLine.Append(" --seed");
        }
        catch { }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = node,
                Arguments = argLine.ToString(),
                WorkingDirectory = ExeDir,
                UseShellExecute = false,
                CreateNoWindow = true,          // <- the whole point: no black window
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            using (Process p = Process.Start(psi))
            {
                // Do NOT wait for the server: it must outlive this launcher.
                // But DO wait a moment for it to publish its state file.
                //
                // Why: the state file is what tells a second click "already
                // running, reuse it". If we returned instantly, a fast double
                // click would race and start two servers (observed: two
                // node processes, two ports, last writer wins the state file).
                for (int i = 0; i < 40; i++)   // up to ~4s
                {
                    System.Threading.Thread.Sleep(100);
                    InstanceState fresh = ReadState();
                    if (fresh != null && IsAlive(fresh.Pid))
                    {
                        OpenBrowser("http://127.0.0.1:" + fresh.Port + "/");
                        break;
                    }
                    if (p.HasExited) break;    // server died early: let the user see it
                }
            }
            return 0;
        }
        catch (Exception ex)
        {
            Fail("Could not start Local Memory:\r\n\r\n" + ex.Message);
            return 3;
        }
    }

    private static void OpenBrowser(string url)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch { }
    }

    /// <summary>
    /// Remove the runtime bookkeeping files (state + lock).
    ///
    /// The state file is written by the server; the lock file is what stops a
    /// second instance from starting. A hard kill (Process.Kill) does not run
    /// the server's exit handlers, so both files would be left behind. They are
    /// self-healing (a dead pid lets the next start take over) but leaving them
    /// means the next start does extra work - clean them here instead.
    /// </summary>
    private static void CleanRuntimeFiles()
    {
        try { File.Delete(StatePath); } catch { }
        try
        {
            string lockPath = Path.Combine(DshHome, "local-memory", "instance.lock");
            File.Delete(lockPath);
        }
        catch { }
    }
}
