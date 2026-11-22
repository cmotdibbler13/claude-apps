@echo off
rem Double-click this to uninstall Stem Remixer (your Stems folder is kept).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" -Remove
echo.
pause
