<!-- hello,starstreaming. -->
<div align="center">
  <h1>beautiCode</h1>
  <p>
    <strong>中文</strong> · <a href="./README.en.md">English</a>
  </p>

  <img width="1672" height="941" alt="ba6a554d-08c1-4d99-abd0-b0ce94478c73" src="https://github.com/user-attachments/assets/d010a8ce-b131-47ef-a1aa-3a473290a4f8" />

</div>

<p align="center">
  <strong>给 AI 编程客户端换皮肤的本地工具。</strong>
</p>

<p align="center">
  一张壁纸、一部番剧、一段会下雨的窗景——放进 DeepSeek Harness、Codex Desktop、<br>
  WorkBuddy、Cursor、豆包的对话窗口背后，安静地待在那里。
</p>


https://github.com/user-attachments/assets/f1b52d41-aea4-4330-80e1-5a90c344360e


---

## 它是什么？

beautiCode 是一个本地动态皮肤工具：把图片、视频或带氛围特效的壁纸，注入到你正在使用的 AI 编程客户端界面背后。代码、输入框和按钮照常工作——它不是把窗口变成播放器，而是让画面待在对话和工作区后面。

皮肤有两个来源：

* **皮肤中心**：在线目录，浏览、搜索、一键安装经过审核的皮肤，下载到本机后自动应用
* **本地导入**：从系统文件夹里挑你自己的图片或视频（JPG / JPEG / PNG / WebP / AVIF，MP4 / MOV）

导入的内容都可以存成命名主题，随时切换；视频主题会记住上次播放进度。


## 支持的客户端

| 客户端 | 接入方式 | 平台 | 状态 |
|---|---|---|---|
| **DeepSeek Harness** | Cordis 插件，设置页内嵌「背景」面板 | Windows | ✅ 推荐，无需托盘 |
| **Codex Desktop** | 托盘 or 本机 CDP 注入 | Windows | ✅ 支持 |
| **WorkBuddy** | 官方 CDP 开关 + 守护注入 | Windows / macOS | ✅ 支持 |
| **Cursor** | 桌面 CDP 守护 | Windows | ✅ 支持（基线 3.18.9） |
| **豆包** | 桌面 CDP 守护 | Windows | ✅ 支持（基线 2.29.12） |

beautiCode 不会修改任何客户端的安装文件，也不替厂商发布补丁——DSH 走官方插件接口，桌面客户端走 `127.0.0.1` 本机调试端口注入，可随时干净卸载。

## 皮肤与主题

### 皮肤中心

打开客户端内的「皮肤中心」（DSH 设置页 / 各客户端注入面板里的入口），可以按名称搜索、按图片或视频筛选，点卡片即安装：下载 → 写入本机主题 → 应用到当前窗口，进度实时可见。上传与审核在皮肤中心网站进行；只有审核通过的皮肤会出现在目录里，来源与版本会记录在主题信息里。

### 本地导入

从系统原生文件选择器挑一个文件，起一个名字（1–80 字符），即成主题。主题只记录名称、类型和原始路径——文件移动或删除后会提示不可用，清除背景不会删掉已存主题。

### 动态皮肤

* **视频背景**：MP4 / MOV 循环播放，默认静音，可手动开声；自动播放被拦时会保持静音播放并提示
* **氛围特效**：内置「画窗」等预设，在图片上叠雨丝、水波、光效层，让静态壁纸动起来
* **智能压暗**：首页保持壁纸原亮度；进入工作状态后自动压暗，保证文字可读（DSH / Codex / WorkBuddy）

### 主题管理

保存当前背景为主题、随时切换、删除；视频主题按主题记录播放进度，切回来时接着上次的位置播。

## 安装

### 直接复制发给你的Agent（最省事）

请在我的电脑上安装 最新版beauticode-desktop，保留工作内容。
遇到异常请处理，确保适配层的守护自动注入。
安装成功应返回 ok:true；客户端未打开时“等待启动”属于正常状态。
最后简短告诉我安装结果、未解决的问题，以及如何打开背景。

### 一个命令接管所有已装客户端（Windows）（手动安装）

```sh
npm install -g beauticode-desktop --foreground-scripts
beauticode-desktop all install
```

`all install` 会检测本机已安装的客户端，逐一套上后台接线，并为已检测到的客户端创建带背景的开始菜单快捷方式；它不会替你启动客户端。首次启用 CDP 的客户端请用新快捷方式启动一次。

### 只给 DeepSeek Harness 用

```sh
npx beauticode-dsh
dsh web
```

装好插件后，打开 DSH「设置」，左侧导航会多出「背景」一项，不需要托盘。也可以在对话里输入 `/bg <文件路径>`、`/bg-theme <名称>`、`/bg-clear`，或直接让 AI 帮你换背景。

### 检查与单独管理

```sh
beauticode-desktop all status
beauticode-desktop all health
beauticode-desktop <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall|health>
```

`status` / `health` 为只读；`install` 会跳过未安装的客户端；单独卸载用宿主命令，例如 `beauticode-desktop cursor uninstall`。

## 安全边界

* 所有注入只走 `127.0.0.1` 本机调试端口或官方插件接口，不改客户端二进制
* 应用前校验、应用后回读验证，失败自动回滚，不会静默画坏页面
* 守护只对启动不足 10 秒且已确认身份的进程做一次受控重启，不会无限重启、不碰无关进程
* 导入媒体只读你主动选择的本地文件；控制通道使用随机令牌

## 关于本地媒体

beautiCode 只读取你主动选择的本地图片和视频。项目不提供番剧、电影或其他受版权保护的内容。请只导入你拥有或有权使用的媒体文件，并遵守当地法律与内容版权要求。

---

## 为什么叫 beautiCode？

因为代码工具不一定只能是冰冷、统一和毫无个性的。

有人喜欢极简黑色。有人喜欢雨夜城市。有人喜欢动漫。有人喜欢在漫长的构建过程中，重新看一遍熟悉的电影。

工具应该帮助人完成工作。但好的工具，也应该允许人把自己带进工作里。

> **我们每天花很多时间面对代码。
> beautiCode 想做的，只是让这些时间更像生活，而不只是等待完成的任务。**

---

## 致谢

beautiCode 的部分媒体处理思路与实现经验参考并改编自：

* Codex Dream Skin

L站的支持：https://linux.do/

画窗参考：https://github.com/Sui-IB/InternalBeyond

相关开源许可、代码来源和修改说明见 `THIRD_PARTY_NOTICES.md`。

beautiCode 是非官方项目，与 DeepSeek、OpenAI、Codex、字节跳动、腾讯或其他应用厂商没有隶属或合作关系。

各客户端的接入细节见 `docs/`：[`deepseek-harness.md`](docs/deepseek-harness.md)、[`host-adapter-cursor-doubao.md`](docs/host-adapter-cursor-doubao.md)、[`host-adapter-workbuddy.md`](docs/host-adapter-workbuddy.md)。

---

## License

MIT
