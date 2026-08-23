// ==UserScript==
// @name         公司 Mihomo 当前页面规则
// @namespace    local.droidzx.mihomo
// @version      1.8.1
// @description  页面角落一个小圆点，显示当前网页命中的 Mihomo 规则与实时流量
// @author       droidzx
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_unregisterMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      192.168.1.50
// @downloadURL  https://raw.githubusercontent.com/droidzx/userscripts/main/mihomo-dot.user.js
// @updateURL    https://raw.githubusercontent.com/droidzx/userscripts/main/mihomo-dot.user.js
// ==/UserScript==

(function () {
  'use strict';

  const API = 'http://192.168.1.50:9090';
  const SECRET = 'a2b63dabca9aa255d53c17cee45dbf0baeef20d13cfc3a69';

  // 展开时 1s 刷新，收起成小圆点时 3s，后台标签页完全不请求
  const POLL_OPEN = 1000;
  const POLL_IDLE = 3000;

  // 不做自己的显示/隐藏开关 —— Tampermonkey 弹出菜单里脚本本身就有启用开关，
  // 再造一个只会让人分不清当前是哪个状态。
  const KEYS = {
    position: 'mihomo-dot-position',
    pinned: 'mihomo-dot-pinned',
    sourceIP: 'mihomo-source-ip',
  };

  let observedDomains = new Set();
  let pollTimer = null;
  let activeRequest = null;
  let retryDelay = 1000;
  let connected = false;
  let latestConnections = [];
  let currentPageUrl = location.href;
  let previousTraffic = new Map();
  let previousTrafficAt = 0;
  let expanded = false;
  let hoverCloseTimer = null;

  // /connections 是整个旁路由的全局连接表，不按 sourceIP 过滤会混进别的设备。
  // 优先用手动设定值；否则由 learnSourceIP() 从本页域名的连接里投票选出本机 IP。
  let sourceIP = GM_getValue(KEYS.sourceIP, '') || '';
  const sourceVotes = new Map();
  let staleCount = 0;

  let root, dot, panel, statusEl, listEl, countEl, titleEl;

  /* ---------- 工具 ---------- */

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function normalizeHost(value) {
    if (!value) return '';
    let host = String(value).trim().toLowerCase();
    if (host.startsWith('[')) {
      const close = host.indexOf(']');
      return close > 0 ? host.slice(1, close) : host;
    }
    return host.replace(/:\d+$/, '').replace(/\.$/, '');
  }

  function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = bytes / 1024;
    let i = 0;
    while (amount >= 1024 && i < units.length - 1) { amount /= 1024; i += 1; }
    return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[i]}`;
  }

  /* ---------- 观察本页用到的域名 ---------- */

  function rememberUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (!/^(https?|wss?):$/.test(url.protocol)) return;
      const host = normalizeHost(url.hostname);
      if (host && !observedDomains.has(host)) {
        observedDomains.add(host);
        queueMicrotask(refreshFromCache);
      }
    } catch (_) { /* 非 URL 的 performance entry */ }
  }

  function monitorPageRequests() {
    observedDomains.add(normalizeHost(location.hostname));

    const scanEntries = () => {
      try {
        for (const e of performance.getEntriesByType('resource')) rememberUrl(e.name);
      } catch (_) { /* 沙箱不提供 Performance API */ }
    };
    scanEntries();

    try {
      const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) rememberUrl(e.name); });
      obs.observe({ type: 'resource', buffered: true });
    } catch (_) {
      try {
        const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) rememberUrl(e.name); });
        obs.observe({ entryTypes: ['resource'] });
      } catch (__) { /* 观察不了就只靠下面的定时补扫 */ }
    }

    // 定时补扫，兜住 PerformanceObserver 漏掉的条目；页面隐藏时不扫
    setInterval(() => { if (!document.hidden) scanEntries(); }, 2000);
  }

  function isCurrentPageDomain(host) {
    const h = normalizeHost(host);
    if (!h) return false;
    if (observedDomains.has(h)) return true;
    for (const d of observedDomains) if (h.endsWith(`.${d}`)) return true;
    return false;
  }

  /* ---------- 本机 IP 识别 ---------- */

  function learnSourceIP(connections) {
    // 已锁定：只做失效检测。IP 变了（DHCP 续约、换网络）就重新识别，
    // 否则面板会一直是空的，而圆点还是绿的，看不出哪里不对。
    if (sourceIP) {
      const mine = connections.some((c) => (c.metadata || {}).sourceIP === sourceIP);
      staleCount = mine || !connections.length ? 0 : staleCount + 1;
      if (staleCount >= 20) {
        sourceIP = '';
        staleCount = 0;
        sourceVotes.clear();
        GM_setValue(KEYS.sourceIP, '');
      }
      return;
    }

    // 用「属于本页的域名」投票，而不是只认主文档域名 —— 主文档那条连接
    // 早就关闭了，子域（cdn、api、埋点）才是连接表里长期存在的。
    for (const c of connections) {
      const m = c.metadata || {};
      if (!isCurrentPageDomain(m.host || m.sniffHost)) continue;
      const ip = m.sourceIP;
      if (ip) sourceVotes.set(ip, (sourceVotes.get(ip) || 0) + 1);
    }

    let best = '';
    let bestN = 0;
    let runnerUp = 0;
    for (const [ip, n] of sourceVotes) {
      if (n > bestN) { runnerUp = bestN; best = ip; bestN = n; }
      else if (n > runnerUp) { runnerUp = n; }
    }
    // 要够票，且明显领先第二名，避免别的设备刚好也在看同一个站时选错
    if (best && bestN >= 5 && bestN >= runnerUp * 2) {
      sourceIP = best;
      GM_setValue(KEYS.sourceIP, best);
    }
  }

  /* ---------- 渲染 ---------- */

  function refreshFromCache() {
    if (!listEl || !latestConnections.length) return;
    render(latestConnections, false);
  }

  function setDotState(state) {
    if (dot) dot.dataset.state = state;
  }

  function render(connections, measureSpeed = true) {
    const now = Date.now();
    const elapsed = previousTrafficAt ? Math.max((now - previousTrafficAt) / 1000, 0.1) : 0;
    const nextTraffic = new Map();
    const groups = new Map();
    let totalUp = 0;
    let totalDown = 0;
    let totalUpDelta = 0;
    let totalDownDelta = 0;

    for (const c of connections) {
      const m = c.metadata || {};
      if (sourceIP && m.sourceIP !== sourceIP) continue;

      const host = normalizeHost(m.host || m.sniffHost);
      const up = Math.max(0, Number(c.upload) || 0);
      const down = Math.max(0, Number(c.download) || 0);
      const key = String(c.id || `${host}|${c.start || ''}`);
      nextTraffic.set(key, { up, down });
      if (!isCurrentPageDomain(host)) continue;

      const rule = c.rule || '未知规则';
      const payload = c.rulePayload || '';
      const chain = Array.isArray(c.chains) && c.chains.length ? c.chains[0] : '';
      const gk = `${rule}|${payload}`;
      let g = groups.get(gk);
      if (!g) {
        g = { rule, payload, chain, up: 0, down: 0, upDelta: 0, downDelta: 0, hosts: new Map() };
        groups.set(gk, g);
      }
      let h = g.hosts.get(host);
      if (!h) { h = { host, up: 0, down: 0, delta: 0 }; g.hosts.set(host, h); }
      g.up += up; g.down += down; h.up += up; h.down += down;
      totalUp += up; totalDown += down;

      if (measureSpeed && elapsed) {
        const prev = previousTraffic.get(key);
        if (prev) {
          const du = Math.max(0, up - prev.up);
          const dd = Math.max(0, down - prev.down);
          g.upDelta += du; g.downDelta += dd; h.delta += du + dd;
          totalUpDelta += du; totalDownDelta += dd;
        }
      }
    }

    if (measureSpeed) { previousTraffic = nextTraffic; previousTrafficAt = now; }

    const busy = totalUpDelta + totalDownDelta > 0;
    setDotState(connected ? (busy ? 'active' : 'connected') : 'error');
    if (countEl) countEl.textContent = String(groups.size);
    if (dot) {
      dot.title = connected
        ? `Mihomo · ${groups.size} 条规则 · ↑${formatBytes(totalUp)} ↓${formatBytes(totalDown)}`
        : 'Mihomo 未连接';
    }

    if (!expanded || !listEl) return;

    if (statusEl) {
      statusEl.textContent = connected
        ? `${sourceIP || '本机 IP 识别中'} · 本页域名 ${observedDomains.size} · 全局连接 ${connections.length}`
        : `连接失败，${Math.round(retryDelay / 1000)} 秒后重试`;
      statusEl.dataset.state = connected ? 'ok' : 'error';
    }
    if (titleEl) {
      titleEl.textContent = busy
        ? `↑ ${formatBytes(totalUpDelta / (elapsed || 1))}/s   ↓ ${formatBytes(totalDownDelta / (elapsed || 1))}/s`
        : `↑ ${formatBytes(totalUp)}   ↓ ${formatBytes(totalDown)}`;
    }

    const cmp = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
    const sorted = [...groups.values()].sort((a, b) => (
      cmp(a.payload || a.rule, b.payload || b.rule) || cmp(a.rule, b.rule)
    ));
    const scroll = listEl.scrollTop;

    if (!sorted.length) {
      listEl.replaceChildren(el('div', 'empty',
        connected ? `本页 ${observedDomains.size} 个域名暂无活动连接` : '等待连接 Mihomo…'));
      listEl.scrollTop = scroll;
      return;
    }

    listEl.replaceChildren(...sorted.map((g) => {
      const hot = g.upDelta + g.downDelta > 0;
      const item = el('section', hot ? 'grp hot' : 'grp');
      const head = el('div', 'grp-head');
      const info = el('div', 'grp-info');
      info.appendChild(el('div', 'rule', g.payload || g.rule));
      const sub = [g.payload ? g.rule : '', g.chain].filter(Boolean).join(' · ');
      if (sub) info.appendChild(el('div', 'sub', sub));
      head.appendChild(info);
      if (hot) head.appendChild(el('span', 'hot-tag', '传输中'));
      item.appendChild(head);
      item.appendChild(el('div', 'traffic', `↑ ${formatBytes(g.up)}   ↓ ${formatBytes(g.down)}`));

      const hosts = el('div', 'hosts');
      for (const h of [...g.hosts.values()].sort((a, b) => cmp(a.host, b.host))) {
        const row = el('div', h.delta > 0 ? 'host-row on' : 'host-row');
        row.appendChild(el('span', 'led'));
        row.appendChild(el('span', 'host', h.host));
        row.appendChild(el('span', 'ht', `↑${formatBytes(h.up)} ↓${formatBytes(h.down)}`));
        hosts.appendChild(row);
      }
      item.appendChild(hosts);
      return item;
    }));
    listEl.scrollTop = scroll;
  }

  /* ---------- 轮询 ---------- */

  function schedule(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  function onFailure() {
    activeRequest = null;
    connected = false;
    setDotState('error');
    if (statusEl) {
      statusEl.textContent = `连接失败，${Math.round(retryDelay / 1000)} 秒后重试`;
      statusEl.dataset.state = 'error';
    }
    schedule(retryDelay);
    retryDelay = Math.min(retryDelay + 500, 5000);
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (activeRequest) return;
    if (document.hidden) { schedule(POLL_IDLE); return; }

    activeRequest = GM_xmlhttpRequest({
      method: 'GET',
      url: `${API}/connections`,
      headers: { Authorization: `Bearer ${SECRET}` },
      timeout: 4000,
      onload(res) {
        activeRequest = null;
        if (res.status === 401) {
          connected = false;
          setDotState('error');
          if (statusEl) {
            statusEl.textContent = 'Mihomo 拒绝鉴权，检查脚本顶部的 SECRET';
            statusEl.dataset.state = 'error';
          }
          schedule(10000);
          return;
        }
        if (res.status !== 200) { onFailure(); return; }
        try {
          const data = JSON.parse(res.responseText);
          if (!Array.isArray(data.connections)) throw new Error('bad payload');
          connected = true;
          retryDelay = 1000;
          latestConnections = data.connections;
          learnSourceIP(latestConnections);
          render(latestConnections);
          schedule(expanded ? POLL_OPEN : POLL_IDLE);
        } catch (_) { onFailure(); }
      },
      onerror: onFailure,
      ontimeout: onFailure,
    });
  }

  function restart() {
    clearTimeout(pollTimer);
    activeRequest?.abort?.();
    activeRequest = null;
    connected = false;
    retryDelay = 1000;
    poll();
  }

  /* ---------- SPA 换页 ---------- */

  function checkPageChange() {
    if (location.href === currentPageUrl) return;
    currentPageUrl = location.href;
    // 换页必须清空，否则旧页面的第三方域名会一直被算进「本页」
    observedDomains = new Set([normalizeHost(location.hostname)]);
    previousTraffic = new Map();
    previousTrafficAt = 0;
    refreshFromCache();
  }

  /* ---------- UI ---------- */

  function savePosition() {
    const r = root.getBoundingClientRect();
    GM_setValue(KEYS.position, { left: r.left, top: r.top });
  }

  function restorePosition() {
    const p = GM_getValue(KEYS.position, null);
    if (!p || typeof p.left !== 'number') return;
    root.style.left = `${Math.min(Math.max(6, p.left), Math.max(6, window.innerWidth - 26))}px`;
    root.style.top = `${Math.min(Math.max(6, p.top), Math.max(6, window.innerHeight - 26))}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  // 面板默认向左上方展开。圆点被拖到左边或顶部时那个方向没有空间，
  // 面板会被视口边缘切掉，所以展开前先按可用空间翻转锚点。
  function anchorPanel() {
    const r = root.getBoundingClientRect();
    const margin = 8;
    // visibility:hidden 仍然有布局，展开前就能量到尺寸
    const w = panel.offsetWidth || 340;
    const h = panel.offsetHeight || 260;
    panel.classList.toggle('to-right', r.right - w < margin);
    panel.classList.toggle('to-bottom', r.bottom - 22 - h < margin);
  }

  function setExpanded(on) {
    expanded = on;
    if (on) anchorPanel();
    panel.classList.toggle('open', on);
    if (on) { refreshFromCache(); restart(); }
  }

  function enableDrag() {
    dot.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const r = root.getBoundingClientRect();
      const ox = ev.clientX - r.left;
      const oy = ev.clientY - r.top;
      let moved = false;
      dot.setPointerCapture(ev.pointerId);

      const move = (e) => {
        if (Math.abs(e.clientX - r.left - ox) + Math.abs(e.clientY - r.top - oy) > 3) moved = true;
        root.style.left = `${Math.min(Math.max(0, e.clientX - ox), window.innerWidth - 20)}px`;
        root.style.top = `${Math.min(Math.max(0, e.clientY - oy), window.innerHeight - 20)}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      };
      const up = () => {
        dot.removeEventListener('pointermove', move);
        dot.removeEventListener('pointerup', up);
        if (moved) { savePosition(); return; }
        const pinned = !panel.classList.contains('pinned');
        panel.classList.toggle('pinned', pinned);
        GM_setValue(KEYS.pinned, pinned);
        setExpanded(pinned);
      };
      dot.addEventListener('pointermove', move);
      dot.addEventListener('pointerup', up);
    });
  }

  function buildUi() {
    root = el('div');
    root.id = 'mihomo-dot-root';
    const shadow = root.attachShadow({ mode: 'open' });

    const style = el('style');
    style.textContent = `
      :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; }
      .wrap { position: relative; font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .dot { width: 12px; height: 12px; border-radius: 50%; cursor: pointer; background: #64748b;
        box-shadow: 0 0 0 3px rgba(15,23,42,.28), 0 2px 6px rgba(0,0,0,.3);
        transition: background .2s ease, transform .15s ease; }
      .dot:hover { transform: scale(1.35); }
      .dot[data-state="connected"] { background: #4ade80; }
      .dot[data-state="active"] { background: #38bdf8; animation: pulse 1.1s ease-in-out infinite; }
      .dot[data-state="error"] { background: #f87171; }
      @keyframes pulse {
        0%, 100% { box-shadow: 0 0 0 3px rgba(15,23,42,.28), 0 0 6px 2px rgba(56,189,248,.85); }
        50% { box-shadow: 0 0 0 3px rgba(15,23,42,.28), 0 0 12px 5px rgba(56,189,248,.35); }
      }
      .panel { position: absolute; right: 0; bottom: 22px; width: 340px; max-width: calc(100vw - 32px);
        color: #e5edf8; background: linear-gradient(160deg, rgba(15,23,42,.98), rgba(10,17,31,.97));
        border: 1px solid rgba(125,211,252,.18); border-radius: 14px; overflow: hidden;
        box-shadow: 0 18px 55px rgba(0,0,0,.45); backdrop-filter: blur(16px);
        opacity: 0; visibility: hidden; transform: translateY(6px);
        transition: opacity .16s ease, transform .16s ease, visibility .16s; }
      .panel.open { opacity: 1; visibility: visible; transform: translateY(0); }
      .panel.to-right { right: auto; left: 0; }
      .panel.to-bottom { bottom: auto; top: 22px; }
      .head { display: flex; align-items: center; gap: 8px; padding: 9px 11px;
        background: rgba(30,41,59,.62); border-bottom: 1px solid rgba(148,163,184,.12); }
      .head .t { flex: 1; font-weight: 700; color: #f1f5f9; font-variant-numeric: tabular-nums; }
      .badge { padding: 2px 7px; border-radius: 999px; background: rgba(56,189,248,.12); color: #7dd3fc; }
      .status { padding: 6px 11px; color: #86efac; background: rgba(15,23,42,.42);
        border-bottom: 1px solid rgba(148,163,184,.09); font-size: 11px; }
      .status[data-state="error"] { color: #fca5a5; }
      .list { max-height: min(46vh, 440px); overflow: auto; padding: 7px; }
      .grp { margin-bottom: 6px; border: 1px solid rgba(148,163,184,.12); border-radius: 10px;
        background: rgba(30,41,59,.42); overflow: hidden; }
      .grp:last-child { margin-bottom: 0; }
      .grp.hot { border-color: rgba(56,189,248,.3); }
      .grp-head { display: flex; align-items: center; gap: 8px; padding: 7px 9px 2px; }
      .grp-info { min-width: 0; flex: 1; }
      .rule { color: #fdba74; font-weight: 700; overflow-wrap: anywhere; }
      .sub { color: #64748b; font-size: 10.5px; }
      .hot-tag { color: #7dd3fc; font-size: 11px; white-space: nowrap; }
      .traffic { padding: 0 9px 6px; color: #94a3b8; font-variant-numeric: tabular-nums; }
      .hosts { border-top: 1px solid rgba(148,163,184,.09); background: rgba(2,6,23,.16); }
      .host-row { display: grid; grid-template-columns: 6px minmax(0,1fr) auto; align-items: center;
        gap: 7px; padding: 4px 9px; border-bottom: 1px solid rgba(148,163,184,.07); }
      .host-row:last-child { border-bottom: 0; }
      .led { width: 6px; height: 6px; border-radius: 50%; background: #475569; }
      .host-row.on .led { background: #38bdf8; box-shadow: 0 0 7px rgba(56,189,248,.9); }
      .host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #bae6fd; }
      .ht { color: #64748b; font-size: 10.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .empty { padding: 20px 8px; text-align: center; color: #94a3b8; }
      ::-webkit-scrollbar { width: 6px; }
      ::-webkit-scrollbar-thumb { background: #475569; border-radius: 6px; }
      .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 7px 11px;
        border-top: 1px solid rgba(148,163,184,.12); background: rgba(2,6,23,.28);
        color: #64748b; font-size: 10.5px; }
      .lg-item { display: inline-flex; align-items: center; gap: 5px; }
      .lg-dot { width: 7px; height: 7px; border-radius: 50%; background: #64748b; }
      .lg-dot[data-state="connected"] { background: #4ade80; }
      .lg-dot[data-state="active"] { background: #38bdf8; }
      .lg-dot[data-state="error"] { background: #f87171; }
    `;

    const wrap = el('div', 'wrap');
    dot = el('div', 'dot');
    dot.dataset.state = 'idle';
    dot.title = 'Mihomo 正在连接…';

    panel = el('div', 'panel');
    const head = el('div', 'head');
    titleEl = el('div', 't', '—');
    countEl = el('span', 'badge', '0');
    head.append(titleEl, countEl);
    statusEl = el('div', 'status', '正在连接…');
    listEl = el('div', 'list');
    // 圆点颜色的含义，否则只有写脚本的人知道绿的蓝的是什么
    const legend = el('div', 'legend');
    for (const [state, text] of [
      ['connected', '已连接'],
      ['active', '传输中'],
      ['error', '连不上'],
      ['idle', '待机'],
    ]) {
      const item = el('span', 'lg-item');
      const swatch = el('span', 'lg-dot');
      swatch.dataset.state = state;
      item.append(swatch, el('span', undefined, text));
      legend.appendChild(item);
    }
    listEl.appendChild(el('div', 'empty', '等待本页产生网络请求…'));
    panel.append(head, statusEl, listEl, legend);

    // 悬停展开，点一下固定
    dot.addEventListener('mouseenter', () => {
      clearTimeout(hoverCloseTimer);
      setExpanded(true);
    });
    const maybeClose = () => {
      clearTimeout(hoverCloseTimer);
      if (panel.classList.contains('pinned')) return;
      hoverCloseTimer = setTimeout(() => setExpanded(false), 260);
    };
    dot.addEventListener('mouseleave', maybeClose);
    panel.addEventListener('mouseenter', () => clearTimeout(hoverCloseTimer));
    panel.addEventListener('mouseleave', maybeClose);

    wrap.append(panel, dot);
    shadow.append(style, wrap);
    document.documentElement.appendChild(root);

    enableDrag();
    restorePosition();
    if (GM_getValue(KEYS.pinned, false)) {
      panel.classList.add('pinned');
      setExpanded(true);
    }
  }

  // 菜单标签要反映当前状态，否则「显示 / 隐藏」这种写死的标签看不出点了会发生什么。
  // Tampermonkey 的标签是静态的，只能注销后重新注册。
  const menuIds = [];

  function registerMenus() {
    if (typeof GM_unregisterMenuCommand === 'function') {
      for (const id of menuIds.splice(0)) {
        try { GM_unregisterMenuCommand(id); } catch (_) { /* 旧版可能不支持 */ }
      }
    }
    menuIds.push(GM_registerMenuCommand('立即重新连接', restart));
    menuIds.push(GM_registerMenuCommand(`设定本机 IP（当前 ${sourceIP || '自动识别'}）`, () => {
      const v = prompt('只显示这个来源 IP 的连接，留空则自动识别：', sourceIP || '');
      if (v === null) return;
      sourceIP = v.trim();
      sourceVotes.clear();
      staleCount = 0;
      GM_setValue(KEYS.sourceIP, sourceIP);
      registerMenus();
      refreshFromCache();
    }));
  }


  /* ---------- 启动 ---------- */

  monitorPageRequests();
  buildUi();
  registerMenus();
  restart();

  setInterval(checkPageChange, 700);
  window.addEventListener('popstate', checkPageChange);
  window.addEventListener('hashchange', checkPageChange);
  window.addEventListener('online', restart);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) restart();
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(pollTimer);
    activeRequest?.abort?.();
  });
})();
