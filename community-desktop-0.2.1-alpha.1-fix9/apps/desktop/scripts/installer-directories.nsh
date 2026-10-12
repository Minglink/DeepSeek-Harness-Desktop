!include "LogicLib.nsh"

Var dshFinalDirectory
Var dshNewDirectory
Var dshOldDirectory
Var dshFinalDirectoryExtended
Var dshNewDirectoryExtended
Var dshOldDirectoryExtended
Var dshPathInput
Var dshPathExtended
Var dshOldMoved
Var dshNewMoved
Var dshTransactionId
Var dshMoveFrom
Var dshMoveTo
Var dshMoveAttempts
Var dshMoveError
Var dshFailurePhase
Var dshFailureCode
Var dshFailureLog

; Installer paths are absolute; preserve existing namespaces and encode UNC roots correctly.
Function dshExtendDirectoryPath
  Push $0
  StrCpy $0 $dshPathInput 4
  ${If} $0 == "\\?\"
    StrCpy $dshPathExtended $dshPathInput
  ${Else}
    StrCpy $0 $dshPathInput 2
    ${If} $0 == "\\"
      StrCpy $0 $dshPathInput "" 2
      StrCpy $dshPathExtended "\\?\UNC\$0"
    ${Else}
      StrCpy $dshPathExtended "\\?\$dshPathInput"
    ${EndIf}
  ${EndIf}
  Pop $0
FunctionEnd

!macro dshSetDirectoryOutPath Path
  StrCpy $dshPathInput "${Path}"
  Call dshExtendDirectoryPath
  SetOutPath $dshPathExtended
!macroend

!macro dshExtractPayload FILE
  !ifmacrodef customInstallerExtract
    !insertmacro customInstallerExtract "${FILE}"
  !else
    nsExec::ExecToStack '"$PLUGINSDIR\dsh-7za.exe" x -y -bd -bb0 "-o$INSTDIR" "${FILE}"'
    Pop $R0
    Pop $R1
  !endif
  ${If} $R0 != 0
    DetailPrint $R1
    Call dshRollbackDirectories
    !ifmacrodef customInstallerExtractFailed
      !insertmacro customInstallerExtractFailed "${FILE}"
    !else
      MessageBox MB_OK|MB_ICONEXCLAMATION "$(decompressionFailed)" /SD IDOK
    !endif
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro dshStageApplication
  StrCpy $dshFinalDirectory $INSTDIR
  System::Call 'ole32::CoCreateGuid(g .r0) i .r1'
  ${If} $1 != 0
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $dshTransactionId $0
  StrCpy $dshNewDirectory "$INSTDIR.new-$0"
  StrCpy $dshOldDirectory "$INSTDIR.old-$0"
  StrCpy $dshPathInput $dshFinalDirectory
  Call dshExtendDirectoryPath
  StrCpy $dshFinalDirectoryExtended $dshPathExtended
  StrCpy $dshPathInput $dshNewDirectory
  Call dshExtendDirectoryPath
  StrCpy $dshNewDirectoryExtended $dshPathExtended
  StrCpy $dshPathInput $dshOldDirectory
  Call dshExtendDirectoryPath
  StrCpy $dshOldDirectoryExtended $dshPathExtended
  StrCpy $dshOldMoved ""
  StrCpy $dshNewMoved ""
  StrCpy $dshFailurePhase ""
  StrCpy $dshFailureCode ""
  StrCpy $dshFailureLog ""
  ClearErrors
  CreateDirectory $dshNewDirectoryExtended
  ${If} ${Errors}
    SetErrorLevel 2
    Quit
  ${EndIf}
  File /oname=$PLUGINSDIR\dsh-7za.exe "${DSH_SEVENZIP_PATH}"
  StrCpy $INSTDIR $dshNewDirectory
  SetOutPath $dshNewDirectoryExtended
  !insertmacro installApplicationFiles
  !ifdef DSH_SEVENZIP_LICENSE_DIR
    File /oname=7zip-installer-LICENSE.txt "${DSH_SEVENZIP_LICENSE_DIR}\LICENSE.txt"
    File /oname=7zip-installer-COPYING.txt "${DSH_SEVENZIP_LICENSE_DIR}\COPYING"
  !endif
  !ifdef UNINSTALLER_ICON
    File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"
  !endif
  StrCpy $INSTDIR $dshFinalDirectory
  !insertmacro dshSetDirectoryOutPath "$PLUGINSDIR"
