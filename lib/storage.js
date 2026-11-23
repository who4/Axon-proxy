import {
  DEFAULT_SESSION,
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  PROXY_COLORS,
  SESSION_AUTH_KEY,
  STORAGE_KEY
} from './constants.js';
import { extractBaseDomain, findMatchingBundle } from './site-bundles.js';

export function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getSessionCredentials() {
  try {
    if (chrome?.storage?.session?.get) {
      const res = await chrome.storage.session.get(SESSION_AUTH_KEY);
      return res?.[SESSION_AUTH_KEY] || {};
    }
  } catch {
    // Ignore if chrome.storage.session is unavailable.
  }
  return {};
}

async function setSessionCredentials(map) {
  try {
    if (chrome?.storage?.session?.set) {
      await chrome.storage.session.set({ [SESSION_AUTH_KEY]: map });
    }
  } catch {
    // Ignore if chrome.storage.session is unavailable.
  }
}

export async function getState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result?.[STORAGE_KEY];
  if (!stored) {
    return structuredClone(DEFAULT_STATE);
  }
  const merged = mergeWithDefaults(stored);

  if (merged.settings.sessionOnlyAuth) {
    const creds = await getSessionCredentials();
    merged.proxies = merged.proxies.map((p) => ({
      ...p,
      username: creds[p.id]?.username ?? p.username ?? '',
      password: creds[p.id]?.password ?? p.password ?? ''
    }));
  }

  return merged;
}

export async function setState(state) {
  const normalized = mergeWithDefaults(state);
  let toPersist = normalized;

  if (normalized.settings.sessionOnlyAuth) {
    const creds = {};
    toPersist = {
      ...normalized,
      proxies: normalized.proxies.map((p) => {
        if (p.username || p.password) {
          creds[p.id] = { username: p.username || '', password: p.password || '' };
        }
        return { ...p, username: '', password: '' };
      })
    };
    await setSessionCredentials(creds);
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: toPersist });
  return normalized;
}

export async function updateState(mutator) {
  const state = await getState();
  const next = typeof mutator === 'function' ? mutator(state) : { ...state, ...mutator };
  return setState(next);
}

function normalizeProxy(p, index) {
  const fallbackBadge = (p.name || p.host || 'PR')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 2)
    .toUpperCase() || 'PR';

  return {
    id: p.id || createId(),
    name: String(p.name || 'Proxy').trim(),
    host: String(p.host || '').trim(),
    port: Number(p.port) || 8080,
    type: ['http', 'https', 'socks5'].includes(p.type) ? p.type : 'http',
    username: p.username || '',
    password: p.password || '',
    badgeText: String(p.badgeText || fallbackBadge).slice(0, 4).toUpperCase(),
    color: p.color || PROXY_COLORS[index % PROXY_COLORS.length],
    fallbackProxyId: p.fallbackProxyId || null
  };
}

function normalizeRule(r) {
  return {
    id: r.id || createId(),
    pattern: String(r.pattern || '').trim(),
    matchType: ['domain', 'wildcard', 'regex', 'cidr'].includes(r.matchType) ? r.matchType : 'domain',
    action: r.action === 'direct' ? 'direct' : 'proxy',
    proxyId: r.proxyId || null,
    includeCompanions: r.includeCompanions !== false,
    capturedDomains: Array.isArray(r.capturedDomains) ? [...new Set(r.capturedDomains.filter(Boolean))] : [],
    enabled: r.enabled !== false
  };
}

function mergeWithDefaults(stored) {
  const proxies = Array.isArray(stored.proxies) ? stored.proxies.map(normalizeProxy) : [];
  const rules = Array.isArray(stored.splitTunnel?.rules)
    ? stored.splitTunnel.rules.map(normalizeRule).filter((r) => r.pattern)
    : [];

  return {
    ...structuredClone(DEFAULT_STATE),
    ...stored,
    version: 2,
    proxies,
    splitTunnel: {
      ...DEFAULT_STATE.splitTunnel,
      ...(stored.splitTunnel || {}),
      rules
    },
    settings: {
      ...DEFAULT_SETTINGS,
      ...(stored.settings || {})
    },
    session: {
      ...DEFAULT_SESSION,
      ...(stored.session || {})
    }
  };
}

export function exportStateJson(state, { includeCredentials = false } = {}) {
  const copy = mergeWithDefaults(state);
  const payload = {
    app: 'Axon Proxy',
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    data: {
      proxies: copy.proxies.map((p) => ({
        ...p,
        username: includeCredentials ? p.username : '',
        password: includeCredentials ? p.password : ''
      })),
      activeProxyId: copy.activeProxyId,
      splitTunnel: copy.splitTunnel,
      settings: copy.settings
    }
  };
  return JSON.stringify(payload, null, 2);
}

export function importStateJson(rawText, currentState, { mode = 'merge' } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('Invalid JSON file');
  }

  const incoming = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  if (!incoming || (!Array.isArray(incoming.proxies) && !Array.isArray(incoming.splitTunnel?.rules))) {
    throw new Error('JSON does not contain valid Axon Proxy configuration');
  }

  const normalizedIncoming = mergeWithDefaults(incoming);

  if (mode === 'replace') {
    return {
      ...normalizedIncoming,
      enabled: currentState.enabled && Boolean(normalizedIncoming.activeProxyId),
      session: currentState.session
    };
  }

  // Merge mode: deduplicate proxies by host:port:type and rules by pattern+matchType
  const existingProxies = [...currentState.proxies];
  for (const p of normalizedIncoming.proxies) {
    const dup = existingProxies.some(
      (ep) => ep.host === p.host && ep.port === p.port && ep.type === p.type
    );
    if (!dup) existingProxies.push({ ...p, id: createId() });
  }

  const existingRules = [...(currentState.splitTunnel?.rules || [])];
  for (const r of normalizedIncoming.splitTunnel.rules) {
    const dup = existingRules.some(
      (er) => er.pattern.toLowerCase() === r.pattern.toLowerCase() && er.matchType === r.matchType
    );
    if (!dup) existingRules.push({ ...r, id: createId() });
  }

  return mergeWithDefaults({
    ...currentState,
    proxies: existingProxies,
    activeProxyId: currentState.activeProxyId || existingProxies[0]?.id || null,
    splitTunnel: {
      ...currentState.splitTunnel,
      enabled: currentState.splitTunnel.enabled || normalizedIncoming.splitTunnel.enabled,
      rules: existingRules
    }
  });
}

export function parseDomainListImport(text, { action = 'proxy', proxyId = null, includeCompanions = true } = {}) {
  const lines = String(text || '')
    .split(/[\r\n,;]+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//') && !line.startsWith('!'));

  const seen = new Set();
  const rules = [];

  for (const raw of lines) {
    const cleaned = raw.replace(/^\|\|/, '').replace(/\^.*$/, '').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const isWildcard = cleaned.includes('*');
    const base = extractBaseDomain(cleaned);
    const hasBundle = Boolean(findMatchingBundle(base));

    rules.push({
      id: createId(),
      pattern: cleaned,
      matchType: isWildcard ? 'wildcard' : 'domain',
      action,
      proxyId,
      includeCompanions: includeCompanions || hasBundle,
      capturedDomains: [],
      enabled: true
    });
  }

  return rules;
}
