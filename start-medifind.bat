@echo off
setlocal

set "PHP_EXE=C:\xampp\php\php.exe"
set "PORT=8095"

if not exist "%PHP_EXE%" (
    echo PHP was not found at "%PHP_EXE%".
    echo Install XAMPP or update PHP_EXE in this file to your php.exe path.
    pause
    exit /b 1
)

netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo Port %PORT% is already in use.
    echo Close the other server using that port, then run this file again.
    pause
    exit /b 1
)

start "MediFind PHP Server" "%PHP_EXE%" -S 127.0.0.1:%PORT% -t "%~dp0"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/index.html"
