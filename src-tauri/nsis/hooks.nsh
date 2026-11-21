!if "${ARCH}" == "arm64"
  !define INKLEAF_WV2_OFFLINE "MicrosoftEdgeWebView2RuntimeInstallerARM64.exe"
!else
  !define INKLEAF_WV2_OFFLINE "MicrosoftEdgeWebView2RuntimeInstallerX64.exe"
!endif

!macro NSIS_HOOK_PREINSTALL
  StrCpy $R0 ""
  ${If} ${RunningX64}
    ReadRegStr $R0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $R0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $R0 == ""
    ReadRegStr $R0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $R0 == ""
    StrCpy $R1 ""
    ${If} ${FileExists} "$EXEDIR\${INKLEAF_WV2_OFFLINE}"
      StrCpy $R1 "$EXEDIR\${INKLEAF_WV2_OFFLINE}"
    ${ElseIf} ${FileExists} "$EXEDIR\runtime\${INKLEAF_WV2_OFFLINE}"
      StrCpy $R1 "$EXEDIR\runtime\${INKLEAF_WV2_OFFLINE}"
    ${EndIf}
    ${If} $R1 != ""
      DetailPrint "Installing offline WebView2 Runtime..."
      ExecWait '"$R1" /silent /install' $R2
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$INSTDIR\data"
  ${IfNot} ${FileExists} "$INSTDIR\settings.json"
    ${If} ${FileExists} "$EXEDIR\settings.json"
      CopyFiles /SILENT "$EXEDIR\settings.json" "$INSTDIR\settings.json"
    ${Else}
      ClearErrors
      FileOpen $R0 "$INSTDIR\settings.json" w
      ${IfNot} ${Errors}
        FileWrite $R0 '{$\r$\n'
        FileWrite $R0 '  "recent": [],$\r$\n'
        FileWrite $R0 '  "window": null,$\r$\n'
        FileWrite $R0 '  "dark": false,$\r$\n'
        FileWrite $R0 '  "language": "auto",$\r$\n'
        FileWrite $R0 '  "images_anywhere": false,$\r$\n'
        FileWrite $R0 '  "remote_images": false$\r$\n'
        FileWrite $R0 '}$\r$\n'
        FileClose $R0
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    Delete "$INSTDIR\settings.json"
    RmDir /r "$INSTDIR\data"
    RMDir "$INSTDIR"
    SetShellVarContext current
    RmDir /r "$APPDATA\${PRODUCTNAME}"
    RmDir /r "$LOCALAPPDATA\${PRODUCTNAME}"
  ${EndIf}
!macroend
