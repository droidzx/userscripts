// ==UserScript==
// @name         Mihomo 监控
// @namespace    local.droidzx.mihomo
// @version      2.2.3
// @description  页面角落按列表显示当前网页使用的 Mihomo 最终出口
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

  // 短连接可能很快结束，前台每秒检查，后台标签页不请求。
  const POLL_INTERVAL = 1000;
  const RECENT_TTL = 5000;

  // 不做自己的显示/隐藏开关 —— Tampermonkey 弹出菜单里脚本本身就有启用开关，
  // 再造一个只会让人分不清当前是哪个状态。
  const KEYS = {
    position: 'mihomo-dot-position',
    sourceIP: 'mihomo-source-ip',
    secret: 'mihomo-api-secret',
  };

  let observedDomains = new Set();
  let pollTimer = null;
  let activeRequest = null;
  let retryDelay = 1000;
  let currentPageUrl = location.href;
  let secret = '';
  let needsTrafficBaseline = false;
  let previousTraffic = new Map();
  let recentRoutes = new Map();

  // /connections 是整个旁路由的全局连接表，不按 sourceIP 过滤会混进别的设备。
  // 复用上次自动识别的值；失效后由 learnSourceIP() 从本页域名的连接里重新投票识别。
  let sourceIP = GM_getValue(KEYS.sourceIP, '') || '';
  const sourceVotes = new Map();
  let staleCount = 0;

  let root, routeBox;

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

  function requestSecret() {
    const saved = String(GM_getValue(KEYS.secret, '') || '').trim();
    if (saved) return saved;
    const entered = window.prompt('请输入 Mihomo API Secret\n仅保存在当前浏览器的油猴本地存储中，不会上传到 GitHub。', '');
    const value = String(entered || '').trim();
    if (value) GM_setValue(KEYS.secret, value);
    return value;
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

  function render(connections) {
    const now = Date.now();
    const baselineOnly = needsTrafficBaseline;
    let order = 0;
    const nextTraffic = new Map();
    const seenRoutes = new Set();
    for (const item of recentRoutes.values()) item.active = false;

    for (const c of connections) {
      const m = c.metadata || {};
      if (sourceIP && m.sourceIP !== sourceIP) continue;
      const host = normalizeHost(m.host || m.sniffHost);
      if (!isCurrentPageDomain(host)) continue;

      const rawChain = Array.isArray(c.chains) ? c.chains.filter(Boolean) : [];
      if (!rawChain.length) continue;
      const exit = rawChain[0];
      const up = Math.max(0, Number(c.upload) || 0);
      const down = Math.max(0, Number(c.download) || 0);
      const connectionKey = String(c.id || `${host}|${c.start || ''}|${exit}`);
      const previous = previousTraffic.get(connectionKey);
      nextTraffic.set(connectionKey, { up, down });
      if (baselineOnly) continue;
      // Mihomo 可能在重连时复用连接 ID，同时把流量计数重置为较小值。
      // 只要计数发生变化就算活跃；只有完全不变才进入 5 秒消失倒计时。
      if (previous && up === previous.up && down === previous.down) continue;
      if (seenRoutes.has(exit)) continue;
      seenRoutes.add(exit);
      recentRoutes.set(exit, {
        exit,
        active: true,
        lastSeenAt: now,
        order: order++,
      });
    }
    previousTraffic = nextTraffic;

    if (baselineOnly) {
      needsTrafficBaseline = false;
      recentRoutes = new Map();
      root.style.display = 'none';
      return;
    }

    for (const [key, item] of recentRoutes) {
      if (now - item.lastSeenAt >= RECENT_TTL) recentRoutes.delete(key);
    }

    const sorted = [...recentRoutes.values()].sort((a, b) => (
      Number(b.active) - Number(a.active)
      || (a.active && b.active ? a.order - b.order : 0)
      || b.lastSeenAt - a.lastSeenAt
      || a.exit.localeCompare(b.exit, 'zh-CN', { numeric: true, sensitivity: 'base' })
    ));

    if (!sorted.length) {
      root.style.display = 'none';
      return;
    }

    root.style.display = '';
    routeBox.replaceChildren(...sorted.map((item) => {
      const row = el('div', item.active ? 'route active' : 'route recent');
      row.append(el('span', 'route-dot'), el('span', 'route-name', item.exit));
      return row;
    }));
  }

  /* ---------- 轮询 ---------- */

  function schedule(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  function onFailure() {
    activeRequest = null;
    previousTraffic = new Map();
    root.style.display = 'none';
    schedule(retryDelay);
    retryDelay = Math.min(retryDelay + 500, 5000);
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (activeRequest) return;
    if (document.hidden) return;

    activeRequest = GM_xmlhttpRequest({
      method: 'GET',
      url: `${API}/connections`,
      headers: { Authorization: `Bearer ${secret}` },
      timeout: 4000,
      onload(res) {
        activeRequest = null;
        if (res.status === 401) {
          root.style.display = 'none';
          GM_setValue(KEYS.secret, '');
          secret = requestSecret();
          if (secret) schedule(0);
          return;
        }
        if (res.status !== 200) { onFailure(); return; }
        try {
          const data = JSON.parse(res.responseText);
          if (!Array.isArray(data.connections)) throw new Error('bad payload');
          retryDelay = 1000;
          learnSourceIP(data.connections);
          render(data.connections);
          schedule(POLL_INTERVAL);
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
    retryDelay = 1000;
    poll();
  }

  function pauseAndClear() {
    clearTimeout(pollTimer);
    pollTimer = null;
    activeRequest?.abort?.();
    activeRequest = null;
    previousTraffic = new Map();
    recentRoutes = new Map();
    needsTrafficBaseline = true;
    root.style.display = 'none';
  }

  /* ---------- SPA 换页 ---------- */

  function checkPageChange() {
    if (location.href === currentPageUrl) return;
    currentPageUrl = location.href;
    // 换页必须清空，否则旧页面的第三方域名会一直被算进「本页」
    observedDomains = new Set([normalizeHost(location.hostname)]);
    previousTraffic = new Map();
    recentRoutes = new Map();
    render([]);
    needsTrafficBaseline = true;
  }

  /* ---------- UI ---------- */

  function savePosition() {
    const r = root.getBoundingClientRect();
    GM_setValue(KEYS.position, { left: r.left, top: r.top });
  }

  function restorePosition() {
    const p = GM_getValue(KEYS.position, null);
    if (!p || typeof p.left !== 'number') return;
    root.style.left = `${Math.min(Math.max(6, p.left), Math.max(6, window.innerWidth - (root.offsetWidth || 120) - 6))}px`;
    root.style.top = `${Math.min(Math.max(6, p.top), Math.max(6, window.innerHeight - (root.offsetHeight || 32) - 6))}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function enableDrag() {
    routeBox.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const r = root.getBoundingClientRect();
      const ox = ev.clientX - r.left;
      const oy = ev.clientY - r.top;
      let moved = false;
      routeBox.setPointerCapture(ev.pointerId);

      const move = (e) => {
        if (Math.abs(e.clientX - r.left - ox) + Math.abs(e.clientY - r.top - oy) > 3) moved = true;
        root.style.left = `${Math.min(Math.max(0, e.clientX - ox), window.innerWidth - root.offsetWidth)}px`;
        root.style.top = `${Math.min(Math.max(0, e.clientY - oy), window.innerHeight - root.offsetHeight)}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      };
      const up = () => {
        routeBox.removeEventListener('pointermove', move);
        routeBox.removeEventListener('pointerup', up);
        if (moved) savePosition();
      };
      routeBox.addEventListener('pointermove', move);
      routeBox.addEventListener('pointerup', up);
    });
  }

  function buildUi() {
    root = el('div');
    root.id = 'mihomo-dot-root';
    const shadow = root.attachShadow({ mode: 'open' });

    const style = el('style');
    style.textContent = `
      :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; }
      .routes { display: grid; gap: 4px; min-width: 112px; max-width: min(200px, calc(100vw - 32px));
        padding: 5px; border: 1px solid rgba(104,211,160,.28); border-radius: 11px; cursor: grab;
        background: linear-gradient(145deg, rgba(15,31,22,.97), rgba(7,18,12,.98));
        box-shadow: 0 9px 28px rgba(0,0,0,.4), 0 0 14px rgba(61,220,151,.05);
        backdrop-filter: blur(16px); user-select: none; }
      .routes:active { cursor: grabbing; }
      .route { display: grid; grid-template-columns: 5px minmax(0,1fr); align-items: center; gap: 7px;
        min-height: 22px; padding: 1px 6px; border: 1px solid rgba(148,196,174,.08); border-radius: 7px;
        color: #dcf8e9; background: rgba(255,255,255,.025);
        font: 700 11px/1.2 Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .route.active { border-color: rgba(61,220,151,.2); background: rgba(61,220,151,.075); }
      .route.recent { opacity: .5; }
      .route-dot { width: 4px; height: 4px; border-radius: 50%; background: #3ddc97;
        box-shadow: 0 0 8px rgba(61,220,151,.8); }
      .route.recent .route-dot { background: #5d7569; box-shadow: none; }
      .route-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `;

    routeBox = el('div', 'routes');
    shadow.append(style, routeBox);
    document.documentElement.appendChild(root);
    root.style.display = 'none';

    enableDrag();
    restorePosition();
  }

  /* ---------- 启动 ---------- */

  monitorPageRequests();
  buildUi();
  secret = requestSecret();
  if (!secret) return;
  restart();

  setInterval(checkPageChange, 700);
  window.addEventListener('popstate', checkPageChange);
  window.addEventListener('hashchange', checkPageChange);
  window.addEventListener('online', restart);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseAndClear();
    else restart();
  });
  window.addEventListener('pagehide', pauseAndClear);
})();
