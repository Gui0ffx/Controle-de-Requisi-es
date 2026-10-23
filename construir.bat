@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  Controle de RCs - gerar o executavel
echo  Rode ESTE arquivo num PC Windows COM internet (so nesta etapa).
echo  O PC da empresa NAO precisa de internet: ele so recebe o .exe pronto.
echo ============================================================
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js nao encontrado. Instale o Node.js LTS em https://nodejs.org e rode este arquivo de novo.
  pause
  exit /b 1
)
echo.
echo [1/3] Baixando dependencias...
call npm install
if errorlevel 1 goto erro
echo.
echo [2/3] Rodando os testes...
call npm test
if errorlevel 1 goto erro
echo.
echo [3/3] Gerando o executavel (leva alguns minutos)...
call npm run dist
if errorlevel 1 goto erro
if not exist ENTREGA mkdir ENTREGA
copy /y dist\*.exe ENTREGA\ >nul
powershell -NoProfile -Command "Get-ChildItem ENTREGA\*.exe | Get-FileHash -Algorithm SHA256 | Format-List | Out-File -Encoding utf8 ENTREGA\SHA256.txt"
echo.
echo ============================================================
echo  PRONTO! Pasta ENTREGA:
dir /b ENTREGA
echo.
echo  Copie para o PC da empresa (pendrive) o arquivo "ControleRC-Portatil-...exe".
echo  Ele roda com duplo clique: sem instalar e sem administrador.
echo  Guarde o SHA256.txt para conferir se o arquivo nao foi alterado.
echo ============================================================
pause
exit /b 0
:erro
echo.
echo ERRO: veja a mensagem acima. Nada foi alterado nos seus dados.
pause
exit /b 1
