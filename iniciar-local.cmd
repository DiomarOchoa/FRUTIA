@echo off
REM Arranque sin proveedores de IA de pago. Requiere Ollama, ComfyUI y Piper instalados.
cd /d "%~dp0"
set FRUTIA_LLM_PROVIDER=ollama
set OLLAMA_URL=http://127.0.0.1:11434
set FRUTIA_OLLAMA_MODEL=qwen2.5:3b
set FRUTIA_OLLAMA_TIMEOUT_MS=900000
set FRUTIA_IMAGE_PROVIDER=comfyui
set COMFYUI_URL=http://127.0.0.1:8188
set FRUTIA_COMFYUI_CHECKPOINT=v1-5-pruned-emaonly.safetensors
set FRUTIA_COMFYUI_STEPS=6
set FRUTIA_TTS_PROVIDER=piper
set PIPER_MODEL=%~dp0voces\es_MX-claude-high.onnx
curl.exe --silent --fail http://127.0.0.1:8188/system_stats >nul 2>&1
if errorlevel 1 (
  start "ComfyUI local" /min "%LOCALAPPDATA%\ComfyUI\.venv\Scripts\python.exe" "%LOCALAPPDATA%\ComfyUI\main.py" --cpu --listen 127.0.0.1 --port 8188 --disable-auto-launch --disable-assets
  timeout /t 15 /nobreak >nul
)
start "" http://localhost:5173
call npm run dev
