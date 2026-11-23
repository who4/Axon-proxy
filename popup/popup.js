import { PROXY_COLORS } from '../lib/constants.js';
import {
  getProxyControlStatus,
  parseProxyUri,
  validateProxyInput,
  validateRuleInput
} from '../lib/proxy-engine.js';
import { expandRuleDomains, findMatchingBundle } from '../lib/site-bundles.js';
import { createId, getState, updateState } from '../lib/storage.js';

const $ = (sel) => document.querySelector(sel);

const MATRIX_COLS = 19;
const MATRIX_ROWS = 6;

// Unprotected coral chevron / downward shield motif (matching attached reference)
const CHEVRON_MASK = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 0],
  [0, 0, 0, 0, 1, 2, 3, 2, 1, 1, 1, 2, 3, 2, 1, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 1, 2, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0],
  [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0]
];

let state = null;
let tabContext = null;
let editingProxyId = null;
let editingRuleId = null;
let selectedColor = PROXY_COLORS[0];
let pendingDeleteId = null;
let pendingDeleteTimer = null;
let matrixCells = [];
let waveTimer = null;
let wavePhase = 0;
let timerInterval = null;

async function init() {
  buildMatrixGrid();
  buildColorSwatches();
  state = await getState();
  bindEvents();
  render();
  startClock();
  await Promise.all([refreshTabContext(), refreshControlStatus()]);
}

function buildMatrixGrid() {
  const grid = $('#matrixGrid');
  grid.innerHTML = '';
  matrixCells = [];
  for (let r = 0; r < MATRIX_ROWS; r += 1) {
    const row = [];
    for (let c = 0; c < MATRIX_COLS; c += 1) {
      const cell = document.createElement('div');
      cell.className = 'matrix-cell dim';
      grid.appendChild(cell);
      row.push(cell);
    }
    matrixCells.push(row);
  }
}

function renderMatrix() {
  const isConnected = Boolean(state?.enabled && state?.activeProxyId);

  if (!isConnected) {
    stopWaveAnimation();
    for (let r = 0; r < MATRIX_ROWS; r += 1) {
      for (let c = 0; c < MATRIX_COLS; c += 1) {
        const level = CHEVRON_MASK[r][c];
        matrixCells[r][c].className = level ? `matrix-cell coral-${level}` : 'matrix-cell dim';
      }
    }
    return;
  }

  paintWaveFrame(wavePhase);
  startWaveAnimation();
}

function paintWaveFrame(phase) {
  for (let c = 0; c < MATRIX_COLS; c += 1) {
    const center = 2.5 + Math.sin(c * 0.42 + phase) * 1.15 + Math.cos(c * 0.21 - phase * 0.7) * 0.45;
    const spread = 1.25 + (Math.sin(c * 0.65 - phase * 0.9) + 1) * 0.42;

    for (let r = 0; r < MATRIX_ROWS; r += 1) {
      const dist = Math.abs(r - center);
      let cls = 'matrix-cell dim';
      if (dist < spread * 0.45) {
        cls = 'matrix-cell green-3';
      } else if (dist < spread * 0.9) {
        cls = 'matrix-cell green-2';
      } else if (dist < spread * 1.22) {
        cls = 'matrix-cell green-1';
      }
      matrixCells[r][c].className = cls;
    }
  }
}

function startWaveAnimation() {
  if (waveTimer) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  waveTimer = window.setInterval(() => {
    wavePhase += 0.28;
    paintWaveFrame(wavePhase);
  }, 190);
}

function stopWaveAnimation() {
  if (waveTimer) {
    clearInterval(waveTimer);
    waveTimer = null;
  }
}

function startClock() {
  updateSessionTimer();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = window.setInterval(updateSessionTimer, 1000);
}

