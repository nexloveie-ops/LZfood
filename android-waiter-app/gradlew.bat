@echo off
set DIR=%~dp0
if exist "%DIR%gradlew" (
  bash "%DIR%gradlew" %*
) else (
  echo gradlew not found
  exit /b 1
)
