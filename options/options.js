import { PROXY_COLORS } from '../lib/constants.js';
import { buildProxyConfigFromState, evaluateUrlRouting } from '../lib/pac-builder.js';
import {
  getProxyControlStatus,
  parseProxyUri,
  validateProxyInput,
  validateRuleInput
} from '../lib/proxy-engine.js';
import { expandRuleDomains, findMatchingBundle, SITE_BUNDLES } from '../lib/site-bundles.js';
import {
  createId,
  exportStateJson,
  getState,
  importStateJson,
  parseDomainListImport,
  updateState
} from '../lib/storage.js';

const $ = (sel) => document.querySelector(sel);

let state = null;
let editingRuleId = null;
let editingProxyId = null;
let selectedColor = PROXY_COLORS[0];
let dragRuleId = null;
let pendingDeleteKey = null;
let pendingDeleteTimer = null;

async function init() {
  buildColorSwatches();
  buildBundleGrid();
  state = await getState();
  bindNav();
  bindControls();
  render();
  await refreshControlStatus();
}

function buildColorSwatches() {
  const wrap = $('#optColorSwatches');
  wrap.innerHTML = '';
  PROXY_COLORS.forEach((color) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'color-swatch';
    btn.style.backgroundColor = color;
    btn.dataset.color = color;
    btn.addEventListener('click', () => {
      selectedColor = color;
      syncColorSelection();
    });
    wrap.appendChild(btn);
  });
}

function syncColorSelection() {
  document.querySelectorAll('#optColorSwatches .color-swatch').forEach((el) => {
    el.classList.toggle('selected', el.dataset.color === selectedColor);
  });
}

function buildBundleGrid() {
  const grid = $('#bundleGrid');
  grid.innerHTML = '';
  SITE_BUNDLES.forEach((bundle) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bundle-btn';
    btn.innerHTML = `
      <strong>${escapeHtml(bundle.name)}</strong>
      <span>*.${escapeHtml(bundle.triggers[0])} · ${bundle.domains.length} domains</span>
    `;
    btn.addEventListener('click', () => addSmartBundleRule(bundle));
    grid.appendChild(btn);
  });
}

function bindNav() {
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const id = link.getAttribute('href').slice(1);
      showSection(id);
      document.querySelectorAll('.nav-link').forEach((l) => l.classList.toggle('active', l === link));
    });
  });
}

function showSection(id) {
  document.querySelectorAll('.section').forEach((s) => {
    s.classList.toggle('hidden', s.id !== id);
  });
  if (id === 'pac') {
    renderPacInspector();
  } else if (id === 'privacy') {
    refreshControlStatus();
  }
}

