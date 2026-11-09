// Self-extracting stub for the Local Memory installer.
//
// Why this exists: IExpress (the only installer builder shipped with Windows)
// refuses to produce output in this environment, and NSIS/Inno require a
// download + install. The C# compiler that ships with .NET Framework 4.8 is
// already present on every Windows 10/11 machine, so we compile a tiny stub
// that carries the payload zip as an embedded resource.
//
// Behaviour:
//   1. extract the embedded payload.zip into a fresh temp folder
//   2. run setup.cmd from there and wait for it
//   3. delete the temp folder afterwards
//
// IMPORTANT: this is compiled as a CONSOLE app (/target:exe), and it starts
// setup.cmd through cmd.exe with UseShellExecute=false.
//   * ShellExecute=true hangs when the parent is a GUI process without a
//     console (observed here: the installer "ran" forever and did nothing).
//   * A console app also gives the user a window to read, which is what we
//     want for an interactive installer.
//
// Compile (see build-exe.ps1):
//   csc /target:exe /out:setup.exe /resource:payload.zip,payload.zip
//       /r:System.IO.Compression.FileSystem.dll /r:System.Windows.Forms.dll
//       make-installer.cs
//
// Keep this file ASCII-only: it is compiled by the .NET Framework csc, which
// does not strip a BOM-less UTF-8 signature the way modern tooling does.

using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class Installer
{
    /// <summary>Log file next to the EXE: always writable and easy to find.</summary>
    private static readonly string LogPath = ResolveLogPath();

    private static string ResolveLogPath()
    {
        try
        {
            string exeDir = SafeExeDirectory();
            if (!string.IsNullOrEmpty(exeDir)) return Path.Combine(exeDir, "installer.log");
        }
        catch { }
        return Path.Combine(Path.GetTempPath(), "local-memory-setup.log");
    }

    /// <summary>Folder the EXE lives in; empty string when unavailable.</summary>
    private static string SafeExeDirectory()
    {
        try
        {
            string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            return dir ?? string.Empty;
        }
        catch { return string.Empty; }
    }

    /// <summary>Write a line to stderr and to the log file, so a failed run leaves a trace.</summary>
    private static void Report(string message)
    {
        try { Console.Error.WriteLine(message); } catch { }
        try
        {
            File.AppendAllText(LogPath,
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine);
        }
        catch { }
    }

    private static void Fatal(string message, bool interactive)
    {
        Report("ERROR: " + message);
        if (!interactive) return;
        try
        {
            MessageBox.Show(message, "Local Memory installer",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch { }
    }

    private static int Main(string[] args)
    {
        // /S = silent: never block on a dialog, just log and exit.
        bool silent = Array.Exists(args, x => x.Equals("/S", StringComparison.OrdinalIgnoreCase));
        string tempDir = null;
        try
        {
            // Antivirus / policy can refuse directory creation in %TEMP% on some
            // machines (observed here: every candidate under Temp/LocalAppData/
            // UserProfile was rejected with "access to the path is denied", while
            // writing a plain file next to the EXE worked fine).
            // So try the EXE's own folder FIRST: it is where we were launched
            // from, it is definitely writable, and it is easy for a user to find.
            string[] bases = new string[]
            {
                SafeExeDirectory(),
                Path.GetTempPath(),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalMemorySetup"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "LocalMemorySetup"),
            };

            tempDir = null;
            foreach (string b in bases)
            {
                try
                {
                    string candidate = Path.Combine(b, "lm-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
                    Directory.CreateDirectory(candidate);
                    // Prove it is writable before committing to it.
                    string probe = Path.Combine(candidate, "probe.tmp");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    tempDir = candidate;
                    Report("using work dir: " + candidate);
                    break;
                }
                catch (Exception ex)
                {
                    Report("work dir rejected (" + b + "): " + ex.Message);
                }
            }
            if (tempDir == null)
            {
                Fatal("No writable folder found for the installer's temporary files.", !silent);
                return 4;
            }

            // --- 1. dump the embedded payload -------------------------------
            string zipPath = Path.Combine(tempDir, "payload.zip");
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream resource = assembly.GetManifestResourceStream("payload.zip"))
            {
                if (resource == null)
                {
                    Fatal("The installer payload is missing. The EXE is corrupt.", !silent);
                    return 2;
                }
                using (FileStream output = File.Create(zipPath))
                {
                    resource.CopyTo(output);
                }
            }
            Report("payload written: " + new FileInfo(zipPath).Length + " bytes");

            // --- 2. unpack it ----------------------------------------------
            ZipFile.ExtractToDirectory(zipPath, tempDir);
            try { File.Delete(zipPath); } catch { }
            Report("payload extracted");

            string setup = Path.Combine(tempDir, "setup.cmd");
            if (!File.Exists(setup))
            {
                Fatal("setup.cmd was not found after extraction. The EXE is corrupt.", !silent);
                return 3;
            }

            // --- 3. hand over to the batch installer ------------------------
            // The doubled outer quotes keep cmd from mis-splitting a quoted
            // path that itself contains spaces.
            string forwarded = args.Length > 0 ? " " + string.Join(" ", args) : string.Empty;
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                Arguments = "/c \"\"" + setup + "\"" + forwarded + "\"",
                WorkingDirectory = tempDir,
                UseShellExecute = false,
            };

            using (Process process = Process.Start(psi))
            {
                process.WaitForExit();
                Report("setup.cmd exit code: " + process.ExitCode);
                return process.ExitCode;
            }
        }
        catch (Exception ex)
        {
            Fatal("Installation failed:\r\n\r\n" + ex.ToString(), !silent);
            return 1;
        }
        finally
        {
            // setup.cmd has finished (or we crashed); drop the temp copy.
            if (tempDir != null)
            {
                try { Directory.Delete(tempDir, true); }
                catch { }
            }
        }
    }
}
