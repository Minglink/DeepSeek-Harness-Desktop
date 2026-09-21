!include "LogicLib.nsh"

!macro TerminateDeepSeekProcesses
  # 1. 强制终止所有主程序、CLI 和关联子进程树
  nsExec::Exec 'taskkill.exe /F /IM "DeepSeek Harness.exe" /T'
  Pop $0
  nsExec::Exec 'taskkill.exe /F /IM "dsh.exe" /T'
  Pop $0

  # 2. 终止属于 DeepSeek Harness 的后台 Node.js 服务进程
  nsExec::Exec 'wmic process where "Name=''node.exe'' and (ExecutablePath like ''%resources\\node\\node.exe%'' or CommandLine like ''%runtime\\lib\\bin.js%'' or CommandLine like ''%dsh-stream-market%'')" call terminate'
  Pop $0

  # 3. 通过 PowerShell 清理占用安装目录或相关服务的一切进程
  nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.Name -match ''DeepSeek|dsh'' -or ($$_.ExecutablePath -and $$_.ExecutablePath -like ''*resources\node\node.exe*'') -or ($$_.CommandLine -and ($$_.CommandLine -match ''runtime\\lib\\bin\.js'' -or $$_.CommandLine -match ''dsh-stream-market'')) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"'
  Pop $0

  # 4. 强制释放本地专属网络监听端口（18899 市场服务、18888 手机远程服务、3081、3080 端口）
  nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 18899,18888,3081,3080 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $$_ -Force -ErrorAction SilentlyContinue }"'
  Pop $0

  # 5. 清除目录及文件的只读属性，确保旧文件覆盖与写入不被 Windows 拒绝
  ${If} $INSTDIR != ""
  ${AndIf} ${FileExists} "$INSTDIR"
    nsExec::Exec 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path ''$INSTDIR'') { Get-ChildItem -LiteralPath ''$INSTDIR'' -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { $$_.IsReadOnly = $$false } }"'
    Pop $0
    nsExec::Exec 'attrib.exe -R "$INSTDIR\*.*" /S /D'
    Pop $0
  ${EndIf}

  Sleep 1000
!macroend

!macro customInit
  !insertmacro TerminateDeepSeekProcesses
!macroend

!macro customCheckAppRunning
  !insertmacro TerminateDeepSeekProcesses
!macroend

!macro customUnInit
  !insertmacro TerminateDeepSeekProcesses
!macroend

!macro customUnInstallCheck
  StrCpy $R0 0
!macroend

!macro customUnInstallCheckCurrentUser
  StrCpy $R0 0
!macroend

!macro customRemoveFiles
  RMDir /r "$INSTDIR"
!macroend

!macro customInstall
  DetailPrint "Configuring DeepSeek Harness URI Scheme (dsh://)..."
  WriteRegStr HKCU "Software\Classes\dsh" "" "DeepSeek Harness Protocol"
  WriteRegStr HKCU "Software\Classes\dsh" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\dsh\DefaultIcon" "" "$INSTDIR\DeepSeek Harness.exe,0"
  WriteRegStr HKCU "Software\Classes\dsh\shell\open\command" "" '"$INSTDIR\DeepSeek Harness.exe" "%1"'

  DetailPrint "Cleaning legacy installation residue..."
  RMDir /r "$INSTDIR\resources\app"
  RMDir /r "$LOCALAPPDATA\Programs\DeepSeek-Harness"

  DetailPrint "Creating Desktop Shortcut..."
  CreateShortCut "$DESKTOP\DeepSeek Harness.lnk" "$INSTDIR\DeepSeek Harness.exe" "" "$INSTDIR\DeepSeek Harness.exe" 0
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\dsh"
!macroend
