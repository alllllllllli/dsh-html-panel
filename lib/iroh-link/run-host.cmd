@echo off
rem iroh-host.ps1 的任务包装：把 stdout/stderr 落盘，便于排障。
rem 计划任务用 SYSTEM 身份执行本文件（见 docs/iroh-link.md §4）。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0iroh-host.ps1" -Root "%~dp0." -CredFile "%USERPROFILE%\.dsh\.credentials.yaml" >> "%~dp0task.out.log" 2>&1
