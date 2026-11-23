/**
 * Curated Smart Site Bundles for multi-domain platforms (video streams, thumbnails, CDNs, APIs).
 * Solves split-tunnel failures like YouTube loading HTML over youtube.com while video chunks
 * come from *.googlevideo.com and thumbnails from *.ytimg.com / *.ggpht.com.
 */

export const SITE_BUNDLES = [
  {
    id: 'youtube',
    name: 'YouTube',
    triggers: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'yt.be'],
    domains: [
      'googlevideo.com',
      'ytimg.com',
      'ggpht.com',
      'youtu.be',
      'youtubei.googleapis.com',
      'youtube-nocookie.com',
      'yt.be',
      'withyoutube.com',
      'youtube.com'
    ]
  },
  {
    id: 'twitter',
    name: 'X / Twitter',
    triggers: ['x.com', 'twitter.com', 't.co'],
    domains: [
      'x.com',
      'twitter.com',
      'twimg.com',
      't.co',
      'twttr.com'
    ]
  },
  {
    id: 'instagram',
    name: 'Instagram',
    triggers: ['instagram.com', 'ig.me'],
    domains: [
      'instagram.com',
      'cdninstagram.com',
      'fbcdn.net',
      'ig.me'
    ]
  },
  {
    id: 'discord',
    name: 'Discord',
    triggers: ['discord.com', 'discordapp.com', 'discord.gg'],
    domains: [
      'discord.com',
      'discordapp.com',
      'discordapp.net',
      'discord.gg',
      'discord.media',
      'discordcdn.com',
      'discord.co'
    ]
  },
  {
    id: 'twitch',
    name: 'Twitch',
    triggers: ['twitch.tv'],
    domains: [
      'twitch.tv',
      'ttvnw.net',
      'jtvnw.net',
      'twitchcdn.net',
      'ext-twitch.tv',
      'twitchsvc.net'
    ]
  },
  {
    id: 'netflix',
    name: 'Netflix',
    triggers: ['netflix.com'],
    domains: [
      'netflix.com',
      'nflxvideo.net',
      'nflximg.net',
      'nflximg.com',
      'nflxso.net',
      'nflxext.com',
      'fast.com'
    ]
  },
  {
    id: 'spotify',
    name: 'Spotify',
    triggers: ['spotify.com', 'spoti.fi'],
    domains: [
      'spotify.com',
      'scdn.co',
      'spotifycdn.com',
      'spoti.fi',
      'audio-ak-spotify-com.akamaized.net'
    ]
  },
  {
    id: 'reddit',
    name: 'Reddit',
    triggers: ['reddit.com', 'redd.it'],
    domains: [
      'reddit.com',
      'redd.it',
      'redditmedia.com',
      'redditstatic.com',
      'reddituploads.com',
      'redditinc.com'
    ]
  },
  {
    id: 'github',
    name: 'GitHub',
    triggers: ['github.com'],
    domains: [
      'github.com',
      'githubusercontent.com',
      'githubassets.com',
      'github.io',
      'githubstatus.com',
      'ghcr.io'
    ]
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    triggers: ['tiktok.com', 'tiktokv.com'],
    domains: [
      'tiktok.com',
      'tiktokcdn.com',
      'tiktokcdn-us.com',
      'tiktokv.com',
      'musical.ly',
      'byteoversea.com'
    ]
  },
  {
    id: 'telegram',
    name: 'Telegram',
    triggers: ['telegram.org', 't.me', 'telegram.me'],
    domains: [
      'telegram.org',
      't.me',
      'telegram.me',
      'telesco.pe',
      'tdesktop.com'
    ]
  },
  {
    id: 'steam',
    name: 'Steam',
    triggers: ['steampowered.com', 'steamcommunity.com'],
    domains: [
      'steampowered.com',
      'steamcommunity.com',
      'steamstatic.com',
      'steamcontent.com',
      'steamusercontent.com',
      's.team'
    ]
  },
  {
    id: 'openai',
    name: 'ChatGPT / OpenAI',
    triggers: ['chatgpt.com', 'openai.com'],
    domains: [
      'chatgpt.com',
      'openai.com',
      'oaiusercontent.com',
      'oaistatic.com'
    ]
  },
  {
    id: 'claude',
    name: 'Claude / Anthropic',
    triggers: ['claude.ai', 'anthropic.com'],
    domains: [
      'claude.ai',
      'anthropic.com',
      'claudeusercontent.com'
    ]
  },
  {
    id: 'google',
    name: 'Google Services',
    triggers: ['google.com'],
    domains: [
      'google.com',
      'gstatic.com',
      'googleapis.com',
      'googleusercontent.com',
      'gvt1.com',
      'gvt2.com'
    ]
  }
];

