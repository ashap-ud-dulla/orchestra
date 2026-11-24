// A Windows notification ("toast") when a run needs you.
// Uses the built-in Windows toast API through PowerShell; nothing to install.
// It is sent as Windows Terminal (Orchestra needs it anyway; Windows lists it under Settings > Notifications, so the
// user can turn it on or off there), else as PowerShell. Clicking it opens the link "orchestra-focus:<tab title>",
// which bin/focus-tab.ps1 handles: it brings that run's tab to the front. The link is registered for this Windows
// user (HKCU, no admin) each time a notification goes out, so a fresh clone on any PC works with no setup step.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

export const FOCUS_SCHEME = 'orchestra-focus';

// The link a notification opens to bring the tab with this title to the front.
export function focusUrl(tabTitle) {
  return tabTitle ? `${FOCUS_SCHEME}:${encodeURIComponent(tabTitle)}` : '';
}

// The toast itself. Its text comes in as $env:OT_* values (set as literals by toastScript), never as code.
export const SCRIPT = `
$ErrorActionPreference = 'Stop'
# Tests: prove the script ran, show nothing.
if ($env:OT_PROBE) { Set-Content -LiteralPath $env:OT_PROBE -Value 'ran'; exit }
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
# The app the toast comes from. Get-StartApps is slow: its answer is kept in a file (OT_CACHE) for the next toasts.
$app = $env:OT_APP
if (-not $app) {
  $app = (Get-StartApps | Where-Object { $_.AppID -like 'Microsoft.WindowsTerminal*!App' } | Select-Object -First 1).AppID
  if ($app -and $env:OT_CACHE) { Set-Content -LiteralPath $env:OT_CACHE -Value $app -Encoding ascii }
}
if (-not $app) { $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' }
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;

// How the toast PowerShell is started. Not by Node: a PowerShell started detached (no console) quits at once without
// running anything, and one that is not detached dies with the hook that sent it (it ends at once). So a short
// PowerShell asks Windows itself (Win32_Process.Create) to start it, hidden: Windows owns that process, and it shows
// the toast after the hook and its tab are gone. The text goes in as PowerShell literals ('' escaped), never as code.
const LAUNCH = `
$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $env:OT_INNER; ProcessStartupInformation = $si }
exit [int]$r.ReturnValue
`;

const psText = (v) => `'${String(v ?? '').replace(/'/g, "''")}'`;

// The toast script with its values set in it (the process Windows starts does not get our env).
export function toastScript(values) {
  const set = Object.entries(values).map(([k, v]) => `$env:${k} = ${psText(v)}`).join('\n');
  return `${set}\n${SCRIPT}`;
}

// Returns true when Windows took the notification, false when it did not, null when they are off. Waits about a
// second for Windows to take it.
export function notify({ title, body, url }) {
  if (!config.notify || process.platform !== 'win32') return null;
  const cache = path.join(config.dataDir, 'notify-app.txt');
  let app = '';
  try {
    app = fs.readFileSync(cache, 'utf8').trim();
  } catch {}
  const inner = toastScript({
    OT_TITLE: String(title).slice(0, 120),
    OT_BODY: String(body).slice(0, 240),
    OT_URL: url || '',
    OT_APP: /^[\w.!{}\-]+$/.test(app) ? app : '',
    OT_CACHE: cache,
    OT_FOCUS: path.join(config.root, 'bin', 'focus-tab.ps1'),
    OT_PROBE: process.env.ORCHESTRA_NOTIFY_PROBE || '',
  });
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', LAUNCH], {
    env: { ...process.env, OT_INNER: Buffer.from(inner, 'utf16le').toString('base64') },
    stdio: 'ignore',
    windowsHide: true,
    timeout: 20000,
  });
  return r.status === 0;
}
