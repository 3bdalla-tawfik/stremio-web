using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Windows.Forms;

internal static class PartyDesktop
{
    [STAThread]
    private static void Main()
    {
        bool firstInstance;
        using (var instance = new Mutex(true, DesktopSettings.InstanceMutex, out firstInstance))
        {
            if (!firstInstance)
            {
                ShowError("Stremio Party is already open.");
                return;
            }

            try
            {
                Run();
            }
            catch (IOException failure) { ShowError(failure.Message); }
            catch (UnauthorizedAccessException failure) { ShowError(failure.Message); }
            catch (Win32Exception failure) { ShowError(failure.Message); }
            catch (InvalidOperationException failure) { ShowError(failure.Message); }
        }
    }

    private static void Run()
    {
        var appDirectory = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, DesktopSettings.AppDirectory);
        if (!File.Exists(Path.Combine(appDirectory, DesktopSettings.IndexFile)))
            throw new FileNotFoundException("Extract the entire Stremio Party ZIP, then launch Stremio Party.exe from the extracted folder.");

        var localApps = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var shellPath = new[]
        {
            Path.Combine(localApps, "Programs", "Stremio", DesktopSettings.ShellFileName),
            Path.Combine(programFiles, "Stremio", DesktopSettings.ShellFileName)
        }.FirstOrDefault(File.Exists);

        if (shellPath == null)
        {
            var openDownloads = MessageBox.Show(
                "Stremio Party uses the Stremio 5 Windows player. Install Stremio 5, then open Stremio Party again. Open the official download page?",
                DesktopSettings.AppName, MessageBoxButtons.YesNo, MessageBoxIcon.Information);
            if (openDownloads == DialogResult.Yes)
                Process.Start(new ProcessStartInfo(DesktopSettings.DownloadsUrl) { UseShellExecute = true });
            return;
        }

        var shellName = Path.GetFileNameWithoutExtension(DesktopSettings.ShellFileName);
        var running = Process.GetProcessesByName(shellName);
        try
        {
            int sessionId;
            using (var launcher = Process.GetCurrentProcess()) sessionId = launcher.SessionId;
            if (running.Any(process => !process.HasExited && process.SessionId == sessionId))
                throw new InvalidOperationException("Exit Stremio from the Windows system tray, then open Stremio Party again.");
        }
        finally
        {
            foreach (var process in running) process.Dispose();
        }

        using (var server = new StaticAppServer(appDirectory, DesktopSettings.AppUri))
        {
            server.Start();
            using (var player = Process.Start(new ProcessStartInfo(shellPath)
            {
                Arguments = DesktopSettings.ShellUrlOption + DesktopSettings.AppUri.AbsoluteUri + DesktopSettings.DesktopEntry + "#/?" +
                    DesktopSettings.StreamingServerParameter + "=" + Uri.EscapeDataString(DesktopSettings.AppUri.AbsoluteUri),
                WorkingDirectory = Path.GetDirectoryName(shellPath),
                UseShellExecute = false
            }))
            {
                if (player == null) throw new InvalidOperationException("Could not start the Stremio Windows player.");
                player.WaitForExit();
                if (player.ExitCode != 0) throw new InvalidOperationException("The Stremio Windows player could not stay open. Check that Stremio 5 can launch on this PC.");
            }
        }
    }

    private static void ShowError(string message)
    {
        MessageBox.Show(message, DesktopSettings.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}
