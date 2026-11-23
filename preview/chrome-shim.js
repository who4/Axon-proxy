/**
 * Browser preview shim for Chrome Extension Manifest V3 APIs.
 * Injected only over HTTP by the local preview server; all extension code remains 100% Chrome MV3 native.
 */
(function installChromePreviewShim() {
  if (typeof window === 'undefined') return;
  if (window.chrome && window.chrome.runtime && window.chrome.runtime.id) {
    return;
  }

  const STORAGE_PREFIX = 'proxyManagerPreview:storage:';
  const SESSION_PREFIX = 'proxyManagerPreview:session:';
  const PROXY_CONFIG_KEY = 'proxyManagerPreview:proxyConfig';
  const WEBRTC_KEY = 'proxyManagerPreview:webrtcPolicy';
  const SIM_TAB_URL_KEY = 'axonPreview:activeTabUrl';

  const DEFAULT_SIM_TAB_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  // Realistic simulated subresource CDN domains captured for preview tabs
  const SIM_TAB_CAPTURED_CDNS = {
    'youtube.com': ['googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtubei.googleapis.com'],
    'x.com': ['twimg.com', 't.co'],
    'discord.com': ['discordapp.net', 'discord.media', 'discordcdn.com'],
    'github.com': ['githubusercontent.com', 'githubassets.com'],
    'example.com': ['cdn.example-assets.net']
  };

  const storageListeners = new Set();
  const badgeState = {
    text: '',
    color: '#24D858',
    title: 'Axon Proxy — Unprotected (Direct)'
  };

  function postToWrapper(payload) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*');
      }
    } catch {
      // Ignore cross-origin errors.
    }
  }

  function readPrefixed(prefix, key, store = window.localStorage) {
    try {
      const raw = store.getItem(`${prefix}${key}`);
      return raw === null ? undefined : JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  function writePrefixed(prefix, key, value, store = window.localStorage) {
    store.setItem(`${prefix}${key}`, JSON.stringify(value));
  }

  function makeStorageArea(prefix, areaName, backingStore) {
    return {
      async get(keys, callback) {
        const result = {};
        if (keys == null) {
          for (let i = 0; i < backingStore.length; i += 1) {
            const k = backingStore.key(i);
            if (k && k.startsWith(prefix)) {
              const shortKey = k.slice(prefix.length);
              result[shortKey] = readPrefixed(prefix, shortKey, backingStore);
            }
          }
        } else if (typeof keys === 'string') {
          const val = readPrefixed(prefix, keys, backingStore);
          if (val !== undefined) result[keys] = val;
        } else if (Array.isArray(keys)) {
          for (const key of keys) {
            const val = readPrefixed(prefix, key, backingStore);
            if (val !== undefined) result[key] = val;
          }
        } else if (typeof keys === 'object') {
          for (const [key, fallback] of Object.entries(keys)) {
            const val = readPrefixed(prefix, key, backingStore);
            result[key] = val !== undefined ? val : fallback;
          }
        }
        if (typeof callback === 'function') callback(result);
        return result;
      },

      async set(items, callback) {
        const changes = {};
        for (const [key, newValue] of Object.entries(items || {})) {
          const oldValue = readPrefixed(prefix, key, backingStore);
          writePrefixed(prefix, key, newValue, backingStore);
          changes[key] = { oldValue, newValue };
        }
        for (const listener of storageListeners) {
          try {
            listener(changes, areaName);
          } catch {
            // Ignore listener errors.
          }
        }
        if (areaName === 'local' && changes.proxyManagerState) {
          syncBadgeFromState(changes.proxyManagerState.newValue);
          postToWrapper({ type: 'PREVIEW_STATE_SYNC' });
        }
        if (typeof callback === 'function') callback();
      },

      async remove(keys, callback) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) {
          backingStore.removeItem(`${prefix}${key}`);
        }
        if (typeof callback === 'function') callback();
      }
    };
  }

  function notifyBadgeUpdate() {
    postToWrapper({
      type: 'PREVIEW_BADGE_UPDATE',
      badge: { ...badgeState }
    });
  }

  function syncBadgeFromState(state) {
    const active = Boolean(state && state.enabled && state.activeProxyId);
    const proxy = active && Array.isArray(state.proxies)
      ? state.proxies.find((p) => p.id === state.activeProxyId)
      : null;

    if (active && proxy) {
      badgeState.text = (proxy.badgeText || 'ON').slice(0, 4).toUpperCase();
      badgeState.color = proxy.color || '#24D858';
      badgeState.title = `Axon Proxy — Protected via ${proxy.name} (${String(proxy.type || 'http').toUpperCase()})`;
    } else {
      badgeState.text = '';
      badgeState.color = '#64748b';
      badgeState.title = 'Axon Proxy — Unprotected (Direct)';
    }
    notifyBadgeUpdate();
  }

  function loadProxyConfig() {
    try {
      const raw = window.localStorage.getItem(PROXY_CONFIG_KEY);
      return raw ? JSON.parse(raw) : { mode: 'direct' };
    } catch {
      return { mode: 'direct' };
    }
  }

  function saveProxyConfig(config) {
    try {
      window.localStorage.setItem(PROXY_CONFIG_KEY, JSON.stringify(config));
    } catch {
      // Ignore quota errors.
    }
  }

  function getSimulatedTabUrl() {
    return window.localStorage.getItem(SIM_TAB_URL_KEY) || DEFAULT_SIM_TAB_URL;
  }

  const chromeShim = {
    storage: {
      local: makeStorageArea(STORAGE_PREFIX, 'local', window.localStorage),
      session: makeStorageArea(SESSION_PREFIX, 'session', window.sessionStorage),
      onChanged: {
        addListener(fn) {
          if (typeof fn === 'function') storageListeners.add(fn);
        },
        removeListener(fn) {
          storageListeners.delete(fn);
        }
      }
    },

    proxy: {
      settings: {
        async set(details, callback) {
          if (details && details.value) {
            saveProxyConfig(details.value);
          }
          if (typeof callback === 'function') callback();
        },
        get(_details, callback) {
          const payload = {
            value: loadProxyConfig(),
            levelOfControl: 'controlled_by_this_extension'
          };
          if (typeof callback === 'function') {
            callback(payload);
            return;
          }
          return Promise.resolve(payload);
        }
      }
    },

    privacy: {
      network: {
        webRTCIPHandlingPolicy: {
          async set({ value }) {
            window.localStorage.setItem(WEBRTC_KEY, value || 'default');
          },
          async clear() {
            window.localStorage.removeItem(WEBRTC_KEY);
          },
          async get() {
            return { value: window.localStorage.getItem(WEBRTC_KEY) || 'default' };
          }
        }
      }
    },

    tabs: {
      async query() {
        return [{ id: 1, url: getSimulatedTabUrl(), active: true }];
      },
      reload() {
        postToWrapper({ type: 'PREVIEW_TAB_RELOADED', url: getSimulatedTabUrl() });
      }
    },

    action: {
      setBadgeText({ text } = {}) {
        badgeState.text = text || '';
        notifyBadgeUpdate();
      },
      setBadgeBackgroundColor({ color } = {}) {
        if (color) badgeState.color = color;
        notifyBadgeUpdate();
      },
      setTitle({ title } = {}) {
        if (title) badgeState.title = title;
        notifyBadgeUpdate();
      }
    },

    runtime: {
      openOptionsPage() {
        if (window.parent && window.parent !== window) {
          postToWrapper({ type: 'PREVIEW_OPEN_OPTIONS' });
        } else {
          window.location.href = '/options/options.html';
        }
      },

      async sendMessage(message) {
        if (!message || typeof message !== 'object') {
          return { ok: false, error: 'Invalid message' };
        }

        if (message.type === 'APPLY_PROXY') {
          try {
            const { applyProxyFromState } = await import('/lib/proxy-engine.js');
            const result = await applyProxyFromState(message.state);
            syncBadgeFromState(message.state);
            return { ok: true, result };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        if (message.type === 'GET_STATE') {
          try {
            const { getState } = await import('/lib/storage.js');
            const state = await getState();
            return { ok: true, state };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        if (message.type === 'GET_TAB_CONTEXT') {
          try {
            const [{ extractBaseDomain, findMatchingBundle }, { evaluateUrlRouting }, { getState }] =
              await Promise.all([
                import('/lib/site-bundles.js'),
                import('/lib/pac-builder.js'),
                import('/lib/storage.js')
              ]);
            const url = getSimulatedTabUrl();
            const hostname = new URL(url).hostname.toLowerCase();
            const baseDomain = extractBaseDomain(hostname);
            const bundle = findMatchingBundle(baseDomain);
            const state = await getState();
            const routing = evaluateUrlRouting(url, state);
            return {
              ok: true,
              context: {
                tabId: 1,
                url,
                hostname,
                baseDomain,
                capturedDomains: SIM_TAB_CAPTURED_CDNS[baseDomain] || [],
                bundle: bundle ? { id: bundle.id, name: bundle.name, domains: bundle.domains } : null,
                routing
              }
            };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        if (message.type === 'ADD_SITE_RULE') {
          try {
            const [{ applyProxyFromState, upsertSiteRule }, { getState, updateState }] = await Promise.all([
              import('/lib/proxy-engine.js'),
              import('/lib/storage.js')
            ]);
            const current = await getState();
            const includeCompanions = current.settings?.autoIncludeCompanions !== false;
            const next = await updateState((s) =>
              upsertSiteRule(s, {
                domain: message.domain,
                action: message.action,
                proxyId: message.proxyId || null,
                capturedDomains: message.capturedDomains || [],
                includeCompanions
              })
            );
            await applyProxyFromState(next);
            syncBadgeFromState(next);
            return { ok: true, state: next };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        if (message.type === 'REMOVE_SITE_RULE') {
          try {
            const [{ applyProxyFromState, removeSiteRule }, { updateState }] = await Promise.all([
              import('/lib/proxy-engine.js'),
              import('/lib/storage.js')
            ]);
            const next = await updateState((s) => removeSiteRule(s, message.domain));
            await applyProxyFromState(next);
            syncBadgeFromState(next);
            return { ok: true, state: next };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        if (message.type === 'TEST_CONNECTION') {
          try {
            const [diagRes, { getProxyControlStatus }, { updateState }] = await Promise.all([
              fetch('/api/diagnostics', { cache: 'no-store' }).then((r) => r.json()),
              import('/lib/proxy-engine.js'),
              import('/lib/storage.js')
            ]);
            const control = await getProxyControlStatus();
            if (diagRes?.ok && diagRes.result?.success) {
              await updateState((s) => ({
                ...s,
                session: {
                  ...s.session,
                  lastLatencyMs: diagRes.result.latencyMs,
                  lastExitIp: diagRes.result.exitIp || s.session?.lastExitIp || null
                }
              }));
              return { ok: true, result: { ...diagRes.result, control } };
            }
            return { ok: false, error: diagRes?.error || 'Connection failed' };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        return { ok: false, error: `Unsupported message type: ${message.type}` };
      }
    }
  };

  window.chrome = chromeShim;

  // Listen for parent wrapper notifications (simulated tab change or right-click rule)
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'PREVIEW_EXTERNAL_STATE_CHANGED') {
      const fresh = readPrefixed(STORAGE_PREFIX, 'proxyManagerState');
      for (const listener of storageListeners) {
        try {
          listener({ proxyManagerState: { newValue: fresh } }, 'local');
        } catch {
          // Ignore listener errors.
        }
      }
      syncBadgeFromState(fresh);
    }
  });

  const initialState = readPrefixed(STORAGE_PREFIX, 'proxyManagerState');
  syncBadgeFromState(initialState);
})();
