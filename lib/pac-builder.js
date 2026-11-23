/**
 * Axon Proxy PAC & Chrome Proxy Configuration Compiler.
 *
 * Key upgrades over v1:
 * 1. Emits `SOCKS5 host:port` in PAC mode so DNS resolves remotely (eliminating DNS leaks & ISP blocking).
 * 2. Strict top-to-bottom rule priority (never silently reorders direct over proxy).
 * 3. Expands Smart Site Bundles + auto-captured tab CDN domains so multi-domain sites like YouTube
 *    route video streams (*.googlevideo.com) and thumbnails (*.ytimg.com, *.ggpht.com) reliably.
 * 4. Multi-proxy per-rule targets, failover backup chains, RegExp, IP/CIDR, and HTTPS upstream proxies.
 * 5. Exact live URL routing simulator (`evaluateUrlRouting`) sharing the same matching semantics.
 */

import { expandRuleDomains, normalizeDomainPattern } from './site-bundles.js';

export function normalizePattern(raw) {
  return normalizeDomainPattern(raw);
}

function escapePacString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

function isDomainName(p) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(p);
}

export function cidrToMask(cidr) {
  const match = String(cidr || '').trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!match) return null;
  const ip = match[1];
  const prefix = Number(match[2]);
  if (prefix < 0 || prefix > 32) return null;
  const octets = ip.split('.').map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return null;

  const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const mask = [
    (maskInt >>> 24) & 255,
    (maskInt >>> 16) & 255,
    (maskInt >>> 8) & 255,
    maskInt & 255
  ].join('.');
  return { ip, mask, prefix };
}

function ipToInt(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

export function pacProxyDirective(proxy) {
  const host = escapePacString(proxy.host);
  const port = Number(proxy.port);
  if (proxy.type === 'socks5') {
    return `SOCKS5 ${host}:${port}`;
  }
  if (proxy.type === 'https') {
    return `HTTPS ${host}:${port}`;
  }
  return `PROXY ${host}:${port}`;
}

/** Build failover chain directive: e.g. "SOCKS5 a:1080; PROXY b:8080; DIRECT" */
export function buildProxyChainDirective(proxy, allProxies = []) {
  if (!proxy) return 'DIRECT';
  const chain = [];
  const visited = new Set();
  let current = proxy;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    chain.push(pacProxyDirective(current));
    if (current.fallbackProxyId) {
      current = allProxies.find((p) => p.id === current.fallbackProxyId) || null;
    } else {
      current = null;
    }
  }

  return chain.join('; ');
}

export function patternToBypassEntries(pattern) {
  const p = normalizePattern(pattern);
  if (!p) return [];

  const entries = [];

  if (p.includes('*')) {
    entries.push(p);
    if (p.startsWith('*.')) {
      const domain = p.slice(2);
      entries.push(domain);
      entries.push('.' + domain);
    }
    return entries;
  }

  if (p.startsWith('.')) {
    entries.push(p);
    entries.push(p.slice(1));
    return entries;
  }

  if (isDomainName(p)) {
    entries.push(p);
    entries.push('.' + p);
    return entries;
  }

  entries.push(p);
  return entries;
}

export function buildChromeBypassList(rules, bypassLocalNetworks = true) {
  const entries = new Set(bypassLocalNetworks ? ['<local>', 'localhost', '127.0.0.1'] : []);

  for (const rule of rules) {
    if (rule.enabled === false || rule.action !== 'direct') continue;
    const expanded = expandRuleDomains(rule);
    for (const token of expanded.all) {
      for (const entry of patternToBypassEntries(token)) {
        entries.add(entry);
      }
    }
  }

  return [...entries];
}

