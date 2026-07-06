#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('readonly', 'workspace')]
    [string]$Sandbox,

    [Parameter(Mandatory = $true)]
    [string]$PromptFile,

    [Parameter(Mandatory = $true)]
    [string]$OutFile,

    [Parameter(Mandatory = $true)]
    [string]$LogFile
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

$promptPath = Resolve-Path -LiteralPath $PromptFile -ErrorAction Stop
$outParent = Split-Path -Parent $OutFile
$logParent = Split-Path -Parent $LogFile

if ($outParent) {
    New-Item -ItemType Directory -Force -Path $outParent | Out-Null
}
if ($logParent) {
    New-Item -ItemType Directory -Force -Path $logParent | Out-Null
}

$help = & codex exec --help 2>&1
if ($LASTEXITCODE -ne 0) {
    Fail "codex exec --help failed; cannot verify supported flags."
}

$helpText = $help -join "`n"
$requiredFlags = @(
    '--sandbox',
    '--output-last-message'
)

foreach ($flag in $requiredFlags) {
    if ($helpText -notmatch [regex]::Escape($flag)) {
        Fail "codex exec flag drift detected: missing required flag $flag."
    }
}

if ($helpText -match [regex]::Escape('--ask-for-approval')) {
    Write-Warning "codex exec help advertises --ask-for-approval, but this wrapper intentionally never passes it."
}

$sandboxValue = switch ($Sandbox) {
    'readonly' { 'read-only' }
    'workspace' { 'workspace-write' }
}

$codexArgs = @(
    'exec',
    '--sandbox', $sandboxValue,
    '--output-last-message', $OutFile,
    '-'
)

# CreateProcess cannot start npm's .cmd/.ps1 shims directly: prefer a real
# .exe on PATH, else run the shim through cmd.exe.
$codexApp = Get-Command codex -CommandType Application -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -match '\.exe$' } | Select-Object -First 1

$psi = [System.Diagnostics.ProcessStartInfo]::new()
if ($codexApp) {
    $psi.FileName = $codexApp.Source
} else {
    $psi.FileName = $env:ComSpec
    $psi.ArgumentList.Add('/d')
    $psi.ArgumentList.Add('/c')
    $psi.ArgumentList.Add('codex')
}
foreach ($arg in $codexArgs) {
    $psi.ArgumentList.Add($arg)
}
$psi.WorkingDirectory = (Get-Location).Path
$psi.RedirectStandardInput = $true
$psi.RedirectStandardError = $true
$psi.RedirectStandardOutput = $false
$psi.UseShellExecute = $false

$process = [System.Diagnostics.Process]::new()
$process.StartInfo = $psi
$exitCode = $null

if (-not $process.Start()) {
    Fail "Failed to start codex exec."
}

try {
    Get-Content -LiteralPath $promptPath -Raw | ForEach-Object {
        $process.StandardInput.Write($_)
    }
    $process.StandardInput.Close()

    while (-not $process.HasExited) {
        $line = $process.StandardError.ReadLine()
        if ($null -ne $line) {
            [Console]::Error.WriteLine($line)
            Add-Content -LiteralPath $LogFile -Value $line
        }
    }

    while (-not $process.StandardError.EndOfStream) {
        $line = $process.StandardError.ReadLine()
        [Console]::Error.WriteLine($line)
        Add-Content -LiteralPath $LogFile -Value $line
    }

    $exitCode = $process.ExitCode
}
finally {
    if (-not $process.HasExited) {
        $process.Kill($true)
        $exitCode = 1
    }
    $process.Dispose()
}

if ($exitCode -ne 0) {
    Fail "codex exec failed with exit code $exitCode. See $LogFile."
}
