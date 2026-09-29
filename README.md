<!-- hello,starstreaming. -->
<div align="center">
  <h1>beautiCode</h1>
  <p>
    <strong>中文</strong> · <a href="./README.en.md">English</a>
  </p>
  <img width="1672" height="941" alt="ChatGPT Image 2026年8月16日 10_58_15" src="https://github.com/user-attachments/assets/c943a0fb-ff48-4361-9e6f-c4b1521aee2b" />

</div>

<p align="center">
  <strong>把你喜欢的画面，放进 vibe coding 的每一分钟。</strong>
</p>

<p align="center">
  为 DeepSeek Harness 添加图片与视频背景，也支持 Codex Desktop。<br>
  可以是一张壁纸，也可以是一部番剧、一个壁纸，或者一段陪你度过漫长工作的风景。
</p>

---


## 它是什么？

beautiCode 是一个本地背景工具，**主要面向 DeepSeek Harness 和 Codex**，并提供可选的 Cursor、豆包 Windows 适配。

它不包含、不安装、也不启动 DSH。请先自行安装 DeepSeek Harness 并运行 `dsh web`。插件装好后，打开 DSH 的「设置」，左侧导航里会多出一项「背景」，不必再开托盘。Codex Desktop 仍走 beautiCode 托盘。可以把电脑里的：

* 图片
* 动态壁纸
* MP4 / MOV 视频
* 番剧

直接设成 DeepSeek Harness 网页背后的背景。

它不会把工作窗口变成一个播放器，而是让画面安静地待在对话和工作区后面。

代码、输入框和按钮仍然可以正常使用。

<img width="1280" height="714" alt="QQ20260818-205802" src="https://github.com/user-attachments/assets/a9a18412-4c62-4083-ab49-d127f05e61c3" />


## 使用方式

### 一键安装插件（推荐）

```sh
npm install -g beauticode-desktop --foreground-scripts
beauticode-desktop all install
```

`--foreground-scripts` 会显示安装提示。npm 7 及更新版本默认隐藏提示；`postinstall` 只显示说明，不会自动安装守护。`all install` 为当前 Windows 用户安装后台集成，并为已检测到的宿主创建开始菜单快捷方式；它不会启动客户端。

首次启用 CDP 时，请用后台快捷方式启动客户端。如果客户端已经运行但没有 CDP，请先正常关闭，再使用快捷方式启动。DSH 使用插件，不需要 CDP 快捷方式。

项目内安装：

```sh
npm install beauticode-desktop --foreground-scripts
npm exec -- beauticode-desktop all install
```

### 检查与单独管理

```sh
beauticode-desktop all status
beauticode-desktop all health
beauticode-desktop <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall|health>
```

`all status` 和 `all health` 都是只读命令；health 会检查守护、宿主进程、CDP 连接和背景注入状态。`all install` 会跳过未安装的宿主，并继续处理其他宿主；`installed` 表示插件或守护已通过检查，不代表客户端已启动。需要单独卸载时使用宿主命令，例如 `beauticode-desktop codex uninstall`。

守护只会对启动不足 10 秒且已确认身份的单个进程尝试一次受控重启；不会终止较旧或身份不明的进程，也不会无限重启。

**Codex MSIX：**本包使用程序包感知启动。MSIX 的 CDP 修复仍待原始图标重启测试验证，验证前请视为未经确认。

通过托盘菜单可以：

* 更换图片
* 更换视频
* 清除背景
* 打开或关闭视频声音
* 进入摸鱼模式
* 保存当前主题
* 切换已保存主题
* 删除主题


## 当前支持情况

目前主要支持：

* Windows
* DeepSeek Harness（推荐）
* Codex Desktop
* JPG、JPEG、PNG、WebP 图片
* MP4 / MOV 视频


## 关于本地视频

beautiCode 只读取你主动选择的本地图片和视频。

项目不会提供番剧、电影或其他受版权保护的内容。

请只导入你拥有或有权使用的媒体文件，并遵守当地法律与内容版权要求。

---

## 为什么叫 beautiCode？

因为代码工具不一定只能是冰冷、统一和毫无个性的。

有人喜欢极简黑色。

有人喜欢雨夜城市。

有人喜欢动漫。

有人喜欢在漫长的构建过程中，重新看一遍熟悉的电影。

工具应该帮助人完成工作。

但好的工具，也应该允许人把自己带进工作里。

> **我们每天花很多时间面对代码。
> beautiCode 想做的，只是让这些时间更像生活，而不只是等待完成的任务。**

---

## 致谢

beautiCode 的部分媒体处理思路与实现经验参考并改编自：

* Codex Dream Skin
L站的支持：
https://linux.do/
画窗参考：
https://github.com/Sui-IB/InternalBeyond
相关开源许可、代码来源和修改说明见：

```text
THIRD_PARTY_NOTICES.md
```

beautiCode 是非官方项目，与 DeepSeek、OpenAI、Codex 或其他应用厂商没有隶属或合作关系。

DeepSeek Harness 的接入说明见 [`docs/deepseek-harness.md`](docs/deepseek-harness.md)。

---

## License

MIT
