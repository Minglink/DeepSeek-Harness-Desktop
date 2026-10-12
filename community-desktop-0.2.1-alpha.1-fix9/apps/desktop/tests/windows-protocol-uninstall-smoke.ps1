<# Actual production NSIS protocol cleanup, only inside a task-owned ordinary Windows account. #>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$ExpectedSid,
    [Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$profile = [Environment]::GetFolderPath('UserProfile')
if ($identity.User.Value -ne $ExpectedSid -or $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or
    [IO.Path]::GetFileName($profile) -notmatch '^DSHGate[0-9a-f]{10}$') { throw 'Protocol execution requires the exact task-owned ordinary Windows SID/profile' }
foreach ($folder in @('ApplicationData', 'LocalApplicationData', 'Desktop', 'Programs')) {
    if (-not [Environment]::GetFolderPath($folder).StartsWith($profile + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Protocol fixture known folder escaped the isolated profile' }
}
if (Test-Path -LiteralPath 'HKCU:\Software\Classes\dsh') { throw 'Fresh isolated SID must have no existing dsh registration' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$report = [ordered]@{ passed=$false; startedAt=[DateTime]::UtcNow.ToString('o'); sid=$identity.User.Value; profile=$profile;
    fixture=$Installer; stages=@(); failures=@(); scope='Actual NSIS production macro/helper execution against the private HKCU of a separate ordinary SID; no product application launched or real user registration touched.' }
function Execute([string]$Path,[string]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$Path; $start.Arguments=$Arguments; $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
    $process=[Diagnostics.Process]::Start($start)
    try { if(-not $process.WaitForExit(60000)){ $process.Kill(); throw 'NSIS protocol fixture deadline' }; if($process.ExitCode -ne 0){throw ('NSIS fixture exit ' + $process.ExitCode)} }
    finally { $process.Dispose() }
}
function Read-Protocol {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Classes\dsh')
    if(-not $key){return $null}
    try {
        $command=$key.OpenSubKey('shell\open\command')
        if(-not $command){return @{ command=$null; urlProtocol=($key.GetValueNames() -contains 'URL Protocol') }}
        try {return @{ command=[string]$command.GetValue(''); urlProtocol=($key.GetValueNames() -contains 'URL Protocol') }} finally {$command.Dispose()}
    } finally {$key.Dispose()}
}
try {
    foreach($case in @('own','other-installation','extra-arguments','updated','keep-app-data','absent')) {
        $installRoot=Join-Path $profile ('DSHProtocolFixture\' + $case)
        New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
        Execute $Installer ('/S /D=' + $installRoot)
        $own='"' + (Join-Path $installRoot 'DeepSeek Harness.exe') + '" "%1"'
        $command=$own
        if($case -eq 'other-installation'){ $command='"' + (Join-Path $profile 'DSHProtocolFixture\Other Installation\DeepSeek Harness.exe') + '" "%1"' }
        if($case -eq 'extra-arguments'){ $command='"' + (Join-Path $installRoot 'DeepSeek Harness.exe') + '" --other-mode "%1"' }
        if($case -ne 'absent') {
            $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\dsh')
            $key.SetValue('URL Protocol',''); $key.SetValue('fixture-owner',$ExpectedSid); $key.Dispose()
            $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Classes\dsh\shell\open\command'); $key.SetValue('',$command); $key.Dispose()
        }
        $before=Read-Protocol
        $arguments='/S '
        if($case -eq 'updated'){ $arguments+='--updated ' }
        if($case -eq 'keep-app-data'){ $arguments+='/KEEP_APP_DATA ' }
        $arguments+='_?=' + $installRoot
        Execute (Join-Path $installRoot 'uninstall-fixture.exe') $arguments
        if((Get-Content -LiteralPath (Join-Path $installRoot 'fixture-completed.txt') -Raw) -ne 'completed'){throw 'NSIS uninstaller section did not complete'}
        $after=Read-Protocol
        if($case -in @('own','absent')) { if($null -ne $after){throw ('Protocol should be absent: ' + $case)} }
        elseif($null -eq $after -or $after.command -ne $before.command -or -not $after.urlProtocol){throw ('Protocol was not preserved: ' + $case)}
        $report.stages+=@{case=$case;passed=$true;before=$before;after=$after;arguments=$arguments;completedAt=[DateTime]::UtcNow.ToString('o')}
        if(Test-Path -LiteralPath 'HKCU:\Software\Classes\dsh') { Remove-Item -LiteralPath 'HKCU:\Software\Classes\dsh' -Recurse }
    }
    $report.passed=$true
} catch {$report.failures+=@{message=$_.Exception.Message;stack=$_.ScriptStackTrace}}
finally {
    if(Test-Path -LiteralPath 'HKCU:\Software\Classes\dsh') { Remove-Item -LiteralPath 'HKCU:\Software\Classes\dsh' -Recurse }
    $report.completedAt=[DateTime]::UtcNow.ToString('o')
    $report|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $OutputDirectory 'protocol-qualification.json') -Encoding UTF8
}
if(-not $report.passed){throw (($report.failures|ForEach-Object{$_.message}) -join '; ')}