function updateSessionTimer() {
  const el = $('#sessionTimer');
  if (!state?.enabled || !state?.activeProxyId || !state?.session?.connectedSince) {
    el.textContent = '00:00';
    return;
  }
  const elapsedSec = Math.max(0, Math.floor((Date.now() - state.session.connectedSince) / 1000));
  const hrs = Math.floor(elapsedSec / 3600);
  const mins = Math.floor((elapsedSec % 3600) / 60);
  const secs = elapsedSec % 60;
  if (hrs > 0) {
    el.textContent = `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  } else {
    el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
}

function buildColorSwatches() {
  const wrap = $('#colorSwatches');
  wrap.innerHTML = '';
  PROXY_COLORS.forEach((color) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch';
    btn.style.backgroundColor = color;
    btn.dataset.color = color;
    btn.title = color;
    btn.addEventListener('click', () => {
      selectedColor = color;
      syncColorSwatchSelection();
    });
    wrap.appendChild(btn);
  });
}

function syncColorSwatchSelection() {
  document.querySelectorAll('.color-swatch').forEach((el) => {
    el.classList.toggle('selected', el.dataset.color === selectedColor);
  });
}

function bindEvents() {
  $('#connectBtn').addEventListener('click', onToggleConnect);
  $('#testBtn').addEventListener('click', onTestConnection);
  $('#selectorCard').addEventListener('click', () => switchTab('proxies'));
  $('#conflictBanner').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('#quickProxyBtn').addEventListener('click', () => onQuickSiteAction('proxy'));
  $('#quickDirectBtn').addEventListener('click', () => onQuickSiteAction('direct'));

  document.querySelectorAll('.dock-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  $('#openOptionsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  $('#addProxyBtn').addEventListener('click', () => openProxyModal());
  $('#emptyAddProxyBtn').addEventListener('click', () => openProxyModal());
  $('#searchInput').addEventListener('input', renderProxyList);
  $('#proxyForm').addEventListener('submit', onProxySubmit);
  $('#closeModal').addEventListener('click', closeProxyModal);
  $('#cancelModal').addEventListener('click', closeProxyModal);

  $('#proxyQuickPaste').addEventListener('input', (e) => {
    const parsed = parseProxyUri(e.target.value);
    if (!parsed) return;
    $('#proxyHost').value = parsed.host;
    $('#proxyPort').value = parsed.port;
    const radio = document.querySelector(`input[name="proxyType"][value="${parsed.type}"]`);
    if (radio) radio.checked = true;
    if (parsed.username) {
      $('#proxyUser').value = parsed.username;
      $('#proxyPass').value = parsed.password || '';
      $('.auth-details').open = true;
    }
    if (!$('#proxyName').value.trim()) {
      $('#proxyName').value = parsed.host;
    }
    showToast('Proxy URI parsed', 'success');
  });

  $('#splitEnabled').addEventListener('change', onSplitToggle);
  $('#addRuleBtn').addEventListener('click', () => openRuleModal());
  $('#ruleForm').addEventListener('submit', onRuleSubmit);
  $('#closeRuleModal').addEventListener('click', closeRuleModal);
  $('#cancelRuleModal').addEventListener('click', closeRuleModal);
  $('#rulePattern').addEventListener('input', updateRuleBundleHint);
  $('#ruleAction').addEventListener('change', syncRuleModalVisibility);
  $('#ruleMatchType').addEventListener('change', syncRuleModalVisibility);

  document.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.addEventListener('click', () => onDefaultPolicyChange(btn.dataset.policy));
  });

  // React to live updates from right-click menu or Options page
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.proxyManagerState) {
      getState().then((fresh) => {
        state = fresh;
        render();
        refreshTabContext();
      });
    }
  });
}

function switchTab(name) {
  document.querySelectorAll('.dock-btn[data-tab]').forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });

  document.querySelectorAll('.panel').forEach((panel) => {
    const active = panel.id === `panel-${name}`;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

async function persist(mutator) {
  state = await updateState(mutator);
  render();
  await chrome.runtime.sendMessage({ type: 'APPLY_PROXY', state });
  await refreshTabContext();
}

function render() {
  const activeProxy = state.proxies.find((p) => p.id === state.activeProxyId) || null;
  const isConnected = Boolean(state.enabled && activeProxy);

  $('#appRoot').classList.toggle('is-connected', isConnected);
  $('#heroTitle').textContent = isConnected ? 'Protected' : 'Unprotected';

  const readout = $('#statusReadout');
  readout.classList.toggle('protected', isConnected);
  readout.classList.toggle('unprotected', !isConnected);
  if (isConnected) {
    readout.textContent = state.session?.lastExitIp || `${activeProxy.host}:${activeProxy.port}`;
  } else {
    readout.textContent = 'IP exposed';
  }

  const cta = $('#connectBtn');
  cta.textContent = isConnected ? 'DISABLE' : 'CONNECT';
  cta.classList.toggle('disable', isConnected);
  cta.classList.toggle('connect', !isConnected);

  // Metrics strip
  const enabledRules = (state.splitTunnel?.rules || []).filter((r) => r.enabled !== false).length;
  if (!isConnected) {
    $('#routingMetric').textContent = 'Direct';
  } else if (state.splitTunnel?.enabled) {
    $('#routingMetric').textContent = `Split · ${enabledRules} ${enabledRules === 1 ? 'rule' : 'rules'}`;
  } else {
    $('#routingMetric').textContent = 'All traffic';
  }

  const latency = state.session?.lastLatencyMs;
  $('#latencyMetric').textContent = isConnected && latency ? `${latency} ms` : '0 ms';

  // Selected proxy card
  const avatar = $('#selectorAvatar');
  if (activeProxy) {
    avatar.textContent = activeProxy.badgeText || 'AX';
    avatar.style.backgroundColor = activeProxy.color || '#24D858';
    avatar.style.color = '#0b0b0d';
    avatar.style.borderColor = 'transparent';
    $('#selectorName').textContent = activeProxy.name;
    const backup = activeProxy.fallbackProxyId
      ? state.proxies.find((p) => p.id === activeProxy.fallbackProxyId)
      : null;
    const failoverNote = backup ? ` · Failover: ${backup.name}` : '';
    $('#selectorSub').textContent = `${activeProxy.type.toUpperCase()} · ${activeProxy.host}:${activeProxy.port}${failoverNote}`;
  } else {
    avatar.textContent = 'AX';
    avatar.style.backgroundColor = '';
    avatar.style.color = '';
    avatar.style.borderColor = '';
    $('#selectorName').textContent = 'No proxy selected';
    $('#selectorSub').textContent = 'Tap to add an HTTP, HTTPS, or SOCKS5 server';
  }

  renderMatrix();
  updateSessionTimer();
  renderProxyList();
  renderSplitPanel();
  renderTabQuickBar();
}

async function refreshTabContext() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_TAB_CONTEXT' });
    if (res?.ok) {
      tabContext = res.context;
      renderTabQuickBar();
    }
  } catch {
    tabContext = null;
  }
}

async function refreshControlStatus() {
  const status = await getProxyControlStatus();
  $('#conflictBanner').classList.toggle('hidden', !status.conflict);
}

function renderTabQuickBar() {
  const card = $('#siteQuickCard');
  if (!tabContext?.baseDomain) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  $('#siteQuickDomain').textContent = tabContext.baseDomain;

  const bundle = tabContext.bundle;
  const capturedCount = (tabContext.capturedDomains || []).length;
  const routing = tabContext.routing;

  const parts = [];
  if (bundle) parts.push(`${bundle.name} +${bundle.domains.length - 1} CDNs`);
  else if (capturedCount > 0) parts.push(`+${capturedCount} captured CDNs`);
  else parts.push('Current tab');

  if (routing?.action === 'proxy') parts.push('Routed via proxy');
  else if (routing?.action === 'direct') parts.push('Direct');

  $('#siteQuickHint').textContent = parts.join(' · ');

  const isProxied = routing?.matchedRule?.action === 'proxy';
  const isDirect = routing?.matchedRule?.action === 'direct';
  $('#quickProxyBtn').classList.toggle('active-proxy', isProxied);
  $('#quickDirectBtn').classList.toggle('active-direct', isDirect);
}

async function onQuickSiteAction(action) {
  if (!tabContext?.baseDomain) return;
  const res = await chrome.runtime.sendMessage({
    type: 'ADD_SITE_RULE',
    domain: tabContext.baseDomain,
    action,
    proxyId: null,
    capturedDomains: tabContext.capturedDomains || [],
    tabId: tabContext.tabId || null
  });

  if (res?.ok && res.state) {
    state = res.state;
    render();
    await refreshTabContext();
    const label = action === 'proxy' ? 'Proxy rule added' : 'Bypass rule added';
    showToast(`${label} for ${tabContext.baseDomain}`, 'success');
  }
}

async function onToggleConnect() {
  if (state.enabled && state.activeProxyId) {
    await persist((s) => ({
      ...s,
      enabled: false,
      session: { ...s.session, connectedSince: null }
    }));
    showToast('Axon Proxy disabled', 'success');
    return;
  }

  if (!state.proxies.length) {
    switchTab('proxies');
    openProxyModal();
    showToast('Add a proxy profile to connect', 'error');
    return;
  }

  const targetId = state.activeProxyId || state.proxies[0].id;
  await persist((s) => ({
    ...s,
    enabled: true,
    activeProxyId: targetId,
    session: {
      ...s.session,
      connectedSince: Date.now()
    }
  }));
  showToast('Protected — proxy active', 'success');
  onTestConnection({ silentStart: true });
}

function renderProxyList() {
  const list = $('#proxyList');
  const empty = $('#emptyState');
  const query = $('#searchInput').value.trim().toLowerCase();

  const filtered = state.proxies.filter((p) => {
    if (!query) return true;
    return (
      p.name.toLowerCase().includes(query) ||
      p.host.toLowerCase().includes(query) ||
      String(p.port).includes(query) ||
      p.type.toLowerCase().includes(query)
    );
  });

  list.innerHTML = '';

  if (filtered.length === 0) {
    empty.classList.toggle('hidden', state.proxies.length > 0);
    return;
  }

  empty.classList.add('hidden');

  filtered.forEach((proxy) => {
    const li = document.createElement('li');
    const isSelected = state.activeProxyId === proxy.id;
    const backup = proxy.fallbackProxyId
      ? state.proxies.find((p) => p.id === proxy.fallbackProxyId)
      : null;

    li.innerHTML = `
      <article class="proxy-card ${isSelected ? 'selected' : ''}" data-id="${proxy.id}">
        <div class="proxy-badge-dot" style="background:${escapeHtml(proxy.color || '#24D858')}">${escapeHtml(proxy.badgeText || 'AX')}</div>
        <div class="proxy-info">
          <div class="proxy-name">${escapeHtml(proxy.name)}</div>
          <div class="proxy-meta">${escapeHtml(proxy.type.toUpperCase())} · ${escapeHtml(proxy.host)}:${proxy.port}${backup ? ` → ${escapeHtml(backup.badgeText || backup.name)}` : ''}</div>
        </div>
        <div class="proxy-actions">
          <button type="button" class="icon-btn edit-btn" title="Edit" aria-label="Edit ${escapeHtml(proxy.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button type="button" class="icon-btn danger delete-btn ${pendingDeleteId === proxy.id ? 'confirming' : ''}" title="${pendingDeleteId === proxy.id ? 'Click again to confirm delete' : 'Delete'}" aria-label="Delete ${escapeHtml(proxy.name)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </article>
    `;

    li.querySelector('.proxy-card').addEventListener('click', (e) => {
      if (e.target.closest('.icon-btn')) return;
      selectProxy(proxy.id);
    });

    li.querySelector('.edit-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openProxyModal(proxy);
    });

    li.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      requestDeleteProxy(proxy.id);
    });

    list.appendChild(li);
  });
}

function renderSplitPanel() {
  const split = state.splitTunnel || {};
  $('#splitEnabled').checked = Boolean(split.enabled);

  document.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.policy === (split.defaultPolicy || 'proxy'));
  });

  const rules = split.rules || [];
  $('#rulesCount').textContent = `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}`;
  $('#emptyRulesBox').classList.toggle('hidden', rules.length > 0);

  const list = $('#ruleList');
  list.innerHTML = '';

  rules.forEach((rule) => {
    const expanded = expandRuleDomains(rule);
    const targetProxy = rule.proxyId ? state.proxies.find((p) => p.id === rule.proxyId) : null;
    const actionLabel = rule.action === 'direct'
      ? '<span class="text-direct">Direct</span>'
      : `<span class="text-proxy">${escapeHtml(targetProxy ? targetProxy.name : 'Active proxy')}</span>`;

    const metaParts = [actionLabel];
    if (rule.matchType && rule.matchType !== 'domain') {
      metaParts.push(rule.matchType.toUpperCase());
    }
    if (expanded.companions.length > 0) {
      metaParts.push(`+${expanded.companions.length} CDNs`);
    }

    const li = document.createElement('li');
    li.className = `rule-card ${rule.enabled === false ? 'disabled' : ''}`;
    li.innerHTML = `
      <input type="checkbox" class="rule-toggle" ${rule.enabled !== false ? 'checked' : ''} aria-label="Toggle rule ${escapeHtml(rule.pattern)}" />
      <div class="rule-body">
        <div class="rule-pattern" title="${escapeHtml(rule.pattern)}">${escapeHtml(rule.pattern)}</div>
        <div class="rule-sub">${metaParts.join(' · ')}</div>
      </div>
      <button type="button" class="icon-btn edit-rule" title="Edit rule">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button type="button" class="icon-btn danger delete-rule" title="Delete rule">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    `;

    li.querySelector('.rule-toggle').addEventListener('change', (e) => {
      toggleRuleEnabled(rule.id, e.target.checked);
    });
    li.querySelector('.edit-rule').addEventListener('click', () => openRuleModal(rule));
    li.querySelector('.delete-rule').addEventListener('click', () => deleteRule(rule.id));
    list.appendChild(li);
  });
}

async function selectProxy(id) {
  await persist((s) => ({
    ...s,
    activeProxyId: id,
    enabled: true,
    session: {
      ...s.session,
      connectedSince: s.enabled && s.session?.connectedSince ? s.session.connectedSince : Date.now()
    }
  }));
  switchTab('main');
  showToast('Proxy selected and connected', 'success');
  onTestConnection({ silentStart: true });
}

function requestDeleteProxy(id) {
  if (pendingDeleteId !== id) {
    pendingDeleteId = id;
    clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = setTimeout(() => {
      pendingDeleteId = null;
      renderProxyList();
    }, 3000);
    renderProxyList();
    showToast('Click delete again to confirm', 'error');
    return;
  }

  pendingDeleteId = null;
  clearTimeout(pendingDeleteTimer);
  deleteProxy(id);
}

async function deleteProxy(id) {
  await persist((s) => {
    const proxies = s.proxies
      .filter((p) => p.id !== id)
      .map((p) => (p.fallbackProxyId === id ? { ...p, fallbackProxyId: null } : p));
    let activeProxyId = s.activeProxyId;
    let enabled = s.enabled;
    let connectedSince = s.session?.connectedSince || null;

    if (activeProxyId === id) {
      activeProxyId = proxies[0]?.id || null;
      enabled = enabled && Boolean(activeProxyId);
      if (!enabled) connectedSince = null;
    }

    const rules = (s.splitTunnel?.rules || []).map((r) =>
      r.proxyId === id ? { ...r, proxyId: null } : r
    );

    return {
      ...s,
      proxies,
      activeProxyId,
      enabled,
      splitTunnel: { ...s.splitTunnel, rules },
      session: { ...s.session, connectedSince }
    };
  });
  showToast('Proxy deleted', 'success');
}

function openProxyModal(proxy = null) {
  editingProxyId = proxy?.id || null;
  $('#modalTitle').textContent = proxy ? 'Edit proxy' : 'Add proxy';
  $('#proxyId').value = proxy?.id || '';
  $('#proxyQuickPaste').value = '';
  $('#proxyName').value = proxy?.name || '';
  $('#proxyBadge').value = proxy?.badgeText || '';
  $('#proxyHost').value = proxy?.host || '';
  $('#proxyPort').value = proxy?.port || '';
  $('#proxyUser').value = proxy?.username || '';
  $('#proxyPass').value = proxy?.password || '';
  selectedColor = proxy?.color || PROXY_COLORS[state.proxies.length % PROXY_COLORS.length];
  syncColorSwatchSelection();

  const radio = document.querySelector(`input[name="proxyType"][value="${proxy?.type || 'socks5'}"]`);
  if (radio) radio.checked = true;

  // Populate failover backup dropdown
  const fallbackSelect = $('#proxyFallback');
  fallbackSelect.innerHTML = '<option value="">None</option>';
  state.proxies
    .filter((p) => p.id !== editingProxyId)
    .forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.type.toUpperCase()})`;
      fallbackSelect.appendChild(opt);
    });
  fallbackSelect.value = proxy?.fallbackProxyId || '';

  $('#formError').classList.add('hidden');
  $('#proxyModal').showModal();
  $('#proxyName').focus();
}

