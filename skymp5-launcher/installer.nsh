; Custom NSIS hooks for the Vengeful Realms Launcher installer.
;
; Refuse to install/update while the launcher is running, otherwise its files
; are locked and the update silently half-applies. nsProcess ships with
; electron-builder's bundled NSIS, so no extra plugin install is needed.

!macro preInit
  SetRegView 64

  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 == ""
    ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${EndIf}

  ${If} $R0 == ""
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\VengefulRealms\VengefulRealms-Launcher"
    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\VengefulRealms\VengefulRealms-Launcher"
  ${EndIf}

  SetRegView 32
  ${If} $R0 == ""
    WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\VengefulRealms\VengefulRealms-Launcher"
    WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\VengefulRealms\VengefulRealms-Launcher"
  ${EndIf}
!macroend

!macro customInit
  ${If} ${Silent}
    ; In-app auto-update (/S): the launcher is quitting itself. Wait up to ~10s
    ; for it to release its files, then proceed without any prompt.
    StrCpy $R1 0
    silent_wait:
      nsProcess::_FindProcess "${PRODUCT_FILENAME}.exe"
      Pop $R0
      nsProcess::_Unload
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        ${If} $R1 < 20
          Sleep 500
          Goto silent_wait
        ${EndIf}
      ${EndIf}
  ${Else}
    ; Manual run: ask the user to close a running launcher before continuing.
    retry_running_check:
      nsProcess::_FindProcess "${PRODUCT_FILENAME}.exe"
      Pop $R0
      ${If} $R0 == 0
        nsProcess::_Unload
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
          "Vengeful Realms Launcher is still running.$\n$\nPlease fully quit it (check the system tray), then click Retry." \
          IDRETRY retry_running_check
        Abort
      ${EndIf}
      nsProcess::_Unload
  ${EndIf}
!macroend