function bindControls() {
  $('#splitEnabled').addEventListener('change', async (e) => {
    await persist((s) => ({
      ...s,
      splitTunnel: { ...s.splitTunnel, enabled: e.target.checked }
    }));
  });

  document.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await persist((s) => ({
        ...s,
        splitTunnel: { ...s.splitTunnel, defaultPolicy: btn.dataset.policy }
      }));
    });
  });

  // Live URL Routing Tester
  $('#routeTesterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    runRouteTest();
  });

  // Rules modal
  $('#addRuleBtn').addEventListener('click', () => openRuleModal());
  $('#ruleForm').addEventListener('submit', onRuleSubmit);
  $('#closeRuleModal').addEventListener('click', () => $('#ruleModal').close());
  $('#cancelRuleModal').addEventListener('click', () => $('#ruleModal').close());
  $('#rulePattern').addEventListener('input', updateBundleHint);
  $('#ruleAction').addEventListener('change', syncRuleModalFields);
  $('#ruleMatchType').addEventListener('change', syncRuleModalFields);

  // Proxies modal
  $('#addProxyBtn').addEventListener('click', () => openProxyModal());
  $('#proxyForm').addEventListener('submit', onProxySubmit);
  $('#closeProxyModal').addEventListener('click', () => $('#proxyModal').close());
  $('#cancelProxyModal').addEventListener('click', () => $('#proxyModal').close());
  $('#proxyQuickPaste').addEventListener('input', (e) => {
    const parsed = parseProxyUri(e.target.value);
    if (!parsed) return;
    $('#proxyHost').value = parsed.host;
    $('#proxyPort').value = parsed.port;
    $('#proxyType').value = parsed.type;
    if (parsed.username) {
      $('#proxyUser').value = parsed.username;
      $('#proxyPass').value = parsed.password || '';
    }
    if (!$('#proxyName').value.trim()) {
      $('#proxyName').value = parsed.host;
    }
    showToast('Proxy URI parsed', 'success');
  });

  // Privacy & Browser Settings
  const settingMap = [
    ['#settingWebrtc', 'webrtcProtection'],
    ['#settingBypassLocal', 'bypassLocalNetworks'],
    ['#settingSessionAuth', 'sessionOnlyAuth'],
    ['#settingContextMenu', 'contextMenuEnabled'],
    ['#settingAutoCompanions', 'autoIncludeCompanions'],
    ['#settingAutoReload', 'autoReloadTabOnRule']
  ];
  settingMap.forEach(([sel, key]) => {
    $(sel).addEventListener('change', async (e) => {
      await persist((s) => ({
        ...s,
        settings: { ...s.settings, [key]: e.target.checked }
      }));
      showToast('Setting updated', 'success');
    });
  });

  $('#refreshControlBtn').addEventListener('click', refreshControlStatus);

  // Backup & Import
  $('#exportJsonBtn').addEventListener('click', onExportJson);
  $('#copyJsonBtn').addEventListener('click', onCopyJson);
  $('#importFileInput').addEventListener('change', onImportFileSelected);
  $('#importJsonBtn').addEventListener('click', onImportJsonClick);
  $('#bulkImportBtn').addEventListener('click', onBulkImportClick);

  // PAC Copy
  $('#copyPacBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#pacCodeViewer').textContent);
      showToast('Configuration copied', 'success');
    } catch {
      showToast('Copy failed', 'error');
    }
  });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.proxyManagerState) {
      getState().then((fresh) => {
        state = fresh;
        render();
      });
    }
  });
}

async function persist(mutator) {
  state = await updateState(mutator);
  render();
  await chrome.runtime.sendMessage({ type: 'APPLY_PROXY', state });
}

function render() {
  const activeProxy = state.proxies.find((p) => p.id === state.activeProxyId);
  const connected = Boolean(state.enabled && activeProxy);
  $('#sidebarStatus').textContent = connected
    ? `Protected · ${activeProxy.name}`
    : 'Unprotected · Direct';

  const split = state.splitTunnel || {};
  $('#splitEnabled').checked = Boolean(split.enabled);

  document.querySelectorAll('.segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.policy === (split.defaultPolicy || 'proxy'));
  });

  renderRules(split.rules || []);
  renderProxies();
  renderSettings();
  populateBulkProxySelect();
  renderPacInspector();
}

function renderSettings() {
  const s = state.settings || {};
  $('#settingWebrtc').checked = s.webrtcProtection !== false;
  $('#settingBypassLocal').checked = s.bypassLocalNetworks !== false;
  $('#settingSessionAuth').checked = Boolean(s.sessionOnlyAuth);
  $('#settingContextMenu').checked = s.contextMenuEnabled !== false;
  $('#settingAutoCompanions').checked = s.autoIncludeCompanions !== false;
  $('#settingAutoReload').checked = s.autoReloadTabOnRule !== false;
}

