import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const require = createRequire(import.meta.url)
const rcedit = require('rcedit')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(__dirname, '..')
const rootDir = path.resolve(desktopDir, '../..')
const resourcesDir = path.join(desktopDir, 'resources')
const iconPath = path.join(resourcesDir, 'icon.ico')
const pngIconPath = path.join(resourcesDir, 'icon.png')
const distReleaseDir = path.join(desktopDir, 'dist-release')
const unpackedDir = path.join(distReleaseDir, 'DeepSeek-Harness-win32-x64')
const electronCacheZip = 'C:\\Users\\Administrator\\AppData\\Local\\electron\\Cache\\electron-v33.4.11-win32-x64.zip'

function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

async function packageWindows() {
  console.log('=== Step 1: Building desktop code & icon ===')
  // 1. Generate ICO if needed
  execFileSync('npx.cmd', ['tsx', path.join(__dirname, 'generate-ico.ts')], { stdio: 'inherit', shell: true })

  // 2. Build desktop main & preload
  execFileSync('npx.cmd', ['tsdown'], { cwd: desktopDir, stdio: 'inherit', shell: true })

  console.log('=== Step 2: Preparing release directory ===')
  if (!fs.existsSync(distReleaseDir)) {
    fs.mkdirSync(distReleaseDir, { recursive: true })
  }

  console.log('=== Step 3: Extracting Electron binary ===')
  if (fs.existsSync(unpackedDir)) {
    fs.rmSync(unpackedDir, { recursive: true, force: true })
  }
  fs.mkdirSync(unpackedDir, { recursive: true })
  execFileSync('tar.exe', ['-xf', electronCacheZip, '-C', unpackedDir], { stdio: 'inherit' })

  console.log('=== Step 4: Copying app resources ===')
  const appDir = path.join(unpackedDir, 'resources', 'app')
  fs.mkdirSync(appDir, { recursive: true })

  // Copy package.json
  fs.copyFileSync(path.join(desktopDir, 'package.json'), path.join(appDir, 'package.json'))

  // Copy dist-electron
  fs.cpSync(path.join(desktopDir, 'dist-electron'), path.join(appDir, 'dist-electron'), { recursive: true })

  // Copy src/renderer
  fs.cpSync(path.join(desktopDir, 'src', 'renderer'), path.join(appDir, 'src', 'renderer'), { recursive: true })

  // Copy web-dist (built frontend)
  const webDistSrc = path.resolve(rootDir, 'apps', 'web', 'dist')
  if (fs.existsSync(webDistSrc)) {
    fs.cpSync(webDistSrc, path.join(appDir, 'web-dist'), { recursive: true })
    console.log('Copied built web-dist frontend into app bundle.')
  }

  // Bundle client plugins into appDir/client-plugins
  const clientPluginsTargetDir = path.join(appDir, 'client-plugins')
  fs.mkdirSync(clientPluginsTargetDir, { recursive: true })

  const manifest: Record<string, { id: string; file: string; rev: string; immediately?: boolean }> = {}

  function collectPlugins(dir: string) {
    if (!fs.existsSync(dir)) return
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true })
      for (const item of items) {
        if (!item.isDirectory()) continue
        const itemPath = path.join(dir, item.name)
        const pkgJsonPath = path.join(itemPath, 'package.json')
        const clientJsPath = path.join(itemPath, 'lib', 'client.js')
        const clientMapPath = path.join(itemPath, 'lib', 'client.js.map')

        if (fs.existsSync(pkgJsonPath) && fs.existsSync(clientJsPath)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
            if (pkg.name && pkg.dsh?.client?.platform === 'web') {
              const content = fs.readFileSync(clientJsPath)
              const rev = shortHash(content)
              
              // Safe folder name: e.g. @deepseek-ai/dsh-client-modules/client.js
              const targetSubDir = path.join(clientPluginsTargetDir, pkg.name)
              fs.mkdirSync(targetSubDir, { recursive: true })
              fs.copyFileSync(clientJsPath, path.join(targetSubDir, 'client.js'))
              if (fs.existsSync(clientMapPath)) {
                fs.copyFileSync(clientMapPath, path.join(targetSubDir, 'client.js.map'))
              }

              manifest[pkg.name] = {
                id: pkg.name,
                file: `${pkg.name}/client.js`,
                rev,
                immediately: pkg.dsh.client.immediately === true,
              }
            }
          } catch {}
        } else {
          collectPlugins(itemPath)
        }
      }
    } catch {}
  }

  collectPlugins(path.join(rootDir, 'packages'))
  fs.writeFileSync(path.join(clientPluginsTargetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`Bundled ${Object.keys(manifest).length} client plugins into client-plugins directory.`)

  // Copy resources (icons)
  fs.cpSync(resourcesDir, path.join(appDir, 'resources'), { recursive: true })

  console.log('=== Step 5: Renaming executable and patching metadata with Whale icon ===')
  const oldExe = path.join(unpackedDir, 'electron.exe')
  const targetExe = path.join(unpackedDir, 'DeepSeek Harness.exe')
  if (fs.existsSync(oldExe)) {
    fs.renameSync(oldExe, targetExe)
  }

  // Find rcedit-x64.exe
  const rceditBin = path.resolve(rootDir, 'node_modules/.pnpm/rcedit@5.0.2/node_modules/rcedit/bin/rcedit-x64.exe')
  if (fs.existsSync(rceditBin)) {
    execFileSync(rceditBin, [
      targetExe,
      '--set-icon', iconPath,
      '--set-version-string', 'FileDescription', 'DeepSeek Harness Desktop',
      '--set-version-string', 'ProductName', 'DeepSeek Harness',
      '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 DeepSeek AI',
      '--set-version-string', 'OriginalFilename', 'DeepSeek Harness.exe',
      '--set-file-version', '0.1.1.0',
      '--set-product-version', '0.1.1.0',
    ])
    console.log('Patched DeepSeek Harness.exe metadata with Whale icon successfully.')
  }

  console.log('=== Step 6: Building One-Click Windows Setup Installer EXE ===')
  const installerExePath = path.join(distReleaseDir, 'DeepSeek-Harness-Setup-0.1.1.exe')
  const payloadZip = path.join(distReleaseDir, 'payload.zip')

  if (fs.existsSync(payloadZip)) {
    fs.unlinkSync(payloadZip)
  }

  console.log('Compressing app bundle into installer payload...')
  execFileSync('tar.exe', ['-a', '-cf', payloadZip, '*'], { cwd: unpackedDir, stdio: 'inherit' })

  // Compile standalone C# installer with Windows csc.exe
  const installerCsPath = path.join(distReleaseDir, 'Installer.cs')
  const csharpCode = `
using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using System.Collections.Generic;
using Microsoft.Win32;

namespace DeepSeekHarness.Installer
{
    public class InstallerForm : Form
    {
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);

        private ProgressBar progressBar;
        private Label lblStatus;
        private PictureBox logoBox;

        public InstallerForm()
        {
            this.Text = "DeepSeek Harness 安装程序";
            this.Size = new Size(520, 360);
            this.StartPosition = FormStartPosition.CenterScreen;
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.BackColor = Color.FromArgb(248, 250, 252);

            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream stream = asm.GetManifestResourceStream("icon.png"))
                {
                    if (stream != null)
                    {
                        Bitmap bmp = new Bitmap(stream);
                        this.Icon = Icon.FromHandle(bmp.GetHicon());
                    }
                }
            }
            catch {}

            Panel card = new Panel();
            card.BackColor = Color.White;
            card.Location = new Point(24, 20);
            card.Size = new Size(456, 275);
            card.BorderStyle = BorderStyle.None;
            this.Controls.Add(card);

            logoBox = new PictureBox();
            logoBox.Size = new Size(64, 64);
            logoBox.Location = new Point(24, 20);
            logoBox.SizeMode = PictureBoxSizeMode.Zoom;
            try
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream stream = asm.GetManifestResourceStream("icon.png"))
                {
                    if (stream != null) logoBox.Image = Image.FromStream(stream);
                }
            }
            catch {}
            card.Controls.Add(logoBox);

            Label lblTitle = new Label();
            lblTitle.Text = "DeepSeek Harness";
            lblTitle.Font = new Font("Segoe UI", 16, FontStyle.Bold);
            lblTitle.ForeColor = Color.FromArgb(15, 23, 42);
            lblTitle.Location = new Point(100, 22);
            lblTitle.AutoSize = true;
            card.Controls.Add(lblTitle);

            Label lblSub = new Label();
            lblSub.Text = "官方桌面客户端 0.1.1 版一键安装与插件协议注册";
            lblSub.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            lblSub.ForeColor = Color.FromArgb(100, 116, 139);
            lblSub.Location = new Point(102, 54);
            lblSub.AutoSize = true;
            card.Controls.Add(lblSub);

            lblStatus = new Label();
            lblStatus.Text = "正在初始化安装环境...";
            lblStatus.Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
            lblStatus.ForeColor = Color.FromArgb(30, 41, 59);
            lblStatus.Location = new Point(24, 110);
            lblStatus.Size = new Size(416, 24);
            card.Controls.Add(lblStatus);

            progressBar = new ProgressBar();
            progressBar.Location = new Point(24, 140);
            progressBar.Size = new Size(408, 22);
            progressBar.Style = ProgressBarStyle.Marquee;
            progressBar.MarqueeAnimationSpeed = 30;
            card.Controls.Add(progressBar);

            Label lblTip = new Label();
            lblTip.Text = "⚡ 正在为您自动部署到个人应用目录并配置桌面快捷方式与 dsh:// 协议关联...";
            lblTip.Font = new Font("Segoe UI", 8.5f, FontStyle.Regular);
            lblTip.ForeColor = Color.FromArgb(100, 116, 139);
            lblTip.Location = new Point(24, 185);
            lblTip.Size = new Size(416, 40);
            card.Controls.Add(lblTip);

            this.Shown += (s, e) => {
                Thread t = new Thread(DoInstallation);
                t.IsBackground = true;
                t.Start();
            };
        }

        private void UpdateStatus(string text, int progress = -1)
        {
            if (this.InvokeRequired)
            {
                this.Invoke(new Action(() => UpdateStatus(text, progress)));
                return;
            }
            lblStatus.Text = text;
            if (progress >= 0)
            {
                progressBar.Style = ProgressBarStyle.Continuous;
                progressBar.Value = Math.Min(100, Math.Max(0, progress));
            }
        }

        private void DoInstallation()
        {
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string installDir = Path.Combine(localAppData, "Programs", "DeepSeek-Harness");
                string exePath = Path.Combine(installDir, "DeepSeek Harness.exe");

                UpdateStatus("正在检查并清理旧版进程...", 10);
                try
                {
                    foreach (var proc in Process.GetProcessesByName("DeepSeek Harness"))
                    {
                        try { proc.Kill(); proc.WaitForExit(2000); } catch {}
                    }
                    Thread.Sleep(500);
                }
                catch {}

                UpdateStatus("正在解压程序文件并写入磁盘...", 25);
                Directory.CreateDirectory(installDir);

                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream resStream = asm.GetManifestResourceStream("payload.zip"))
                {
                    if (resStream != null)
                    {
                        using (ZipArchive archive = new ZipArchive(resStream))
                        {
                            int count = archive.Entries.Count;
                            int i = 0;
                            foreach (ZipArchiveEntry entry in archive.Entries)
                            {
                                i++;
                                string completeFileName = Path.Combine(installDir, entry.FullName);
                                string dir = Path.GetDirectoryName(completeFileName);
                                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                                if (!string.IsNullOrEmpty(entry.Name))
                                {
                                    for (int retry = 0; retry < 5; retry++)
                                    {
                                        try
                                        {
                                            entry.ExtractToFile(completeFileName, true);
                                            break;
                                        }
                                        catch (IOException)
                                        {
                                            if (retry == 4) throw;
                                            Thread.Sleep(300);
                                        }
                                    }
                                }
                                if (i % 50 == 0)
                                {
                                    UpdateStatus(string.Format("正在释放核心文件 ({0}/{1})...", i, count), 25 + (int)(35.0 * i / count));
                                }
                            }
                        }
                    }
                    else
                    {
                        string currentDir = AppDomain.CurrentDomain.BaseDirectory;
                        string zipPath = Path.Combine(currentDir, "payload.zip");
                        if (File.Exists(zipPath))
                        {
                            ZipFile.ExtractToDirectory(zipPath, installDir);
                        }
                    }
                }

                UpdateStatus("正在配置 Windows dsh:// 协议关联...", 70);
                RegisterProtocol(exePath);

                UpdateStatus("正在生成桌面与开始菜单快捷方式...", 88);
                CreateShortcuts(exePath, installDir);

                UpdateStatus("安装完成！正在启动 DeepSeek Harness...", 100);
                Thread.Sleep(800);

                Process.Start(new ProcessStartInfo {
                    FileName = exePath,
                    WorkingDirectory = installDir
                });

                this.Invoke(new Action(() => this.Close()));
            }
            catch (Exception ex)
            {
                MessageBox.Show("安装过程中发生错误: " + ex.Message, "安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
                this.Invoke(new Action(() => this.Close()));
            }
        }

        private void RegisterProtocol(string exePath)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\\Classes\\dsh"))
                {
                    key.SetValue("", "DeepSeek Harness Protocol");
                    key.SetValue("URL Protocol", "");

                    using (RegistryKey iconKey = key.CreateSubKey("DefaultIcon"))
                    {
                        iconKey.SetValue("", "\\"" + exePath + "\\",0");
                    }

                    using (RegistryKey shellKey = key.CreateSubKey(@"shell\\open\\command"))
                    {
                        shellKey.SetValue("", "\\"" + exePath + "\\" \\"%1\\"");
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("RegisterProtocol failed: " + ex.Message);
            }
        }

        private void CreateShortcuts(string exePath, string installDir)
        {
            var desktopDirs = new List<string>();
            try {
                string userProfile = Environment.GetEnvironmentVariable("USERPROFILE");
                if (!string.IsNullOrEmpty(userProfile))
                {
                    desktopDirs.Add(Path.Combine(userProfile, "Desktop"));
                    desktopDirs.Add(Path.Combine(userProfile, "OneDrive", "Desktop"));
                }
            } catch {}
            try { desktopDirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.Desktop)); } catch {}
            try { desktopDirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)); } catch {}
            try { desktopDirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.CommonDesktopDirectory)); } catch {}

            foreach (var dir in desktopDirs)
            {
                if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                {
                    try {
                        CreateShortcut(Path.Combine(dir, "DeepSeek Harness.lnk"), exePath, installDir);
                    } catch {}
                }
            }

            var startMenuDirs = new List<string>();
            try { startMenuDirs.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs")); } catch {}
            try { startMenuDirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.Programs)); } catch {}
            try { startMenuDirs.Add(Environment.GetFolderPath(Environment.SpecialFolder.CommonPrograms)); } catch {}

            foreach (var dir in startMenuDirs)
            {
                if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                {
                    try {
                        CreateShortcut(Path.Combine(dir, "DeepSeek Harness.lnk"), exePath, installDir);
                    } catch {}
                }
            }

            try {
                SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
            } catch {}
        }

        private void CreateShortcut(string shortcutPath, string targetPath, string workDir)
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) t = Type.GetTypeFromCLSID(new Guid("72C24DD5-D70A-438B-84D2-9642D0377B37"));
            if (t != null)
            {
                dynamic shell = Activator.CreateInstance(t);
                dynamic shortcut = shell.CreateShortcut(shortcutPath);
                shortcut.TargetPath = targetPath;
                shortcut.WorkingDirectory = workDir;
                shortcut.Description = "DeepSeek Harness Official Desktop";
                shortcut.IconLocation = targetPath + ",0";
                shortcut.Save();
            }
        }

        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new InstallerForm());
        }
    }
}
`

  fs.writeFileSync(installerCsPath, csharpCode, 'utf8')

  console.log('Compiling native C# Installer with csc.exe (embedding payload and icon)...')
  const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
  
  const cscArgs = [
    '/target:winexe',
    `/out:${installerExePath}`,
    `/win32icon:${iconPath}`,
    `/resource:${payloadZip},payload.zip`,
    `/resource:${pngIconPath},icon.png`,
    '/reference:System.Windows.Forms.dll',
    '/reference:System.Drawing.dll',
    '/reference:System.IO.Compression.dll',
    '/reference:System.IO.Compression.FileSystem.dll',
    installerCsPath,
  ]

  const compileResult = spawnSync(cscPath, cscArgs, { stdio: 'inherit' })
  if (compileResult.status !== 0) {
    throw new Error('Failed to compile installer executable')
  }

  // Clean up intermediate source
  try {
    fs.unlinkSync(installerCsPath)
  } catch {}

  console.log(`Generated Standalone Installer EXE: ${installerExePath}`)
}

packageWindows().catch((err) => {
  console.error('Packaging failed:', err)
  process.exit(1)
})
