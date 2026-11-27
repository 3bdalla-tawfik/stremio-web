using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

internal sealed class StreamingEngineProxy : IDisposable
{
    private static long requestSequence;
    private static readonly string[] DiagnosticPaths = { "/settings", "/subtitleSignature", "/hlsv2/probe", "/network-info", "/device-info", "/stats", "/create" };
    private static readonly string[] RequestHeaders = { "Accept", "Range", "If-Range", "If-None-Match", "If-Modified-Since" };
    private static readonly string[] ResponseHeaders = { "Accept-Ranges", "Content-Range", "Content-Encoding", "ETag", "Last-Modified", "Cache-Control", "Location" };
    private static readonly string[] ContentHeaders = { "Content-Range", "Content-Encoding", "Last-Modified" };
    private readonly Uri appUri;
    private readonly string appOrigin;
    private readonly HttpClient client = new HttpClient(new HttpClientHandler
    {
        UseCookies = false,
        UseProxy = false,
        AllowAutoRedirect = false
    });

    internal StreamingEngineProxy(Uri appUri)
    {
        this.appUri = appUri;
        appOrigin = appUri.GetLeftPart(UriPartial.Authority);
    }

    internal async Task Forward(HttpListenerContext context)
    {
        var incoming = context.Request;
        var response = context.Response;
        var origin = incoming.Headers["Origin"];
        var fetchSite = incoming.Headers["Sec-Fetch-Site"];
        // Keep the local streaming API available only to the app and native player.
        if ((origin != null && origin != appOrigin) || (fetchSite != null && fetchSite != "same-origin" && fetchSite != "none"))
        {
            response.StatusCode = (int)HttpStatusCode.Forbidden;
            return;
        }

        var destination = new UriBuilder(DesktopSettings.StreamingEngineUri)
        {
            Path = incoming.Url.AbsolutePath,
            Query = incoming.Url.Query.TrimStart('?')
        }.Uri;
        var path = destination.AbsolutePath;
        var kind = Array.IndexOf(DiagnosticPaths, path) >= 0 ? path :
            path.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase) ? "playlist" : "stream-service";
        kind = "#" + Interlocked.Increment(ref requestSequence) + " " + kind;
        var timing = Stopwatch.StartNew();
        PlaybackLog.Write("Started " + kind + (incoming.Headers["Range"] == null ? "" : " (range request)"));
        using (var upstream = new HttpRequestMessage(new HttpMethod(incoming.HttpMethod), destination))
        {
            foreach (var header in RequestHeaders)
            {
                var value = incoming.Headers[header];
                if (value != null) upstream.Headers.TryAddWithoutValidation(header, value);
            }
            if (incoming.HasEntityBody)
            {
                upstream.Content = new StreamContent(incoming.InputStream);
                if (incoming.ContentLength64 >= 0) upstream.Content.Headers.ContentLength = incoming.ContentLength64;
                if (incoming.ContentType != null) upstream.Content.Headers.TryAddWithoutValidation("Content-Type", incoming.ContentType);
            }

            HttpResponseMessage result;
            try
            {
                result = await client.SendAsync(upstream, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            }
            catch (HttpRequestException)
            {
                PlaybackLog.Write(kind + " could not connect to the streaming service");
                response.StatusCode = (int)HttpStatusCode.BadGateway;
                return;
            }
            catch (TaskCanceledException)
            {
                PlaybackLog.Write(kind + " timed out waiting for the streaming service");
                response.StatusCode = (int)HttpStatusCode.GatewayTimeout;
                return;
            }

            using (result)
            {
                PlaybackLog.Write(kind + " returned HTTP " + (int)result.StatusCode + " in " + timing.ElapsedMilliseconds + " ms");
                response.StatusCode = (int)result.StatusCode;
                if (upstream.Method == HttpMethod.Get && destination.AbsolutePath == DesktopSettings.StreamingSettingsPath && result.IsSuccessStatusCode)
                {
                    await WriteSettings(result, response).ConfigureAwait(false);
                    return;
                }

                foreach (var name in ResponseHeaders) CopyHeader(result.Headers, response, name);
                foreach (var name in ContentHeaders) CopyHeader(result.Content.Headers, response, name);
                if (result.Content.Headers.ContentType != null) response.ContentType = result.Content.Headers.ContentType.ToString();
                if (result.Content.Headers.ContentLength.HasValue) response.ContentLength64 = result.Content.Headers.ContentLength.Value;
                else if (upstream.Method != HttpMethod.Head) response.SendChunked = true;
                if (upstream.Method != HttpMethod.Head)
                {
                    try
                    {
                        await result.Content.CopyToAsync(response.OutputStream).ConfigureAwait(false);
                        PlaybackLog.Write(kind + " body completed in " + timing.ElapsedMilliseconds + " ms");
                    }
                    catch (HttpRequestException failure)
                    {
                        PlaybackLog.Write(kind + " body interrupted: " + failure.GetType().Name);
                        response.Abort();
                    }
                    catch (System.IO.IOException failure)
                    {
                        PlaybackLog.Write(kind + " body interrupted: " + failure.GetType().Name);
                        response.Abort();
                    }
                }
            }
        }
    }

    private async Task WriteSettings(HttpResponseMessage upstream, HttpListenerResponse response)
    {
        var serializer = new JavaScriptSerializer();
        var settings = serializer.Deserialize<Dictionary<string, object>>(await upstream.Content.ReadAsStringAsync().ConfigureAwait(false));
        settings[DesktopSettings.StreamingBaseUrlKey] = appUri.AbsoluteUri;
        var json = Encoding.UTF8.GetBytes(serializer.Serialize(settings));
        response.ContentType = "application/json; charset=utf-8";
        response.ContentLength64 = json.Length;
        await response.OutputStream.WriteAsync(json, 0, json.Length).ConfigureAwait(false);
    }

    private static void CopyHeader(System.Net.Http.Headers.HttpHeaders source, HttpListenerResponse target, string name)
    {
        IEnumerable<string> values;
        if (source.TryGetValues(name, out values)) target.Headers[name] = string.Join(", ", values);
    }

    public void Dispose()
    {
        client.Dispose();
    }
}
