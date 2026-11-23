export const STORAGE_KEY = 'proxyManagerState';
export const SESSION_AUTH_KEY = 'axonProxySessionCredentials';

export const PROXY_TYPES = ['http', 'https', 'socks5'];
export const RULE_ACTIONS = ['proxy', 'direct'];
export const MATCH_TYPES = ['domain', 'wildcard', 'regex', 'cidr'];

export const PROXY_COLORS = [
  '#24D858',
  '#38BDF8',
  '#818CF8',
  '#F59E0B',
  '#FB7185',
  '#2DD4BF',
  '#A78BFA',
  '#F97316'
];

export const DEFAULT_SETTINGS = {
  webrtcProtection: true,
  bypassLocalNetworks: true,
  contextMenuEnabled: true,
  autoIncludeCompanions: true,
  autoReloadTabOnRule: true,
  sessionOnlyAuth: false
};

export const DEFAULT_SESSION = {
  connectedSince: null,
  lastLatencyMs: null,
  lastExitIp: null,
  lastCountry: null
};

export const DEFAULT_STATE = {
  version: 2,
  proxies: [],
  activeProxyId: null,
  enabled: false,
  splitTunnel: {
    enabled: false,
    defaultPolicy: 'proxy',
    rules: []
  },
  settings: { ...DEFAULT_SETTINGS },
  session: { ...DEFAULT_SESSION }
};
