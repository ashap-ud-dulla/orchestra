# Clicking a run's Windows notification lands here (the "orchestra-focus:<tab title>" link that lib/notify.mjs
# registers for this Windows user). It finds the Windows Terminal tab with that title, selects it and brings its
# window to the front. Claude puts a mark before the title ("* ITP2-14941"), so the tab name must end with it.
# The title is only compared as text; nothing in it runs. No tab with that title (closed): nothing happens.
param([string]$Url)
$ErrorActionPreference = 'Stop'
$title = [uri]::UnescapeDataString(($Url -replace '^orchestra-focus:', '')).Trim()
if (-not $title) { exit }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$root = $A::RootElement
$isWt = New-Object Windows.Automation.PropertyCondition($A::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$isTab = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)

foreach ($w in $root.FindAll([Windows.Automation.TreeScope]::Children, $isWt)) {
  foreach ($t in $w.FindAll([Windows.Automation.TreeScope]::Descendants, $isTab)) {
    $name = $t.Current.Name
    if ($name -ne $title -and -not $name.EndsWith(' ' + $title)) { continue }
    $t.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern).Select()
    try {
      $win = $w.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
      if ($win.Current.WindowVisualState -eq [Windows.Automation.WindowVisualState]::Minimized) {
        $win.SetWindowVisualState([Windows.Automation.WindowVisualState]::Normal)
      }
    } catch {}
    $w.SetFocus()
    exit
  }
}
