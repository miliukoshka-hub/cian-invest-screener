@echo off
chcp 65001 >nul
title Инвестиционный парсер ЦИАН и калькулятор недвижимости
echo ==============================================================
echo  Запуск инвестиционного парсера ЦИАН и калькулятора...
echo  Не закрывайте это окно во время работы с парсером.
echo ==============================================================
cd /d "%~dp0"
start "" "http://localhost:3456/cian-parser-dashboard.html"
"C:\Users\Admin\AppData\Local\nodejs\node.exe" "parser\server.js"
pause
