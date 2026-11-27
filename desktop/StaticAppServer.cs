using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading.Tasks;

internal sealed class StaticAppServer : IDisposable
{
    private const string GetMethod = "GET";
    private const string HeadMethod = "HEAD";
    private readonly HttpListener listener = new HttpListener();
    private readonly string directory;
    private readonly StreamingEngineProxy engineProxy;

    public StaticAppServer(string appDirectory, Uri address)
    {
        directory = Path.GetFullPath(appDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        engineProxy = new StreamingEngineProxy(address);
        listener.Prefixes.Add(address.AbsoluteUri);
    }

    public void Start()
    {
        try
        {
            listener.Start();
        }
        catch (HttpListenerException failure)
        {
            throw new IOException("Could not start the local Stremio Party interface. Check whether port " + DesktopSettings.AppUri.Port + " is in use.", failure);
        }
        Task.Run((Func<Task>)Listen);
    }

    private async Task Listen()
    {
        while (listener.IsListening)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (HttpListenerException failure)
            {
                if (listener.IsListening) Trace.TraceError("Stremio Party could not accept a local request: {0}", failure.ErrorCode);
                return;
            }
            catch (ObjectDisposedException)
            {
                return;
            }
            // Each request owns its response until the asynchronous file copy completes.
            Serve(context);
        }
    }

    private async void Serve(HttpListenerContext context)
    {
        using (var response = context.Response)
        {
            try
            {
                var request = context.Request;
                if (!IPAddress.IsLoopback(request.RemoteEndPoint.Address))
                {
                    response.StatusCode = (int)HttpStatusCode.Forbidden;
                    return;
                }
                var filePath = FindAsset(request.Url.AbsolutePath);
                if (filePath == null)
                {
                    await engineProxy.Forward(context).ConfigureAwait(false);
                    return;
                }

                if (request.HttpMethod != GetMethod && request.HttpMethod != HeadMethod)
                {
                    response.StatusCode = (int)HttpStatusCode.MethodNotAllowed;
                    return;
                }

                string mimeType;
                response.ContentType = DesktopSettings.ContentTypes.TryGetValue(Path.GetExtension(filePath), out mimeType) ? mimeType : "application/octet-stream";
                response.Headers["Cache-Control"] = "no-cache";
                response.Headers["X-Content-Type-Options"] = "nosniff";
                using (var file = File.OpenRead(filePath))
                {
                    response.ContentLength64 = file.Length;
                    if (request.HttpMethod == GetMethod) await file.CopyToAsync(response.OutputStream).ConfigureAwait(false);
                }
            }
            catch (IOException failure) { Abort(response, failure); }
            catch (HttpListenerException failure) { Abort(response, failure); }
            catch (UnauthorizedAccessException failure) { Abort(response, failure); }
            catch (ArgumentException failure) { Abort(response, failure); }
        }
    }

    private string FindAsset(string path)
    {
        var relative = Uri.UnescapeDataString(path).TrimStart('/');
        if (relative.Length == 0 || relative == DesktopSettings.DesktopEntry) relative = DesktopSettings.IndexFile;
        if (relative.IndexOfAny(Path.GetInvalidPathChars()) >= 0 || relative.IndexOfAny(new[] { '\\', ':' }) >= 0) return null;

        var filePath = Path.GetFullPath(Path.Combine(directory, relative.Replace('/', Path.DirectorySeparatorChar)));
        return filePath.StartsWith(directory, StringComparison.OrdinalIgnoreCase) && File.Exists(filePath) ? filePath : null;
    }

    private static void Abort(HttpListenerResponse response, Exception failure)
    {
        Trace.TraceError("Stremio Party could not serve a local asset: {0}", failure.GetType().Name);
        response.Abort();
    }

    public void Dispose()
    {
        listener.Close();
        engineProxy.Dispose();
    }
}
