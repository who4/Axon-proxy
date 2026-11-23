# Axon Proxy — Chrome Web Store Submission Kit

Everything below is validated for Chrome Web Store (Manifest V3) submission.

## 1. Upload Package
Run `npm run pack:cws` (already built for you) to generate the clean upload archive:
- **ZIP file**: `dist/axon-proxy-v2.0.0-chrome-web-store.zip`
- Contains **only** the 17 runtime extension files (`manifest.json`, `background.js`, `icons/`, `lib/`, `popup/`, `options/`). Excludes dev server, preview wrapper, tests, and `node_modules`.

---

## 2. Store Listing Copy (Ready to Paste)

- **Extension Name**: `Axon Proxy`
- **Summary (121 / 132 chars)**:
  > Fast HTTP, HTTPS & SOCKS5 proxy router with smart split tunneling, CDN bundles, right-click rules, and WebRTC leak guard.
- **Category**: `Productivity` (or `Developer Tools`)
- **Language**: `English`

### Detailed Description
```text
Axon Proxy is a fast, privacy-focused HTTP, HTTPS, and SOCKS5 proxy manager for Chrome with intelligent split tunneling and instant visual status feedback.

KEY FEATURES
• Smart Split Tunneling & CDN Bundles — Route specific sites through your proxy while keeping everything else direct (or vice versa). Built-in Smart Site Bundles automatically capture companion media and thumbnail CDNs (e.g., YouTube video streams and thumbnails on googlevideo.com & ytimg.com, Discord, Twitch, X, Instagram, Netflix, GitHub, and more).
• Auto-Capture Tab CDNs — Automatically detects companion subresource hosts loaded by your active tab when adding site rules.
• Right-Click Context Menu — Right-click any page or link to route that site through your active proxy, send it to a specific proxy server, bypass via direct connection, or remove its rule.
• Multi-Proxy & Failover Chains — Save unlimited HTTP, HTTPS, and SOCKS5 profiles with Smart URI quick-paste (socks5://user:pass@host:port), per-rule proxy targeting, and automatic backup failover servers.
• SOCKS5 Remote DNS — Generated PAC scripts always emit SOCKS5 directives so DNS lookups tunnel securely through your proxy.
• Live URL Routing Tester & PAC Inspector — Test any URL or media CDN hostname to see the exact rule and PAC directive that handles it.
• WebRTC IP Leak Guard & Session-Only Auth — Prevent local IP leaks via WebRTC and optionally keep proxy credentials in volatile session memory only.
• Keyboard Shortcuts & Sanitized Backups — Toggle proxy (Alt+Shift+P), cycle servers (Alt+Shift+N), and export/import JSON or bulk domain lists (credentials omitted by default).

PRIVACY FIRST
Axon Proxy runs 100% locally in your browser. It never collects browsing history, analytics, or credentials.
```

---

## 3. Privacy Practices Tab (Required by Chrome Web Store)

### Single Purpose Description
> Axon Proxy routes browser network traffic through user-configured HTTP, HTTPS, and SOCKS5 proxy servers with customizable per-site split-tunneling rules and WebRTC leak protection.

### Permission Justifications
- **`proxy`**: Applies the user's selected proxy server configuration (`fixed_servers`) or compiled split-tunneling PAC script (`pac_script`) to Chrome's network stack.
- **`storage`**: Persists user-configured proxy profiles, split-tunneling rules, and preferences locally in `chrome.storage.local` (and optional volatile credentials in `chrome.storage.session`).
- **`webRequest`**: Observes subresource hostnames per tab solely in memory to auto-detect companion video/image CDNs when the user creates a split-tunnel rule for that site.
- **`webRequestAuthProvider`**: Responds to HTTP/HTTPS/SOCKS proxy authentication challenges strictly matching the user's configured proxy host and port, with retry capping.
- **`contextMenus`**: Provides right-click page and link menu entries so users can add or remove proxy/direct rules for any website in one click.
- **`tabs`**: Reads the active tab's URL to display the current site's routing status in the popup, support one-click site rules, and optionally reload the tab after rule updates.
- **`privacy`**: Sets Chrome's `webRTCIPHandlingPolicy` to `disable_non_proxied_udp` when the user enables the WebRTC IP leak guard.
- **Host permission (`<all_urls>`)**: Required by Chrome's `webRequestAuthProvider` and `webRequest` APIs to handle proxy authentication challenges and detect companion CDN domains across whichever websites the user chooses to route.
- **Remote Code**: `No, I am not using Remote code.` (All JavaScript is bundled directly inside the extension package.)

### Data Usage Certification
- Does your extension collect or transmit user data? **No** (All proxy settings and rules stay locally on the user's device; connection diagnostics only query `api.ipify.org` and `www.google.com/generate_204` on demand to display exit IP and latency).
- Check all 3 limited-use certification boxes on the Privacy Practices tab.
- **Privacy Policy URL**: Host `store/privacy-policy.html` (e.g., on GitHub Pages, your website, or your deployed app's `/privacy` URL) and paste that public HTTPS URL into the Chrome Web Store Privacy Policy field.

---

## 4. Store Graphics Included
- **Store Icon (128×128)**: `icons/icon128.png`
- **Store Screenshots (1280×800)**:
  - `store/screenshots/01-popup-protected.png`
  - `store/screenshots/02-split-tunneling-tester.png`
  - `store/screenshots/03-pac-diagnostics.png`

---

## 5. How to Submit (2 Minutes)
1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) and sign in with your Google developer account.
2. Click **+ New Item** and upload `dist/axon-proxy-v2.0.0-chrome-web-store.zip`.
3. Fill in the **Store Listing** tab using Section 2 above, upload `icons/icon128.png` and the 3 screenshots from `store/screenshots/`.
4. Fill in the **Privacy Practices** tab using Section 3 above and link your hosted `privacy-policy.html`.
5. Click **Submit for Review**.
