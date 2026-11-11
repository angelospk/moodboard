# Moodboard extension installer for Windows (unpacked install + hourly update task).
# Run it by double-clicking install.cmd, or:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
# Safe to run again: it replaces the task and reuses the already downloaded app folder.

$ErrorActionPreference = 'Stop'

$root = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$base = Join-Path $root 'MoodboardExtension'
$app = Join-Path $base 'app'
$updateDest = Join-Path $base 'update.ps1'
$taskName = 'Moodboard extension update'

New-Item -ItemType Directory -Force -Path $base | Out-Null

# 1. Copy the updater next to the app, so the scheduled task does not depend on the download folder.
Copy-Item -Path (Join-Path $PSScriptRoot 'update.ps1') -Destination $updateDest -Force

# 2. Register (or replace) the task: at every logon and then every hour, no window.
$action = New-ScheduledTaskAction `
	-Execute 'powershell.exe' `
	-Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $updateDest)

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerHourly = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(5)) `
	-RepetitionInterval (New-TimeSpan -Hours 1) `
	-RepetitionDuration (New-TimeSpan -Days 9999)

$settings = New-ScheduledTaskSettingsSet `
	-Hidden `
	-AllowStartIfOnBatteries `
	-DontStopIfGoingOnBatteries `
	-StartWhenAvailable `
	-ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
	-MultipleInstances IgnoreNew

Register-ScheduledTask `
	-TaskName $taskName `
	-Action $action `
	-Trigger @($triggerLogon, $triggerHourly) `
	-Settings $settings `
	-Description 'Κατεβάζει την τελευταία έκδοση της επέκτασης Moodboard μία φορά την ώρα.' `
	-Force | Out-Null

# 3. First download now, so the app folder exists before the user picks it in Chrome.
#    Run it in a separate process: update.ps1 ends with exit, which would end this script too.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updateDest

if (-not (Test-Path (Join-Path $app 'manifest.json'))) {
	Write-Host 'Η πρώτη λήψη απέτυχε (δίκτυο ή release). Θα ξαναδοκιμάσει αυτόματα σε μία ώρα.' -ForegroundColor Yellow
}

# 4. Tell the user what to do in Chrome.
Write-Host ''
Write-Host 'Η επέκταση Moodboard εγκαταστάθηκε.' -ForegroundColor Green
Write-Host ''
Write-Host 'Άνοιξε το Chrome και κάνε τα εξής:'
Write-Host '  1. Άνοιξε τη διεύθυνση chrome://extensions'
Write-Host '  2. Ενεργοποίησε το Developer mode (πάνω δεξιά)'
Write-Host '  3. Πάτησε Load unpacked'
Write-Host ('  4. Διάλεξε τον φάκελο: {0}' -f $app)
Write-Host ''
Write-Host 'Οι ενημερώσεις κατεβαίνουν κάθε ώρα. Όταν το παράθυρο της επέκτασης'
Write-Host 'δείξει «Νέα έκδοση διαθέσιμη», πάτησε «Επανεκκίνηση».'
Write-Host ''