const TWO_PART_TLDS = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'ne.jp', 'or.jp',
  'com.au', 'net.au', 'org.au',
  'com.br', 'com.cn', 'com.hk', 'com.sg', 'com.tw', 'com.tr',
  'co.kr', 'co.in', 'co.nz', 'co.za'
]);

/** Clean a raw URL or pattern down to a lowercase host/pattern token. */
export function normalizeDomainPattern(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';

  if (s.includes('://')) {
    try {
      s = new URL(s).hostname.toLowerCase();
    } catch {
      s = s.replace(/^[a-z]+:\/\//, '');
    }
  }

  s = s.split('/')[0].split('?')[0].split('#')[0];
  if (s.includes(':') && !s.startsWith('[')) {
    const parts = s.split(':');
    if (parts.length === 2 && /^\d+$/.test(parts[1])) {
      s = parts[0];
    }
  }

  return s.replace(/\.+$/, '');
}

/** Extract registrable base domain (e.g. m.youtube.com -> youtube.com, *.youtube.com -> youtube.com). */
export function extractBaseDomain(raw) {
  let host = normalizeDomainPattern(raw);
  if (!host) return '';
  if (host.startsWith('*.')) host = host.slice(2);
  if (host.startsWith('.')) host = host.slice(1);
  if (host.includes('*') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.')) {
    return host;
  }

  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');

  const lastTwo = parts.slice(-2).join('.');
  if (TWO_PART_TLDS.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

/** Find a curated Smart Site Bundle matching any token in a pattern or hostname. */
export function findMatchingBundle(patternOrHost) {
  const tokens = String(patternOrHost || '')
    .split(/[\n,;]+/)
    .map((t) => extractBaseDomain(t))
    .filter(Boolean);

  for (const token of tokens) {
    for (const bundle of SITE_BUNDLES) {
      if (
        bundle.triggers.some((trig) => token === trig || token.endsWith('.' + trig)) ||
        bundle.domains.some((dom) => token === dom || token.endsWith('.' + dom))
      ) {
        return bundle;
      }
    }
  }
  return null;
}

/**
 * Expand a rule into primary tokens + companion CDN domains (Smart Site Bundle + captured tab CDNs).
 */
export function expandRuleDomains(rule) {
  const matchType = rule.matchType || 'domain';
  const rawTokens = String(rule.pattern || '')
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (matchType === 'regex' || matchType === 'cidr') {
    return {
      primary: rawTokens,
      companions: [],
      bundle: null,
      all: rawTokens
    };
  }

  const primary = rawTokens.map(normalizeDomainPattern).filter(Boolean);
  const includeCompanions = rule.includeCompanions !== false;

  if (!includeCompanions) {
    return {
      primary,
      companions: [],
      bundle: null,
      all: [...new Set(primary)]
    };
  }

  const primaryBases = new Set(primary.map(extractBaseDomain));
  const companionSet = new Set();
  let matchedBundle = null;

  for (const token of primary) {
    const bundle = findMatchingBundle(token);
    if (bundle) {
      if (!matchedBundle) matchedBundle = bundle;
      for (const dom of bundle.domains) {
        if (!primary.includes(dom) && !primary.includes(`*.${dom}`) && !primaryBases.has(dom)) {
          companionSet.add(dom);
        }
      }
    }
  }

  if (Array.isArray(rule.capturedDomains)) {
    for (const rawCap of rule.capturedDomains) {
      const cap = extractBaseDomain(rawCap);
      if (cap && !primary.includes(cap) && !primaryBases.has(cap)) {
        companionSet.add(cap);
      }
    }
  }

  const companions = [...companionSet];
  return {
    primary,
    companions,
    bundle: matchedBundle,
    all: [...new Set([...primary, ...companions])]
  };
}
