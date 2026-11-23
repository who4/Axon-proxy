import { extractBaseDomain } from '/lib/site-bundles.js';
import { removeSiteRule, upsertSiteRule } from '/lib/proxy-engine.js';

const VIEW_URLS = {
  popup: '/popup/popup.html',
  options: '/options/options.html'
};

const STORAGE_KEY = 'proxyManagerPreview:storage:proxyManagerState';
const SIM_TAB_URL_KEY = 'axonPreview:activeTabUrl';

const SIM_CDNS = {
  'youtube.com': ['googlevideo.com', 'ytimg.com', 'ggpht.com', 'youtubei.googleapis.com'],
  'x.com': ['twimg.com', 't.co'],
  'discord.com': ['discordapp.net', 'discord.media', 'discordcdn.com'],
  'github.com': ['githubusercontent.com', 'githubassets.com'],
  'example.com': ['cdn.example-assets.net']
};

const stage = document.getElementById('stage');
const frame = document.getElementById('previewFrame');
const badgeEl = document.getElementById('extBadge');
const actionEl = document.getElementById('extensionAction');
const buttons = Array.from(document.querySelectorAll('.switcher-btn'));
const simTabSelect = document.getElementById('simTabSelect');
const ctxTrigger = document.getElementById('ctxTrigger');
const ctxDropdown = document.getElementById('ctxDropdown');
const wrapperToast = document.getElementById('wrapperToast');

let toastTimer = null;

function readPreviewState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { proxies: [], splitTunnel: { enabled: false, defaultPolicy: 'proxy', rules: [] }, settings: {} };
  } catch {
    return { proxies: [], splitTunnel: { enabled: false, defaultPolicy: 'proxy', rules: [] }, settings: {} };
  }
}

function writePreviewState(next) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  try {
    frame.contentWindow?.postMessage({ type: 'PREVIEW_EXTERNAL_STATE_CHANGED' }, window.location.origin);
  } catch {
    // Ignore frame postMessage issues.
  }
}

function setView(view, { updateHash = true } = {}) {
  const next = view === 'options' ? 'options' : 'popup';

  buttons.forEach((btn) => {
    const isActive = btn.dataset.view === next;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  stage.classList.toggle('stage-popup', next === 'popup');
  stage.classList.toggle('stage-options', next === 'options');

  frame.src = VIEW_URLS[next];
  frame.title = next === 'popup' ? 'Axon Proxy Popup' : 'Axon Proxy Settings';

  if (updateHash) {
    window.history.replaceState(null, '', next === 'options' ? '#options' : '#popup');
  }
}

function updateBadge(badge) {
  if (!badge) return;
  const text = badge.text || '';
  badgeEl.textContent = text;
  badgeEl.classList.toggle('hidden', !text);
  if (badge.color) {
    badgeEl.style.backgroundColor = badge.color;
  }
  if (badge.title) {
    actionEl.title = badge.title;
  }
}

function showToast(msg) {
  wrapperToast.textContent = msg;
  wrapperToast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => wrapperToast.classList.add('hidden'), 2600);
}

function renderContextMenu() {
  const state = readPreviewState();
  const url = simTabSelect.value;
  const baseDomain = extractBaseDomain(url);
  const activeProxy = (state.proxies || []).find((p) => p.id === state.activeProxyId);

  ctxDropdown.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'ctx-header';
  header.textContent = `Axon Proxy · ${baseDomain}`;
  ctxDropdown.appendChild(header);

  const addItem = (label, handler, isDanger = false) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ctx-item${isDanger ? ' danger' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      ctxDropdown.classList.add('hidden');
      handler();
    });
    ctxDropdown.appendChild(btn);
  };

  addItem(
    `Use proxy (${activeProxy ? activeProxy.name : 'Active proxy'}) + media/CDNs`,
    () => applyContextRule(baseDomain, 'proxy', null)
  );

  if (state.proxies?.length) {
    const sub = document.createElement('div');
    sub.className = 'ctx-sublabel';
    sub.textContent = 'Use specific proxy for this site:';
    ctxDropdown.appendChild(sub);

    state.proxies.forEach((p) => {
      addItem(`  → ${p.name} (${p.type.toUpperCase()})`, () => applyContextRule(baseDomain, 'proxy', p.id));
    });
  }

  const sep = document.createElement('div');
  sep.className = 'ctx-sep';
  ctxDropdown.appendChild(sep);

  addItem('Use direct network (bypass proxy)', () => applyContextRule(baseDomain, 'direct', null));
  addItem('Remove site from rules', () => {
    const current = readPreviewState();
    const next = removeSiteRule(current, baseDomain);
    writePreviewState(next);
    showToast(`Removed rules for ${baseDomain}`);
  }, true);
}

function applyContextRule(baseDomain, action, proxyId) {
  const current = readPreviewState();
  const next = upsertSiteRule(current, {
    domain: baseDomain,
    action,
    proxyId,
    capturedDomains: SIM_CDNS[baseDomain] || [],
    includeCompanions: current.settings?.autoIncludeCompanions !== false
  });
  writePreviewState(next);
  const verb = action === 'direct' ? 'Bypass rule added' : 'Proxy + CDN rule added';
  showToast(`${verb} for ${baseDomain}`);
}

buttons.forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});

const savedTabUrl = window.localStorage.getItem(SIM_TAB_URL_KEY);
if (savedTabUrl && Array.from(simTabSelect.options).some((o) => o.value === savedTabUrl)) {
  simTabSelect.value = savedTabUrl;
} else {
  window.localStorage.setItem(SIM_TAB_URL_KEY, simTabSelect.value);
}

simTabSelect.addEventListener('change', () => {
  window.localStorage.setItem(SIM_TAB_URL_KEY, simTabSelect.value);
  frame.contentWindow?.postMessage({ type: 'PREVIEW_EXTERNAL_STATE_CHANGED' }, window.location.origin);
});

ctxTrigger.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = ctxDropdown.classList.contains('hidden');
  if (open) {
    renderContextMenu();
    ctxDropdown.classList.remove('hidden');
  } else {
    ctxDropdown.classList.add('hidden');
  }
});

document.addEventListener('click', (e) => {
  if (!ctxDropdown.contains(e.target) && e.target !== ctxTrigger) {
    ctxDropdown.classList.add('hidden');
  }
});

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'PREVIEW_OPEN_OPTIONS') {
    setView('options');
  } else if (data.type === 'PREVIEW_BADGE_UPDATE') {
    updateBadge(data.badge);
  }
});

const initialHash = window.location.hash.replace('#', '');
if (initialHash === 'options') {
  setView('options', { updateHash: false });
}
