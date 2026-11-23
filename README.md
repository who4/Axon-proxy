<p align="center">
  <img src="icons/icon128.png" alt="Axon Proxy icon" width="84" height="84" />
</p>

<h1 align="center">Axon Proxy</h1>

<p align="center">
  A local-only Manifest V3 proxy manager for Chrome supporting HTTP, HTTPS, and SOCKS5 servers, multi-proxy split tunneling, companion CDN bundles, and WebRTC leak protection.
</p>

<p align="center">
  <a href="https://github.com/who4/Axon-proxy/releases">
    <img src="https://img.shields.io/github/v/release/who4/Axon-proxy?style=flat-square&color=24D858&labelColor=141418" alt="Latest Release" />
  </a>
  <img src="https://img.shields.io/badge/Manifest-V3-141418?style=flat-square&labelColor=0B0B0D" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Chrome-109%2B-141418?style=flat-square&labelColor=0B0B0D" alt="Chrome 109+" />
</p>

---

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <img src="docs/screenshots/popup-unprotected.png" alt="Axon Proxy popup — Unprotected state" width="320" />
      <br />
      <sub><strong>Unprotected</strong> — Direct connection with active-tab quick controls</sub>
    </td>
    <td align="center" width="50%">
      <img src="docs/screenshots/popup-protected.png" alt="Axon Proxy popup — Protected state" width="320" />
      <br />
      <sub><strong>Protected</strong> — Live session timer, exit IP, latency check, and server badge</sub>
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/options-split-tunneling.png" alt="Axon Proxy — Split tunneling rules and live URL routing tester" width="860" />
  <br />
  <sub><strong>Split Tunneling &amp; Live URL Tester</strong> — Verify how pages and media CDN hosts resolve before browsing</sub>
</p>

<p align="center">
  <img src="docs/screenshots/options-pac-diagnostics.png" alt="Axon Proxy — Compiled PAC script inspector" width="860" />
  <br />
  <sub><strong>PAC Inspector</strong> — Inspect the exact <code>FindProxyForURL</code> script generated from your rules</sub>
</p>

---

## Features

### Split Tunneling That Does Not Break Media Sites
Standard domain rules often fail on modern sites when your default policy is Direct. Adding `*.youtube.com` loads the page shell, but video streams (`googlevideo.com`) and thumbnails (`ytimg.com`, `ggpht.com`) fall through to Direct and stall.

Axon Proxy solves this in two ways:
- **Built-in Site Bundles**: Rules for platforms such as YouTube, X, Instagram, Discord, Twitch, Netflix, Spotify, Reddit, GitHub, TikTok, Telegram, Steam, OpenAI, and Claude automatically expand to include their companion video, image, and API hosts.
- **Tab CDN Auto-Capture**: Tracks third-party subresource hosts loaded by the active tab via `webRequest` so site rules created from a live page pick up companion CDNs automatically.

### Routing & Proxy Management
- **Protocols**: HTTP, HTTPS, and SOCKS5, with remote DNS resolution (`SOCKS5 host:port`) in generated PAC scripts.
- **Strict Top-to-Bottom Priority**: Drag-and-drop rule ordering, per-rule enable/disable toggles, and per-rule proxy selection.
- **Matcher Types**: Domain, Wildcard (`*.example.com`), RegExp, and IPv4 CIDR (`10.20.0.0/16`).
- **Failover Chains**: Assign a backup proxy to any profile so traffic falls back cleanly if the primary server drops.
- **Right-Click Context Menu**: Right-click any page or link to route it through your active proxy, send it to a specific saved server, bypass it directly, or clear its rule.
- **Smart URI Paste**: Paste `socks5://user:pass@host:port` (or `http://` / `https://`) into the proxy modal to auto-fill host, port, protocol, and credentials.
- **Live URL Tester & PAC Inspector**: Test any URL or CDN hostname against your active rule set and inspect the compiled PAC script.

### Privacy & Reliability
- **WebRTC IP Leak Guard**: Applies Chrome's `disable_non_proxied_udp` WebRTC policy while connected.
- **Scoped Authentication**: `onAuthRequired` credentials are only sent to the exact configured proxy host and port, with retry capping to avoid auth loops.
- **Session-Only Credentials**: Optionally keep usernames and passwords in `chrome.storage.session` so they are wiped when Chrome closes.
- **Proxy Conflict Detection**: Checks Chrome's `levelOfControl` and warns if another extension is overriding proxy settings.
- **Sanitized Backups**: Export and import JSON configs or bulk domain/AdBlock lists. Proxy credentials are omitted from exports by default.

---

## Installation

### Option 1: From GitHub Releases (Recommended)
1. Download the latest `axon-proxy-v*.zip` from the [Releases](https://github.com/who4/Axon-proxy/releases) page and extract it.
2. Open `chrome://extensions` in Chrome and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the extracted folder (the one containing `manifest.json`).

### Option 2: From Source
```bash
git clone https://github.com/who4/Axon-proxy.git
```
Load the cloned directory directly via `chrome://extensions` → **Developer mode** → **Load unpacked**.

---

## Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `Alt + Shift + P` | Toggle proxy connection on or off |
| `Alt + Shift + N` | Cycle to the next saved proxy profile |

Shortcuts can be customized at `chrome://extensions/shortcuts`.

---

## Development & Releases

The extension itself uses native Manifest V3 ES modules with no build step. Node.js is only used for the local web preview, unit tests, and release packaging.

```bash
# Install dev server dependency and start local preview at http://localhost:3000
npm install
npm run dev

# Run routing engine unit tests and syntax checks
node --test lib/engine.test.js
npm run lint

# Build a verified Chrome Web Store / release ZIP into dist/
npm run pack:cws
```

Pushing a version tag matching `v*` (for example `git tag v2.0.0 && git push origin v2.0.0`) runs `.github/workflows/release.yml`, which validates the extension, executes unit tests, packages the runtime files into `axon-proxy-<tag>.zip`, and publishes a GitHub Release with the archive attached.

---

## Privacy

Axon Proxy runs entirely inside your browser. Proxy profiles, rules, and preferences are stored locally in `chrome.storage.local` (or `chrome.storage.session` when session-only credentials are enabled). No browsing history, telemetry, or credentials are sent to any external server. When you connect or click **Test connection**, the extension sends a minimal request to `api.ipify.org` and `www.google.com/generate_204` solely to display your current exit IP and connection latency.
