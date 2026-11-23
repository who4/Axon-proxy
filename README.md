# Axon Proxy — Chrome Extension

A fast, local-only Manifest V3 Chrome extension to route **HTTP**, **HTTPS**, and **SOCKS5** proxies with multi-proxy split tunneling, **Smart Site Bundles + live CDN capture** (so video/thumbnail domains like YouTube's `googlevideo.com` and `ytimg.com` load reliably), right-click context menu rules, and WebRTC leak protection.

## Key Features

- **Obsidian Pixel-Matrix UI**: Real-time Unprotected/Protected state matrix, live session timer, latency & exit-IP diagnostics, and custom colored toolbar badges per proxy.
- **Smart Multi-Domain Split Tunneling**:
  - Strict top-to-bottom rule priority with per-rule toggles and drag-and-drop reordering.
  - **Smart Site Bundles** (YouTube, X/Twitter, Discord, Instagram, Twitch, Netflix, GitHub, Spotify, Reddit, OpenAI, etc.) automatically include companion video/image/API CDNs.
  - **Auto-Capture Tab CDNs** tracks third-party subresource hosts per tab via `webRequest`.
  - **Multi-Proxy Routing & Failover Chains**: Route different domains through different proxy servers and attach backup failover proxies (`SOCKS5 a:1080; PROXY b:8080`).
  - Supports **Domain**, **Wildcard**, **RegExp**, and **IPv4 CIDR** matchers.
- **Right-Click Context Menu**: Right-click any webpage or link to route it via your active proxy, pick a specific proxy, bypass directly, or remove existing rules (with optional tab auto-reload).
- **Privacy & Security**:
  - Remote DNS resolution via `SOCKS5` in PAC mode.
  - Automatic **WebRTC IP Leak Guard** (`disable_non_proxied_udp` while connected).
  - Host-scoped, retry-capped `onAuthRequired` proxy authentication + optional session-only credential storage (`chrome.storage.session`).
  - Chrome proxy override conflict detection (`levelOfControl`).
- **Tools & Portability**: Smart URI paste (`socks5://user:pass@host:port`), Live URL Routing Tester, Live PAC Inspector, Keyboard Shortcuts (`Alt+Shift+P`, `Alt+Shift+N`), and JSON/Bulk Domain Import & Export.

## Install in Chrome (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this repository folder

## Local Web Preview

```bash
npm install
npm run dev
```

Opens the live preview server on `http://0.0.0.0:3000`.
