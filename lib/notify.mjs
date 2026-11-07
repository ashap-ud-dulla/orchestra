// A Windows notification ("toast") when a run needs you.
// Uses the built-in Windows toast API through PowerShell; nothing to install.
// It is sent as Windows Terminal (Orchestra needs it anyway; Windows lists it under Settings > Notifications, so the
// user can turn it on or off there), else as PowerShell. Clicking it opens the link "orchestra-focus:<tab title>",
// which bin/focus-tab.ps1 handles: it brings that run's tab to the front. The link is registered for this Windows
// user (HKCU, no admin) each time a notification goes out, so a fresh clone on any PC works with no setup step.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { config } from './config.mjs';

export const FOCUS_SCHEME = 'orchestra-focus';

// The link a notification opens to bring the tab with this title to the front.
export function focusUrl(tabTitle) {
  return tabTitle ? `${FOCUS_SCHEME}:${encodeURIComponent(tabTitle)}` : '';
}

// Text goes in through env vars, never into the script, so nothing in it can run as code.
export const SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
if ($env:OT_URL) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\\Classes\\${FOCUS_SCHEME}')
  $k.SetValue('', 'URL:Orchestra: show the run tab')
  $k.SetValue('URL Protocol', '')
  # conhost --headless: powershell gets a console with no window, so a click flashes nothing (Hidden alone still flashes).
  $k.CreateSubKey('shell\\open\\command').SetValue('', 'conhost.exe --headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $env:OT_FOCUS + '" "%1"')
}
$e = { param($s) [Security.SecurityElement]::Escape($s) }
$xml = '<toast activationType="protocol" launch="' + (& $e $env:OT_URL) + '"><visual><binding template="ToastGeneric"><text>' + (& $e $env:OT_TITLE) + '</text><text>' + (& $e $env:OT_BODY) + '</text></binding></visual></toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$app = (Get-StartApps | Where-Object { $_.AppID -like 'Microsoft.WindowsTerminal*!App' } | Select-Object -First 1).AppID
if (-not $app) { $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;

// Returns true when a notification was sent (or would be, when they are off).
export function notify({ title, body, url }) {
  if (!config.notify || process.platform !== 'win32') return false;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    env: {
      ...process.env,
      OT_TITLE: String(title).slice(0, 120),
      OT_BODY: String(body).slice(0, 240),
      OT_URL: url || '',
      OT_FOCUS: path.join(config.root, 'bin', 'focus-tab.ps1'),
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  return true;
}
