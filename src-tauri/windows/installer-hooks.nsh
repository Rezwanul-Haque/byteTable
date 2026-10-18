; NSIS installer hooks, wired in via `bundle.windows.nsis.installerHooks`.
;
; WHY THIS EXISTS: Tauri registers each file association with the APP's icon —
; its template hard-codes the icon argument as
;
;     !insertmacro APP_ASSOCIATE "{{ext}}" "{{or association.name ext}}" ... \
;         "$INSTDIR\${MAINBINARYNAME}.exe,0" ...
;
; so a .db file in Explorer gets ByteTable's application icon rather than a
; document icon. There is no config field for this (the same gap as
; CFBundleTypeIconFile on macOS, see src-tauri/Info.plist), so the key is
; rewritten here, after the installer has written its own.
;
; THE PROGID IS THE ASSOCIATION'S `name` from tauri.conf.json — that is what
; `{{or association.name ext}}` resolves to. These two strings must match
; `bundle.fileAssociations[].name` EXACTLY, spaces included; rename an
; association there and the icon silently stops applying.
;
; SHCTX, not a hard-coded hive: it is NSIS's built-in context that follows
; SetShellVarContext, so this lands in HKLM for a per-machine install and HKCU
; for a per-user one, exactly like the keys Tauri wrote a moment earlier.
;
; The `.ico` files arrive at $INSTDIR because `bundle.resources` maps them to
; bare names; NSIS writes resources with `/oname=` relative to $INSTDIR.
;
; No uninstall hook is needed: Tauri's APP_UNASSOCIATE deletes the whole
; `Software\Classes\<ProgID>` key, which takes DefaultIcon with it, and the
; .ico files are removed with the other resources.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\SQLite Database\DefaultIcon" "" "$INSTDIR\document-db.ico,0"
  WriteRegStr SHCTX "Software\Classes\SQL Script\DefaultIcon" "" "$INSTDIR\document-sql.ico,0"
  ; Tell the shell the association icons changed, so Explorer repaints without
  ; waiting for a logout — the Windows equivalent of the icon-cache dance macOS
  ; needs.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
