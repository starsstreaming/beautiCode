# Third-party notices

## DeepSeek Harness bundled runtime

- Package: `@deepseek-ai/dsh@0.1.0-rc.6`
- License: MIT, Copyright (c) 2026 DeepSeek
- Upstream project: https://github.com/deepseek-ai/deepseek-harness
- Distribution: the Windows installer includes the npm runtime and its
  dependency tree in a private, versioned directory. beautiCode does not install
  DSH globally or modify the upstream package.
- The upstream DSH license is copied to `licenses/dsh/LICENSE`; dependency
  package licenses remain alongside their packages in the bundled runtime.

## Fei-Away/Codex-Dream-Skin (media server lineage)

- License: MIT
- Upstream project: https://github.com/Fei-Away/Codex-Dream-Skin
- Source commit referenced for the loopback media server design and tests:
  `865b906a833313d9d14c468ce8fb4a3e3f72a953`
- Related stacked behavior references (not vendored as history):
  - atomic theme write marker: `770216204d62cdc599e5a5bcafbc16e59f91d06b`
  - verified apply + rollback: `a09057772ff345e4482dffb656d3c94b6ab61432`
  - native-chrome CSS narrowing: `f196381caf8dfdf1064f6eb82003291418059b9d`
- Upstream baseline observed while designing contracts: `611c101`
- Reused ideas / adapted component: loopback authenticated media server,
  Range/206 handling, token route isolation, MP4 `ftyp` gate, media server
  stage/commit controller, and the associated unit tests
- Local component: `packages/core/src/media-server.ts` (+ tests)
- Modifications relative to upstream:
  - rewritten in TypeScript under the beautiCode package layout
  - Dream Skin brand constants, custom scheme, and header names replaced
  - origins and header names made configurable
  - single shared implementation (no Windows/macOS file copies)
  - full-file hash retained for identity checks, with streaming-friendly hooks
  - integrated with beautiCode generation / apply-transaction APIs

The original MIT copyright notice for that upstream work is preserved here:

```text
MIT License

Copyright (c) 2026 Codex Dream Skin Studio contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Trademarks, official host binaries, and third-party artwork from the upstream
project are **not** reused and are outside the MIT grant (see upstream NOTICE).
