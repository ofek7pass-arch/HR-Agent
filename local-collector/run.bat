@echo off
REM האספן המקומי — מופעל ע"י Task Scheduler.
REM Node נייד, לא מותקן גלובלית (אותו אחד שמשמש את פרויקט הנדל"ן).
cd /d "%~dp0.."
"C:\Users\OfekPass\tools\node-v20.19.1-win-x64\node.exe" local-collector\run.js >> local-collector\collector.log 2>&1
