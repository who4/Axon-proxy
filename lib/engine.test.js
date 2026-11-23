import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChromeBypassList,
  buildPacScript,
  buildProxyChainDirective,
  buildProxyConfigFromState,
  cidrToMask,
  evaluateUrlRouting
} from './pac-builder.js';
import {
  parseProxyUri,
  removeSiteRule,
  upsertSiteRule,
  validateProxyInput,
  validateRuleInput
} from './proxy-engine.js';
import {
  expandRuleDomains,
  extractBaseDomain,
  findMatchingBundle
} from './site-bundles.js';
import {
  exportStateJson,
  importStateJson,
  parseDomainListImport
} from './storage.js';

function compilePac(pacCode) {
  return new Function(
    'isPlainHostName',
    'dnsDomainIs',
    'shExpMatch',
    'isInNet',
    `${pacCode}\nreturn FindProxyForURL;`
  )(
    (h) => !h.includes('.'),
    (h, d) => h.endsWith(d),
    (s, g) =>
      new RegExp(
        '^' +
          g
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.') +
          '$',
        'i'
      ).test(s),
    (host, ip, mask) => {
      const toInt = (v) => {
        const p = v.split('.').map(Number);
        if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return null;
        return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
      };
      const h = toInt(host);
      const n = toInt(ip);
      const m = toInt(mask);
      return h !== null && n !== null && m !== null && (h & m) === (n & m);
    }
  );
}

test('extractBaseDomain handles subdomains, wildcards, URLs, and two-part TLDs', () => {
  assert.equal(extractBaseDomain('https://m.youtube.com/watch?v=1'), 'youtube.com');
  assert.equal(extractBaseDomain('*.youtube.com'), 'youtube.com');
  assert.equal(extractBaseDomain('news.bbc.co.uk'), 'bbc.co.uk');
  assert.equal(extractBaseDomain('127.0.0.1:8080'), '127.0.0.1');
});

test('Smart Site Bundle expands YouTube videos, thumbnails, and avatars', () => {
  const bundle = findMatchingBundle('*.youtube.com');
  assert.equal(bundle?.id, 'youtube');
  const expanded = expandRuleDomains({
    pattern: '*.youtube.com',
    matchType: 'wildcard',
    includeCompanions: true,
    capturedDomains: ['custom-cdn.example.net']
  });
  assert.ok(expanded.companions.includes('googlevideo.com'));
  assert.ok(expanded.companions.includes('ytimg.com'));
  assert.ok(expanded.companions.includes('ggpht.com'));
  assert.ok(expanded.companions.includes('example.net'));
});

test('YouTube rule with Direct default catches video streams & thumbnails in both evaluator and compiled PAC', () => {
  const p1 = { id: 'p1', name: 'Netherlands', host: '10.0.0.1', port: 1080, type: 'socks5', fallbackProxyId: 'p2' };
  const p2 = { id: 'p2', name: 'Backup', host: '10.0.0.2', port: 8080, type: 'http', fallbackProxyId: null };

  let state = {
    enabled: true,
    activeProxyId: 'p1',
    proxies: [p1, p2],
    splitTunnel: { enabled: true, defaultPolicy: 'direct', rules: [] },
    settings: { bypassLocalNetworks: true, autoIncludeCompanions: true }
  };

  state = upsertSiteRule(state, { domain: 'www.youtube.com', action: 'proxy', includeCompanions: true });

  const pac = buildPacScript(state);
  assert.ok(pac.includes('SOCKS5 10.0.0.1:1080; PROXY 10.0.0.2:8080'));
  const findProxy = compilePac(pac);

  const expected = 'SOCKS5 10.0.0.1:1080; PROXY 10.0.0.2:8080';
  for (const url of [
    'https://www.youtube.com/watch?v=abc',
    'https://youtube.com/',
    'https://rr5---sn-abc.googlevideo.com/videoplayback?id=1',
    'https://i.ytimg.com/vi/abc/maxresdefault.jpg',
    'https://yt3.ggpht.com/ytc/avatar=s68'
  ]) {
    const host = new URL(url).hostname;
    assert.equal(evaluateUrlRouting(url, state).directive, expected);
    assert.equal(findProxy(url, host), expected);
  }

  assert.equal(evaluateUrlRouting('https://example.org/', state).directive, 'DIRECT');
  assert.equal(findProxy('https://example.org/', 'example.org'), 'DIRECT');
});

