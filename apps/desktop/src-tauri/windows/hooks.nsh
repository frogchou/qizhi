!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "正在安装栖知本地 NTFS 索引服务..."
  nsExec::ExecToLog '"$INSTDIR\栖知.exe" --install-ntfs-indexer-service'
  Pop $0
  ${If} $0 != 0
    DetailPrint "本地 NTFS 索引服务安装失败；可在设置中查看诊断。"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "正在卸载栖知本地 NTFS 索引服务..."
  nsExec::ExecToLog '"$INSTDIR\栖知.exe" --uninstall-ntfs-indexer-service'
  Pop $0
!macroend
