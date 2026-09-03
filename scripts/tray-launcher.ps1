Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$appRoot = Split-Path -Parent $PSScriptRoot
$appUrl = 'http://localhost:5173/'
$healthUrl = 'http://127.0.0.1:5173/api/state'
$serverProcess = $null
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\ScheduleAppTrayLauncher', [ref]$createdNew)

if (-not $createdNew) {
    Start-Process $appUrl
    exit 0
}

function Show-Error([string]$message) {
    [System.Windows.Forms.MessageBox]::Show(
        $message,
        'Schedule App',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
}

function Invoke-HiddenProcess([string]$fileName, [string]$arguments, [bool]$wait) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $fileName
    $info.Arguments = $arguments
    $info.WorkingDirectory = $appRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $process = [System.Diagnostics.Process]::Start($info)
    if ($wait) {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Setup failed with exit code $($process.ExitCode)." }
    }
    return $process
}

function Test-Server {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
        return $response.StatusCode -in 200, 204
    } catch {
        return $_.Exception.Response.StatusCode.value__ -eq 204
    }
}

function Ensure-AppReady {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $node -or -not $npm) {
        throw 'Node.js was not found. Install the Node.js LTS release, then start Schedule App again.'
    }

    if (-not (Test-Path (Join-Path $appRoot 'node_modules'))) {
        Invoke-HiddenProcess $npm.Source 'install' $true | Out-Null
    }

    $distFile = Join-Path $appRoot 'dist\index.html'
    $sourceFiles = Get-ChildItem (Join-Path $appRoot 'src') -Recurse -File
    $needsBuild = -not (Test-Path $distFile)
    if (-not $needsBuild) {
        $distTime = (Get-Item $distFile).LastWriteTimeUtc
        $needsBuild = $null -ne ($sourceFiles | Where-Object LastWriteTimeUtc -gt $distTime | Select-Object -First 1)
    }
    if ($needsBuild) {
        Invoke-HiddenProcess $npm.Source 'run build' $true | Out-Null
    }

    return $node.Source
}

function Start-AppServer {
    if (Test-Server) { return }
    $nodePath = Ensure-AppReady
    $scriptPath = Join-Path $appRoot 'server.mjs'
    $scriptArgument = '"' + $scriptPath + '" --production'
    $script:serverProcess = Invoke-HiddenProcess $nodePath $scriptArgument $false
    for ($count = 0; $count -lt 40; $count++) {
        Start-Sleep -Milliseconds 250
        if (Test-Server) { return }
        if ($script:serverProcess.HasExited) { break }
    }
    throw 'The server could not start. Check whether another app is using port 5173.'
}

function Get-StartupShortcutPath {
    $startupFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
    return Join-Path $startupFolder 'Schedule App.lnk'
}

function Set-StartupEnabled([bool]$enabled) {
    $shortcutPath = Get-StartupShortcutPath
    if ($enabled) {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = Join-Path $appRoot 'Start-ScheduleApp.vbs'
        $shortcut.WorkingDirectory = $appRoot
        $shortcut.Description = 'Start Schedule App in the background'
        $shortcut.Save()
    } elseif (Test-Path $shortcutPath) {
        Remove-Item -LiteralPath $shortcutPath -Force
    }
}

function New-ScheduleAppIcon {
    $bitmap = New-Object System.Drawing.Bitmap 32, 32
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(37, 99, 235))
    $graphics.FillEllipse($brush, 1, 1, 30, 30)
    $font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $graphics.DrawString('S', $font, $textBrush, [System.Drawing.RectangleF]::new(0, 0, 32, 31), $format)
    $icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
    $graphics.Dispose()
    $brush.Dispose()
    $font.Dispose()
    $textBrush.Dispose()
    $format.Dispose()
    return @{ Icon = $icon; Bitmap = $bitmap }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open Schedule App')
$startupItem = New-Object System.Windows.Forms.ToolStripMenuItem('Start with Windows')
$startupItem.CheckOnClick = $true
$startupItem.Checked = Test-Path (Get-StartupShortcutPath)
$menu.Items.Add($startupItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$exitItem = $menu.Items.Add('Exit')
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$iconResources = New-ScheduleAppIcon
$notifyIcon.Icon = $iconResources.Icon
$notifyIcon.Text = 'Schedule App'
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Visible = $true

$openAction = {
    if (-not (Test-Server)) {
        try { Start-AppServer } catch { Show-Error $_.Exception.Message; return }
    }
    Start-Process $appUrl
}
$openItem.add_Click($openAction)
$notifyIcon.add_DoubleClick($openAction)
$startupItem.add_Click({
    try {
        Set-StartupEnabled $startupItem.Checked
        $message = if ($startupItem.Checked) { 'Schedule App will start with Windows.' } else { 'Automatic startup is disabled.' }
        $notifyIcon.ShowBalloonTip(2000, 'Schedule App', $message, [System.Windows.Forms.ToolTipIcon]::Info)
    } catch {
        $startupItem.Checked = -not $startupItem.Checked
        Show-Error 'The startup setting could not be changed.'
    }
})
$exitItem.add_Click({
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        $script:serverProcess.Kill()
        $script:serverProcess.WaitForExit()
    }
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

try {
    Start-AppServer
    $notifyIcon.ShowBalloonTip(2500, 'Schedule App', 'Running. Double-click this icon to open the app.', [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Process $appUrl
    [System.Windows.Forms.Application]::Run()
} catch {
    $notifyIcon.Visible = $false
    Show-Error $_.Exception.Message
} finally {
    if ($script:serverProcess -and -not $script:serverProcess.HasExited) {
        $script:serverProcess.Kill()
    }
    $notifyIcon.Dispose()
    $iconResources.Icon.Dispose()
    $iconResources.Bitmap.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
