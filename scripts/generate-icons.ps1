$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

Add-Type -AssemblyName System.Drawing

function New-ProxyIcon {
  param([int]$Size, [string]$OutPath)

  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(11, 15, 20))

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($Size, $Size)),
    [System.Drawing.Color]::FromArgb(59, 130, 246),
    [System.Drawing.Color]::FromArgb(99, 102, 241)
  )

  $margin = [math]::Max(2, [int]($Size * 0.12))
  $g.FillEllipse($brush, $margin, $margin, $Size - 2 * $margin, $Size - 2 * $margin)

  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(220, 255, 255, 255)), ([math]::Max(1, $Size / 16))
  $cx = $Size / 2
  $g.DrawLine($pen, $margin, $cx, $Size - $margin, $cx)
  $g.DrawEllipse($pen, $margin, $margin, $Size - 2 * $margin, $Size - 2 * $margin)

  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  $brush.Dispose()
  $pen.Dispose()
}

foreach ($size in @(16, 32, 48, 128)) {
  New-ProxyIcon -Size $size -OutPath (Join-Path $iconsDir "icon$size.png")
}

Write-Host "Icons written to $iconsDir"
