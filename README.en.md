<div align="center">
  <h1>beautiCode</h1>
  <p>
    <a href="./README.md">中文</a> · <strong>English</strong>
  </p>
  <img width="1672" height="941" alt="beautiCode wallpaper behind a coding session" src="https://github.com/user-attachments/assets/c943a0fb-ff48-4361-9e6f-c4b1521aee2b" />

</div>

<p align="center">
  <strong>Put the pictures you love behind every minute of vibe coding.</strong>
</p>

<p align="center">
  Add image and video backgrounds to DeepSeek Harness, with Codex Desktop supported too.<br>
  A still wallpaper, an episode of anime, or a landscape that stays with you through long sessions.
</p>

---


## What is it?

beautiCode is a local background tool, **aimed mainly at DeepSeek Harness and Codex**.

It does not bundle, install, or start DSH. Install DeepSeek Harness yourself and run `dsh web`. After the plugin is installed, a **Background** entry appears in the DSH settings dialog — no tray required. Codex Desktop still goes through the beautiCode tray. You can set files already on your computer as the background behind the DeepSeek Harness page:

* Images
* Live wallpapers
* MP4 / MOV videos
* Anime

It does not turn the work window into a player. The picture stays quietly behind the chat and workspace.

Code, input fields, and buttons keep working as usual.

<img width="1280" height="714" alt="beautiCode background in DeepSeek Harness" src="https://github.com/user-attachments/assets/a9a18412-4c62-4083-ab49-d127f05e61c3" />


## How to use it

### One-command plugin install (recommended)

If you only want a background in DeepSeek Harness, install the plugin. You do not need to fork the repo, download the Windows installer, or open the tray. Install DSH and Node.js first.

```sh
npx beauticode-dsh
```

`npx beauticode-dsh` downloads the plugin from npm and writes it into your DSH profile. **pnpm is not required, and you do not need to run `dsh plugin add`.** If `dsh` is on your PATH, you can start the page with `dsh web`.

On the page, open **Settings** and pick **Background** from its left-hand nav. Pick an image or MP4/MOV from a folder, clear the background, toggle sound, switch saved themes, or go fullscreen to put the browser's tab strip and address bar away. Saved themes include the built-in Gallery window. The web console does not include fish mode. Light and dark appearance still follow DSH’s own setting. The last background is restored on the next start.

You can also use `/bg`, `/bg-theme`, `/bg-clear`, or just ask the AI to set a local image or video as the background.

If you already have pnpm, DSH can install the npm package itself:

```sh
npx @deepseek-ai/dsh plugin --profile web add beauticode-dsh
npx @deepseek-ai/dsh web
```

Uninstall:

```sh
npx beauticode-dsh --remove
```


### Windows installer

Use the [Windows installer](https://github.com/starsstreaming/beautiCode/releases/latest) when you need Codex Desktop, the system tray, or you do not want to keep the source tree around.

Then start DSH yourself:

```sh
dsh web
# If dsh is not on PATH:
npx @deepseek-ai/dsh web
```

The installer ships Node.js. You do not need a separate Node.js, npm, or pnpm install. It wires the DSH plugin at the end of setup. If you changed the install directory, follow `集成说明.txt` in that folder.

After you start `dsh web`, the **Background** page under **Settings** is ready. Codex Desktop still needs the beautiCode tray: choose **Codex Desktop** and it will launch Codex as needed; choose **DeepSeek Harness** and it only connects to a DSH page you already started — it will not start DSH for you.

If automatic wiring fails, replace the path with your actual install directory (default `%LOCALAPPDATA%\Programs\beautiCode`):

```sh
dsh plugin --profile web add file:%LOCALAPPDATA%\Programs\beautiCode\integrations\deepseek-harness
npx @deepseek-ai/dsh plugin --profile web add file:%LOCALAPPDATA%\Programs\beautiCode\integrations\deepseek-harness
```

From the tray you can:

* Click **Apply or re-apply**: the DSH path only connects to an already-running page (it reopens a closed page; if DSH is not running it asks you to run `dsh web` first). The Codex path behaves as before.
* Change the image or video
* Clear the background, toggle sound, enter fish mode, save and switch themes

Quitting the tray does not stop DeepSeek Harness, so in-progress work is not interrupted.

The current installer is not commercially code-signed, so Windows may show a SmartScreen warning.
Imported images, videos, and saved themes live in
`%LOCALAPPDATA%\beautiCode`. The uninstaller keeps that data by default.

<p align="center">
  <img width="320" alt="Windows installer" src="https://github.com/user-attachments/assets/8c16eeb9-94d0-4f19-a816-b32fba8a110c" />
</p>

### Run from source

Source development needs Node.js 22 or newer. From the project directory:

```bash
npm install
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-dsh-plugin.ps1
npx @deepseek-ai/dsh web
# Start the tray only when you need Codex or the fish-mode hotkey:
# npm run tray
```

Or add the local plugin directory to DSH yourself (requires pnpm):

```sh
npx @deepseek-ai/dsh plugin --profile web add file:%CD%/integrations/deepseek-harness
npx @deepseek-ai/dsh web
```

Or open the host picker:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-beauticode.ps1
```

Build the Windows installer:

```powershell
npm run installer:windows
```

Output:

```text
artifacts\windows\installer\
```

The tray menu can:

* Change the image
* Change the video
* Clear the background
* Turn video sound on or off
* Enter fish mode
* Save the current theme
* Switch saved themes
* Delete a theme


## Current support

Currently supported:

* Windows
* DeepSeek Harness (recommended)
* Codex Desktop
* JPG, JPEG, PNG, and WebP images
* MP4 / MOV video


## About local video

beautiCode only reads local images and videos you choose yourself.

This project does not provide anime, movies, or other copyrighted content.

Import only media you own or have the right to use, and follow local law and copyright rules.

---

## Why the name beautiCode?

Coding tools do not have to be cold, uniform, and anonymous.

Some people want a plain black window.

Some want a rainy city at night.

Some want anime.

Some want a familiar film playing through a long build.

Tools should help you finish the work.

A good tool should also let you bring yourself into that work.

> **We spend a lot of hours in front of code.
> beautiCode only wants those hours to feel more like living, not just waiting for a task to finish.**

---

## Acknowledgements

Parts of beautiCode’s media handling take ideas and implementation notes from:

* Codex Dream Skin

LINUX DO:
https://linux.do/

Gallery window reference:
https://github.com/Sui-IB/InternalBeyond

Third-party licenses, sources, and modifications:

```text
THIRD_PARTY_NOTICES.md
```

beautiCode is unofficial. It is not affiliated with DeepSeek, OpenAI, Codex, or any other app vendor.

DeepSeek Harness integration notes: [`docs/deepseek-harness.md`](docs/deepseek-harness.md).

---

## License

MIT
