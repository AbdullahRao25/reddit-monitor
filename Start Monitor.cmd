@echo off
title Reddit account monitor
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-monitor.ps1" %*
if errorlevel 1 pause