function buildDomainCondition(pattern) {
  const p = normalizePattern(pattern);
  if (!p) return null;

  const escaped = escapePacString(p);
  const checks = [];

  if (p.includes('*')) {
    checks.push(`shExpMatch(h, "${escaped}")`);
    if (p.startsWith('*.')) {
      const domain = escapePacString(p.slice(2));
      checks.push(`h === "${domain}"`);
      checks.push(`dnsDomainIs(h, ".${domain}")`);
    }
  } else if (p.startsWith('.')) {
    const domain = escapePacString(p.slice(1));
    checks.push(`h === "${domain}"`);
    checks.push(`dnsDomainIs(h, ".${domain}")`);
  } else if (isDomainName(p)) {
    checks.push(`h === "${escaped}"`);
    checks.push(`dnsDomainIs(h, ".${escaped}")`);
  } else {
    checks.push(`h === "${escaped}"`);
    checks.push(`shExpMatch(h, "${escaped}")`);
  }

  return '(' + checks.join(' || ') + ')';
}

function buildRuleCondition(rule) {
  const matchType = rule.matchType || 'domain';

  if (matchType === 'regex') {
    const raw = String(rule.pattern || '').trim();
    if (!raw) return null;
    try {
      new RegExp(raw, 'i');
      const escaped = escapePacString(raw);
      return `(new RegExp("${escaped}", "i").test(url) || new RegExp("${escaped}", "i").test(h))`;
    } catch {
      return null;
    }
  }

  if (matchType === 'cidr') {
    const tokens = String(rule.pattern || '')
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const checks = tokens
      .map(cidrToMask)
      .filter(Boolean)
      .map(({ ip, mask }) => `isInNet(h, "${ip}", "${mask}")`);
    return checks.length ? `(${checks.join(' || ')})` : null;
  }

  const expanded = expandRuleDomains(rule);
  const conditions = expanded.all.map(buildDomainCondition).filter(Boolean);
  return conditions.length ? conditions.join(' || ') : null;
}

export function buildPacScript(state) {
  const proxies = state.proxies || [];
  const activeProxy = proxies.find((p) => p.id === state.activeProxyId) || null;
  const splitTunnel = state.splitTunnel || { enabled: false, defaultPolicy: 'proxy', rules: [] };
  const bypassLocal = state.settings?.bypassLocalNetworks !== false;

  const activeDirective = buildProxyChainDirective(activeProxy, proxies);
  const defaultReturn = splitTunnel.defaultPolicy === 'direct' ? 'DIRECT' : activeDirective;

  const enabledRules = (splitTunnel.rules || []).filter((r) => r.enabled !== false);

  // Strict top-to-bottom evaluation — user order is respected!
  const ruleBlocks = enabledRules
    .map((rule) => {
      const condition = buildRuleCondition(rule);
      if (!condition) return '';

      let targetDirective = 'DIRECT';
      if (rule.action !== 'direct') {
        const specificProxy = rule.proxyId
          ? proxies.find((p) => p.id === rule.proxyId)
          : activeProxy;
        targetDirective = buildProxyChainDirective(specificProxy || activeProxy, proxies);
      }

      const comment = escapePacString(rule.pattern);
      return `  // Rule: ${comment}\n  if (${condition}) {\n    return "${targetDirective}";\n  }`;
    })
    .filter(Boolean)
    .join('\n');

  const localBypassBlock = bypassLocal
    ? `  if (isPlainHostName(h) ||
      h === "localhost" ||
      shExpMatch(h, "127.*") ||
      shExpMatch(h, "10.*") ||
      shExpMatch(h, "192.168.*") ||
      isInNet(h, "172.16.0.0", "255.240.0.0") ||
      shExpMatch(h, "*.local") ||
      shExpMatch(h, "*.localhost")) {
    return "DIRECT";
  }\n`
    : '';

  return `function FindProxyForURL(url, host) {
  var h = String(host || "").toLowerCase();
${localBypassBlock}${ruleBlocks ? ruleBlocks + '\n' : ''}  return "${defaultReturn}";
}`;
}

export function buildFixedServersConfig(proxy, bypassList = null, bypassLocalNetworks = true) {
  const scheme = proxy.type === 'socks5' ? 'socks5' : proxy.type === 'https' ? 'https' : 'http';
  const defaultBypass = bypassLocalNetworks ? ['<local>', '127.0.0.1', 'localhost'] : [];
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme,
        host: proxy.host,
        port: Number(proxy.port)
      },
      bypassList: bypassList || defaultBypass
    }
  };
}

