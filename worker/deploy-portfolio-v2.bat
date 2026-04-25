@echo off
REM Deploy v2 : ajoute les colonnes instrument_name + instrument_class
REM dans portfolio_positions, puis deploy le worker.

cd /d "%~dp0"

echo.
echo ============================================================
echo  Kairos - Deploy v2 (migration + worker)
echo ============================================================
echo.

echo [1/2] Migration D1 (ajout colonnes instrument_name + instrument_class)...
call npx wrangler d1 execute kairos-history --remote --file migrations/portfolio-schema-v2.sql
if errorlevel 1 (
    echo.
    echo NOTE : si l'erreur est 'duplicate column name', c'est que la migration
    echo       a deja ete appliquee. C'est OK, on continue.
    echo.
)
echo     Migration appliquee.
echo.

echo [2/2] Deploiement du Worker...
call npx wrangler deploy
if errorlevel 1 (
    echo ERREUR : deploy echoue.
    pause
    exit /b 1
)
echo.
echo ============================================================
echo  Deploy v2 reussi !
echo ============================================================
echo.
echo  Nouveautes :
echo   - Toutes les positions IG (CFD shares + indices + forex + commodities)
echo     sont maintenant gardees, pas seulement les actions.
echo   - Affichage du nom de l'instrument (Apple Inc, EUR/USD, France 40, etc.)
echo   - Badge de classe par position (indice / forex / commodity / etc.)
echo   - Le Kairos Score n'est mappe que sur les actions (logique).
echo.
pause