function populateBulkProxySelect() {
  const sel = $('#bulkProxyId');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Active proxy</option>';
  state.proxies.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.type.toUpperCase()})`;
    sel.appendChild(opt);
  });
  sel.value = prev;
}

function renderRules(rules) {
  const tbody = $('#rulesBody');
  const empty = $('#emptyRules');
  tbody.innerHTML = '';

  if (!rules.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const activeProxy = state.proxies.find((p) => p.id === state.activeProxyId);

  rules.forEach((rule, index) => {
    const expanded = expandRuleDomains(rule);
    const targetProxy = rule.proxyId ? state.proxies.find((p) => p.id === rule.proxyId) : null;
    const defaultLabel = activeProxy ? `Active (${activeProxy.name})` : 'Active proxy';
    const routeHtml = rule.action === 'direct'
      ? '<span class="route-direct-text">Direct (bypass)</span>'
      : `<span class="route-proxy-text">${escapeHtml(targetProxy ? targetProxy.name : defaultLabel)}</span>`;

    let companionHtml = '';
    if (expanded.companions.length > 0) {
      const previewList = expanded.companions.slice(0, 4).join(', ');
      const extra = expanded.companions.length > 4 ? ` +${expanded.companions.length - 4}` : '';
      const label = expanded.bundle ? `${expanded.bundle.name} bundle` : 'Captured CDNs';
      companionHtml = `<div class="companion-line">${escapeHtml(label)}: ${escapeHtml(previewList)}${extra}</div>`;
    }

    const deleteKey = `rule:${rule.id}`;
    const tr = document.createElement('tr');
    tr.draggable = true;
    tr.dataset.id = rule.id;
    if (rule.enabled === false) tr.classList.add('row-disabled');

    tr.innerHTML = `
      <td><input type="checkbox" class="rule-check" ${rule.enabled !== false ? 'checked' : ''} aria-label="Enable rule" /></td>
      <td>
        <code class="pattern-code">${escapeHtml(rule.pattern)}</code>
        ${companionHtml}
      </td>
      <td><span class="mono muted">${escapeHtml((rule.matchType || 'domain').toUpperCase())}</span></td>
      <td>${routeHtml}</td>
      <td>
        <div class="table-actions">
          <button type="button" class="icon-btn move-up" title="Move up" ${index === 0 ? 'disabled' : ''}>↑</button>
          <button type="button" class="icon-btn move-down" title="Move down" ${index === rules.length - 1 ? 'disabled' : ''}>↓</button>
          <button type="button" class="icon-btn edit-rule">Edit</button>
          <button type="button" class="icon-btn danger delete-rule ${pendingDeleteKey === deleteKey ? 'confirming' : ''}">
            ${pendingDeleteKey === deleteKey ? 'Confirm?' : 'Delete'}
          </button>
        </div>
      </td>
    `;

    tr.addEventListener('dragstart', () => {
      dragRuleId = rule.id;
      tr.classList.add('dragging');
    });
    tr.addEventListener('dragend', () => {
      dragRuleId = null;
      tr.classList.remove('dragging');
    });
    tr.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    tr.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!dragRuleId || dragRuleId === rule.id) return;
      await reorderRuleToTarget(dragRuleId, rule.id);
    });

    tr.querySelector('.rule-check').addEventListener('change', async (e) => {
      await persist((s) => ({
        ...s,
        splitTunnel: {
          ...s.splitTunnel,
          rules: s.splitTunnel.rules.map((r) => (r.id === rule.id ? { ...r, enabled: e.target.checked } : r))
        }
      }));
    });
    tr.querySelector('.move-up').addEventListener('click', () => moveRule(rule.id, -1));
    tr.querySelector('.move-down').addEventListener('click', () => moveRule(rule.id, 1));
    tr.querySelector('.edit-rule').addEventListener('click', () => openRuleModal(rule));
    tr.querySelector('.delete-rule').addEventListener('click', () => confirmDelete(deleteKey, () => deleteRule(rule.id)));

    tbody.appendChild(tr);
  });
}

function renderProxies() {
  const grid = $('#proxyGrid');
  const empty = $('#emptyProxies');
  grid.innerHTML = '';

  if (!state.proxies.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  state.proxies.forEach((proxy) => {
    const isActive = state.activeProxyId === proxy.id;
    const backup = proxy.fallbackProxyId
      ? state.proxies.find((p) => p.id === proxy.fallbackProxyId)
      : null;
    const deleteKey = `proxy:${proxy.id}`;

    const tile = document.createElement('article');
    tile.className = `proxy-tile ${isActive ? 'is-active' : ''}`;
    tile.innerHTML = `
      <div class="proxy-tile-head">
        <div class="proxy-avatar" style="background:${escapeHtml(proxy.color || '#24D858')}">${escapeHtml(proxy.badgeText || 'AX')}</div>
        <div>
          <h3>${escapeHtml(proxy.name)}${isActive ? ' · Active' : ''}</h3>
          <div class="meta">${escapeHtml(proxy.type.toUpperCase())} · ${escapeHtml(proxy.host)}:${proxy.port}</div>
          ${backup ? `<div class="meta">Failover → ${escapeHtml(backup.name)}</div>` : ''}
        </div>
      </div>
      <div class="actions">
        <button type="button" class="btn btn-primary select-proxy">${isActive && state.enabled ? 'Connected' : 'Connect'}</button>
        <button type="button" class="btn btn-ghost edit-proxy">Edit</button>
        <button type="button" class="btn btn-ghost danger delete-proxy ${pendingDeleteKey === deleteKey ? 'confirming' : ''}">
          ${pendingDeleteKey === deleteKey ? 'Confirm?' : 'Delete'}
        </button>
      </div>
    `;

    tile.querySelector('.select-proxy').addEventListener('click', async () => {
      await persist((s) => ({
        ...s,
        activeProxyId: proxy.id,
        enabled: true,
        session: {
          ...s.session,
          connectedSince: s.enabled && s.session?.connectedSince ? s.session.connectedSince : Date.now()
        }
      }));
      showToast(`Connected via ${proxy.name}`, 'success');
    });
    tile.querySelector('.edit-proxy').addEventListener('click', () => openProxyModal(proxy));
    tile.querySelector('.delete-proxy').addEventListener('click', () => confirmDelete(deleteKey, () => deleteProxy(proxy.id)));
    grid.appendChild(tile);
  });
}

function runRouteTest() {
  const raw = $('#routeTestInput').value.trim();
  const box = $('#routeTestResult');
  if (!raw) {
    box.classList.add('hidden');
    return;
  }

  const res = evaluateUrlRouting(raw, state);
  box.classList.remove('hidden');

  if (res.error) {
    box.innerHTML = `<div class="tester-verdict verdict-direct">${escapeHtml(res.error)}</div>`;
    return;
  }

  const isProxy = res.action === 'proxy';
  const badgeText = isProxy
    ? `Via ${res.proxy?.name || 'Proxy'}`
    : 'Direct connection';

  box.innerHTML = `
    <div class="tester-verdict ${isProxy ? 'verdict-proxy' : 'verdict-direct'}">
      <span>${escapeHtml(badgeText)}</span>
      <span class="mono muted">(${escapeHtml(res.host)})</span>
    </div>
    <div class="muted">${escapeHtml(res.reason)}</div>
    <div class="tester-directive">PAC directive: ${escapeHtml(res.directive)}</div>
  `;
}

async function addSmartBundleRule(bundle) {
  const pattern = `*.${bundle.triggers[0]}`;
  const exists = (state.splitTunnel?.rules || []).some(
    (r) => r.pattern.toLowerCase() === pattern.toLowerCase()
  );
  if (exists) {
    showToast(`${bundle.name} rule already exists`, 'error');
    return;
  }

  await persist((s) => ({
    ...s,
    splitTunnel: {
      ...s.splitTunnel,
      enabled: true,
      rules: [
        {
          id: createId(),
          pattern,
          matchType: 'wildcard',
          action: 'proxy',
          proxyId: null,
          includeCompanions: true,
          capturedDomains: [],
          enabled: true
        },
        ...(s.splitTunnel.rules || [])
      ]
    }
  }));
  showToast(`${bundle.name} bundle added (${bundle.domains.length} domains)`, 'success');
}

async function moveRule(id, direction) {
  await persist((s) => {
    const rules = [...(s.splitTunnel.rules || [])];
    const idx = rules.findIndex((r) => r.id === id);
    const nextIdx = idx + direction;
    if (idx < 0 || nextIdx < 0 || nextIdx >= rules.length) return s;
    [rules[idx], rules[nextIdx]] = [rules[nextIdx], rules[idx]];
    return { ...s, splitTunnel: { ...s.splitTunnel, rules } };
  });
}

async function reorderRuleToTarget(sourceId, targetId) {
  await persist((s) => {
    const rules = [...(s.splitTunnel.rules || [])];
    const fromIdx = rules.findIndex((r) => r.id === sourceId);
    const toIdx = rules.findIndex((r) => r.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return s;
    const [moved] = rules.splice(fromIdx, 1);
    rules.splice(toIdx, 0, moved);
    return { ...s, splitTunnel: { ...s.splitTunnel, rules } };
  });
}

function confirmDelete(key, callback) {
  if (pendingDeleteKey !== key) {
    pendingDeleteKey = key;
    clearTimeout(pendingDeleteTimer);
    pendingDeleteTimer = setTimeout(() => {
      pendingDeleteKey = null;
      render();
    }, 3000);
    render();
    return;
  }
  pendingDeleteKey = null;
  clearTimeout(pendingDeleteTimer);
  callback();
}

function openRuleModal(rule = null) {
  editingRuleId = rule?.id || null;
  $('#ruleModalTitle').textContent = rule ? 'Edit rule' : 'Add rule';
  $('#ruleId').value = rule?.id || '';
  $('#rulePattern').value = rule?.pattern || '';
  $('#ruleMatchType').value = rule?.matchType || 'wildcard';
  $('#ruleAction').value = rule?.action || 'proxy';
  $('#ruleIncludeCompanions').checked = rule ? rule.includeCompanions !== false : true;

  const sel = $('#ruleProxyId');
  sel.innerHTML = '<option value="">Active proxy</option>';
  state.proxies.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} (${p.type.toUpperCase()})`;
    sel.appendChild(opt);
  });
  sel.value = rule?.proxyId || '';

  $('#ruleFormError').classList.add('hidden');
  syncRuleModalFields();
  updateBundleHint();
  $('#ruleModal').showModal();
}