/**
 * Pick the optimal Chrome proxy config mode for the full Axon Proxy state.
 */
export function buildProxyConfigFromState(state) {
  const proxies = state.proxies || [];
  const activeProxy = proxies.find((p) => p.id === state.activeProxyId);
  if (!activeProxy) {
    return { mode: 'direct' };
  }

  const bypassLocal = state.settings?.bypassLocalNetworks !== false;
  const splitTunnel = state.splitTunnel || { enabled: false, defaultPolicy: 'proxy', rules: [] };
  const hasFallback = Boolean(activeProxy.fallbackProxyId && proxies.some((p) => p.id === activeProxy.fallbackProxyId));
  const enabledRules = (splitTunnel.rules || []).filter((r) => r.enabled !== false);

  // If no split tunneling and no failover chain, native fixed_servers is ultra-fast
  if (!splitTunnel.enabled || enabledRules.length === 0) {
    if (!hasFallback && activeProxy.type !== 'https') {
      return buildFixedServersConfig(activeProxy, null, bypassLocal);
    }
    return {
      mode: 'pac_script',
      pacScript: {
        data: buildPacScript({
          ...state,
          splitTunnel: { enabled: false, defaultPolicy: 'proxy', rules: [] }
        }),
        mandatory: false
      }
    };
  }

  const hasProxyRules = enabledRules.some((r) => r.action === 'proxy');
  const hasDirectRules = enabledRules.some((r) => r.action === 'direct');
  const hasAdvancedMatchers = enabledRules.some((r) => r.matchType === 'regex' || r.matchType === 'cidr');
  const defaultViaProxy = splitTunnel.defaultPolicy !== 'direct';

  // Fast-path native bypassList ONLY when single proxy, default via proxy, and pure domain/wildcard bypass rules
  if (
    defaultViaProxy &&
    hasDirectRules &&
    !hasProxyRules &&
    !hasAdvancedMatchers &&
    !hasFallback &&
    activeProxy.type !== 'https'
  ) {
    return buildFixedServersConfig(
      activeProxy,
      buildChromeBypassList(enabledRules, bypassLocal),
      bypassLocal
    );
  }

  return {
    mode: 'pac_script',
    pacScript: {
      data: buildPacScript(state),
      mandatory: false
    }
  };
}

function shellMatch(str, glob) {
  const re = new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
    'i'
  );
  return re.test(str);
}

export function hostMatchesPattern(host, pattern, matchType = 'domain', fullUrl = '') {
  const h = String(host || '').toLowerCase();

  if (matchType === 'regex') {
    try {
      const re = new RegExp(pattern, 'i');
      return re.test(fullUrl || h) || re.test(h);
    } catch {
      return false;
    }
  }

  if (matchType === 'cidr') {
    const parsed = cidrToMask(pattern);
    const hostInt = ipToInt(h);
    if (!parsed || hostInt === null) return false;
    const netInt = ipToInt(parsed.ip);
    const maskInt = ipToInt(parsed.mask);
    return (hostInt & maskInt) === (netInt & maskInt);
  }

  const p = normalizePattern(pattern);
  if (!p) return false;
  if (p === '*') return true;

  if (p.includes('*')) {
    if (shellMatch(h, p)) return true;
    if (p.startsWith('*.')) {
      const dom = p.slice(2);
      return h === dom || h.endsWith('.' + dom);
    }
    return false;
  }

  if (p.startsWith('.')) {
    const suffix = p.slice(1);
    return h === suffix || h.endsWith('.' + suffix);
  }

  if (isDomainName(p)) {
    return h === p || h.endsWith('.' + p);
  }

  return h === p;
}

function isLocalHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h.includes('.')) return true;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h.startsWith('127.') || h.startsWith('10.') || h.startsWith('192.168.')) return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Evaluate any URL or hostname against the current Axon Proxy state with exact PAC parity.
 */
