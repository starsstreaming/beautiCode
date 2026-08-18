<div align="center">
  <h1>beautiCode</h1>
  <img width="1672" height="941" alt="ChatGPT Image 2026年8月16日 10_58_15" src="https://github.com/user-attachments/assets/c943a0fb-ff48-4361-9e6f-c4b1521aee2b" />

</div>

<p align="center">
  <strong>把你喜欢的画面，放进 vibe coding 的每一分钟。</strong>
</p>

<p align="center">
  为 DeepSeek Harness 添加图片与视频背景，也支持 Codex Desktop。<br>
  可以是一张壁纸，也可以是一部番剧、一个壁纸，或者一段陪你度过漫长工作的风景。
</p>

<p align="center">
  <strong>工作不一定只能盯着灰色界面。</strong>
</p>

[Windows 安装包](https://github.com/starsstreaming/beautiCode/releases/tag/v1.0.0)
---





## 它是什么？

beautiCode 是一个本地背景工具，**主要面向 DeepSeek Harness和Codex**。

它不包含、不安装、也不启动 DSH。请先自行安装 DeepSeek Harness 并运行 `dsh web`。插件装好后，DSH 侧栏「设置」上方会出现「背景」，不必再开托盘。Codex Desktop 仍走 beautiCode 托盘。可以把电脑里的：

* 图片
* 动态壁纸
* MP4 视频
* 番剧
* 电影
* MV
* 风景延时摄影

直接设成 DeepSeek Harness 网页背后的背景。

它不会把工作窗口变成一个播放器，而是让画面安静地待在对话和工作区后面。

代码、输入框和按钮仍然可以正常使用。

<img width="1812" height="1164" alt="QQ20260816-110858-HD" src="https://github.com/user-attachments/assets/fbc7ae4a-2e68-4df6-be0d-29c63d65ab68" />

---

## 一边工作，一边看点喜欢的

有时候并不是想认真看完一整部电影。

只是希望写代码、等 AI 回复、跑构建或者排查 Bug 时，屏幕上不那么单调。

beautiCode 可以让你：

* 把番剧放在 DeepSeek Harness 背景中循环播放
* 导入本地电影，边工作边慢慢看
* 使用动漫场景作为动态背景
* 播放演唱会、MV 或直播录像
* 放一段雨夜、海边、城市航拍作为工作氛围
* 在等待模型执行任务时随手摸一会儿鱼

视频默认静音，不会突然打断工作。

需要声音时，也可以随时打开。

> 不是逃离工作，而是给漫长的工作过程，留一点属于自己的空间。

## 使用方式

### 一键安装插件（推荐）

只要给 DeepSeek Harness 加背景，装插件即可，不必 fork 仓库、不必下 Windows 安装包，也不必开托盘。请先自己装好 DSH 和 Node.js。

```sh
npx beauticode-dsh
npx @deepseek-ai/dsh web
```

`npx beauticode-dsh` 会从 npm 下载插件并写入你的 DSH profile，**不需要 pnpm，也不需要再执行 `dsh plugin add`**。已把 `dsh` 装到 PATH 时，第二行也可以写成 `dsh web`。

打开网页后，侧栏「设置」上方有「背景」：可从文件夹选图片或 MP4、清除、开关声音、切换已保存主题。已保存主题里自带「画窗」。网页控制台没有摸鱼。外观浅色/深色仍用 DSH 自己的设置。下次启动会恢复上次背景。

也可以用 `/bg`、`/bg-theme`、`/bg-clear`，或直接跟 AI 说把本机图片/视频设成背景。

已有 pnpm 时，也可以让 DSH 自己装这个 npm 包：

```sh
npx @deepseek-ai/dsh plugin --profile web add beauticode-dsh
npx @deepseek-ai/dsh web
```

卸载：

```sh
npx beauticode-dsh --remove
```
<img width="471" height="450" alt="aa80cb6fa224ff3bd45a2c43e3f9a7b6" src="https://github.com/user-attachments/assets/44ed8608-6a89-4308-b4a8-e721d33f4184" />

### Windows 安装包

需要 Codex Desktop、系统托盘或懒得留源码时，再下 [Windows 安装包](https://github.com/starsstreaming/beautiCode/releases/latest)。

然后自己启动：

```sh
dsh web
# 未把 dsh 装到 PATH 时：
npx @deepseek-ai/dsh web
```

安装包自带 Node.js，不需要另外安装 Node.js、npm 或 pnpm。安装结束时会自动写入 DSH 插件。若你改过安装目录，以安装文件夹里的 `集成说明.txt` 为准。

自己启动 `dsh web` 后，侧栏「背景」即可使用。Codex Desktop 仍要开 beautiCode 托盘：选 **Codex Desktop** 会按需拉起 Codex；选 **DeepSeek Harness** 只连接你已经启动的 DSH 网页，不会替你启动 DSH。

若自动写入失败，把路径换成实际安装目录（默认是 `%LOCALAPPDATA%\Programs\beautiCode`）：

```sh
dsh plugin --profile web add file:%LOCALAPPDATA%\Programs\beautiCode\integrations\deepseek-harness
npx @deepseek-ai/dsh plugin --profile web add file:%LOCALAPPDATA%\Programs\beautiCode\integrations\deepseek-harness
```

之后在托盘里：

* 点「应用或重新应用」：DSH 路径只连接已启动的网页（网页关了会重新打开，DSH 没运行则提示你先 `dsh web`）；Codex 路径与原来一样
* 更换图片或视频
* 清除背景、开关声音、摸鱼、保存和切换主题

退出托盘不会结束 DeepSeek Harness，避免打断正在进行的工作。

当前安装包尚未进行商业代码签名，Windows 可能显示 SmartScreen 提示。
用户导入的图片、视频和已保存主题位于
`%LOCALAPPDATA%\beautiCode`，卸载程序默认保留这些数据。

<p align="center">
  <img width="320" alt="Windows 安装包" src="https://github.com/user-attachments/assets/8c16eeb9-94d0-4f19-a816-b32fba8a110c" />
</p>

### 从源码运行

源码开发需要 Node.js 22 或更高版本。在项目目录执行：

```bash
npm install
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-dsh-plugin.ps1
npx @deepseek-ai/dsh web
# 托盘只在要用 Codex 或摸鱼热键时再开：
# npm run tray
```

或手动把本地插件目录加进 DSH（需要 pnpm）：

```sh
npx @deepseek-ai/dsh plugin --profile web add file:%CD%/integrations/deepseek-harness
npx @deepseek-ai/dsh web
```

或打开宿主选择器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-beauticode.ps1
```

构建 Windows 安装包：

```powershell
npm run installer:windows
```

输出位于：

```text
artifacts\windows\installer\
```

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
* MP4 视频


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
相关开源许可、代码来源和修改说明见：

```text
THIRD_PARTY_NOTICES.md
```

beautiCode 是非官方项目，与 DeepSeek、OpenAI、Codex 或其他应用厂商没有隶属或合作关系。

DeepSeek Harness 的接入说明见 [`docs/deepseek-harness.md`](docs/deepseek-harness.md)。

---

## License

MIT
