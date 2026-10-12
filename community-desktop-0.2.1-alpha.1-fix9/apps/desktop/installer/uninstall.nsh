; Electron user data and updater downloads leave with the application; the Harness home is never touched.
!include FileFunc.nsh
Var UnTarget
Var UnHome

; Only the installation owning Electron's exact current-user open command removes the protocol.
; Updates and installation-location migrations preserve it until the next application launch.
Function un.CleanProtocol
  Push $R0
  Push $R1
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${If} ${Errors}
    ReadRegStr $R0 HKCU "Software\Classes\dsh\shell\open\command" ""
    StrCmp $R0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 done
    DeleteRegKey HKCU "Software\Classes\dsh"
  ${EndIf}
done:
  Pop $R1
  Pop $R0
FunctionEnd

; The helper refuses unsafe roots, the installation and the Harness home, and never descends into reparse points;
; a locked file leaves residue and never fails the uninstall. customCheckAppRunning extracts window-frame.dll first.
Function un.RemoveData
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveData(w "$UnTarget", w "$INSTDIR", w "$UnHome") ?c'
FunctionEnd

Function un.CleanData
  ${If} ${isUpdated}
    Return
  ${EndIf}
  ; The installer runs an older uninstaller with /KEEP_APP_DATA when replacing it from another directory.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ; Only a DSH_HOME published as a Windows environment variable is visible here.
  ReadEnvStr $UnHome DSH_HOME
  ClearErrors
  StrCpy $UnTarget "$APPDATA\${PRODUCT_FILENAME}"
  Call un.RemoveData
  !ifdef APP_PACKAGE_NAME
    ; Electron derives user data from the package name; a scoped name nests it one directory deeper.
    StrCpy $UnTarget "$APPDATA\${APP_PACKAGE_NAME}"
    Call un.RemoveData
    System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveEmptyParents(w "$UnTarget", w "$APPDATA") ?c'
  !endif
  StrCpy $UnTarget "$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}"
  Call un.RemoveData
FunctionEnd