function closeProxyModal() {
  $('#proxyModal').close();
  editingProxyId = null;
}

async function onProxySubmit(e) {
  e.preventDefault();
  const data = {
    name: $('#proxyName').value,
    host: $('#proxyHost').value.trim(),
    port: $('#proxyPort').value,
    type: document.querySelector('input[name="proxyType"]:checked').value,
    username: $('#proxyUser').value.trim(),
    password: $('#proxyPass').value
  };

  const errors = validateProxyInput(data);
  if (errors.length) {
    const errEl = $('#formError');
    errEl.textContent = errors.join('. ');
    errEl.classList.remove('hidden');
    return;
  }

  const id = editingProxyId || createId();
  const rawBadge = $('#proxyBadge').value.trim();
  const defaultBadge = data.name.trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'AX';

  const entry = {
    id,
    name: data.name.trim(),
    host: data.host,
    port: Number(data.port),
    type: data.type,
    username: data.username,
    password: data.password,
    badgeText: (rawBadge || defaultBadge).slice(0, 4).toUpperCase(),
    color: selectedColor,
    fallbackProxyId: $('#proxyFallback').value || null
  };

  await persist((s) => {
    const exists = s.proxies.some((p) => p.id === id);
    const proxies = exists
      ? s.proxies.map((p) => (p.id === id ? entry : p))
      : [...s.proxies, entry];
    return {
      ...s,
      proxies,
      activeProxyId: s.activeProxyId || id
    };
  });

  const wasEdit = Boolean(editingProxyId);
  closeProxyModal();
  showToast(wasEdit ? 'Proxy updated' : 'Proxy added', 'success');
}

