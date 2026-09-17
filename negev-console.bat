@echo off
title Negev-chan Local Control Center
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0negev-console.ps1" %*
