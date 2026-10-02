/* 由 build.mjs 生成，请勿手改 */
{
const AO3TL_BOOKMARKLET = true;
(() => {
  'use strict';

  // 订阅作者时间线：把所有订阅的作者拼成一个 creators:(a OR b OR ...) 搜索，按更新时间排序。
  // 插件里：在 AO3 导航栏加 "My Timeline" 菜单，每天自动刷新一次订阅列表。
  // bookmarklet 里（打包时会定义 AO3TL_BOOKMARKLET）：点一下直接跳到 M/M 时间线，订阅列表超过一天才重新抓。

  const IS_BOOKMARKLET = typeof AO3TL_BOOKMARKLET !== 'undefined';

  const USERS_KEY = 'ao3tlUsernames';
  const SYNCED_AT_KEY = 'ao3tlSyncedAt';
  const RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const PAGE_FETCH_DELAY_MS = 500; // 翻订阅列表时每页之间稍等一下，别比人手点得还快

  // ---------- 存储：插件里用 chrome.storage，bookmarklet 里用 AO3 域名下的 localStorage ----------

  const hasExtensionStorage = typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);

  function loadCache() {
    return new Promise((resolve) => {
      const done = (users, syncedAt) => resolve({
        usernames: Array.isArray(users) ? users : [],
        syncedAt: Number(syncedAt) || 0,
      });
      try {
        if (hasExtensionStorage) {
          chrome.storage.local.get([USERS_KEY, SYNCED_AT_KEY], (r) => done(r[USERS_KEY], r[SYNCED_AT_KEY]));
        } else {
          done(JSON.parse(localStorage.getItem(USERS_KEY) || '[]'), localStorage.getItem(SYNCED_AT_KEY));
        }
      } catch {
        done([], 0);
      }
    });
  }

  function saveCache(usernames) {
    const syncedAt = Date.now();
    try {
      if (hasExtensionStorage) {
        chrome.storage.local.set({ [USERS_KEY]: usernames, [SYNCED_AT_KEY]: syncedAt });
      } else {
        localStorage.setItem(USERS_KEY, JSON.stringify(usernames));
        localStorage.setItem(SYNCED_AT_KEY, String(syncedAt));
      }
    } catch {
      /* 存不下就下次再抓 */
    }
  }

  // ---------- 抓取订阅列表 ----------

  // AO3 页头的 "Hi, <username>!" 下拉链接正好是 /users/<username>，没有更多路径
  function getCurrentUsername() {
    for (const a of document.querySelectorAll('a.dropdown-toggle[href]')) {
      const m = a.getAttribute('href').match(/^\/users\/([^/]+)$/);
      if (m) return decodeURIComponent(m[1]);
    }
    return null;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 任何一页失败都直接抛错，不返回半截列表，免得覆盖掉之前完整的缓存
  async function fetchSubscribedUsernames(username, onProgress) {
    const usernames = [];
    for (let page = 1; ; page++) {
      onProgress?.(page);
      const res = await fetch(
        `/users/${encodeURIComponent(username)}/subscriptions?type=users&page=${page}`,
        { credentials: 'same-origin' },
      );
      if (!res.ok) throw new Error(res.status === 429 ? 'AO3 暂时限制了请求频率（429）' : `HTTP ${res.status}`);
      // 登录过期时 AO3 会重定向到登录页，不能当成"没有订阅"
      if (!new URL(res.url).pathname.endsWith('/subscriptions')) throw new Error('登录状态已失效，请重新登录 AO3');
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const dl = doc.querySelector('dl.subscription');
      if (!dl) {
        // 一个订阅都没有时 AO3 不渲染列表（标题仍是 "My User Subscriptions"）；其他情况说明页面结构不对
        const title = doc.querySelector('#main h2.heading')?.textContent || '';
        if (page === 1 && /Subscriptions/i.test(title)) return usernames;
        throw new Error('无法解析订阅列表页面');
      }
      for (const a of dl.querySelectorAll('dt a[href^="/users/"]')) {
        const name = a.textContent.trim();
        if (name) usernames.push(name);
      }
      if (!doc.querySelector('ol.pagination li.next a[href]')) return [...new Set(usernames)];
      await sleep(PAGE_FETCH_DELAY_MS);
    }
  }

  async function syncSubscriptions(onProgress) {
    const username = getCurrentUsername();
    if (!username) throw new Error('没有检测到登录状态，请先登录 AO3');
    const usernames = await fetchSubscribedUsernames(username, onProgress);
    saveCache(usernames);
    return usernames;
  }

  // 缓存超过一天（或为空）就重新抓
  async function getUsernames(onProgress) {
    const cache = await loadCache();
    if (cache.usernames.length && Date.now() - cache.syncedAt < RESYNC_INTERVAL_MS) return cache.usernames;
    return syncSubscriptions(onProgress);
  }

  function buildTimelineUrl(usernames, tagId) {
    const params = new URLSearchParams({
      'work_search[query]': `creators:(${usernames.join(' OR ')})`,
      'work_search[sort_column]': 'revised_at',
    });
    // /works?tag_id=M/M 会渲染 AO3 自带的筛选侧栏；/works/search 不会
    if (tagId) {
      params.set('tag_id', tagId);
      return `/works?${params}`;
    }
    return `/works/search?${params}`;
  }

  // ---------- 进度提示 ----------

  let notice;
  function showNotice(text) {
    if (!notice) {
      notice = document.createElement('div');
      notice.className = 'ao3tl-notice';
      notice.setAttribute('role', 'status');
      notice.style.cssText = [
        'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)', 'z-index:2147483647',
        'max-width:calc(100% - 32px)', 'padding:8px 16px', 'border-radius:6px',
        'background:#900', 'color:#fff', 'font:14px/1.4 sans-serif', 'box-shadow:0 2px 8px rgba(0,0,0,.3)',
      ].join(';');
      document.body.append(notice);
    }
    notice.textContent = text;
  }

  function hideNotice(delay = 0) {
    const el = notice;
    notice = null;
    if (el) setTimeout(() => el.remove(), delay);
  }

  const progress = (page) => showNotice(`正在同步订阅列表…（第 ${page} 页）`);

  // ---------- bookmarklet：直接跳到 M/M 时间线 ----------

  async function runBookmarklet() {
    if (window.ao3tlRunning) return;
    window.ao3tlRunning = true;
    try {
      const usernames = await getUsernames(progress);
      if (!usernames.length) {
        hideNotice();
        alert('AO3 时间线：你还没有订阅任何作者。');
        return;
      }
      showNotice(`正在打开时间线（${usernames.length} 位作者）…`);
      location.href = buildTimelineUrl(usernames, 'M/M');
    } catch (err) {
      hideNotice();
      alert(`AO3 时间线：${err.message}`);
    } finally {
      window.ao3tlRunning = false;
    }
  }

  // ---------- 插件：导航栏菜单 ----------

  async function openTimeline(tagId) {
    // 先同步打开空白标签页，避免异步之后再 window.open 被拦截
    const tab = window.open('about:blank', '_blank');
    try {
      const usernames = await getUsernames(progress);
      hideNotice();
      if (!usernames.length) {
        tab?.close();
        alert('AO3 时间线：你还没有订阅任何作者。');
        return;
      }
      const url = new URL(buildTimelineUrl(usernames, tagId), location.origin).href;
      if (tab) tab.location.href = url;
      else location.href = url;
    } catch (err) {
      tab?.close();
      hideNotice();
      alert(`AO3 时间线：${err.message}`);
    }
  }

  async function manualSync() {
    try {
      const usernames = await syncSubscriptions(progress);
      showNotice(`已同步 ${usernames.length} 位订阅作者`);
      hideNotice(2500);
    } catch (err) {
      hideNotice();
      alert(`AO3 时间线：${err.message}`);
    }
  }

  // 结构照抄 AO3 自己的下拉菜单（li.dropdown > a.dropdown-toggle + ul.menu），
  // AO3 已加载的 bootstrap-dropdown 在 document 上做事件委托，会自动接管展开/收起
  function injectNavMenu() {
    const nav = document.querySelector('ul.primary.navigation.actions');
    if (!nav || document.getElementById('ao3tl-nav')) return;

    const li = document.createElement('li');
    li.id = 'ao3tl-nav';
    li.className = 'dropdown';
    li.setAttribute('aria-haspopup', 'true');

    const toggle = document.createElement('a');
    toggle.className = 'dropdown-toggle';
    toggle.href = '#';
    toggle.dataset.toggle = 'dropdown';
    toggle.dataset.target = '#';
    toggle.textContent = 'My Timeline';

    const menu = document.createElement('ul');
    menu.className = 'menu dropdown-menu';
    const items = [
      ['M/M（带筛选侧栏）', () => openTimeline('M/M')],
      ['全部分类', () => openTimeline(null)],
      ['立即同步订阅列表', manualSync],
    ];
    for (const [label, action] of items) {
      const item = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = label;
      a.addEventListener('click', (e) => {
        e.preventDefault();
        action();
      });
      item.append(a);
      menu.append(item);
    }

    li.append(toggle, menu);
    nav.append(li);
  }

  async function maybeAutoSync() {
    const cache = await loadCache();
    if (Date.now() - cache.syncedAt < RESYNC_INTERVAL_MS) return;
    try {
      await syncSubscriptions();
    } catch (err) {
      console.warn('AO3 时间线：后台同步订阅列表失败', err);
    }
  }

  if (IS_BOOKMARKLET) {
    runBookmarklet();
  } else if (getCurrentUsername()) {
    injectNavMenu();
    maybeAutoSync();
  }
})();
}
