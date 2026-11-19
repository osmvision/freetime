; Extra steps for the NSIS installer (see bundle.windows.nsis.installerHooks in tauri.conf.json).

!macro NSIS_HOOK_POSTINSTALL
  ; Up to 0.2.0 the program was named freetime-desktop.exe. An update installs freetime.exe and
  ; new shortcuts; this removes the old file so it doesn't linger in the install folder.
  Delete "$INSTDIR\freetime-desktop.exe"
!macroend