function syncRuleModalFields() {
  const action = $('#ruleAction').value;
  const matchType = $('#ruleMatchType').value;
  $('#optRuleProxyField').classList.toggle('hidden', action === 'direct');
  $('#optCompanionsRow').classList.toggle('hidden', matchType === 'regex' || matchType === 'cidr');
}

function updateBundleHint() {
  const val = $('#rulePattern').value.trim();
  const hint = $('#optBundleHint');
  const bundle = findMatchingBundle(val);
  if (bundle) {
    hint.textContent = `${bundle.name} smart bundle detected — auto-includes ${bundle.domains.join(', ')}`;
    hint.classList.add('bundle-detected');
  } else {
    hint.textContent = 'Supports domains, wildcards, RegExp, or IPv4 CIDR';
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
      splitTunnel: { ...s.splitTunnel, enabled: true, rules: nextRules }
    };
  });
  $('#ruleModal').close();
  showToast('Rule saved', 'success');
}

async function deleteRule(id) {
  await persist((s) => ({
    ...s,
    splitTunnel: {
      ...s.splitTunnel,
      rules: (s.splitTunnel.rules || []).filter((r) => r.id !== id)
    }
  }));
  showToast('Rule deleted', 'success');
}

function openProxyModal(proxy = null) {
  editingProxyId = proxy?.id || null;
  $('#proxyModalTitle').textContent = proxy ? 'Edit proxy' : 'Add proxy';
  $('#proxyId').value = proxy?.id || '';
  $('#proxyQuickPaste').value = '';
  $('#proxyName').value = proxy?.name || '';
  $('#proxyBadge').value = proxy?.badgeText || '';
  $('#proxyHost').value = proxy?.host || '';
  $('#proxyPort').value = proxy?.port || '';
  $('#proxyType').value = proxy?.type || 'socks5';
  $('#proxyUser').value = proxy?.username || '';
  $('#proxyPass').value = proxy?.password || '';
  selectedColor = proxy?.color || PROXY_COLORS[state.proxies.length % PROXY_COLORS.length];
  syncColorSelection();

  const fb = $('#proxyFallback');
  fb.innerHTML = '<option value="">None</option>';
  state.proxies
    .filter((p) => p.id !== editingProxyId)
    .forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.type.toUpperCase()})`;
      fb.appendChild(opt);
    });
  fb.value = proxy?.fallbackProxyId || '';

  $('#formError').classList.add('hidden');
  $('#proxyModal').showModal();
}

async function onProxySubmit(e) {
  e.preventDefault();
  const data = {
    name: $('#proxyName').value,
    host: $('#proxyHost').value.trim(),
    port: $('#proxyPort').value,
    type: $('#proxyType').value
  };
  const errors = validateProxyInput(data);
  if (errors.length) {
    $('#formError').textContent = errors.join('. ');
    $('#formError').classList.remove('hidden');
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
    username: $('#proxyUser').value.trim(),
    password: $('#proxyPass').value,
    badgeText: (rawBadge || defaultBadge).slice(0, 4).toUpperCase(),
    color: selectedColor,
    fallbackProxyId: $('#proxyFallback').value || null
  };

  await persist((s) => {
    const exists = s.proxies.some((p) => p.id === id);
    const proxies = exists
      ? s.proxies.map((p) => (p.id === id ? entry : p))
      : [...s.proxies, entry];
    return { ...s, proxies, activeProxyId: s.activeProxyId || id };
  });
  $('#proxyModal').close();
  showToast('Proxy saved', 'success');
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

async function refreshControlStatus() {
  const status = await getProxyControlStatus();
  const box = $('#controlStatusBox');
  box.classList.toggle('conflict', status.conflict);
  if (status.conflict) {
    box.textContent = `Conflict detected: Chrome proxy is ${status.levelOfControl}. Disable conflicting VPN/proxy extensions.`;
  } else {
    box.textContent = `Healthy · Control: ${status.levelOfControl} · Active Chrome mode: ${status.mode}`;
  }
}

function onExportJson() {
  const includeCredentials = $('#exportIncludeCreds').checked;
  const json = exportStateJson(state, { includeCredentials });
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `axon-proxy-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Backup exported', 'success');
}

