#requires -Version 7.0
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$failed = $false

function Test-Step {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,

        [Parameter(Mandatory = $true)]
        [scriptblock]$Command
    )

    try {
        $output = & $Command 2>&1
        if ($LASTEXITCODE -eq 0) {
            $summary = ($output | Select-Object -First 1) -join ''
            if ([string]::IsNullOrWhiteSpace($summary)) {
                Write-Host "PASS $Name"
            }
            else {
                Write-Host "PASS $Name - $summary"
            }
        }
        else {
            $script:failed = $true
            $summary = ($output | Select-Object -First 1) -join ''
            Write-Host "FAIL $Name - exit $LASTEXITCODE $summary"
        }
    }
    catch {
        $script:failed = $true
        Write-Host "FAIL $Name - $($_.Exception.Message)"
    }
}

Test-Step 'codex --version' { codex --version }
Test-Step 'git status -sb' { git status -sb }
Test-Step 'cargo --version' { cargo --version }
Test-Step 'python imports: numpy, rasterio, pyogrio' {
    python -c "import numpy, rasterio, pyogrio; print('numpy/rasterio/pyogrio imports ok')"
}

if ($failed) {
    exit 1
}

exit 0
