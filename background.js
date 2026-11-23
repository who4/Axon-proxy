import { buildProxyConfigFromState, evaluateUrlRouting } from './lib/pac-builder.js';
import {
  applyProxyFromState,
  getProxyControlStatus,
  removeSiteRule,
  upsertSiteRule
} from './lib/proxy-engine.js';
import { extractBaseDomain, findMatchingBundle } from './lib/site-bundles.js';
import { getState, updateState } from './lib/storage.js';

const MENU_ROOT = 'axon-root';
const MENU_USE_ACTIVE = 'axon-use-active';
const MENU_USE_SPECIFIC = 'axon-use-specific';
const MENU_BYPASS = 'axon-bypass';
const MENU_REMOVE = 'axon-remove';
const MENU_PROXY_PREFIX = 'axon-proxy-';

// Per-tab live subresource CDN tracker (tabId -> { pageHost, hosts: Set<string> })
const tabCapturedHosts = new Map();
const MAX_CAPTURED_PER_TAB = 40;

// Retry guard for onAuthRequired (requestId -> attempt count)
const authRetries = new Map();

function safeExtractHost(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

/* -------------------------------------------------------------------------- */
/* Lifecycle & Initialization                                                 */
/* -------------------------------------------------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  await refreshAll();
});

chrome.runtime.onStartup?.addListener(async () => {
  await refreshAll();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.proxyManagerState) {
    refreshAll();
  }
});

async function refreshAll() {
  const state = await getState();
  await applyProxyFromState(state);
  updateBadge(state);
  await rebuildContextMenus(state);
}

/* -------------------------------------------------------------------------- */
/* Dynamic Toolbar Badge                                                      */
/* -------------------------------------------------------------------------- */

function updateBadge(state) {
  const active = Boolean(state.enabled && state.activeProxyId);
  const proxy = active ? state.proxies.find((p) => p.id === state.activeProxyId) : null;

  if (active && proxy) {
    const text = (proxy.badgeText || 'ON').slice(0, 4).toUpperCase();
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: proxy.color || '#24D858' });
    chrome.action.setTitle({
      title: `Axon Proxy — Protected via ${proxy.name} (${proxy.type.toUpperCase()})`
    });
  } else {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Axon Proxy — Unprotected (Direct)' });
  }
}

/* -------------------------------------------------------------------------- */
/* Right-Click Context Menus                                                  */
/* -------------------------------------------------------------------------- */

