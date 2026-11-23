import { buildProxyConfigFromState, cidrToMask } from './pac-builder.js';
import { extractBaseDomain, findMatchingBundle } from './site-bundles.js';
import { createId, getState } from './storage.js';

const PROXY_SCOPE = { scope: 'regular' };

export async function applyWebRtcPolicy(state) {
  try {
    const webrtcApi = chrome?.privacy?.network?.webRTCIPHandlingPolicy;
    if (!webrtcApi) return { supported: false };

    const shouldProtect = Boolean(state.enabled && state.activeProxyId && state.settings?.webrtcProtection);
    if (shouldProtect) {
      await webrtcApi.set({ value: 'disable_non_proxied_udp', scope: 'regular' });
      return { supported: true, policy: 'disable_non_proxied_udp' };
    }
    await webrtcApi.clear({ scope: 'regular' });
    return { supported: true, policy: 'default' };
  } catch {
    return { supported: false };
  }
}

export async function getProxyControlStatus() {
  return new Promise((resolve) => {
    try {
      chrome.proxy.settings.get(PROXY_SCOPE, (details) => {
        resolve({
          mode: details?.value?.mode || 'direct',
          levelOfControl: details?.levelOfControl || 'controllable_by_this_extension',
          conflict:
            details?.levelOfControl === 'controlled_by_other_extensions' ||
            details?.levelOfControl === 'not_controllable'
        });
      });
    } catch {
      resolve({ mode: 'unknown', levelOfControl: 'unknown', conflict: false });
    }
  });
}

export async function applyProxyFromState(state = null) {
  const data = state || (await getState());

  if (!data.enabled || !data.activeProxyId) {
    await clearProxy();
    await applyWebRtcPolicy(data);
    const control = await getProxyControlStatus();
    return { mode: 'direct', config: { mode: 'direct' }, control };
  }

  const proxy = data.proxies.find((p) => p.id === data.activeProxyId);
  if (!proxy) {
    await clearProxy();
    await applyWebRtcPolicy(data);
    const control = await getProxyControlStatus();
    return { mode: 'direct', config: { mode: 'direct' }, control, error: 'Active proxy not found' };
  }

  const config = buildProxyConfigFromState(data);

  await chrome.proxy.settings.set({
    value: config,
    ...PROXY_SCOPE
  });

  await applyWebRtcPolicy(data);
  const control = await getProxyControlStatus();

  return { mode: config.mode, config, proxy, control };
}

export async function clearProxy() {
  await chrome.proxy.settings.set({
    value: { mode: 'direct' },
    ...PROXY_SCOPE
  });
}

export async function getChromeProxyMode() {
  const status = await getProxyControlStatus();
  return status.mode;
}

/**
 * Parse pasted proxy strings:
 * - socks5://user:pass@1.2.3.4:1080
 * - http://host:port
 * - https://user:pass@proxy.corp.net:443
 * - 1.2.3.4:1080:user:pass
 * - 1.2.3.4:1080
 */
export function parseProxyUri(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // Scheme URI format
  if (/^(https?|socks5h?|socks4):\/\//i.test(text)) {
    try {
      const normalized = text.replace(/^socks5h:\/\//i, 'socks5://');
      const url = new URL(normalized);
      const scheme = url.protocol.replace(':', '').toLowerCase();
      const type = scheme === 'socks5' || scheme === 'socks4' ? 'socks5' : scheme === 'https' ? 'https' : 'http';
      const port = Number(url.port) || (type === 'socks5' ? 1080 : type === 'https' ? 443 : 8080);
      return {
        type,
        host: url.hostname,
        port,
        username: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || '')
      };
    } catch {
      return null;
    }
  }

  // host:port:user:pass or host:port
  const parts = text.split(':');
  if (parts.length === 2 || parts.length === 4) {
    const port = Number(parts[1]);
    if (parts[0] && Number.isInteger(port) && port >= 1 && port <= 65535) {
      return {
        type: port === 1080 || port === 10808 ? 'socks5' : port === 443 ? 'https' : 'http',
        host: parts[0].trim(),
        port,
        username: parts[2] || '',
        password: parts[3] || ''
      };
    }
  }

  return null;
}

export function validateProxyInput({ name, host, port, type }) {
  const errors = [];
  if (!name?.trim()) errors.push('Name is required');
  if (!host?.trim()) errors.push('Host is required');
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    errors.push('Port must be between 1 and 65535');
  }
  if (!['http', 'https', 'socks5'].includes(type)) {
    errors.push('Type must be HTTP, HTTPS, or SOCKS5');
  }
  return errors;
}

export function validateRuleInput({ pattern, matchType = 'domain' }) {
  const errors = [];
  const trimmed = String(pattern || '').trim();
  if (!trimmed) {
    errors.push('Pattern is required');
    return errors;
  }

  if (matchType === 'regex') {
    try {
      new RegExp(trimmed, 'i');
    } catch (err) {
      errors.push(`Invalid RegExp: ${err.message}`);
    }
  }

  if (matchType === 'cidr') {
    const tokens = trimmed.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!tokens.length || tokens.some((t) => !cidrToMask(t))) {
      errors.push('Use valid IPv4 CIDR notation (e.g. 10.20.0.0/16)');
    }
  }

  return errors;
}

/**
 * Add or update a split-tunnel rule for a site (used by right-click menu & 1-click active tab actions).
 */
export function upsertSiteRule(
  state,
  { domain, action = 'proxy', proxyId = null, capturedDomains = [], includeCompanions = true }
) {
  const base = extractBaseDomain(domain);
  if (!base) return state;

  const pattern = `*.${base}`;
  const rules = [...(state.splitTunnel?.rules || [])];
  const bundle = findMatchingBundle(base);
  const cleanCaptured = [...new Set((capturedDomains || []).map(extractBaseDomain).filter((d) => d && d !== base))];

  const existingIdx = rules.findIndex((r) => {
    const existingBase = extractBaseDomain(r.pattern);
    return existingBase === base && (r.matchType === 'domain' || r.matchType === 'wildcard');
  });

  if (existingIdx >= 0) {
    const prev = rules[existingIdx];
    const mergedCaptured = [...new Set([...(prev.capturedDomains || []), ...cleanCaptured])];
    rules[existingIdx] = {
      ...prev,
      action,
      proxyId: action === 'direct' ? null : proxyId,
      includeCompanions: includeCompanions || Boolean(bundle),
      capturedDomains: mergedCaptured,
      enabled: true
    };
  } else {
    rules.unshift({
      id: createId(),
      pattern,
      matchType: 'wildcard',
      action,
      proxyId: action === 'direct' ? null : proxyId,
      includeCompanions: includeCompanions || Boolean(bundle),
      capturedDomains: cleanCaptured,
      enabled: true
    });
  }

  return {
    ...state,
    splitTunnel: {
      ...state.splitTunnel,
      enabled: true,
      rules
    }
  };
}

export function removeSiteRule(state, domain) {
  const base = extractBaseDomain(domain);
  if (!base) return state;

  const rules = (state.splitTunnel?.rules || []).filter((r) => {
    const existingBase = extractBaseDomain(r.pattern);
    return existingBase !== base;
  });

  return {
    ...state,
    splitTunnel: {
      ...state.splitTunnel,
      rules
    }
  };
}
