@echo off
chcp 65001 >nul 2>&1
title osu! Timing Analyzer (BPM, Offset y Compas)
if "%~1"=="" (
  node "%~dp0bin\osu-timing.js"
) else (
  node "%~dp0bin\osu-timing.js" --wait %*
)
