using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace FixedByDesign {
  sealed class Fixture : HttpMessageHandler {
    public readonly Dictionary<string, byte[]> files = new Dictionary<string, byte[]>();
    public string redirect;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) {
      cancellation.ThrowIfCancellationRequested();
      if (redirect != null) {
        var response = new HttpResponseMessage(HttpStatusCode.Redirect);
        response.Headers.Location = new Uri(redirect);
        return Task.FromResult(response);
      }
      byte[] bytes;
      if (!files.TryGetValue(request.RequestUri.ToString(), out bytes)) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
      return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) });
    }
  }
  static class BootstrapTests {
    static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
    static void Reject(Action action) {
      try { action(); } catch (IOException) { return; }
      throw new Exception("Expected validation failure");
    }
    static async Task RejectAsync(Func<Task> action) {
      try { await action(); } catch (IOException) { return; } catch (OperationCanceledException) { return; }
      throw new Exception("Expected transfer failure");
    }
    static string Hash(byte[] bytes) { using (var hash = SHA512.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static int Main() {
      try { Run().GetAwaiter().GetResult(); Console.WriteLine("Windows bootstrap checks passed: latest resolution, strict origin/version/size/hash, cancellation, preservation and Internet provenance."); return 0; }
      catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
    static async Task Run() {
      var bytes = Encoding.UTF8.GetBytes("future release payload");
      var payload = new Payload { name = "FBD-Launcher-9.8.7-windows-x64.exe", size = bytes.Length, sha512 = Hash(bytes) };
      var payloadUrl = Installer.Repository + "/releases/download/v9.8.7/" + payload.name;
      var manifestUrl = Installer.Repository + "/releases/download/v9.8.7/launcher-manifest.json";
      var release = new Release { tag_name = "v9.8.7", assets = new[] {
        new Asset { name = payload.name, browser_download_url = payloadUrl, size = payload.size },
        new Asset { name = "launcher-manifest.json", browser_download_url = manifestUrl, size = 500 },
      }};
      var manifest = new Manifest { schemaVersion = 1, version = "9.8.7", payloads = new Dictionary<string, Payload> { { "windows-x64", payload } } };
      var json = new JavaScriptSerializer();
      var fixture = new Fixture();
      fixture.files[Installer.Latest] = Encoding.UTF8.GetBytes(json.Serialize(release));
      fixture.files[manifestUrl] = Encoding.UTF8.GetBytes(json.Serialize(manifest));
      fixture.files[payloadUrl] = bytes;
      string directory = Path.Combine(Path.GetTempPath(), "fbd-bootstrap-test-" + Guid.NewGuid().ToString("N"));
      Directory.CreateDirectory(directory);
      try {
        using (var installer = new Installer(fixture)) {
          var latest = await installer.Resolve(CancellationToken.None);
          Check(latest.Item1.tag_name == "v9.8.7", "Bootstrap must resolve a future version, not its own build version");
          var destination = Path.Combine(directory, "setup.exe");
          await installer.Download(latest.Item1, latest.Item2, destination, null, CancellationToken.None);
          Check(File.ReadAllText(destination) == "future release payload", "Verified download differs");
          Installer.MarkInternet(destination);
          Check(File.ReadAllText(destination + ":Zone.Identifier").Contains("ZoneId=3"), "Internet provenance missing");
          payload.sha512 = new string('0', 128);
          await RejectAsync(() => installer.Download(release, payload, destination, null, CancellationToken.None));
          Check(!File.Exists(destination + ".part"), "Corrupted partial file retained");
          Check(File.ReadAllText(destination) == "future release payload", "Existing file overwritten after failure");
          payload.sha512 = Hash(bytes);
          payload.size++;
          await RejectAsync(() => installer.Download(release, payload, destination, null, CancellationToken.None));
          payload.size--;
          using (var cancellation = new CancellationTokenSource()) {
            cancellation.Cancel();
            await RejectAsync(() => installer.Download(release, payload, destination, null, cancellation.Token));
          }
          Check(!File.Exists(destination + ".part"), "Cancelled partial file retained");
        }
        Check(Installer.Trusted(new Uri("https://release-assets.githubusercontent.com/file")), "GitHub redirect rejected");
        foreach (var url in new[] { "http://github.com/file", "https://github.com.evil.test/file", "https://user@github.com/file", "https://github.com:123/file" })
          Check(!Installer.Trusted(new Uri(url)), "Untrusted URL accepted");
        manifest.version = "0.1.0"; Reject(() => Installer.Select(release, manifest)); manifest.version = "9.8.7";
        manifest.schemaVersion = 2; Reject(() => Installer.Select(release, manifest)); manifest.schemaVersion = 1;
        release.prerelease = true; Reject(() => Installer.Select(release, manifest)); release.prerelease = false;
        release.draft = true; Reject(() => Installer.Select(release, manifest)); release.draft = false;
        release.assets[0].browser_download_url = "https://example.test/file"; Reject(() => Installer.Select(release, manifest)); release.assets[0].browser_download_url = payloadUrl;
        payload.name = "../setup.exe"; Reject(() => Installer.Select(release, manifest)); payload.name = "FBD-Launcher-9.8.7-windows-x64.exe";
        payload.size = long.MaxValue; Reject(() => Installer.Select(release, manifest)); payload.size = bytes.Length;
        fixture = new Fixture { redirect = "https://example.test/file" };
        using (var installer = new Installer(fixture)) await RejectAsync(() => installer.Resolve(CancellationToken.None));
        fixture = new Fixture();
        using (var installer = new Installer(fixture)) await RejectAsync(() => installer.Resolve(CancellationToken.None));
      } finally { Directory.Delete(directory, true); }
    }
  }
}