export function evaluateUrlRouting(urlOrHost, state) {
  const raw = String(urlOrHost || '').trim();
  const fullUrl = raw.includes('://') ? raw : `https://${raw}`;
  const host = normalizePattern(raw);

  if (!host) {
    return { error: 'Enter a valid domain or URL' };
  }

  const proxies = state.proxies || [];
  const activeProxy = proxies.find((p) => p.id === state.activeProxyId) || null;
  const bypassLocal = state.settings?.bypassLocalNetworks !== false;

  if (!state.enabled || !activeProxy) {
    return {
      host,
      action: 'direct',
      directive: 'DIRECT',
      proxy: null,
      matchedRule: null,
      matchedViaCompanion: false,
      bundleName: null,
      reason: 'Axon Proxy is currently disabled (Direct connection)'
    };
  }

  if (bypassLocal && isLocalHost(host)) {
    return {
      host,
      action: 'direct',
      directive: 'DIRECT',
      proxy: null,
      matchedRule: null,
      matchedViaCompanion: false,
      bundleName: null,
      reason: 'Local / private network bypass'
    };
  }

  if (state.splitTunnel?.enabled) {
    const rules = (state.splitTunnel.rules || []).filter((r) => r.enabled !== false);
    for (const rule of rules) {
      const matchType = rule.matchType || 'domain';

      if (matchType === 'regex' || matchType === 'cidr') {
        const tokens = matchType === 'cidr'
          ? String(rule.pattern).split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean)
          : [rule.pattern];
        if (tokens.some((tok) => hostMatchesPattern(host, tok, matchType, fullUrl))) {
          const targetProxy = rule.action === 'direct'
            ? null
            : (rule.proxyId ? proxies.find((p) => p.id === rule.proxyId) : activeProxy) || activeProxy;
          return {
            host,
            action: rule.action,
            directive: rule.action === 'direct' ? 'DIRECT' : buildProxyChainDirective(targetProxy, proxies),
            proxy: targetProxy,
            matchedRule: rule,
            matchedViaCompanion: false,
            bundleName: null,
            reason: `Matched ${matchType.toUpperCase()} rule "${rule.pattern}"`
          };
        }
        continue;
      }

      const expanded = expandRuleDomains(rule);
      const hitPrimary = expanded.primary.some((tok) => hostMatchesPattern(host, tok, matchType, fullUrl));
      const hitCompanion = !hitPrimary && expanded.companions.some((tok) => hostMatchesPattern(host, tok, 'domain', fullUrl));

      if (hitPrimary || hitCompanion) {
        const targetProxy = rule.action === 'direct'
          ? null
          : (rule.proxyId ? proxies.find((p) => p.id === rule.proxyId) : activeProxy) || activeProxy;
        const directive = rule.action === 'direct'
          ? 'DIRECT'
          : buildProxyChainDirective(targetProxy, proxies);
        return {
          host,
          action: rule.action,
          directive,
          proxy: targetProxy,
          matchedRule: rule,
          matchedViaCompanion: hitCompanion,
          bundleName: expanded.bundle?.name || null,
          reason: hitCompanion
            ? `Matched via ${expanded.bundle ? `${expanded.bundle.name} CDN bundle` : 'captured companion domain'} on rule "${rule.pattern}"`
            : `Matched rule "${rule.pattern}"`
        };
      }
    }

    // No rule matched — apply default policy
    if (state.splitTunnel.defaultPolicy === 'direct') {
      return {
        host,
        action: 'direct',
        directive: 'DIRECT',
        proxy: null,
        matchedRule: null,
        matchedViaCompanion: false,
        bundleName: null,
        reason: 'Default split-tunnel policy (Direct)'
      };
    }
  }

  return {
    host,
    action: 'proxy',
    directive: buildProxyChainDirective(activeProxy, proxies),
    proxy: activeProxy,
    matchedRule: null,
    matchedViaCompanion: false,
    bundleName: null,
    reason: state.splitTunnel?.enabled ? 'Default split-tunnel policy (Via proxy)' : 'Global active proxy'
  };
}
