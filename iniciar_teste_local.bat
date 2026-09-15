@echo off
echo ===================================================
echo   Iniciando Simulador de Live do Instagram...
echo ===================================================
timeout /t 1 >nul
start "" "http://localhost:8080/simulador_live_instagram.html"
node iniciar_teste_local.js
pause