!macroend

Function .onGUIEnd
  Call dshCleanupDirectories
FunctionEnd

Function dshCleanupDirectories
  ${If} $dshFinalDirectory != ""
    Call dshRollbackDirectories
  ${EndIf}
FunctionEnd

; Verify the process current directory is outside both directories before moving them.
Function dshReleaseDirectoryHandle
  Push $0
  Push $1
  Push $2
  Push $3
  !insertmacro dshSetDirectoryOutPath "$PLUGINSDIR"
  System::Call 'kernel32::SetCurrentDirectoryW(w "$dshPathExtended") i.r0 ?e'
  Pop $dshMoveError
  ${If} $0 != 0
    System::Call 'kernel32::GetCurrentDirectoryW(i ${NSIS_MAX_STRLEN}, w .r1) i.r0 ?e'
    Pop $dshMoveError
    ${If} $0 != 0
    ${AndIf} $0 < ${NSIS_MAX_STRLEN}
      System::Call 'kernel32::GetFullPathNameW(w "$dshPathExtended", i ${NSIS_MAX_STRLEN}, w .r2, p 0) i.r0 ?e'
      Pop $dshMoveError
      ${If} $0 != 0
      ${AndIf} $0 < ${NSIS_MAX_STRLEN}
        System::Call 'kernel32::lstrcmpiW(w r1, w r2) i.r3'
        ${If} $3 == 0
          StrCpy $dshMoveError 0
          Goto cwd_done
        ${EndIf}
        StrCpy $dshMoveError 13
      ${ElseIf} $0 != 0
        StrCpy $dshMoveError 111
      ${EndIf}
    ${ElseIf} $0 != 0
      StrCpy $dshMoveError 111
    ${EndIf}
  ${EndIf}
  cwd_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  ${If} $dshMoveError == 0
    ClearErrors
  ${Else}
    SetErrors
  ${EndIf}
FunctionEnd

; MoveFileW cannot replace an existing target or move a directory across volumes.
; Only transient access/share/lock failures receive ten attempts, 250 ms apart.
Function dshMoveDirectory
  Push $0
  Push $1
  Push $2
  StrCpy $dshPathInput $dshMoveFrom
  Call dshExtendDirectoryPath
  StrCpy $1 $dshPathExtended
  StrCpy $dshPathInput $dshMoveTo
  Call dshExtendDirectoryPath
  StrCpy $2 $dshPathExtended
  StrCpy $dshMoveAttempts 0
  move_retry:
  IntOp $dshMoveAttempts $dshMoveAttempts + 1
  System::Call 'kernel32::MoveFileW(w r1, w r2) i.r0 ?e'
  ; ?e pushes GetLastError after the API result has been stored in $0.
  Pop $dshMoveError
  ${If} $0 != 0
    StrCpy $dshMoveError 0
  ${ElseIf} $dshMoveAttempts < 10
    ${If} $dshMoveError == 5
    ${OrIf} $dshMoveError == 32
    ${OrIf} $dshMoveError == 33
      Sleep 250
      Goto move_retry
    ${EndIf}
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
  ${If} $dshMoveError == 0
    ClearErrors
  ${Else}
    SetErrors
  ${EndIf}
FunctionEnd

