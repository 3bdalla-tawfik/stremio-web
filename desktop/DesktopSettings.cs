using System;
using System.Collections.Generic;

internal static class DesktopSettings
{
    internal const string AppName = "Stremio Party";
    internal const string AppDirectory = "app";
    internal const string IndexFile = "index.html";
    internal const string ShellFileName = "stremio-shell-ng.exe";
    internal const string DownloadsUrl = "https://www.stremio.com/downloads";
    internal const string InstanceMutex = @"Local\StremioParty.Desktop";
    internal const string ShellUrlOption = "--webui-url=";
    // Give older web service workers a path outside their cached entry page.
    internal const string DesktopEntry = "party-desktop";
    internal static readonly Uri AppUri = new Uri("http://127.0.0.1:18858/");
    internal static readonly Uri StreamingEngineUri = new Uri("http://127.0.0.1:11470/");
    internal const string StreamingServerParameter = "streamingServerUrl";
    internal const string StreamingSettingsPath = "/settings";
    internal const string StreamingBaseUrlKey = "baseUrl";

    internal static readonly Dictionary<string, string> ContentTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" },
        { ".js", "text/javascript; charset=utf-8" },
        { ".css", "text/css; charset=utf-8" },
        { ".json", "application/json" },
        { ".map", "application/json" },
        { ".wasm", "application/wasm" },
        { ".svg", "image/svg+xml" },
        { ".png", "image/png" },
        { ".jpg", "image/jpeg" },
        { ".jpeg", "image/jpeg" },
        { ".webp", "image/webp" },
        { ".ico", "image/x-icon" },
        { ".ttf", "font/ttf" },
        { ".woff2", "font/woff2" }
    };
}
