@echo off
title OrbitAvanya Email Dashboard
cd /d "%~dp0EmailAutomation2026\EmailAutomation\Scripts"
echo Starting OrbitAvanya Campaign Dashboard...
echo It will open in your browser at http://localhost:7070
echo Keep this window open while using the dashboard.
echo Press Ctrl+C to stop the dashboard.
echo.
python DASHBOARD.py
pause