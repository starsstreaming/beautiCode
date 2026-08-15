# DeepSeek Harness 桥接插件

该 Cordis 插件向 DSH Web 注入 beautiCode 浏览器客户端，并提供本机鉴权接口。支持图片、MP4、播放位置、静音、摸鱼模式、深浅色调以及清除背景。

推荐直接运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\WoRk\beautiCode\scripts\start-beauticode-dsh.ps1
```

启动器使用安装包内置或 beautiCode 私有目录中的兼容 DSH，按桥接内容哈希发布不可变插件版本，动态生成补丁并使用独立 DSH_HOME。若目标端口已有旧桥接或未加载桥接的 DSH，它不会自动重启或结束该进程；关闭该 DSH 后再次启动即可自动采用新插件。

手动接入时：

1. 修改 `cordis.patch.example.yml` 中的 `file:///.../index.mjs`。
2. 确保 DSH 和 beautiCode 使用相同的 `BEAUTICODE_DATA_ROOT`。
3. 运行 `dsh web --patch <补丁路径> --port 3080`。
4. 打开页面后从 beautiCode 托盘应用背景。

安全边界：DSH Web 必须绑定本机回环地址；控制端点需要随机令牌；媒体 URL 仅允许带令牌的回环 HTTP 地址；浏览器回执只接受同源请求。
