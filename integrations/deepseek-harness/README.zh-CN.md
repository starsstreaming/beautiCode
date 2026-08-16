# DeepSeek Harness 桥接插件

该 Cordis 插件向 DSH Web 注入 beautiCode 浏览器客户端，并提供本机鉴权接口。支持图片、MP4、播放位置、静音、摸鱼模式、深浅色调以及清除背景。

插件以标准 npm 包发布（`@beauticode/dsh-plugin`），直接装进你自己的 DSH profile，不依赖任何 beautiCode 启动器。

## 安装

```sh
# 使用你本机的 dsh（npx @deepseek-ai/dsh 或全局安装）
dsh plugin --profile web add @beauticode/dsh-plugin

# 本地源码调试时按路径安装
dsh plugin --profile web add file:<beautiCode 路径>/integrations/deepseek-harness
```

## 启用

把下面的条目加到 profile 自己的 patch 层（`~/.dsh/cordis.patch.yml` 或 profile 目录的 `cordis.patch.yml`），然后重启 `dsh web`：

```yaml
- insert:
    - id: beauticode-bridge
      name: '@beauticode/dsh-plugin'
      inject: [webServer]
```

也可以参考 `cordis.patch.example.yml`。

## 控制

插件只暴露本机接口。控制端（beautiCode CLI/托盘）需要：

1. 与插件使用同一个 `BEAUTICODE_DATA_ROOT`（令牌文件 `dsh-bridge.token` 所在目录）。
2. 通过 `dsh-bridge.token` 里的 256 位随机令牌做 `Bearer` 鉴权。

接口一览（均以 `/__beauticode/` 前缀）：

| 路径 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/version` | GET/HEAD | 无 | 桥接协议与版本 |
| `/client.js` | GET | 无 | 浏览器注入脚本 |
| `/events` | GET (SSE) | 同源 | 浏览器客户端事件流 |
| `/apply` | POST | Bearer | 应用图片/视频/清除 |
| `/mode` | POST | Bearer | 摸鱼/静音/色调 |
| `/status` | GET | Bearer | 当前状态与回执汇总 |
| `/ack` | POST | 同源 | 浏览器渲染/模式回执 |

## 安全边界

- DSH Web 必须绑定本机回环地址。
- 控制端点需要随机令牌；浏览器回执只接受同源请求。
- 媒体 URL 仅允许带令牌的回环 HTTP 地址。
- 插件只注入与鉴权，不改动 DSH 源码，也不结束/重启用户的 DSH 进程。