async function onSplitToggle(e) {
  await persist((s) => ({
    ...s,
    splitTunnel: { ...s.splitTunnel, enabled: e.target.checked }
  }));
}

async function onDefaultPolicyChange(policy) {
  await persist((s) => ({
    ...s,
    splitTunnel: { ...s.splitTunnel, defaultPolicy: policy }
  }));
}

function openRuleModal(rule = null) {
  editingRuleId = rule?.id || null;
  $('#ruleModalTitle').textContent = rule ? 'Edit rule' : 'Add rule';
  $('#ruleId').value = rule?.id || '';
  $('#rulePattern').value = rule?.pattern || '';
  $('#ruleMatchType').value = rule?.matchType || 'wildcard';
  $('#ruleAction').value = rule?.action || 'proxy';
  $('#ruleIncludeCompanions').checked = rule ? rule.includeCompanions !== false : true;

  const proxySelect = $('#ruleProxyId');
  proxySelect.innerHTML = '<option value="">Active proxy</option>';
  state.proxies.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.type.toUpperCase()})`;
    proxySelect.appendChild(opt);
  });
  proxySelect.value = rule?.proxyId || '';

  $('#ruleFormError').classList.add('hidden');
  syncRuleModalVisibility();
  updateRuleBundleHint();
  $('#ruleModal').showModal();
  $('#rulePattern').focus();
}

function closeRuleModal() {
  $('#ruleModal').close();
  editingRuleId = null;
}

function syncRuleModalVisibility() {
  const action = $('#ruleAction').value;
  const matchType = $('#ruleMatchType').value;
  $('#ruleProxyField').classList.toggle('hidden', action === 'direct');
  $('#ruleCompanionsRow').classList.toggle('hidden', matchType === 'regex' || matchType === 'cidr');
}

function updateRuleBundleHint() {
  const val = $('#rulePattern').value.trim();
  const hint = $('#bundleHint');
  const bundle = findMatchingBundle(val);
  if (bundle) {
    const sample = bundle.domains.slice(0, 4).join(', ');
    hint.textContent = `${bundle.name} bundle detected — includes ${sample}${bundle.domains.length > 4 ? ` +${bundle.domains.length - 4} more` : ''}`;
    hint.classList.add('bundle-detected');
  } else {
    hint.textContent = 'Use *.domain.com, domain.com, RegExp, or IPv4 CIDR';
    hint.classList.remove('bundle-detected');
  }
}

async function onRuleSubmit(e) {
  e.preventDefault();
  const pattern = $('#rulePattern').value.trim();
  const matchType = $('#ruleMatchType').value;
  const action = $('#ruleAction').value;
  const proxyId = action === 'direct' ? null : $('#ruleProxyId').value || null;
  const includeCompanions = $('#ruleIncludeCompanions').checked;

  const errors = validateRuleInput({ pattern, matchType });
  if (errors.length) {
    $('#ruleFormError').textContent = errors.join('. ');
    $('#ruleFormError').classList.remove('hidden');
    return;
  }

  const id = editingRuleId || createId();
  await persist((s) => {
    const rules = s.splitTunnel.rules || [];
    const existing = rules.find((r) => r.id === id);
    const entry = {
      id,
      pattern,
      matchType,
      action,
      proxyId,
      includeCompanions,
      capturedDomains: existing?.capturedDomains || [],
      enabled: existing ? existing.enabled !== false : true
    };
    const nextRules = existing
      ? rules.map((r) => (r.id === id ? entry : r))
      : [entry, ...rules];
    return {
      ...s,
      splitTunnel: {
        ...s.splitTunnel,
        enabled: true,
        rules: nextRules
      }
    };
  });

  closeRuleModal();
  showToast('Rule saved', 'success');
}

async function toggleRuleEnabled(id, enabled) {
  await persist((s) => ({
    ...s,
    splitTunnel: {
      ...s.splitTunnel,
      rules: (s.splitTunnel.rules || []).map((r) => (r.id === id ? { ...r, enabled } : r))
    }
  }));
}

async function deleteRule(id) {
  await persist((s) => ({
    ...s,
    splitTunnel: {
      ...s.splitTunnel,
      rules: (s.splitTunnel.rules || []).filter((r) => r.id !== id)
    }
  }));
  showToast('Rule removed', 'success');
}

async function onTestConnection({ silentStart = false } = {}) {
  const btn = $('#testBtn');
  btn.disabled = true;
  btn.textContent = 'Testing connection…';
  if (!silentStart) showToast('Testing connection…', 'success');

  try {
    const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
    if (res?.ok && res.result?.success) {
      state = await getState();
      render();
      if (res.result.control) {
        $('#conflictBanner').classList.toggle('hidden', !res.result.control.conflict);
      }
      const ipNote = res.result.exitIp ? ` · ${res.result.exitIp}` : '';
      showToast(`Connected (${res.result.latencyMs || 0} ms${ipNote})`, 'success');
    } else {
      showToast('Connection failed', 'error');
    }
  } catch {
    showToast('Connection test failed', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test connection';
  }
}

let activeToastTimer = null;

function showToast(message, type = 'success') {
  const container = $('#toastContainer');
  container.innerHTML = '';
  clearTimeout(activeToastTimer);
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  activeToastTimer = setTimeout(() => toast.remove(), 2200);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

init();
