Option Explicit

Dim shell
Dim fso
Dim scriptDir
Dim runnerPath
Dim command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
runnerPath = fso.BuildPath(scriptDir, "run-codex-usage-bridge.ps1")
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & runnerPath & Chr(34)

shell.Run command, 0, True
