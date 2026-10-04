(() => {
  'use strict';

  // 订阅作者时间线：把所有订阅的作者拼成一个 creators:(a OR b OR ...) 搜索，按更新时间排序。
  // 插件里：在 AO3 导航栏加 "My Timeline" 菜单，每天自动刷新一次订阅列表。
  // bookmarklet 里（打包时会定义 AO3TL_BOOKMARKLET）：点一下直接跳到 M/M 时间线，订阅列表超过一天才重新抓。

  const IS_BOOKMARKLET = typeof AO3TL_BOOKMARKLET !== 'undefined';

  const KEYS = {
    users: 'ao3tlUsernames',
    syncedAt: 'ao3tlSyncedAt',
    progress: 'ao3tlSyncProgress', // 同步到一半的进度，离开页面后下个页面接着抓
    lock: 'ao3tlSyncLock', // 自动同步的跨标签页锁
    failedAt: 'ao3tlSyncFailedAt',
  };
  const RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000; // 自动同步真正失败后，一小时内不再自动重试
  const PROGRESS_MAX_AGE_MS = 60 * 60 * 1000; // 断点进度超过一小时就作废，从头抓
  const LOCK_TTL_MS = 15 * 1000; // 持锁的标签页每抓完一页续一次
  const PAGE_FETCH_DELAY_MS = 500; // 翻订阅列表时每页之间稍等一下，别比人手点得还快

  // ---------- 存储：插件里用 chrome.storage，bookmarklet 里用 AO3 域名下的 localStorage ----------

  const hasExtensionStorage = typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);

  async function storageGet(keys) {
    try {
      if (hasExtensionStorage) return await chrome.storage.local.get(keys);
      const result = {};
      for (const key of keys) {
        const raw = localStorage.getItem(key);
        if (raw !== null) result[key] = JSON.parse(raw);
      }
      return result;
    } catch {
      return {};
    }
  }

  async function storageSet(items) {
    try {
      if (hasExtensionStorage) return await chrome.storage.local.set(items);
      for (const [key, value] of Object.entries(items)) localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 存不下就下次再抓 */
    }
  }

  async function storageRemove(keys) {
    try {
      if (hasExtensionStorage) return await chrome.storage.local.remove(keys);
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  async function loadCache() {
    const r = await storageGet([KEYS.users, KEYS.syncedAt]);
    return {
      usernames: Array.isArray(r[KEYS.users]) ? r[KEYS.users] : [],
      syncedAt: Number(r[KEYS.syncedAt]) || 0,
    };
  }

  // ---------- 离开页面 ----------

  // 离开页面时浏览器会取消还没完成的请求（报 "Failed to fetch"）。
  // 这种中断不算失败：进度已经按页存下来了，下个页面会接着抓。
  class LeftPageError extends Error {}
  let leaving = false;
  const pageAbort = new AbortController();
  window.addEventListener('pagehide', () => {
    leaving = true;
    pageAbort.abort();
    releaseLock();
  });

  // ---------- 抓取订阅列表 ----------

  // AO3 页头的 "Hi, <username>!" 下拉链接正好是 /users/<username>，没有更多路径。
  // 未登录时 body 带 logged-out，而且页头有个 /users/login?return_to=... 的下拉链接，要排除掉
  function getCurrentUsername() {
    if (document.body.classList.contains('logged-out')) return null;
    for (const a of document.querySelectorAll('#header a.dropdown-toggle[href]')) {
      const m = a.getAttribute('href').match(/^\/users\/([^/?#]+)$/);
      if (m && m[1] !== 'login') return decodeURIComponent(m[1]);
    }
    return null;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function fetchSubscriptionsPage(username, page) {
    try {
      const res = await fetch(
        `/users/${encodeURIComponent(username)}/subscriptions?type=users&page=${page}`,
        { credentials: 'same-origin', signal: pageAbort.signal },
      );
      if (!res.ok) throw new Error(res.status === 429 ? 'AO3 暂时限制了请求频率（429）' : `HTTP ${res.status}`);
      // 登录过期时 AO3 会重定向到登录页，不能当成"没有订阅"
      if (!new URL(res.url).pathname.endsWith('/subscriptions')) throw new Error('登录状态已失效，请重新登录 AO3');
      return new DOMParser().parseFromString(await res.text(), 'text/html');
    } catch (err) {
      if (leaving) throw new LeftPageError('离开页面，同步已暂停');
      throw err;
    }
  }

  // 每抓完一页就保存进度；任何一页失败都直接抛错，不会用半截列表覆盖之前完整的缓存
  async function fetchSubscribedUsernames(username, onProgress, onPageDone) {
    const saved = (await storageGet([KEYS.progress]))[KEYS.progress];
    const resume = saved && saved.username === username && Date.now() - saved.updatedAt < PROGRESS_MAX_AGE_MS;
    const usernames = resume ? [...saved.usernames] : [];

    for (let page = resume ? saved.nextPage : 1; ; page++) {
      onProgress?.(page);
      const doc = await fetchSubscriptionsPage(username, page);
      const dl = doc.querySelector('dl.subscription');
      if (!dl) {
        // 一个订阅都没有时 AO3 不渲染列表（标题仍是 "My User Subscriptions"）；其他情况说明页面结构不对
        const title = doc.querySelector('#main h2.heading')?.textContent || '';
        if (page !== 1 || !/Subscriptions/i.test(title)) throw new Error('无法解析订阅列表页面');
      } else {
        for (const a of dl.querySelectorAll('dt a[href^="/users/"]')) {
          const name = a.textContent.trim();
          if (name) usernames.push(name);
        }
      }

      if (!doc.querySelector('ol.pagination li.next a[href]')) {
        await storageRemove([KEYS.progress]);
        return [...new Set(usernames)];
      }
      await storageSet({
        [KEYS.progress]: { username, usernames, nextPage: page + 1, updatedAt: Date.now() },
      });
      await onPageDone?.();
      await sleep(PAGE_FETCH_DELAY_MS);
    }
  }

  async function syncSubscriptions(onProgress, onPageDone) {
    const username = getCurrentUsername();
    if (!username) throw new Error('没有检测到登录状态，请先登录 AO3');
    const usernames = await fetchSubscribedUsernames(username, onProgress, onPageDone);
    await storageSet({ [KEYS.users]: usernames, [KEYS.syncedAt]: Date.now() });
    await storageRemove([KEYS.failedAt]);
    return usernames;
  }

  // 缓存超过一天（或为空）就重新抓；重新抓失败但有旧缓存时，先用旧的
  async function getUsernames(onProgress) {
    const cache = await loadCache();
    if (cache.usernames.length && Date.now() - cache.syncedAt < RESYNC_INTERVAL_MS) return cache.usernames;
    try {
      return await syncSubscriptions(onProgress);
    } catch (err) {
      if (err instanceof LeftPageError || !cache.usernames.length) throw err;
      console.warn('AO3 时间线：同步订阅列表失败，先用上次的列表', err);
      return cache.usernames;
    }
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

  // ---------- 跨标签页锁（只用于后台自动同步） ----------

  const tabId = Math.random().toString(36).slice(2);

  async function tryAcquireLock() {
    const lock = (await storageGet([KEYS.lock]))[KEYS.lock];
    if (lock && lock.owner !== tabId && Date.now() - lock.at < LOCK_TTL_MS) return false;
    await storageSet({ [KEYS.lock]: { owner: tabId, at: Date.now() } });
    // 写完读回确认，减少两个标签页同时抢到锁的情况
    const check = (await storageGet([KEYS.lock]))[KEYS.lock];
    return Boolean(check && check.owner === tabId);
  }

  const renewLock = () => storageSet({ [KEYS.lock]: { owner: tabId, at: Date.now() } });

  async function releaseLock() {
    const lock = (await storageGet([KEYS.lock]))[KEYS.lock];
    if (lock && lock.owner === tabId) await storageRemove([KEYS.lock]);
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

  function reportError(err) {
    hideNotice();
    if (err instanceof LeftPageError) return; // 页面都要离开了，不用提示
    alert(`AO3 时间线：${err.message}`);
  }

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
      reportError(err);
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
      reportError(err);
    }
  }

  async function manualSync() {
    try {
      const usernames = await syncSubscriptions(progress);
      showNotice(`已同步 ${usernames.length} 位订阅作者`);
      hideNotice(2500);
    } catch (err) {
      reportError(err);
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
    const r = await storageGet([KEYS.syncedAt, KEYS.failedAt]);
    if (Date.now() - (Number(r[KEYS.syncedAt]) || 0) < RESYNC_INTERVAL_MS) return;
    if (Date.now() - (Number(r[KEYS.failedAt]) || 0) < RETRY_AFTER_FAILURE_MS) return;
    if (!(await tryAcquireLock())) return; // 别的标签页正在同步

    try {
      await syncSubscriptions(undefined, renewLock);
    } catch (err) {
      if (err instanceof LeftPageError) return;
      await storageSet({ [KEYS.failedAt]: Date.now() });
      console.warn('AO3 时间线：后台同步订阅列表失败，一小时后再自动重试', err);
    } finally {
      if (!leaving) await releaseLock();
    }
  }

  if (IS_BOOKMARKLET) {
    runBookmarklet();
  } else if (getCurrentUsername()) {
    injectNavMenu();
    maybeAutoSync();
  }
})();
