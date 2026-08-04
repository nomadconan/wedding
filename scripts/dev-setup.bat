@echo off
:: WeddingClear - initial local setup (Windows CMD)
:: Order: install -> env -> db:start -> db:reset -> db:types -> dev
:: Prerequisite: Docker Desktop must be running (WSL2 backend) before db:start.
:: NOTE: ASCII-only on purpose - Korean text garbles under CP949 consoles.

setlocal
cd /d "%~dp0.."

echo [1/6] npm install
call npm install
if errorlevel 1 goto :error

echo [2/6] env file
if exist ".env.local" (
  echo      .env.local already exists - keeping it ^(not overwritten^)
) else (
  copy ".env.example" ".env.local" >nul
  if errorlevel 1 goto :error
  echo      created .env.local - fill in values before continuing:
  echo        - NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY  ^(from db:start output^)
  echo        - SUPABASE_SERVICE_ROLE_KEY   ^(server only^)
  echo        - ANTHROPIC_API_KEY / AI_MODEL ^(server only^)
  echo        - TOSS_CLIENT_KEY / TOSS_SECRET_KEY ^(test keys^)
)

echo [3/6] npm run db:start   ^(local Supabase, needs Docker^)
call npm run db:start
if errorlevel 1 goto :error

echo [4/6] npm run db:reset   ^(migrations + seed.sql^)
call npm run db:reset
if errorlevel 1 goto :error

echo [5/6] npm run db:types   ^(regenerate types/database.ts^)
call npm run db:types
if errorlevel 1 goto :error

echo [6/6] npm run dev        ^(http://localhost:3000^)
call npm run dev
goto :eof

:error
echo.
echo SETUP FAILED at the step above. Fix it and re-run scripts\dev-setup.bat
exit /b 1
