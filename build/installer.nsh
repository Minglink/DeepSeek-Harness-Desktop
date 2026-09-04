!macro customInit
  nsExec::Exec 'taskkill.exe /F /IM "DeepSeek Harness.exe" /T'
  nsExec::Exec 'taskkill.exe /F /IM "dsh.exe" /T'
!macroend

!macro customInstall
  DetailPrint "Cleaning legacy 0.1.0 installation residue..."
  RMDir /r "$LOCALAPPDATA\Programs\DeepSeek-Harness"
  DetailPrint "Sessions and user settings preserved. Ready for 0.1.2."
!macroend

