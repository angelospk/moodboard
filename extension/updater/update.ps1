# Moodboard extension updater for Windows.
# Downloads the latest release zip and replaces the unpacked extension files when the zip changed.
# Quiet: no prompts, no windows, always exits 0 (a network failure just means "try again next hour").

$ErrorActionPreference = 'Stop'

$root = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE 'AppData\Local' }
$base = Join-Path $root 'MoodboardExtension'
$app = Join-Path $base 'app'
$appNew = Join-Path $base 'app.new'
$shaFile = Join-Path $base '.zip-sha256'
$zip = Join-Path $base 'update.zip'
$url = 'https://github.com/angelospk/moodboard/releases/latest/download/moodboard-extension.zip'

New-Item -ItemType Directory -Force -Path $base | Out-Null

# Leftover folders from an earlier swap that Chrome kept locked: try to clean them up.
Get-ChildItem -Path $base -Directory -Filter 'app.old.*' -ErrorAction SilentlyContinue |
	ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

# 1. Download the latest release.
try {
	Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 120
} catch {
	Remove-Item $zip -Force -ErrorAction SilentlyContinue
	exit 0
}

# 2. Compare with the zip that was installed last time.
$sha = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
$last = ''
if (Test-Path $shaFile) {
	$last = (Get-Content -Path $shaFile -Raw).Trim()
}
if ($sha -eq $last) {
	Remove-Item $zip -Force -ErrorAction SilentlyContinue
	exit 0
}

# 3. Extract into a fresh folder, so files that left the zip disappear too.
Remove-Item $appNew -Recurse -Force -ErrorAction SilentlyContinue
try {
	Expand-Archive -Path $zip -DestinationPath $appNew -Force
} catch {
	Remove-Item $appNew -Recurse -Force -ErrorAction SilentlyContinue
	Remove-Item $zip -Force -ErrorAction SilentlyContinue
	exit 0
}

# A release zip may wrap the extension in one folder; Chrome needs manifest.json at the root.
if (-not (Test-Path (Join-Path $appNew 'manifest.json'))) {
	$nested = Get-ChildItem -Path $appNew -Directory | Select-Object -First 1
	if ($nested -and (Test-Path (Join-Path $nested.FullName 'manifest.json'))) {
		$inner = Join-Path $base 'app.inner'
		Remove-Item $inner -Recurse -Force -ErrorAction SilentlyContinue
		Move-Item -Path $nested.FullName -Destination $inner
		Remove-Item $appNew -Recurse -Force -ErrorAction SilentlyContinue
		Move-Item -Path $inner -Destination $appNew
	}
}
if (-not (Test-Path (Join-Path $appNew 'manifest.json'))) {
	Remove-Item $appNew -Recurse -Force -ErrorAction SilentlyContinue
	Remove-Item $zip -Force -ErrorAction SilentlyContinue
	exit 0
}

# 4. Swap the folders by renaming, so a locked app folder is never deleted.
#    A rename is safe even while Chrome holds the files open; the removal of the old copy can wait.
$old = Join-Path $base ('app.old.' + [guid]::NewGuid().ToString('N').Substring(0, 8))
if (Test-Path $app) {
	try {
		Move-Item -Path $app -Destination $old -ErrorAction Stop
	} catch {
		# The folder is locked (e.g. Chrome holds a file): copy the new files over it instead, so the
		# update still lands. Stale files may stay, but nothing in the manifest points at them.
		try {
			Copy-Item -Path (Join-Path $appNew '*') -Destination $app -Recurse -Force -ErrorAction Stop
			Set-Content -Path $shaFile -Value $sha -Encoding ASCII
		} catch {}
		Remove-Item $appNew -Recurse -Force -ErrorAction SilentlyContinue
		Remove-Item $zip -Force -ErrorAction SilentlyContinue
		exit 0
	}
}
try {
	Move-Item -Path $appNew -Destination $app -ErrorAction Stop
} catch {
	# Put the previous version back, so the extension keeps working.
	if ((Test-Path $old) -and -not (Test-Path $app)) {
		Move-Item -Path $old -Destination $app -ErrorAction SilentlyContinue
	}
	Remove-Item $appNew -Recurse -Force -ErrorAction SilentlyContinue
	Remove-Item $zip -Force -ErrorAction SilentlyContinue
	exit 0
}
Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue

# 5. Remember the installed zip and clean up.
Set-Content -Path $shaFile -Value $sha -Encoding ASCII
Remove-Item $zip -Force -ErrorAction SilentlyContinue
exit 0