; Save the original failure before rollback can replace Win32's last error.
Function dshRecordDirectoryFailure
  Push $0
  !ifdef DSH_INSTALLER_LOG_DIR
    StrCpy $dshFailureLog "${DSH_INSTALLER_LOG_DIR}\directory-failure-$dshTransactionId.log"
    ClearErrors
    StrCpy $dshPathInput "${DSH_INSTALLER_LOG_DIR}"
    Call dshExtendDirectoryPath
    CreateDirectory $dshPathExtended
    StrCpy $dshPathInput $dshFailureLog
    Call dshExtendDirectoryPath
    FileOpen $0 $dshPathExtended w
    ${IfNot} ${Errors}
      FileWrite $0 "phase=$dshFailurePhase$\r$\nwin32=$dshFailureCode$\r$\nattempts=$dshMoveAttempts$\r$\nfinal=$dshFinalDirectory$\r$\nstaged=$dshNewDirectory$\r$\nbackup=$dshOldDirectory$\r$\n"
      FileClose $0
    ${Else}
      StrCpy $dshFailureLog ""
    ${EndIf}
  !endif
  DetailPrint "Directory replacement failed: phase=$dshFailurePhase, win32=$dshFailureCode"
  Pop $0
FunctionEnd

; Only directories created or renamed by this installer are removed during rollback.
Function dshRollbackDirectories
  Call dshReleaseDirectoryHandle
  ${If} ${Errors}
    SetErrors
    Return
  ${EndIf}
  ${If} $dshNewMoved == "1"
    ClearErrors
    RMDir /r $dshFinalDirectoryExtended
    ${If} ${Errors}
      ; Keep the complete old backup when the staged directory cannot be removed.
      DetailPrint $dshOldDirectory
      SetErrors
      Return
    ${EndIf}
    StrCpy $dshNewMoved ""
  ${EndIf}
  ${If} $dshOldMoved == "1"
    ClearErrors
    StrCpy $dshMoveFrom $dshOldDirectory
    StrCpy $dshMoveTo $dshFinalDirectory
    Call dshMoveDirectory
    ${If} ${Errors}
      ; Leave the complete backup in place if another process prevents restoration.
      DetailPrint $dshOldDirectory
      SetErrors
      Return
    ${EndIf}
    StrCpy $dshOldMoved ""
  ${EndIf}
  ${If} $dshNewDirectory != ""
    RMDir /r $dshNewDirectoryExtended
  ${EndIf}
  StrCpy $INSTDIR $dshFinalDirectory
FunctionEnd

Function dshPromoteDirectories
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 2
  !endif
  ; SetOutPath opens a directory handle; release it before either rename.
  StrCpy $dshFailurePhase "release-cwd"
  StrCpy $dshMoveAttempts 0
  Call dshReleaseDirectoryHandle
  ${If} ${Errors}
    Goto promote_failed
  ${EndIf}
  ${If} ${FileExists} "$dshFinalDirectoryExtended\*.*"
    StrCpy $dshFailurePhase "backup-current"
    StrCpy $dshMoveFrom $dshFinalDirectory
    StrCpy $dshMoveTo $dshOldDirectory
    Call dshMoveDirectory
    ${If} ${Errors}
      Goto promote_failed
    ${EndIf}
    StrCpy $dshOldMoved "1"
  ${Else}
    ; NSIS can create the destination before the install section starts.
    RMDir $dshFinalDirectoryExtended
  ${EndIf}
  ClearErrors
  StrCpy $dshFailurePhase "promote-staged"
  StrCpy $dshMoveFrom $dshNewDirectory
  StrCpy $dshMoveTo $dshFinalDirectory
  Call dshMoveDirectory
  ${If} ${Errors}
    Goto promote_failed
  ${EndIf}
  StrCpy $dshNewMoved "1"
  SetOutPath $dshFinalDirectoryExtended
  !ifmacrodef InstallerPublishStage
    !insertmacro InstallerPublishStage 3
  !endif
  ClearErrors
  Return
  promote_failed:
  StrCpy $dshFailureCode $dshMoveError
  Call dshRecordDirectoryFailure
  Call dshRollbackDirectories
  SetErrors
FunctionEnd

!macro dshFinishDirectories
  StrCpy $dshNewMoved ""
  ${If} $dshOldMoved == "1"
    RMDir /r $dshOldDirectoryExtended
    StrCpy $dshOldMoved ""
  ${EndIf}
!macroend
