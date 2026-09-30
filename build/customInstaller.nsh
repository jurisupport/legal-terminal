# Resolve the per-user template wrapper before any page/function macros expand.
# Keep this file distinct from electron-builder's own installer.nsh.
!define LT_NSIS_TEMPLATES "${__FILEDIR__}/../node_modules/app-builder-lib/templates/nsis"
!addincludedir "${LT_NSIS_TEMPLATES}"
!cd "${__FILEDIR__}"

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
