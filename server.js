import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const app = express();

const SHIM_TAG = '  <script src="/preview/chrome-shim.js"></script>\n';

async function serveInjectedHtml(relativePath, res, next) {
  try {
    const filePath = path.join(__dirname, relativePath);
    const html = await fs.readFile(filePath, 'utf-8');
    const injected = html.includes('</head>')
      ? html.replace('</head>', `${SHIM_TAG}</head>`)
      : `${SHIM_TAG}${html}`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(injected);
  } catch (err) {
    next(err);
  }
}

async function handleDiagnostics(_req, res) {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    let exitIp = null;
    let status = 0;

    try {
      const ipRes = await fetch('https://api.ipify.org?format=json', {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store'
      });
      status = ipRes.status;
      if (ipRes.ok) {
        const json = await ipRes.json();
        exitIp = json?.ip || null;
      }
    } catch {
      const probe = await fetch('https://www.google.com/generate_204', {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store'
      });
      status = probe.status;
    }

    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    res.json({
      ok: true,
      result: {
        success: status === 200 || status === 204,
        status,
        latencyMs,
        exitIp
      }
    });
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : 'Connection failed'
    });
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'preview', 'index.html'));
});

app.get('/popup/popup.html', (_req, res, next) => {
  serveInjectedHtml('popup/popup.html', res, next);
});

app.get('/options/options.html', (_req, res, next) => {
  serveInjectedHtml('options/options.html', res, next);
});

app.get('/api/test-connection', handleDiagnostics);
app.get('/api/diagnostics', handleDiagnostics);

app.get('/privacy', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'store', 'privacy-policy.html'));
});

app.get('/download/chrome-web-store.zip', (_req, res) => {
  const zipPath = path.join(__dirname, 'dist', 'axon-proxy-v2.0.0-chrome-web-store.zip');
  res.download(zipPath, 'axon-proxy-v2.0.0-chrome-web-store.zip', (err) => {
    if (err && !res.headersSent) {
      res.status(404).send('Run npm run pack:cws to build the Chrome Web Store package.');
    }
  });
});

// Serve only extension assets and preview files
app.use('/preview', express.static(path.join(__dirname, 'preview')));
app.use('/popup', express.static(path.join(__dirname, 'popup')));
app.use('/options', express.static(path.join(__dirname, 'options')));
app.use('/lib', express.static(path.join(__dirname, 'lib')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

app.use((_req, res) => {
  res.redirect('/');
});

app.listen(PORT, HOST, () => {
  console.log(`Axon Proxy preview server running at http://${HOST}:${PORT}`);
});
