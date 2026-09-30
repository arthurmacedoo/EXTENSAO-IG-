@echo off
echo ===================================================
echo   Iniciando Painel & Simulador de Live...
echo ===================================================
timeout /t 1 >nul
start "" "http://localhost:8080/index.html"
start "" "http://localhost:8080/simulador_live_instagram.html"
node iniciar_teste_local.js
pause
