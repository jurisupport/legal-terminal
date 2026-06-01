!macro _continueWhenLegacyUninstallerFails CONTEXT_LABEL
  ${If} ${Errors}
    DetailPrint "Existing ${CONTEXT_LABEL} uninstaller could not be launched; continuing repair install."
    ClearErrors
    StrCpy $R0 0
  ${ElseIf} $R0 != 0
    DetailPrint "Existing ${CONTEXT_LABEL} uninstaller exited with code $R0; continuing repair install."
    ClearErrors
    StrCpy $R0 0
  ${Else}
    ClearErrors
  ${EndIf}
!macroend

!macro customUnInstallCheck
  !insertmacro _continueWhenLegacyUninstallerFails "selected-context"
!macroend

!macro customUnInstallCheckCurrentUser
  !insertmacro _continueWhenLegacyUninstallerFails "current-user"
!macroend
