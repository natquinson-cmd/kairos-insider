@echo off
REM ============================================================
REM Kairos Insider - Deploy Radar Portefeuille (Phase 1)
REM ============================================================
REM Ce script enchaine les 4 etapes de deploiement :
REM   1. wrangler login (OAuth Cloudflare via navigateur)
REM   2. Generation cle AES-256 + push secret PORTFOLIO_ENCRYPTION_KEY
REM   3. Migration D1 (cree les 3 tables portfolio_*)
REM   4. wrangler deploy
REM ============================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ============================================================
echo  KAIROS INSIDER - Deploy Radar Portefeuille
echo ============================================================
echo.

REM --- Etape 1 : Login Cloudflare (verifie d'abord si deja fait) ---
echo [1/4] Verification de l'authentification Cloudflare...
call npx wrangler whoami 2>nul | findstr /C:"You are logged in" >nul
if errorlevel 1 (
    echo     -^> Pas encore authentifie. Ouverture du navigateur...
    echo        IMPORTANT : cliquer ALLOW dans le navigateur sous 60 sec.
    echo.
    call npx wrangler login
    if errorlevel 1 (
        echo.
        echo ERREUR : login echoue. Verifie le navigateur et relance le script.
        pause
        exit /b 1
    )
    echo     OK - authentifie.
) else (
    echo     OK - deja authentifie.
)
echo.

REM --- Etape 2 : Generer cle AES-256 + push secret ---
echo [2/4] Generation de la cle de chiffrement et push du secret...
echo     PORTFOLIO_ENCRYPTION_KEY = 256 bits aleatoires (base64)
echo.
REM PowerShell genere 32 bytes random et les encode en base64
for /f "delims=" %%K in ('powershell -NoProfile -Command "$b=New-Object byte[] 32; (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b); [Convert]::ToBase64String($b)"') do set "ENCKEY=%%K"

if "!ENCKEY!"=="" (
    echo ERREUR : Impossible de generer la cle.
    pause
    exit /b 1
)

REM Push vers Cloudflare via stdin
echo !ENCKEY!| call npx wrangler secret put PORTFOLIO_ENCRYPTION_KEY
if errorlevel 1 (
    echo.
    echo ERREUR : echec du push secret. Verifie ta connexion.
    pause
    exit /b 1
)
echo     OK - secret stocke chez Cloudflare. La cle n'est PAS sauvegardee localement.
echo.

REM --- Etape 3 : Migration D1 ---
echo [3/4] Application de la migration D1 (portfolio_*)...
call npx wrangler d1 execute kairos-history --remote --file migrations/portfolio-schema.sql
if errorlevel 1 (
    echo.
    echo ERREUR : migration echouee. Voir le log ci-dessus.
    pause
    exit /b 1
)
echo     OK - tables portfolio_connections / positions / snapshots creees.
echo.

REM --- Etape 4 : Deploy ---
echo [4/4] Deploiement du Worker (Cloudflare Workers)...
call npx wrangler deploy
if errorlevel 1 (
    echo.
    echo ERREUR : deploy echoue.
    pause
    exit /b 1
)
echo.
echo ============================================================
echo  DEPLOIEMENT REUSSI
echo ============================================================
echo.
echo  Endpoints actifs :
echo    GET  /api/portfolio/brokers
echo    GET  /api/portfolio/connections
echo    POST /api/portfolio/connect
echo    POST /api/portfolio/sync
echo    GET  /api/portfolio/positions
echo    GET  /api/portfolio/alerts
echo.
echo  Test rapide : ouvrir kairosinsider.fr/dashboard.html section
echo  "Mon Portefeuille" - tu dois voir la card "Radar Portefeuille".
echo.
echo  Note : aucun broker n'est encore "live" (Phase 2 - integration
echo  IG Markets a venir). Pour le moment, le bouton "Connecter un
echo  broker" affiche "Bientot" sur tous les brokers.
echo.
pause
