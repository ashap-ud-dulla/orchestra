// A Windows notification ("toast") when a run needs you. Clicking it opens the run.
// Uses the built-in Windows toast API through PowerShell; nothing to install.
import { spawn } from 'node:child_process';
import { config } from './config.mjs';

// Text goes in through env vars, never into the script, so nothing in it can run as code.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$e = { param($s) [Security.SecurityElement]::Escape($s) }
$xml = '<toast activationType="protocol" launch="' + (& $e $env:OT_URL) + '"><visual><binding template="ToastGeneric"><text>' + (& $e $env:OT_TITLE) + '</text><text>' + (& $e $env:OT_BODY) + '</text></binding></visual></toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;

// Returns true when a notification was sent (or would be, when they are off).
export function notify({ title, body, url }) {
  if (!config.notify || process.platform !== 'win32') return false;
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
    env: { ...process.env, OT_TITLE: String(title).slice(0, 120), OT_BODY: String(body).slice(0, 240), OT_URL: url },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  return true;
}
