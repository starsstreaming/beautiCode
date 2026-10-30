#!/usr/bin/env node

console.log("\nbeautiCode (Linux) 已安装。下一步请运行命令安装宿主守护和背景版启动项：");
console.log("  全局安装：beauticode-linux all install");
console.log("  项目内安装：npm exec -- beauticode-linux all install");
console.log("这一步会写入当前用户的 ~/.config/autostart 与 ~/.local/share/applications，不会启动桌面客户端。");
console.log("文件选择器需要 zenity 或 kdialog（例如 sudo apt install zenity）。");
console.log("安装后检查：beauticode-linux all status");
