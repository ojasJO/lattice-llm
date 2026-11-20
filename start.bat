@echo off
setlocal EnableExtensions
title Lattice
cd /d "%~dp0"

rem ---------------------------------------------------------------- reuse a working venv
if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -c "import sys" >nul 2>nul && goto :deps
  echo [lattice] the existing .venv is broken ^(copied from another PC?^) - recreating it...
  rmdir /s /q ".venv"
)

rem ---------------------------------------------------------------- find Python 3.10+
set "PYEXE="
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
  if not errorlevel 1 set "PYEXE=py -3"
)
if not defined PYEXE (
  where python >nul 2>nul
  if not errorlevel 1 (
    python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
    if not errorlevel 1 set "PYEXE=python"
  )
)
if not defined PYEXE (
  echo.
  echo   Lattice needs Python 3.10 or newer, and none was found.
  echo.
  echo   Install it with:   winget install -e --id Python.Python.3.12
  echo   or download it from https://www.python.org/downloads/  ^(tick "Add python.exe to PATH"^)
  echo   and then run start.bat again.
  echo.
  pause
  exit /b 1
)
echo [lattice] creating a private Python environment in .venv ...
%PYEXE% -m venv .venv
if errorlevel 1 goto :fail

:deps
".venv\Scripts\python.exe" -c "import aiohttp, psutil" >nul 2>nul
if errorlevel 1 (
  echo [lattice] installing dependencies ^(aiohttp, psutil^) ...
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 goto :fail
)

".venv\Scripts\python.exe" -m lattice %*
exit /b %errorlevel%

:fail
echo.
echo [lattice] setup failed - see the messages above.
pause
exit /b 1