async function onCopyJson() {
  const includeCredentials = $('#exportIncludeCreds').checked;
  const json = exportStateJson(state, { includeCredentials });
  try {
    await navigator.clipboard.writeText(json);
    showToast('JSON copied to clipboard', 'success');
  } catch {
    showToast('Clipboard copy failed', 'error');
  }
}

function onImportFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $('#importJsonText').value = String(reader.result || '');
    onImportJsonClick();
  };
  reader.readAsText(file);
  e.target.value = '';
}

async function onImportJsonClick() {
  const raw = $('#importJsonText').value.trim();
  if (!raw) {
    showToast('Paste or select a JSON backup first', 'error');
    return;
  }
  const mode = $('#importMode').value;
  try {
    const merged = importStateJson(raw, state, { mode });
    await persist(() => merged);
    $('#importJsonText').value = '';
    showToast('Configuration imported', 'success');
  } catch (err) {
    showToast(err.message || 'Import failed', 'error');
  }
}

async function onBulkImportClick() {
  const raw = $('#bulkDomainText').value.trim();
  if (!raw) {
    showToast('Enter at least one domain to import', 'error');
    return;
  }
  const action = $('#bulkAction').value;
  const proxyId = action === 'direct' ? null : $('#bulkProxyId').value || null;
  const includeCompanions = $('#bulkCompanions').checked;

  const newRules = parseDomainListImport(raw, { action, proxyId, includeCompanions });
  if (!newRules.length) {
    showToast('No valid domains found', 'error');
    return;
  }

  await persist((s) => ({
    ...s,
    splitTunnel: {
      ...s.splitTunnel,
      enabled: true,
      rules: [...newRules, ...(s.splitTunnel.rules || [])]
    }
  }));
  $('#bulkDomainText').value = '';
  showToast(`Imported ${newRules.length} rules`, 'success');
}

function renderPacInspector() {
  const viewer = $('#pacCodeViewer');
  const meta = $('#pacMetaLabel');

  if (!state.enabled || !state.activeProxyId) {
    meta.textContent = 'mode: direct (disabled)';
    viewer.textContent = '// Axon Proxy is currently disabled — all traffic connects directly.';
    return;
  }

  const config = buildProxyConfigFromState(state);
  meta.textContent = `mode: ${config.mode}`;
  if (config.mode === 'pac_script') {
    viewer.textContent = config.pacScript.data;
  } else {
    viewer.textContent = JSON.stringify(config, null, 2);
  }
}

let activeOptToastTimer = null;

function showToast(message, type = 'success') {
  const container = $('#toastContainer');
  container.innerHTML = '';
  clearTimeout(activeOptToastTimer);
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  activeOptToastTimer = setTimeout(() => toast.remove(), 2400);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}

init();
