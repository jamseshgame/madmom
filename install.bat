@echo off
REM Windows wrapper for install.py — double-click or run from cmd/PowerShell.
REM Prefers the `py` launcher (more robust than `python`, which on Windows can
REM resolve to a Microsoft Store stub that prompts to install Python instead
REM of running it). Falls back to `python` if `py` isn't on PATH.
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel% equ 0 (
    py install.py %*
) else (
    python install.py %*
)
set _ec=%errorlevel%
echo.
pause
exit /b %_ec%
