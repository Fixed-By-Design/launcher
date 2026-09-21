using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace FixedByDesign {
  sealed class SetupWindow : Form {
    readonly Label status = new Label { AutoSize = false, Dock = DockStyle.Fill, Text = "La dernière version sera téléchargée depuis GitHub au moment de l’installation.", ForeColor = Color.FromArgb(190, 203, 175) };
    readonly ProgressBar progress = new ProgressBar { Dock = DockStyle.Fill, Style = ProgressBarStyle.Continuous };
    readonly Button install = new Button { Text = "Installer la dernière version", AutoSize = true, BackColor = Color.FromArgb(213, 229, 157), ForeColor = Color.FromArgb(29, 41, 22), FlatStyle = FlatStyle.Flat };
    readonly Button cancel = new Button { Text = "Annuler", AutoSize = true, Enabled = false, FlatStyle = FlatStyle.Flat };
    CancellationTokenSource cancellation;
    bool installing;
    bool userCancelled;
    [StructLayout(LayoutKind.Sequential)]
    struct SystemInfo { public ushort architecture, reserved; public uint pageSize; public IntPtr minAddress, maxAddress, activeMask; public uint processors, type, granularity; public ushort level, revision; }
    [DllImport("kernel32.dll")] static extern void GetNativeSystemInfo(out SystemInfo info);
    public SetupWindow() {
      Text = "Installer Fixed By Design";
      ClientSize = new Size(560, 320);
      MinimumSize = new Size(540, 350);
      StartPosition = FormStartPosition.CenterScreen;
      BackColor = Color.FromArgb(16, 21, 16);
      ForeColor = Color.FromArgb(236, 239, 227);
      Font = new Font("Segoe UI", 10);
      var layout = new TableLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(24), RowCount = 5, ColumnCount = 1 };
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 45));
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 62));
      layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 22));
      layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 52));
      layout.Controls.Add(new Label { Text = "Ton aventure commence ici.", AutoSize = true, Font = new Font(Font.FontFamily, 20) }, 0, 0);
      layout.Controls.Add(new Label { Text = "Version communautaire de test, sans signature d’éditeur.\nWindows peut afficher un avertissement ou empêcher l’ouverture.", AutoSize = false, Dock = DockStyle.Fill }, 0, 1);
      layout.Controls.Add(status, 0, 2);
      layout.Controls.Add(progress, 0, 3);
      var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, Padding = new Padding(0, 12, 0, 0) };
      buttons.Controls.Add(install); buttons.Controls.Add(cancel);
      layout.Controls.Add(buttons, 0, 4);
      Controls.Add(layout);
      install.Click += async (sender, args) => await BeginInstall();
      cancel.Click += (sender, args) => { userCancelled = true; cancellation.Cancel(); };
      FormClosing += (sender, args) => {
        if (cancellation == null) return;
        args.Cancel = true;
        if (!installing) { userCancelled = true; cancellation.Cancel(); }
      };
    }
    async Task BeginInstall() {
      SystemInfo system; GetNativeSystemInfo(out system);
      if (system.architecture != 9 || Environment.OSVersion.Version.Major < 10) { status.Text = "Cette version nécessite Windows 10/11 x64 sur un processeur Intel ou AMD."; return; }
      install.Enabled = false; cancel.Enabled = true;
      cancellation = new CancellationTokenSource();
      cancellation.CancelAfter(TimeSpan.FromMinutes(20));
      userCancelled = false;
      string directory = Path.Combine(Path.GetTempPath(), "fbd-setup-" + Guid.NewGuid().ToString("N"));
      try {
        Directory.CreateDirectory(directory);
        using (var installer = new Installer()) {
          status.Text = "Recherche de la dernière version sur GitHub…";
          var resolved = await installer.Resolve(cancellation.Token);
          var payload = resolved.Item2;
          if (new DriveInfo(Path.GetPathRoot(directory)).AvailableFreeSpace < payload.size * 3) throw new IOException("Libère de l’espace disque puis réessaie.");
          status.Text = "Téléchargement de la version " + resolved.Item1.tag_name + "…";
          var path = Path.Combine(directory, payload.name);
          await installer.Download(resolved.Item1, payload, path, new Progress<int>(value => progress.Value = value), cancellation.Token);
          cancellation.Token.ThrowIfCancellationRequested();
          Installer.MarkInternet(path);
          installing = true; cancel.Enabled = false;
          status.Text = "Fichier vérifié. Termine l’installation dans la fenêtre qui s’ouvre.";
          using (var process = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true })) {
            if (process == null) throw new IOException("Windows n’a pas ouvert l’installateur.");
            await Task.Run(() => process.WaitForExit());
            if (process.ExitCode != 0) throw new IOException("L’installation a été interrompue ou refusée par Windows. Code : " + process.ExitCode + ".");
          }
          status.Text = "Installation terminée. Ouvre Fixed By Design depuis le menu Démarrer.";
          install.Text = "Réinstaller la dernière version";
        }
      } catch (OperationCanceledException) {
        status.Text = userCancelled ? "Téléchargement annulé. Ton installation existante n’a pas été modifiée." : "Le téléchargement a expiré. Vérifie ta connexion et réessaie.";
      } catch (Exception error) {
        status.Text = "Installation impossible : " + error.Message;
        install.Text = "Réessayer";
      } finally {
        try { if (Directory.Exists(directory)) Directory.Delete(directory, true); }
        catch (Exception error) { status.Text += "\nNettoyage impossible : " + error.Message; }
        cancellation.Dispose(); cancellation = null; installing = false;
        install.Enabled = true; cancel.Enabled = false;
      }
    }
  }
  static class Program {
    [STAThread]
    static void Main() {
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new SetupWindow());
    }
  }
}
