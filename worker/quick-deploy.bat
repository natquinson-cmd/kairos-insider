@echo off
REM Deploy rapide du Worker (sans migration ni secrets, juste le code).
REM Si pas authentifie, lance login d'abord.

cd /d "%~dp0"

echo.
echo ============================================================
echo  Quick Deploy - Kairos Worker
echo ============================================================
echo.

echo [1/2] Verification authentification...
call npx wrangler whoami 2>nul | findstr /C:"You are logged in" >nul
if errorlevel 1 (
    echo     -^> Login Cloudflare necessaire (clique Allow dans le browser)
    call npx wrangler login
    if errorlevel 1 (
        echo ERREUR : login echoue.
        pause
        exit /b 1
    )
)
echo     OK
echo.

echo [2/2] Deploiement...
call npx wrangler deploy
if errorlevel 1 (
    echo ERREUR : deploy echoue.
    pause
    exit /b 1
)
echo.
echo Deploy reussi !
echo.
pause
