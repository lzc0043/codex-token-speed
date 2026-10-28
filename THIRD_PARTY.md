# Reference and licensing

The Codex local IPC framing, initialization and selection-event compatibility
were informed by [soleillevant0125/codex-token-overlay](https://github.com/soleillevant0125/codex-token-overlay),
especially `macos/Sources/CodexTokenCore/CodexIPCMonitor.swift` and
`SessionPathResolver.swift`. Our Node implementation is independently scoped to
this plugin; it does not fall back to the most recently modified session.

That project's MIT notice is retained below:

MIT License

Copyright (c) 2026 soleillevant0125

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

Metric definitions were checked against DeepSeek Harness's official source;
links and the exact referenced revision are in `DEEPSEEK_REFERENCE.md`.
No extracted application files or DeepSeek implementation code are distributed.

Gauge and Database icons are from Microsoft's Fluent System Icons, revision
`60d561a815310bd52914fa0bccee14836428e23b`, under the MIT license.
Original vectors, rendered PNGs, source links and the full Microsoft copyright
notice are retained in `assets/icons/`.
