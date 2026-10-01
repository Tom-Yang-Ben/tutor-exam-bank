' ================================================================
'  run_hidden.vbs -- entry point of the two desktop shortcuts (docs/desktop-launcher.md)
'
'  wscript.exe run_hidden.vbs launch [node.exe]   -> node scripts\desktop\launch.js
'  wscript.exe run_hidden.vbs stop   [node.exe]   -> node scripts\desktop\stop.js
'
'  Runs node with a hidden window (no black console), waits for it, and shows a
'  message box only when node cannot be started or exits with a non-zero code
'  (launch.js / stop.js report every expected problem themselves and exit 0).
'
'  This file is ASCII only on purpose: wscript reads .vbs files in the ANSI code
'  page, so Chinese text is stored as UTF-16 code units in hex and decoded by U().
'  test/unit/desktopLauncherScripts.test.js checks what each U("...") decodes to.
' ================================================================
Option Explicit

Dim fso, sh, here, appDir, mode, script, nodeExe, rc, logDir

' window title: the product name
Const MSG_TITLE = "51FA984C7CFB7D71"
' "Node.js not found ... run install_desktop_shortcut.bat again / install Node.js LTS"
Const MSG_NO_NODE = "627E4E0D52300020004E006F00640065002E006A0073FF0C51FA984C7CFB7D7171216CD5555F52D530028ACB91CD65B096D964CA0020006500780061006D005F00700072006F005C0073006300720069007000740073005C00770069006E0064006F00770073005C0069006E007300740061006C006C005F006400650073006B0074006F0070005F00730068006F00720074006300750074002E00620061007400205EFA7ACB63775F91FF1B90846C925B8988DD0020004E006F00640065002E006A0073002076848A71FF0C514852300020006E006F00640065006A0073002E006F0072006700205B8988DD0020004C00540053002072483002"
' "The program ended unexpectedly (exit code "
Const MSG_CRASH_1 = "51FA984C7CFB7D7176847A0B5F0F75705E387D50675FFF087D50675F78BC0020"
' "). Please give today's launcher-<date>.log in this folder to the maintainer:"
Const MSG_CRASH_2 = "FF0930028ACB628A9019500B8CC76599593E88E14ECA592976840020006C00610075006E0063006800650072002D65E5671F002E006C006F006700204EA47D667DAD8B7776844EBAFF1A"

Function U(hex)
    Dim i, s
    s = ""
    For i = 1 To Len(hex) Step 4
        s = s & ChrW(CLng("&H" & Mid(hex, i, 4) & "&"))
    Next
    U = s
End Function

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
appDir = fso.GetParentFolderName(fso.GetParentFolderName(here))
logDir = fso.BuildPath(appDir, "data\logs")

mode = "launch"
If WScript.Arguments.Count >= 1 Then mode = LCase(WScript.Arguments(0))
If mode = "stop" Then
    script = fso.BuildPath(here, "stop.js")
Else
    script = fso.BuildPath(here, "launch.js")
End If

nodeExe = "node"
If WScript.Arguments.Count >= 2 Then
    If fso.FileExists(WScript.Arguments(1)) Then nodeExe = WScript.Arguments(1)
End If

sh.CurrentDirectory = appDir
On Error Resume Next
rc = sh.Run("""" & nodeExe & """ """ & script & """", 0, True)
If Err.Number <> 0 Then
    On Error GoTo 0
    MsgBox U(MSG_NO_NODE), vbCritical + vbSystemModal, U(MSG_TITLE)
    WScript.Quit 1
End If
On Error GoTo 0

If rc <> 0 Then
    MsgBox U(MSG_CRASH_1) & rc & U(MSG_CRASH_2) & vbCrLf & logDir, vbCritical + vbSystemModal, U(MSG_TITLE)
End If
WScript.Quit rc
