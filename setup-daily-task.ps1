# Registers (or removes) a Windows Task Scheduler job that runs the Moonshot
# Scanner daily cycle every morning at 07:30, hidden, under the current user.
#
#   .\setup-daily-task.ps1          -> register / update
#   .\setup-daily-task.ps1 -Remove  -> unregister
param([switch]$Remove)

$taskName = "MoonshotScanner-Daily"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$taskName' (if it existed)."
    exit 0
}

$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot "src\run-daily.js"
if (-not (Test-Path $script)) { throw "Cannot find $script" }

# Wrap in powershell -WindowStyle Hidden so no console window flashes.
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"& '$node' --env-file-if-exists=.env '$script'`"" `
    -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -Daily -At 07:30
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Description "Moonshot Scanner daily track/learn/scan cycle" -Force | Out-Null

Write-Host "Registered '$taskName': daily at 07:30 (runs when next possible if the PC was off)."
Write-Host "Remove anytime with: .\setup-daily-task.ps1 -Remove"
