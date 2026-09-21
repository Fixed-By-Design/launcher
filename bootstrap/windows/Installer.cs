using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace FixedByDesign {
  public sealed class Asset {
    public string name { get; set; }
    public string browser_download_url { get; set; }
    public long size { get; set; }
  }
  public sealed class Release {
    public string tag_name { get; set; }
    public bool draft { get; set; }
    public bool prerelease { get; set; }
    public Asset[] assets { get; set; }
  }
  public sealed class Payload {
    public string name { get; set; }
    public long size { get; set; }
    public string sha512 { get; set; }
  }
  public sealed class Manifest {
    public int schemaVersion { get; set; }
    public string version { get; set; }
    public Dictionary<string, Payload> payloads { get; set; }
  }
  public sealed class Installer : IDisposable {
    public const string Repository = "https://github.com/Fixed-By-Design/launcher";
    public const string Latest = "https://api.github.com/repos/Fixed-By-Design/launcher/releases/latest";
    const long MaximumPayload = 1024L * 1024 * 1024;
    readonly HttpClient client;
    public Installer(HttpMessageHandler handler = null) {
      ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
      client = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false });
      client.Timeout = TimeSpan.FromMinutes(20);
      client.DefaultRequestHeaders.UserAgent.ParseAdd("FixedByDesign-Setup/1");
      client.DefaultRequestHeaders.CacheControl = new System.Net.Http.Headers.CacheControlHeaderValue { NoCache = true };
    }
    public void Dispose() { client.Dispose(); }
    public static bool Trusted(Uri uri) {
      return uri.Scheme == "https" && uri.IsDefaultPort && uri.UserInfo == "" &&
        (uri.Host == "api.github.com" || uri.Host == "github.com" || uri.Host == "release-assets.githubusercontent.com" || uri.Host == "objects.githubusercontent.com");
    }
    async Task<HttpResponseMessage> Request(string url, CancellationToken cancellation) {
      var uri = new Uri(url);
      for (int redirect = 0; redirect < 6; redirect++) {
        if (!Trusted(uri)) throw new IOException("GitHub a renvoyé une adresse de téléchargement non autorisée.");
        var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellation);
        if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400) {
          var location = response.Headers.Location;
          response.Dispose();
          if (location == null) throw new IOException("Redirection GitHub invalide.");
          uri = location.IsAbsoluteUri ? location : new Uri(uri, location);
          continue;
        }
        if (response.IsSuccessStatusCode) return response;
        var status = response.StatusCode;
        response.Dispose();
        if (status == HttpStatusCode.NotFound) throw new IOException("Aucune version disponible. Réessaie plus tard.");
        if (status == HttpStatusCode.Forbidden || (int)status == 429) throw new IOException("GitHub limite les téléchargements. Patiente quelques minutes puis réessaie.");
        throw new IOException("GitHub est indisponible. Vérifie ta connexion puis réessaie.");
      }
      throw new IOException("Trop de redirections pendant le téléchargement.");
    }
    async Task<byte[]> Metadata(string url, CancellationToken cancellation) {
      using (var response = await Request(url, cancellation))
      using (var input = await response.Content.ReadAsStreamAsync())
      using (var output = new MemoryStream()) {
        var buffer = new byte[16384];
        int count;
        while ((count = await input.ReadAsync(buffer, 0, buffer.Length, cancellation)) > 0) {
          if (output.Length + count > 1024 * 1024) throw new IOException("Métadonnées GitHub trop volumineuses.");
          output.Write(buffer, 0, count);
        }
        return output.ToArray();
      }
    }
    public static Asset FindAsset(Release release, string name) {
      Asset found = null;
      foreach (var asset in release.assets ?? new Asset[0]) {
        if (asset.name != name) continue;
        if (found != null) throw new IOException("La release contient des fichiers en double.");
        found = asset;
      }
      var expected = Repository + "/releases/download/" + Uri.EscapeDataString(release.tag_name) + "/" + Uri.EscapeDataString(name);
      if (found == null || found.browser_download_url != expected) throw new IOException("La release est incomplète ou son adresse de téléchargement est invalide.");
      return found;
    }
    public static Payload Select(Release release, Manifest manifest) {
      if (release.draft || release.prerelease || !Regex.IsMatch(release.tag_name ?? "", @"\Av[0-9]+\.[0-9]+\.[0-9]+\z"))
        throw new IOException("Cette release ne correspond pas au canal de distribution.");
      if (manifest.schemaVersion != 1 || "v" + manifest.version != release.tag_name)
        throw new IOException("Le manifeste ne correspond pas à la release. Télécharge à nouveau l’installateur depuis GitHub.");
      Payload payload;
      if (manifest.payloads == null || !manifest.payloads.TryGetValue("windows-x64", out payload) || payload == null ||
          payload.name != "FBD-Launcher-" + manifest.version + "-windows-x64.exe" ||
          payload.size <= 0 || payload.size > MaximumPayload || !Regex.IsMatch(payload.sha512 ?? "", @"\A[a-f0-9]{128}\z"))
        throw new IOException("Le fichier Windows de cette version est invalide ou absent.");
      if (FindAsset(release, payload.name).size != payload.size) throw new IOException("La taille du fichier ne correspond pas au manifeste.");
      return payload;
    }
    public async Task<Tuple<Release, Payload>> Resolve(CancellationToken cancellation) {
      var json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
      var release = json.Deserialize<Release>(System.Text.Encoding.UTF8.GetString(await Metadata(Latest, cancellation)));
      if (release == null || release.draft || release.prerelease || !Regex.IsMatch(release.tag_name ?? "", @"\Av[0-9]+\.[0-9]+\.[0-9]+\z"))
        throw new IOException("Aucune release compatible disponible.");
      var manifestAsset = FindAsset(release, "launcher-manifest.json");
      var manifest = json.Deserialize<Manifest>(System.Text.Encoding.UTF8.GetString(await Metadata(manifestAsset.browser_download_url, cancellation)));
      if (manifest == null) throw new IOException("Manifeste de téléchargement invalide.");
      return Tuple.Create(release, Select(release, manifest));
    }
    public async Task Download(Release release, Payload payload, string destination, IProgress<int> progress, CancellationToken cancellation) {
      var part = destination + ".part";
      try {
        using (var response = await Request(FindAsset(release, payload.name).browser_download_url, cancellation))
        using (var input = await response.Content.ReadAsStreamAsync())
        using (var output = new FileStream(part, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, true))
        using (var hash = SHA512.Create()) {
          if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != payload.size)
            throw new IOException("Taille de téléchargement inattendue.");
          var buffer = new byte[65536];
          long received = 0;
          int count;
          while ((count = await input.ReadAsync(buffer, 0, buffer.Length, cancellation)) > 0) {
            received += count;
            if (received > payload.size) throw new IOException("Le téléchargement dépasse la taille annoncée.");
            hash.TransformBlock(buffer, 0, count, buffer, 0);
            await output.WriteAsync(buffer, 0, count, cancellation);
            if (progress != null) progress.Report((int)(received * 100 / payload.size));
          }
          hash.TransformFinalBlock(new byte[0], 0, 0);
          var actual = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
          if (received != payload.size || actual != payload.sha512) throw new IOException("Le téléchargement est incomplet ou corrompu. Réessaie.");
          await output.FlushAsync(cancellation);
        }
        cancellation.ThrowIfCancellationRequested();
        File.Move(part, destination);
      } finally {
        if (File.Exists(part)) File.Delete(part);
      }
    }
    public static void MarkInternet(string path) {
      File.WriteAllText(path + ":Zone.Identifier", "[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=" + Repository + "\r\n");
    }
  }
}
