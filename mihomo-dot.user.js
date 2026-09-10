// ==UserScript==
// @name         Mihomo 监控
// @namespace    local.droidzx.mihomo
// @version      2.0.0
// @description  页面角落显示当前网页的 Mihomo 出口，点击查看完整代理链
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

  // 短连接可能很快结束，前台每秒检查，后台标签页不请求。
  const POLL_INTERVAL = 1000;
  const RECENT_TTL = 10000;

  // 不做自己的显示/隐藏开关 —— Tampermonkey 弹出菜单里脚本本身就有启用开关，
  // 再造一个只会让人分不清当前是哪个状态。
  const KEYS = {
    position: 'mihomo-dot-position',
    sourceIP: 'mihomo-source-ip',
  };

  let observedDomains = new Set();
  let pollTimer = null;
  let activeRequest = null;
  let retryDelay = 1000;
  let latestConnections = [];
  let currentPageUrl = location.href;
  let recentChains = new Map();
  let expanded = false;

  // /connections 是整个旁路由的全局连接表，不按 sourceIP 过滤会混进别的设备。
  // 复用上次自动识别的值；失效后由 learnSourceIP() 从本页域名的连接里重新投票识别。
  let sourceIP = GM_getValue(KEYS.sourceIP, '') || '';
  const sourceVotes = new Map();
  let staleCount = 0;

  let root, dot, panel, listEl, countEl, brandMarkEl;

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
    render(latestConnections);
  }

  function render(connections) {
    const now = Date.now();
    let order = 0;
    for (const item of recentChains.values()) item.active = false;

    for (const c of connections) {
      const m = c.metadata || {};
      if (sourceIP && m.sourceIP !== sourceIP) continue;
      const host = normalizeHost(m.host || m.sniffHost);
      if (!isCurrentPageDomain(host)) continue;

      const rawChain = Array.isArray(c.chains) ? c.chains.filter(Boolean) : [];
      if (!rawChain.length) continue;
      const key = rawChain.join('\u001f');
      recentChains.set(key, {
        steps: [...rawChain].reverse(),
        exit: rawChain[0],
        active: true,
        lastSeenAt: now,
        order: order++,
      });
    }

    for (const [key, item] of recentChains) {
      if (now - item.lastSeenAt > RECENT_TTL) recentChains.delete(key);
    }

    const sorted = [...recentChains.values()].sort((a, b) => (
      Number(b.active) - Number(a.active)
      || (a.active && b.active ? a.order - b.order : 0)
      || b.lastSeenAt - a.lastSeenAt
      || a.exit.localeCompare(b.exit, 'zh-CN', { numeric: true, sensitivity: 'base' })
    ));

    if (!sorted.length) {
      root.style.display = 'none';
      setExpanded(false);
      return;
    }

    root.style.display = '';
    const current = sorted.find((item) => item.active) || sorted[0];
    dot.textContent = current.exit + (sorted.length > 1 ? `  +${sorted.length - 1}` : '');
    dot.dataset.state = sorted.some((item) => item.active) ? 'active' : 'recent';
    dot.title = expanded ? '收起代理链' : '展开完整代理链';
    if (brandMarkEl) brandMarkEl.classList.toggle('active', sorted.some((item) => item.active));
    if (countEl) countEl.textContent = `${sorted.length} 条`;

    if (!expanded || !listEl) return;

    const scroll = listEl.scrollTop;
    listEl.replaceChildren(...sorted.map((item, index) => {
      const card = el('section', item.active ? 'chain-card active' : 'chain-card recent');
      const meta = el('div', 'chain-meta');
      meta.append(el('span', 'chain-index', String(index + 1).padStart(2, '0')),
        el('span', 'chain-state', item.active ? '连接中' : '刚刚'));
      const path = el('div', 'chain-path');
      item.steps.forEach((step, stepIndex) => {
        path.appendChild(el('span', stepIndex === item.steps.length - 1 ? 'chain-step exit' : 'chain-step', step));
        if (stepIndex < item.steps.length - 1) path.appendChild(el('span', 'chain-arrow', '›'));
      });
      card.append(meta, path);
      return card;
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
    root.style.display = 'none';
    setExpanded(false);
    schedule(retryDelay);
    retryDelay = Math.min(retryDelay + 500, 5000);
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (activeRequest) return;
    if (document.hidden) { schedule(POLL_INTERVAL); return; }

    activeRequest = GM_xmlhttpRequest({
      method: 'GET',
      url: `${API}/connections`,
      headers: { Authorization: `Bearer ${SECRET}` },
      timeout: 4000,
      onload(res) {
        activeRequest = null;
        if (res.status === 401) {
          root.style.display = 'none';
          setExpanded(false);
          schedule(10000);
          return;
        }
        if (res.status !== 200) { onFailure(); return; }
        try {
          const data = JSON.parse(res.responseText);
          if (!Array.isArray(data.connections)) throw new Error('bad payload');
          retryDelay = 1000;
          latestConnections = data.connections;
          learnSourceIP(latestConnections);
          render(latestConnections);
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

  /* ---------- SPA 换页 ---------- */

  function checkPageChange() {
    if (location.href === currentPageUrl) return;
    currentPageUrl = location.href;
    // 换页必须清空，否则旧页面的第三方域名会一直被算进「本页」
    observedDomains = new Set([normalizeHost(location.hostname)]);
    recentChains = new Map();
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
    root.style.left = `${Math.min(Math.max(6, p.left), Math.max(6, window.innerWidth - (root.offsetWidth || 120) - 6))}px`;
    root.style.top = `${Math.min(Math.max(6, p.top), Math.max(6, window.innerHeight - (root.offsetHeight || 32) - 6))}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  // 面板默认向左上方展开。标签被拖到左边或顶部时那个方向没有空间，
  // 面板会被视口边缘切掉，所以展开前先按可用空间翻转锚点。
  function anchorPanel() {
    const r = root.getBoundingClientRect();
    const margin = 8;
    // visibility:hidden 仍然有布局，展开前就能量到尺寸
    const w = panel.offsetWidth || 340;
    const h = panel.offsetHeight || 260;
    panel.classList.toggle('to-right', r.right - w < margin);
    panel.classList.toggle('to-bottom', r.top - h - 8 < margin);
  }

  function setExpanded(on) {
    expanded = on;
    if (on) anchorPanel();
    panel.classList.toggle('open', on);
    dot.setAttribute('aria-expanded', String(on));
    if (on) { refreshFromCache(); restart(); }
  }

  function enableDrag() {
    dot.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      setExpanded(!expanded);
    });
    dot.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const r = root.getBoundingClientRect();
      const ox = ev.clientX - r.left;
      const oy = ev.clientY - r.top;
      let moved = false;
      dot.setPointerCapture(ev.pointerId);

      const move = (e) => {
        if (Math.abs(e.clientX - r.left - ox) + Math.abs(e.clientY - r.top - oy) > 3) moved = true;
        root.style.left = `${Math.min(Math.max(0, e.clientX - ox), window.innerWidth - root.offsetWidth)}px`;
        root.style.top = `${Math.min(Math.max(0, e.clientY - oy), window.innerHeight - root.offsetHeight)}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
      };
      const up = () => {
        dot.removeEventListener('pointermove', move);
        dot.removeEventListener('pointerup', up);
        if (moved) savePosition();
        else setExpanded(!expanded);
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
      .dot { display: block; max-width: min(220px, calc(100vw - 32px)); height: 30px; padding: 0 12px;
        overflow: hidden; border: 1px solid rgba(104,211,160,.34); border-radius: 999px; cursor: grab;
        color: #d9fbea; background: linear-gradient(135deg, rgba(21,42,31,.96), rgba(11,24,17,.97));
        box-shadow: 0 8px 28px rgba(0,0,0,.4), 0 0 16px rgba(61,220,151,.08);
        font: 700 12px/28px Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        text-overflow: ellipsis; white-space: nowrap; transition: border-color .18s ease, opacity .18s ease, transform .15s ease; }
      .dot:hover { border-color: rgba(104,230,176,.62); transform: translateY(-1px); }
      .dot:active { cursor: grabbing; transform: translateY(0); }
      .dot:focus-visible { outline: 2px solid rgba(105,240,179,.7); outline-offset: 2px; }
      .dot[data-state="active"] { border-color: rgba(61,220,151,.58); }
      .dot[data-state="recent"] { opacity: .68; }
      .panel { position: absolute; right: 0; bottom: calc(100% + 8px); display: flex; flex-direction: column;
        width: 380px; height: min(240px, calc(100vh - 72px)); max-width: calc(100vw - 24px);
        color: #e8f0ec; background: rgba(9,16,12,.97); backdrop-filter: blur(18px);
        border: 1px solid rgba(125,220,174,.22); border-radius: 16px; overflow: hidden;
        box-shadow: 0 26px 80px rgba(0,0,0,.58), 0 0 0 1px rgba(255,255,255,.03) inset;
        opacity: 0; visibility: hidden; transform: translateY(7px) scale(.985); transform-origin: bottom right;
        transition: opacity .16s ease, transform .16s ease, visibility .16s; }
      .panel.open { opacity: 1; visibility: visible; transform: translateY(0); }
      .panel.to-right { right: auto; left: 0; }
      .panel.to-bottom { bottom: auto; top: calc(100% + 8px); transform-origin: top right; }
      .panel.to-right { transform-origin: bottom left; }
      .panel.to-right.to-bottom { transform-origin: top left; }
      .head { padding: 13px 14px; background: radial-gradient(circle at 88% -30%, rgba(61,220,151,.18), transparent 48%), linear-gradient(145deg, #16271e, #101b15);
        border-bottom: 1px solid rgba(148,196,174,.13); flex: 0 0 auto; }
      .brand { display: flex; align-items: center; gap: 7px; min-width: 0; flex: 1;
        color: #f3faf6; font-size: 12px; font-weight: 750; letter-spacing: .06em; }
      .brand-mark { width: 7px; height: 7px; border-radius: 50%; background: #5f756a; }
      .brand-mark.active { background: #3ddc97; box-shadow: 0 0 9px rgba(61,220,151,.72); }
      .badge { padding: 2px 7px; border-radius: 999px; background: rgba(61,220,151,.1);
        color: #8ce9bd; font-size: 10.5px; font-weight: 600; letter-spacing: 0; text-transform: none; }
      .list { min-height: 0; flex: 1 1 auto; overflow: auto; padding: 9px; background: rgba(7,12,9,.76); }
      .chain-card { margin-bottom: 8px; padding: 10px 11px 12px; border: 1px solid rgba(148,196,174,.12);
        border-radius: 12px; background: linear-gradient(145deg, rgba(23,39,30,.96), rgba(14,25,19,.96)); }
      .chain-card:last-child { margin-bottom: 0; }
      .chain-card.active { border-color: rgba(61,220,151,.28); box-shadow: 0 0 22px rgba(61,220,151,.04) inset; }
      .chain-card.recent { opacity: .58; }
      .chain-meta { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .chain-index { color: #647d70; font: 650 10px/1 Inter, ui-monospace, monospace; letter-spacing: .08em; }
      .chain-state { padding: 2px 7px; border-radius: 999px; color: #7de6b0; background: rgba(61,220,151,.09); font-size: 10px; }
      .chain-card.recent .chain-state { color: #8a9d94; background: rgba(255,255,255,.04); }
      .chain-path { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
      .chain-step { max-width: 100%; padding: 4px 7px; overflow: hidden; border: 1px solid rgba(148,196,174,.1);
        border-radius: 7px; color: #a9bdb3; background: rgba(255,255,255,.035); font-size: 11px;
        text-overflow: ellipsis; white-space: nowrap; }
      .chain-step.exit { color: #caffdf; border-color: rgba(61,220,151,.3); background: rgba(61,220,151,.12); font-weight: 750; }
      .chain-arrow { color: #4f6c5d; font-size: 15px; line-height: 1; }
      ::-webkit-scrollbar { width: 5px; }
      ::-webkit-scrollbar-track { background: transparent; }
      ::-webkit-scrollbar-thumb { background: #354d41; border-radius: 6px; }
    `;

    const wrap = el('div', 'wrap');
    dot = el('button', 'dot');
    dot.type = 'button';
    dot.dataset.state = 'recent';
    dot.title = '展开完整代理链';
    dot.setAttribute('aria-expanded', 'false');

    panel = el('div', 'panel');
    const head = el('div', 'head');
    const brand = el('div', 'brand');
    brandMarkEl = el('span', 'brand-mark');
    brand.append(brandMarkEl, el('span', '', '代理链'), countEl = el('span', 'badge', '0 条'));
    head.appendChild(brand);
    listEl = el('div', 'list');
    panel.append(head, listEl);

    wrap.append(panel, dot);
    shadow.append(style, wrap);
    document.documentElement.appendChild(root);
    root.style.display = 'none';

    enableDrag();
    restorePosition();
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
