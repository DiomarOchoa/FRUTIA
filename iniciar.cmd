@echo off
REM ─────────────────────────────────────────────────────────────
REM  Frutia · iniciar aplicacion
REM
REM  Doble clic en este archivo. Dejar la ventana ABIERTA
REM  mientras uses la app: si la cierras, el servidor se apaga.
REM ─────────────────────────────────────────────────────────────

cd /d "%~dp0"

echo.
echo   Iniciando Frutia...
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo   [ERROR] Node.js no esta instalado.
  echo   Descargalo de https://nodejs.org  y vuelve a intentarlo.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   Instalando dependencias. Tendra que esperar unos minutos...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   [ERROR] La instalacion fallo.
    pause
    exit /b 1
  )
  echo.
)

if not exist .env (
  echo   [AVISO] No existe el archivo .env con tu clave de API.
  echo   Copia .env.example a .env y pega tu clave de Google AI Studio.
  echo   Sin ella podras ver la app, pero no generar videos.
  echo.
)

echo   Abriendo http://localhost:5173 en 6 segundos...
echo   Para detener todo: cierra esta ventana.
echo.
timeout /t 6 /nobreak >nul
start "" http://localhost:5173

call npm run dev

echo.
echo   El servidor se detuvo.
pause