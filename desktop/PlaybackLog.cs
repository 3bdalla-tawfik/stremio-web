using System;
using System.Diagnostics;
using System.IO;

internal static class PlaybackLog
{
    private static readonly object Gate = new object();
    private static readonly string PathName = Path.Combine(Path.GetTempPath(), "Stremio-Party-playback.log");

    internal static void Write(string message)
    {
        lock (Gate)
        {
            try
            {
                if (File.Exists(PathName) && new FileInfo(PathName).Length > 1024 * 1024) File.WriteAllText(PathName, "");
                File.AppendAllText(PathName, DateTime.UtcNow.ToString("O") + " " + message + Environment.NewLine);
            }
            catch (IOException error) { Trace.TraceWarning(error.GetType().Name); }
            catch (UnauthorizedAccessException error) { Trace.TraceWarning(error.GetType().Name); }
        }
    }
}
