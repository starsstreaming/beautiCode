<!-- hello,starstreaming. -->
<div align="center">
  <h1>beautiCode</h1>
  <p>
    <a href="./README.md">中文</a> · <strong>English</strong>
  </p>

  <img width="1672" height="941" alt="ba6a554d-08c1-4d99-abd0-b0ce94478c73" src="https://github.com/user-attachments/assets/d010a8ce-b131-47ef-a1aa-3a473290a4f8" />

</div>

<p align="center">
  <strong>One tool to give every agent client a dynamic skin.</strong>
</p>

<p align="center">
  A wallpaper, an anime episode, a rainy window scene—place it behind the chat in DeepSeek Harness, Codex Desktop,<br>
  WorkBuddy, Cursor, or Doubao, where it quietly stays.
</p>


https://github.com/user-attachments/assets/f1b52d41-aea4-4330-80e1-5a90c344360e


---

## What is it?

beautiCode is a local dynamic skin tool: it places images, videos, or wallpapers with atmospheric effects behind the interface of the AI coding client you use. Code, input fields, and buttons keep working as usual—it does not turn the window into a player; the picture stays behind the chat and workspace.

Skins come from two sources:

* **Skin Center**: an online catalog where you can browse, search, and install reviewed skins with one click. They are downloaded to your computer and applied automatically.
* **Local import**: pick your own images or videos from a system folder (JPG / JPEG / PNG / WebP / AVIF, MP4 / MOV).

Imported content can be saved as named themes and switched at any time; video themes remember their last playback position.


## Supported clients

| Client | Integration | Platform | Status |
|---|---|---|---|
| **DeepSeek Harness** | Cordis plugin with an embedded **Background** panel in Settings | Windows | ✅ Recommended, no tray required |
| **Codex Desktop** | Tray or local CDP injection | Windows | ✅ Supported |
| **WorkBuddy** | Official CDP switch + background injection daemon | Windows / macOS | ✅ Supported |
| **Cursor** | Desktop CDP daemon | Windows | ✅ Supported (baseline 3.18.9) |
| **Doubao** | Desktop CDP daemon | Windows | ✅ Supported (baseline 2.29.12) |

beautiCode does not modify any client's installation files or publish patches on behalf of vendors—DSH uses the official plugin interface, while desktop clients use injection through a local debugging port on `127.0.0.1`. It can be cleanly uninstalled at any time.

## Skins and themes

### Skin Center

Open **Skin Center** inside the client (from DSH Settings or the injected panel in each client). Search by name, filter by image or video, and click a card to install: download → save as a local theme → apply to the current window, with progress shown in real time. Uploads and reviews happen on the Skin Center website; only approved skins appear in the catalog, and their source and version are recorded in the theme information.

### Local import

Pick a file with the system's native file picker and give it a name (1–80 characters) to create a theme. Themes only record the name, type, and original path—moving or deleting the file makes the theme unavailable. Clearing the background does not delete saved themes.

### Dynamic skins

* **Video backgrounds**: MP4 / MOV videos play in a loop, muted by default, with sound available manually. If autoplay with sound is blocked, playback continues muted and a notice appears.
* **Atmospheric effects**: built-in presets such as **Gallery Window** add rain, ripples, and lighting layers to images, bringing still wallpapers to life.
* **Smart dimming**: the home screen keeps the wallpaper's original brightness; entering a working session dims it automatically to keep text readable (DSH / Codex / WorkBuddy).

### Theme management

Save the current background as a theme, switch themes at any time, or delete them. Video playback positions are saved per theme, so switching back resumes where you left off.

## Installation

### Copy this request to your agent (easiest)

```sh
Please run npm install -g beauticode-desktop --foreground-scripts && beauticode-desktop all install on my computer to install the latest beautiCode. Keep running clients open and preserve my work. If anything goes wrong, diagnose and resolve it with beauticode-desktop all status / all health, and make sure each host's daemon is installed and can inject automatically. A result of ok:true means success; skipped for a client that is not installed and wait-for-launch for a client that is not running are both normal. Finish with a brief report of the installation results, unresolved issues, and how to open the background controls.
```

### Set up all installed clients with one command (Windows) (manual installation)

```sh
npm install -g beauticode-desktop --foreground-scripts
beauticode-desktop all install
```

`all install` detects clients installed on your computer, sets up their background integration one by one, and creates Start menu shortcuts with background support for detected clients. It does not start the clients for you. For a client enabling CDP for the first time, launch it once using the new shortcut.

### For DeepSeek Harness only

```sh
npx beauticode-dsh
dsh web
```

After installing the plugin, open DSH **Settings**. A **Background** entry appears in the left navigation, with no tray required. You can also enter `/bg <file path>`, `/bg-theme <name>`, or `/bg-clear` in the chat, or simply ask the AI to change the background.

### Check and manage individual clients

```sh
beauticode-desktop all status
beauticode-desktop all health
beauticode-desktop <dsh|codex|workbuddy|cursor|doubao> <install|status|uninstall|health>
```

`status` / `health` are read-only; `install` skips clients that are not installed. To uninstall an individual integration, use its host command, for example `beauticode-desktop cursor uninstall`.

## Security boundaries

* All injection uses a local debugging port on `127.0.0.1` or the official plugin interface; client binaries are never modified.
* Changes are validated before application and verified by reading them back afterward. Failures trigger automatic rollback, so a broken page is not left unnoticed.
* The daemon performs at most one controlled restart for a verified process that started less than 10 seconds ago. It does not restart indefinitely or touch unrelated processes.
* Imported media is read only from local files you explicitly select; control channels use random tokens.

## About local media

beautiCode only reads local images and videos you explicitly select. The project does not provide anime, movies, or other copyrighted content. Import only media you own or have the right to use, and follow local laws and copyright requirements.

---

## Why the name beautiCode?

Because coding tools do not have to be cold, uniform, and impersonal.

Some people like minimalist black. Some like rainy cities at night. Some like anime. Some like watching a familiar movie again during a long build.

Tools should help people get work done. But good tools should also let people bring themselves into their work.

> **We spend a lot of time facing code every day.
> beautiCode simply wants that time to feel more like life, rather than just waiting for a task to finish.**

---

## Acknowledgements

Some of beautiCode's media processing ideas and implementation experience were informed by and adapted from:

* Codex Dream Skin

Support from LINUX DO: https://linux.do/

Gallery Window reference: https://github.com/Sui-IB/InternalBeyond

See `THIRD_PARTY_NOTICES.md` for the relevant open-source licenses, code sources, and modification notes.

beautiCode is an unofficial project and is not affiliated with or partnered with DeepSeek, OpenAI, Codex, ByteDance, Tencent, or other application vendors.

See `docs/` for integration details for each client: [`deepseek-harness.md`](docs/deepseek-harness.md), [`host-adapter-cursor-doubao.md`](docs/host-adapter-cursor-doubao.md), [`host-adapter-workbuddy.md`](docs/host-adapter-workbuddy.md).

---

## License

MIT