async function rebuildContextMenus(state) {
  if (!chrome.contextMenus) return;

  await new Promise((resolve) => chrome.contextMenus.removeAll(resolve));

  if (state.settings?.contextMenuEnabled === false) return;

  const contexts = ['page', 'link'];

  chrome.contextMenus.create({
    id: MENU_ROOT,
    title: 'Axon Proxy',
    contexts
  });

  const activeProxy = state.proxies.find((p) => p.id === state.activeProxyId);
  const activeLabel = activeProxy ? activeProxy.name : 'Active proxy';

  chrome.contextMenus.create({
    id: MENU_USE_ACTIVE,
    parentId: MENU_ROOT,
    title: `Use proxy (${activeLabel}) + media/CDNs`,
    contexts
  });

  if (state.proxies.length > 0) {
    chrome.contextMenus.create({
      id: MENU_USE_SPECIFIC,
      parentId: MENU_ROOT,
      title: 'Use specific proxy for this site',
      contexts
    });

    for (const proxy of state.proxies) {
      chrome.contextMenus.create({
        id: `${MENU_PROXY_PREFIX}${proxy.id}`,
        parentId: MENU_USE_SPECIFIC,
        title: `${proxy.name} (${proxy.type.toUpperCase()})`,
        contexts
      });
    }
  }

  chrome.contextMenus.create({
    id: MENU_BYPASS,
    parentId: MENU_ROOT,
    title: 'Use direct network (bypass proxy)',
    contexts
  });

  chrome.contextMenus.create({
    id: MENU_REMOVE,
    parentId: MENU_ROOT,
    title: 'Remove site from rules',
    contexts
  });
}

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  const targetUrl = info.linkUrl || info.pageUrl || tab?.url || '';
  const host = safeExtractHost(targetUrl);
  if (!host) return;

  const captured = tab?.id ? [...(tabCapturedHosts.get(tab.id)?.hosts || [])] : [];
  const state = await getState();
  const includeCompanions = state.settings?.autoIncludeCompanions !== false;

  let nextState = state;

  if (info.menuItemId === MENU_USE_ACTIVE) {
    nextState = await updateState((s) =>
      upsertSiteRule(s, {
        domain: host,
        action: 'proxy',
        proxyId: null,
        capturedDomains: captured,
        includeCompanions
      })
    );
  } else if (String(info.menuItemId).startsWith(MENU_PROXY_PREFIX)) {
    const proxyId = String(info.menuItemId).slice(MENU_PROXY_PREFIX.length);
    nextState = await updateState((s) =>
      upsertSiteRule(s, {
        domain: host,
        action: 'proxy',
        proxyId,
        capturedDomains: captured,
        includeCompanions
      })
    );
  } else if (info.menuItemId === MENU_BYPASS) {
    nextState = await updateState((s) =>
      upsertSiteRule(s, {
        domain: host,
        action: 'direct',
        proxyId: null,
        capturedDomains: captured,
        includeCompanions
      })
    );
  } else if (info.menuItemId === MENU_REMOVE) {
    nextState = await updateState((s) => removeSiteRule(s, host));
  } else {
    return;
  }

  await applyProxyFromState(nextState);
  updateBadge(nextState);

  if (nextState.settings?.autoReloadTabOnRule && tab?.id && !info.linkUrl) {
    try {
      chrome.tabs.reload(tab.id);
    } catch {
      // Ignore if tab cannot be reloaded.
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Per-Tab Live Subresource CDN Auto-Capture                                  */
/* -------------------------------------------------------------------------- */

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const reqHost = safeExtractHost(details.url);
    if (!reqHost) return;

    if (details.type === 'main_frame') {
      tabCapturedHosts.set(details.tabId, {
        pageHost: reqHost,
        pageBase: extractBaseDomain(reqHost),
        hosts: new Set()
      });
      return;
    }

    // Track media, video, image, script, and XHR/fetch CDN domains for the tab
    if (!['media', 'image', 'xmlhttprequest', 'script', 'sub_frame', 'object'].includes(details.type)) {
      return;
    }

    const entry = tabCapturedHosts.get(details.tabId);
    if (!entry) return;

    const reqBase = extractBaseDomain(reqHost);
    if (!reqBase || reqBase === entry.pageBase) return;

    if (entry.hosts.size < MAX_CAPTURED_PER_TAB) {
      entry.hosts.add(reqBase);
    }
  },
  { urls: ['<all_urls>'] }
);

chrome.tabs?.onRemoved.addListener((tabId) => {
  tabCapturedHosts.delete(tabId);
});

/* -------------------------------------------------------------------------- */
/* Keyboard Commands                                                          */
/* -------------------------------------------------------------------------- */

chrome.commands?.onCommand.addListener(async (command) => {
  const state = await getState();
  if (!state.proxies.length) return;

  if (command === 'toggle-proxy') {
    const nextEnabled = !state.enabled;
    const nextActiveId = state.activeProxyId || state.proxies[0].id;
    const next = await updateState((s) => ({
      ...s,
      enabled: nextEnabled,
      activeProxyId: nextActiveId,
      session: {
        ...s.session,
        connectedSince: nextEnabled ? Date.now() : null
      }
    }));
    await applyProxyFromState(next);
    updateBadge(next);
  } else if (command === 'cycle-proxy') {
    const idx = state.proxies.findIndex((p) => p.id === state.activeProxyId);
    const nextProxy = state.proxies[(idx + 1) % state.proxies.length];
    const next = await updateState((s) => ({
      ...s,
      activeProxyId: nextProxy.id,
      enabled: true,
      session: {
        ...s.session,
        connectedSince: s.enabled && s.session?.connectedSince ? s.session.connectedSince : Date.now()
      }
    }));
    await applyProxyFromState(next);
    updateBadge(next);
  }
});

/* -------------------------------------------------------------------------- */
/* Hardened Host-Scoped Proxy Authentication                                  */
/* -------------------------------------------------------------------------- */