test('PAC respects strict top-to-bottom rule priority and multi-proxy targets', () => {
  const p1 = { id: 'p1', name: 'NL', host: '1.1.1.1', port: 1080, type: 'socks5' };
  const p2 = { id: 'p2', name: 'Corp', host: '2.2.2.2', port: 8443, type: 'https' };

  const state = {
    enabled: true,
    activeProxyId: 'p1',
    proxies: [p1, p2],
    splitTunnel: {
      enabled: true,
      defaultPolicy: 'direct',
      rules: [
        { id: 'r1', pattern: 'api.corp.io', matchType: 'domain', action: 'proxy', proxyId: 'p2', enabled: true, includeCompanions: false },
        { id: 'r2', pattern: 'corp.io', matchType: 'domain', action: 'direct', proxyId: null, enabled: true, includeCompanions: false },
        { id: 'r3', pattern: '10.42.0.0/16', matchType: 'cidr', action: 'proxy', proxyId: 'p2', enabled: true },
        { id: 'r4', pattern: '^https://.*\\.special\\.dev/admin', matchType: 'regex', action: 'proxy', proxyId: 'p1', enabled: true }
      ]
    },
    settings: { bypassLocalNetworks: false }
  };

  const findProxy = compilePac(buildPacScript(state));

  // Proxy rule ABOVE broader direct rule MUST win (strict top-to-bottom!)
  assert.equal(evaluateUrlRouting('https://api.corp.io/v1', state).directive, 'HTTPS 2.2.2.2:8443');
  assert.equal(findProxy('https://api.corp.io/v1', 'api.corp.io'), 'HTTPS 2.2.2.2:8443');

  // Broader direct rule catches other subdomains
  assert.equal(evaluateUrlRouting('https://www.corp.io/', state).directive, 'DIRECT');
  assert.equal(findProxy('https://www.corp.io/', 'www.corp.io'), 'DIRECT');

  // CIDR rule matches IPv4 subnet
  assert.equal(evaluateUrlRouting('http://10.42.8.15/', state).directive, 'HTTPS 2.2.2.2:8443');
  assert.equal(findProxy('http://10.42.8.15/', '10.42.8.15'), 'HTTPS 2.2.2.2:8443');

  // Regex rule matches URL path
  assert.equal(evaluateUrlRouting('https://app.special.dev/admin/users', state).directive, 'SOCKS5 1.1.1.1:1080');
  assert.equal(findProxy('https://app.special.dev/admin/users', 'app.special.dev'), 'SOCKS5 1.1.1.1:1080');
});

test('Failover chain prevents cycles safely', () => {
  const a = { id: 'a', host: '1.1.1.1', port: 1080, type: 'socks5', fallbackProxyId: 'b' };
  const b = { id: 'b', host: '2.2.2.2', port: 8080, type: 'http', fallbackProxyId: 'a' };
  assert.equal(buildProxyChainDirective(a, [a, b]), 'SOCKS5 1.1.1.1:1080; PROXY 2.2.2.2:8080');
});

test('fixed_servers fast-path vs pac_script selection', () => {
  const p = { id: 'p1', host: '127.0.0.1', port: 1080, type: 'socks5' };
  const simpleState = {
    enabled: true,
    activeProxyId: 'p1',
    proxies: [p],
    splitTunnel: {
      enabled: true,
      defaultPolicy: 'proxy',
      rules: [{ id: 'r1', pattern: 'localbank.com', matchType: 'domain', action: 'direct', enabled: true, includeCompanions: false }]
    },
    settings: { bypassLocalNetworks: true }
  };
  const cfg = buildProxyConfigFromState(simpleState);
  assert.equal(cfg.mode, 'fixed_servers');
  assert.ok(cfg.rules.bypassList.includes('localbank.com'));
  assert.ok(cfg.rules.bypassList.includes('.localbank.com'));
});

test('Smart URI parsing and validation', () => {
  const socks = parseProxyUri('socks5h://bob:p%40ss@192.0.2.10:1080');
  assert.deepEqual(socks, { type: 'socks5', host: '192.0.2.10', port: 1080, username: 'bob', password: 'p@ss' });

  const colon = parseProxyUri('192.0.2.20:8080:alice:secret');
  assert.deepEqual(colon, { type: 'http', host: '192.0.2.20', port: 8080, username: 'alice', password: 'secret' });

  assert.equal(validateProxyInput({ name: 'NL', host: '1.2.3.4', port: 1080, type: 'socks5' }).length, 0);
  assert.ok(validateProxyInput({ name: '', host: '', port: 99999, type: 'ftp' }).length >= 3);
  assert.ok(validateRuleInput({ pattern: '[unclosed', matchType: 'regex' }).length > 0);
  assert.ok(validateRuleInput({ pattern: '999.0.0.1/24', matchType: 'cidr' }).length > 0);
  assert.deepEqual(cidrToMask('10.20.0.0/16'), { ip: '10.20.0.0', mask: '255.255.0.0', prefix: 16 });
});

test('Export sanitizes credentials by default, import merges cleanly, and bulk parser cleans AdBlock lines', () => {
  const baseState = {
    version: 2,
    proxies: [{ id: 'p1', name: 'NL', host: '1.1.1.1', port: 1080, type: 'socks5', username: 'u', password: 'secret', badgeText: 'NL', color: '#24D858', fallbackProxyId: null }],
    activeProxyId: 'p1',
    enabled: true,
    splitTunnel: { enabled: true, defaultPolicy: 'direct', rules: [] },
    settings: { webrtcProtection: true },
    session: {}
  };

  const sanitized = exportStateJson(baseState, { includeCredentials: false });
  assert.ok(!sanitized.includes('secret'));

  const withCreds = exportStateJson(baseState, { includeCredentials: true });
  assert.ok(withCreds.includes('secret'));

  const imported = importStateJson(sanitized, { ...baseState, proxies: [], activeProxyId: null }, { mode: 'merge' });
  assert.equal(imported.proxies.length, 1);
  assert.equal(imported.proxies[0].host, '1.1.1.1');

  const bulk = parseDomainListImport('# comment\n||youtube.com^\ngithub.com\ngithub.com', { action: 'proxy' });
  assert.equal(bulk.length, 2);
  assert.equal(bulk[0].pattern, 'youtube.com');

  const afterRemove = removeSiteRule(upsertSiteRule(baseState, { domain: 'youtube.com', action: 'proxy' }), 'youtube.com');
  assert.equal(afterRemove.splitTunnel.rules.length, 0);
  assert.ok(buildChromeBypassList([], true).includes('localhost'));
});
