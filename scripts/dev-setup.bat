@echo off
:: WeddingClear - initial local setup (Windows CMD)
:: Order: install -> db:start -> env -> db:reset -> db:types -> dev
:: Prerequisite: Docker Desktop must be running (WSL2 backend) before db:start.
:: NOTE: ASCII-only on purpose - Korean text garbles under CP949 consoles.
::
:: db:start now runs BEFORE the env step: the Supabase URL and keys only exist
:: once the local stack is up, and scripts\sync-env.mjs reads them from
:: `supabase status` instead of asking a human to retype them (S0-01).

setlocal
cd /d "%~dp0.."

echo [1/6] npm install
call npm install
if errorlevel 1 goto :error

echo [2/6] npm run db:start   ^(local Supabase, needs Docker^)
call npm run db:start
if errorlevel 1 goto :error

echo [3/6] env file           ^(scripts\sync-env.mjs^)
call npm run env:sync
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
