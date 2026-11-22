@echo off
rem Double-click this to install Stem Remixer. Add -Remove to uninstall.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install.ps1" %*
echo.
pause
