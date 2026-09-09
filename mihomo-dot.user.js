// ==UserScript==
// @name         Mihomo 监控
// @namespace    local.droidzx.mihomo
// @version      1.9.1
// @description  页面角落一个小圆点，显示当前网页的 Mihomo 策略、传输域名与实时流量
// @author       droidzx
// @match        *://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
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
  const RECENT_TTL = 8000;

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
  let recentActivity = new Map();
  let expanded = false;
  let hoverCloseTimer = null;

  // /connections 是整个旁路由的全局连接表，不按 sourceIP 过滤会混进别的设备。
  // 复用上次自动识别的值；失效后由 learnSourceIP() 从本页域名的连接里重新投票识别。
  let sourceIP = GM_getValue(KEYS.sourceIP, '') || '';
  const sourceVotes = new Map();
  let staleCount = 0;

  let root, dot, panel, statusEl, listEl, countEl, strategyEl, upSpeedEl, downSpeedEl, pinEl, brandMarkEl;

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
    if (!listEl) return;
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
    let totalUpDelta = 0;
    let totalDownDelta = 0;

    const getGroup = (rule, payload, chain) => {
      const gk = `${rule}|${payload}`;
      let g = groups.get(gk);
      if (!g) {
        g = { rule, payload, chain, upDelta: 0, downDelta: 0, hosts: new Map() };
        groups.set(gk, g);
      }
      return g;
    };

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
      const chain = Array.isArray(c.chains) ? c.chains.filter(Boolean).join(' · ') : '';
      const g = getGroup(rule, payload, chain);
      let h = g.hosts.get(host);
      if (!h) { h = { host, delta: 0 }; g.hosts.set(host, h); }

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

    const activeGroups = [...groups.values()].map((g) => ({
      ...g,
      hosts: new Map([...g.hosts].filter(([, h]) => h.delta > 0)),
    })).filter((g) => g.hosts.size > 0);
    const domainCount = new Set(activeGroups.flatMap((g) => [...g.hosts.keys()])).size;

    // 短连接常在一个轮询周期内就结束，停止传输后短暂保留，让人有时间看清。
    for (const item of recentActivity.values()) item.active = false;
    if (measureSpeed && elapsed) {
      for (const g of activeGroups) {
        for (const h of g.hosts.values()) {
          const key = `${g.rule}|${g.payload}|${g.chain}|${h.host}`;
          recentActivity.set(key, {
            rule: g.rule,
            payload: g.payload,
            chain: g.chain,
            host: h.host,
            speed: h.delta / elapsed,
            active: true,
            lastActiveAt: now,
          });
        }
      }
    }
    for (const [key, item] of recentActivity) {
      if (now - item.lastActiveAt > RECENT_TTL) recentActivity.delete(key);
    }

    const displayGroups = new Map();
    for (const item of recentActivity.values()) {
      const key = `${item.rule}|${item.payload}|${item.chain}`;
      let group = displayGroups.get(key);
      if (!group) {
        group = { rule: item.rule, payload: item.payload, chain: item.chain, activeSpeed: 0, lastActiveAt: 0, hosts: new Map() };
        displayGroups.set(key, group);
      }
      group.hosts.set(item.host, item);
      group.lastActiveAt = Math.max(group.lastActiveAt, item.lastActiveAt);
      if (item.active) group.activeSpeed += item.speed;
    }

    if (measureSpeed) { previousTraffic = nextTraffic; previousTrafficAt = now; }

    const busy = totalUpDelta + totalDownDelta > 0;
    setDotState(connected ? (busy ? 'active' : 'connected') : 'error');
    if (brandMarkEl) {
      brandMarkEl.classList.toggle('active', busy);
    }
    if (countEl) countEl.textContent = busy
      ? `${domainCount} 传输中`
      : recentActivity.size ? `${recentActivity.size} 刚刚` : '空闲';
    if (dot) {
      dot.title = connected
        ? `本页 ${domainCount} 个域名 · ↑${formatBytes(totalUpDelta / (elapsed || 1))}/s ↓${formatBytes(totalDownDelta / (elapsed || 1))}/s`
        : 'Mihomo 连接失败';
    }

    if (!expanded || !listEl) return;

    if (statusEl) {
      if (connected) {
        statusEl.dataset.state = 'ok';
      } else {
        statusEl.textContent = `连接失败，${Math.round(retryDelay / 1000)} 秒后重试`;
        statusEl.dataset.state = 'error';
      }
    }
    if (upSpeedEl) upSpeedEl.textContent = `${formatBytes(totalUpDelta / (elapsed || 1))}/s`;
    if (downSpeedEl) downSpeedEl.textContent = `${formatBytes(totalDownDelta / (elapsed || 1))}/s`;

    const cmp = (a, b) => a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
    const sorted = [...displayGroups.values()].sort((a, b) => (
      b.activeSpeed - a.activeSpeed
      || b.lastActiveAt - a.lastActiveAt
      || cmp(a.payload || a.rule, b.payload || b.rule) || cmp(a.rule, b.rule)
    ));
    const strategies = sorted.map((g) => g.payload || g.rule)
      .filter((name, index, all) => all.indexOf(name) === index);
    if (strategyEl) strategyEl.textContent = strategies.length ? strategies.join(' · ') : '暂无传输';
    const scroll = listEl.scrollTop;

    if (!sorted.length) {
      listEl.replaceChildren(el('div', 'empty', connected ? '当前没有正在传输的域名' : '等待连接 Mihomo…'));
      listEl.scrollTop = scroll;
      return;
    }

    listEl.replaceChildren(...sorted.map((g) => {
      const item = el('section', 'grp');
      const head = el('div', 'grp-head');
      const info = el('div', 'grp-info');
      info.appendChild(el('div', 'rule', g.payload || g.rule));
      const sub = [g.payload ? g.rule : '', g.chain].filter(Boolean).join(' · ');
      if (sub) info.appendChild(el('div', 'sub', sub));
      head.appendChild(info);
      head.appendChild(el('span', g.activeSpeed > 0 ? 'hot-tag' : 'hot-tag recent',
        g.activeSpeed > 0 ? formatBytes(g.activeSpeed) + '/s' : '刚刚'));
      item.appendChild(head);

      const hosts = el('div', 'hosts');
      for (const h of [...g.hosts.values()].sort((a, b) => cmp(a.host, b.host))) {
        const row = el('div', h.active ? 'host-row on' : 'host-row recent');
        row.appendChild(el('span', 'led'));
        row.appendChild(el('span', 'host', h.host));
        row.appendChild(el('span', 'ht', h.active ? formatBytes(h.speed) + '/s' : '刚刚'));
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
    if (strategyEl) strategyEl.textContent = '连接失败';
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
          if (strategyEl) strategyEl.textContent = '鉴权失败';
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
    recentActivity = new Map();
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

  function setPinned(on, save = true) {
    panel.classList.toggle('pinned', on);
    pinEl.classList.toggle('on', on);
    pinEl.textContent = on ? '已固定' : '固定';
    pinEl.title = on ? '取消固定，移出面板后自动收起' : '固定面板，保持展开';
    pinEl.setAttribute('aria-pressed', String(on));
    if (save) GM_setValue(KEYS.pinned, on);
    if (on) setExpanded(true);
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
        if (moved) savePosition();
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
      .wrap { position: relative; font: 12px/1.45 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .dot { width: 12px; height: 12px; border-radius: 50%; cursor: pointer; background: #64748b;
        border: 2px solid rgba(255,255,255,.9); box-sizing: border-box;
        box-shadow: 0 0 0 3px rgba(15,23,42,.42), 0 3px 10px rgba(0,0,0,.35);
        transition: background .2s ease, transform .15s ease, box-shadow .2s ease; }
      .dot:hover { transform: scale(1.3); }
      .dot[data-state="connected"] { background: #64748b; }
      .dot[data-state="active"] { background: #42d3a4; animation: pulse 1.1s ease-in-out infinite; }
      .dot[data-state="error"] { background: #fb7185; }
      @keyframes pulse {
        0%, 100% { box-shadow: 0 0 0 3px rgba(15,23,42,.42), 0 0 7px 2px rgba(61,220,151,.75); }
        50% { box-shadow: 0 0 0 3px rgba(15,23,42,.42), 0 0 14px 6px rgba(61,220,151,.28); }
      }
      .panel { position: absolute; right: 0; bottom: 22px; width: 332px; max-width: calc(100vw - 24px);
        color: #e8f0ec; background: rgba(9,16,12,.97); backdrop-filter: blur(18px);
        border: 1px solid rgba(125,220,174,.2); border-radius: 18px; overflow: hidden;
        box-shadow: 0 26px 80px rgba(0,0,0,.58), 0 0 0 1px rgba(255,255,255,.025) inset;
        opacity: 0; visibility: hidden; transform: translateY(7px) scale(.985); transform-origin: bottom right;
        transition: opacity .16s ease, transform .16s ease, visibility .16s; }
      .panel.open { opacity: 1; visibility: visible; transform: translateY(0); }
      .panel.to-right { right: auto; left: 0; }
      .panel.to-bottom { bottom: auto; top: 22px; }
      .panel.to-right { transform-origin: bottom left; }
      .head { padding: 14px; background: radial-gradient(circle at 85% -20%, rgba(61,220,151,.16), transparent 48%), linear-gradient(145deg, #16271e, #101b15);
        border-bottom: 1px solid rgba(148,196,174,.13); }
      .topline { display: flex; align-items: center; gap: 8px; margin-bottom: 13px; }
      .brand { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1;
        color: #f3faf6; font-size: 12px; font-weight: 750; letter-spacing: .08em; text-transform: uppercase; }
      .brand-mark { width: 7px; height: 7px; border-radius: 50%; background: #5f756a; }
      .brand-mark.active { background: #3ddc97; box-shadow: 0 0 9px rgba(61,220,151,.72); }
      .badge { padding: 2px 7px; border-radius: 999px; background: rgba(61,220,151,.1);
        color: #8ce9bd; font-size: 10.5px; font-weight: 600; letter-spacing: 0; text-transform: none; }
      .pin { border: 1px solid rgba(148,196,174,.18); border-radius: 8px; padding: 4px 8px;
        background: rgba(255,255,255,.045); color: #91a99d; cursor: pointer; font: inherit; font-size: 11px; }
      .pin:hover { background: rgba(255,255,255,.09); color: #f4fbf7; }
      .pin.on { color: #b6f4d4; background: rgba(61,220,151,.13); border-color: rgba(61,220,151,.35); }
      .strategy { margin-bottom: 9px; padding: 10px 11px; border: 1px solid rgba(61,220,151,.18);
        border-radius: 12px; background: linear-gradient(135deg, rgba(61,220,151,.11), rgba(61,220,151,.035)); }
      .strategy-label { display: block; margin-bottom: 3px; color: #759384; font-size: 10px; letter-spacing: .08em; }
      .strategy-value { display: block; overflow: hidden; color: #b8f5d5; font-size: 15px; line-height: 1.3;
        font-weight: 760; text-overflow: ellipsis; white-space: nowrap; }
      .metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
      .metric { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0;
        padding: 7px 9px; border: 1px solid rgba(148,196,174,.09); border-radius: 9px; background: rgba(5,13,9,.28); }
      .metric-label { display: block; margin-bottom: 2px; color: #769184; font-size: 10px; }
      .metric-value { display: block; overflow: hidden; color: #f2f8f5; font-size: 15px; line-height: 1.25;
        font-weight: 720; font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
      .metric.down .metric-value { color: #72e5aa; }
      .status { padding: 7px 12px; color: #86efac; background: rgba(11,25,17,.92);
        border-bottom: 1px solid rgba(148,196,174,.1); font-size: 11px; }
      .status[data-state="ok"] { display: none; }
      .status[data-state="error"] { color: #fda4af; background: rgba(76,20,31,.35); }
      .list { max-height: min(42vh, 380px); overflow: auto; padding: 8px; background: rgba(7,12,9,.76); }
      .grp { position: relative; margin-bottom: 7px; border: 1px solid rgba(61,220,151,.16); border-radius: 12px;
        background: linear-gradient(145deg, rgba(22,37,29,.96), rgba(15,26,20,.96)); overflow: hidden; }
      .grp:last-child { margin-bottom: 0; }
      .grp::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 2px; background: #3ddc97;
        box-shadow: 0 0 9px rgba(61,220,151,.5); }
      .grp-head { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 7px 10px 7px 12px; }
      .grp-info { min-width: 0; flex: 1; }
      .rule { color: #f1f7f3; font-weight: 680; overflow-wrap: anywhere; }
      .sub { margin-top: 1px; color: #657d71; font-size: 10.5px; }
      .hot-tag { padding: 2px 7px; border-radius: 999px; color: #78e8ae; background: rgba(61,220,151,.1);
        font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .hot-tag.recent { color: #81978c; background: rgba(255,255,255,.04); }
      .hosts { border-top: 1px solid rgba(148,196,174,.08); background: rgba(4,10,7,.22); }
      .host-row { display: grid; grid-template-columns: 6px minmax(0,1fr) auto; align-items: center;
        gap: 8px; min-height: 27px; padding: 3px 10px 3px 12px; border-bottom: 1px solid rgba(148,196,174,.055); }
      .host-row:last-child { border-bottom: 0; }
      .led { width: 5px; height: 5px; border-radius: 50%; background: #3c5549; }
      .host-row.on .led { background: #3ddc97; box-shadow: 0 0 7px rgba(61,220,151,.9); }
      .host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c5d6cd; }
      .host-row.on .host { color: #effaf4; }
      .host-row.recent { opacity: .58; }
      .ht { min-width: 54px; padding: 2px 6px; border-radius: 6px; color: #7e978a; background: rgba(255,255,255,.035);
        text-align: right; font-size: 10.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .host-row.on .ht { color: #9aebc2; background: rgba(61,220,151,.08); }
      .empty { padding: 28px 8px; text-align: center; color: #647a6e; }
      ::-webkit-scrollbar { width: 5px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #354d41; border-radius: 6px; }
    `;

    const wrap = el('div', 'wrap');
    dot = el('div', 'dot');
    dot.dataset.state = 'idle';
    dot.title = 'Mihomo 正在连接…';

    panel = el('div', 'panel');
    const head = el('div', 'head');
    const topline = el('div', 'topline');
    const brand = el('div', 'brand');
    brandMarkEl = el('span', 'brand-mark');
    brand.append(brandMarkEl, el('span', '', 'Mihomo'), countEl = el('span', 'badge', '空闲'));
    pinEl = el('button', 'pin', '固定');
    pinEl.type = 'button';
    pinEl.addEventListener('click', () => setPinned(!panel.classList.contains('pinned')));
    topline.append(brand, pinEl);
    const strategy = el('div', 'strategy');
    strategy.append(el('span', 'strategy-label', '当前策略'), strategyEl = el('strong', 'strategy-value', '暂无传输'));
    const metrics = el('div', 'metrics');
    const upMetric = el('div', 'metric up');
    upMetric.append(el('span', 'metric-label', 'Mihomo ↑ 上传'), upSpeedEl = el('strong', 'metric-value', '0 B/s'));
    const downMetric = el('div', 'metric down');
    downMetric.append(el('span', 'metric-label', 'Mihomo ↓ 下载'), downSpeedEl = el('strong', 'metric-value', '0 B/s'));
    metrics.append(upMetric, downMetric);
    head.append(topline, strategy, metrics);
    statusEl = el('div', 'status', '正在连接…');
    listEl = el('div', 'list');
    listEl.appendChild(el('div', 'empty', '等待本页产生网络请求…'));
    panel.append(head, statusEl, listEl);

    // 悬停展开，标题栏按钮负责固定
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
    setPinned(Boolean(GM_getValue(KEYS.pinned, false)), false);
  }

  /* ---------- 启动 ---------- */

  monitorPageRequests();
  buildUi();
  refreshFromCache();
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
