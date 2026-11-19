@echo off
rem Double-click to run the Globe Haul Shop Tool locally (http://localhost:8173/). Close the window to stop.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