chrome.webRequest.onAuthRequired.addListener(
  async (details) => {
    if (!details.isProxy) {
      return {};
    }

    const attempts = (authRetries.get(details.requestId) || 0) + 1;
    authRetries.set(details.requestId, attempts);
    if (attempts > 2) {
      authRetries.delete(details.requestId);
      return { cancel: true };
    }

    const state = await getState();
    if (!state.enabled) {
      return { cancel: true };
    }

    const challengerHost = String(details.challenger?.host || '').toLowerCase();
    const challengerPort = Number(details.challenger?.port || 0);

    // Match credentials strictly to the proxy server issuing the challenge
    let proxy = state.proxies.find(
      (p) =>
        p.host.toLowerCase() === challengerHost &&
        (!challengerPort || Number(p.port) === challengerPort) &&
        p.username
    );

    if (!proxy && state.activeProxyId) {
      const active = state.proxies.find((p) => p.id === state.activeProxyId);
      if (active?.host.toLowerCase() === challengerHost && active.username) {
        proxy = active;
      }
    }

    if (!proxy?.username) {
      return {};
    }

    return {
      authCredentials: {
        username: proxy.username,
        password: proxy.password || ''
      }
    };
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

chrome.webRequest.onCompleted.addListener(
  (details) => authRetries.delete(details.requestId),
  { urls: ['<all_urls>'] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => authRetries.delete(details.requestId),
  { urls: ['<all_urls>'] }
);

/* -------------------------------------------------------------------------- */
/* Runtime Messaging                                                          */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'APPLY_PROXY') {
    applyProxyFromState(message.state)
      .then(async (result) => {
        const state = message.state || (await getState());
        updateBadge(state);
        await rebuildContextMenus(state);
        sendResponse({ ok: true, result });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_STATE') {
    getState().then((state) => sendResponse({ ok: true, state }));
    return true;
  }

  if (message.type === 'TEST_CONNECTION') {
    runDiagnostics()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_TAB_CONTEXT') {
    getActiveTabContext()
      .then((context) => sendResponse({ ok: true, context }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'ADD_SITE_RULE') {
    handleQuickSiteRule(message)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'REMOVE_SITE_RULE') {
    updateState((s) => removeSiteRule(s, message.domain))
      .then(async (state) => {
        await applyProxyFromState(state);
        updateBadge(state);
        sendResponse({ ok: true, state });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'GET_PAC_PREVIEW') {
    getState()
      .then(async (state) => {
        const config = buildProxyConfigFromState(state);
        const control = await getProxyControlStatus();
        sendResponse({ ok: true, config, control });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

async function getActiveTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const hostname = safeExtractHost(url);
  if (!hostname) {
    return { hostname: '', baseDomain: '', capturedDomains: [], bundle: null, routing: null };
  }

  const baseDomain = extractBaseDomain(hostname);
  const captured = tab?.id ? [...(tabCapturedHosts.get(tab.id)?.hosts || [])] : [];
  const bundle = findMatchingBundle(baseDomain);
  const state = await getState();
  const routing = evaluateUrlRouting(url, state);

  return {
    tabId: tab?.id || null,
    url,
    hostname,
    baseDomain,
    capturedDomains: captured,
    bundle: bundle ? { id: bundle.id, name: bundle.name, domains: bundle.domains } : null,
    routing
  };
}

async function handleQuickSiteRule({ domain, action, proxyId = null, capturedDomains = [], tabId = null }) {
  const current = await getState();
  const includeCompanions = current.settings?.autoIncludeCompanions !== false;
  const next = await updateState((s) =>
    upsertSiteRule(s, {
      domain,
      action,
      proxyId,
      capturedDomains,
      includeCompanions
    })
  );
  await applyProxyFromState(next);
  updateBadge(next);

  if (next.settings?.autoReloadTabOnRule && tabId) {
    try {
      chrome.tabs.reload(tabId);
    } catch {
      // Ignore reload failures.
    }
  }
  return next;
}

async function runDiagnostics() {
  const control = await getProxyControlStatus();
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
      // Fall back to lightweight generate_204 reachability check
      const probe = await fetch('https://www.google.com/generate_204', {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store'
      });
      status = probe.status;
    }

    const latencyMs = Math.max(1, Math.round(performance.now() - started));
    const success = status === 200 || status === 204;

    if (success) {
      await updateState((s) => ({
        ...s,
        session: {
          ...s.session,
          lastLatencyMs: latencyMs,
          lastExitIp: exitIp || s.session?.lastExitIp || null
        }
      }));
    }

    return {
      success,
      status,
      latencyMs,
      exitIp,
      control
    };
  } finally {
    clearTimeout(timeout);
  }
}
