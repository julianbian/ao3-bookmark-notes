(() => {
  'use strict';

  // 书签页路径 → bookmark 搜索里的 bookmarkable_type
  const TYPES = { works: 'Work', series: 'Series', external_works: 'ExternalWork' };

  const match = location.pathname.match(/^\/(works|series|external_works)\/(\d+)\/bookmarks\/?$/);
  if (!match) return;
  const [, kind, id] = match;

  const main = document.getElementById('main');
  const list = main && main.querySelector(':scope > ol.bookmark');
  // 已经注入过（比如 bookmarklet 被点了两次）就不再重复
  if (!list || main.querySelector(':scope > .ao3bn-toggle')) return;

  // 视图：all 是原页面，其余通过书签搜索获取
  const VIEWS = {
    all: { label: '全部书签' },
    notes: {
      label: '附 note',
      heading: '附 note 的书签',
      empty: '还没有附 note 的公开书签。',
      search: { 'bookmark_search[with_notes]': '1' },
    },
    recs: {
      label: '推荐 · 附 note',
      heading: '推荐（Rec）并附 note 的书签',
      empty: '还没有推荐并附 note 的公开书签。',
      search: { 'bookmark_search[with_notes]': '1', 'bookmark_search[rec]': '1' },
    },
  };
  const FILTER_VIEWS = Object.keys(VIEWS).filter((v) => v !== 'all');

  const VIEW_PARAM = 'bn_view';
  const PAGE_PARAM = 'bn_page';
  const STORAGE_KEY = 'ao3bnView';

  // 搜索结果缓存：30 分钟内直接用，不再请求 AO3；过期后重新请求，失败时退回旧缓存
  const FRESH_MS = 30 * 60 * 1000;
  const CACHE_PREFIX = 'ao3bn:page:';
  const CACHE_INDEX_KEY = 'ao3bn:index'; // 缓存键 -> 抓取时间，用于淘汰最旧的
  const RETRY_DELAYS_MS = [1500, 4000]; // 5xx / 网络错误时自动重试的间隔

  const memory = new Map(); // 缓存键 -> Promise<data>，同一次页面里避免重复读存储
  const totals = {}; // view -> 总数
  let requestSeq = 0;
  let currentView = 'all';

  // ---------- 存储：插件里用 chrome.storage，bookmarklet 里用 AO3 域名下的 localStorage ----------

  const hasExtensionStorage = typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);
  // localStorage 只有约 5MB 且和 AO3 自己共用，少存一些
  const CACHE_MAX_ENTRIES = hasExtensionStorage ? 300 : 40;

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
      /* 存不下就算了，下次重新请求 */
    }
  }

  async function storageRemove(keys) {
    if (!keys.length) return;
    try {
      if (hasExtensionStorage) return await chrome.storage.local.remove(keys);
      for (const key of keys) localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  // ---------- 搜索请求、解析与缓存 ----------

  function searchUrl(view, page) {
    const params = new URLSearchParams({
      'bookmark_search[bookmark_query]': `bookmarkable_id:${id} AND bookmarkable_type:${TYPES[kind]}`,
      ...VIEWS[view].search,
      'bookmark_search[sort_column]': 'created_at',
      commit: 'Search Bookmarks',
      page: String(page),
    });
    return `/bookmarks/search?${params}`;
  }

  class HttpError extends Error {
    constructor(status) {
      super(`HTTP ${status}`);
      this.status = status;
    }
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 5xx（包括 Cloudflare 的 52x、530）和网络错误多半是 AO3 一时抽风，自动重试两次；429 不重试
  async function fetchFromAO3(view, page, onRetry) {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(searchUrl(view, page), { credentials: 'same-origin' });
        if (!res.ok) throw new HttpError(res.status);
        return parseSearchPage(await res.text());
      } catch (err) {
        const retryable = err instanceof HttpError ? err.status >= 500 : err instanceof TypeError;
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
        onRetry?.(attempt + 1, err);
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  // 确认搜索结果确实指向当前作品（防御性校验）
  const ownPath = new RegExp(`^/${kind}/${id}(?:[/?#]|$)`);
  function belongsHere(li) {
    return [...li.querySelectorAll('a[href]')].some((a) => ownPath.test(a.getAttribute('href')));
  }

  // 解析成可存储的纯数据（HTML 字符串），渲染时再转回节点
  function parseSearchPage(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const docMain = doc.getElementById('main');
    if (!docMain) throw new Error('无法解析 AO3 返回的页面');

    const foundText = [...docMain.querySelectorAll('h3.heading')]
      .map((h) => h.textContent)
      .find((t) => /Found/.test(t));
    const total = foundText ? parseInt(foundText.replace(/[^\d]/g, ''), 10) || 0 : 0;

    const items = [...docMain.querySelectorAll('ol.bookmark > li.bookmark')]
      .filter(belongsHere)
      .map(toUserBlurb)
      .filter(Boolean)
      .map((li) => li.outerHTML);

    const pagination = docMain.querySelector('ol.pagination')?.outerHTML || null;
    return { total, items, pagination, fetchedAt: Date.now() };
  }

  // 把搜索结果里的整条书签（含作品简介）转换成书签页那种只有书签人信息的条目
  function toUserBlurb(src) {
    const user = src.querySelector(':scope > div.user');
    if (!user) return null;

    const li = document.createElement('li');
    li.className = 'user short blurb group';
    li.setAttribute('role', 'article');

    const header = document.createElement('div');
    header.className = 'header module';
    const byline = user.querySelector(':scope > h5.byline');
    const date = user.querySelector(':scope > p.datetime');
    const status = src.querySelector(':scope > p.status');
    if (status) status.querySelector('span.count')?.remove();
    for (const el of [byline, date, status]) if (el) header.append(el);
    li.append(header);

    // 剩下的就是书签 tags、notes 等
    li.append(...user.children);
    return li;
  }

  const cacheKey = (view, page) => `${CACHE_PREFIX}${kind}:${id}:${view}:${page}`;

  async function readCached(key) {
    const data = (await storageGet([key]))[key];
    return data && Array.isArray(data.items) && typeof data.fetchedAt === 'number' ? data : null;
  }

  async function writeCached(key, data) {
    const index = (await storageGet([CACHE_INDEX_KEY]))[CACHE_INDEX_KEY] || {};
    index[key] = data.fetchedAt;
    const oldest = Object.keys(index).sort((a, b) => index[a] - index[b]);
    const evicted = oldest.slice(0, Math.max(0, oldest.length - CACHE_MAX_ENTRIES));
    for (const k of evicted) delete index[k];
    await storageRemove(evicted);
    await storageSet({ [key]: data, [CACHE_INDEX_KEY]: index });
  }

  // 返回 { ...data, stale?, error? }：
  //   缓存还新鲜 → 直接用；否则请求 AO3；请求失败但有旧缓存 → 用旧缓存并标记 stale
  function getPage(view, page, { refresh = false, onRetry } = {}) {
    const key = cacheKey(view, page);
    if (!refresh && memory.has(key)) return memory.get(key);

    const promise = (async () => {
      const cached = await readCached(key);
      if (!refresh && cached && Date.now() - cached.fetchedAt < FRESH_MS) return cached;
      try {
        const data = await fetchFromAO3(view, page, onRetry);
        await writeCached(key, data);
        return data;
      } catch (error) {
        if (cached) return { ...cached, stale: true, error };
        throw error;
      }
    })();
    memory.set(key, promise);
    promise.then(
      (data) => { if (data.stale) memory.delete(key); }, // 旧缓存只是应急，下次还要再试
      () => memory.delete(key),
    );
    return promise;
  }

  // ---------- 界面 ----------

  const toggle = document.createElement('ul');
  toggle.className = 'ao3bn-toggle';
  for (const view of Object.keys(VIEWS)) {
    const li = document.createElement('li');
    li.dataset.view = view;
    toggle.append(li);
  }

  const panel = document.createElement('div');
  panel.className = 'ao3bn-panel';
  panel.innerHTML = `
    <h2 class="heading ao3bn-heading"></h2>
    <div class="ao3bn-pagination"></div>
    <div class="ao3bn-message"></div>
    <ol class="bookmark index group ao3bn-list"></ol>
    <div class="ao3bn-pagination"></div>
  `;
  const heading = panel.querySelector('.ao3bn-heading');
  const pagerSlots = panel.querySelectorAll('.ao3bn-pagination');
  const message = panel.querySelector('.ao3bn-message');
  const resultList = panel.querySelector('.ao3bn-list');

  const originalHeading = main.querySelector(':scope > h2.heading');
  // 原页面标题形如 "1 - 20 of 1,842 Bookmarks"
  const allCount = originalHeading?.textContent.match(/([\d,]+)\s+Bookmarks?/);
  if (allCount) totals.all = parseInt(allCount[1].replace(/,/g, ''), 10);
  (originalHeading || list).before(toggle);
  list.after(panel);

  function renderToggle() {
    for (const li of toggle.children) {
      const view = li.dataset.view;
      const el = document.createElement(view === currentView ? 'span' : 'a');
      if (view === currentView) el.className = 'current';
      else el.href = urlFor({ view, page: 1 });
      el.textContent = view in totals
        ? `${VIEWS[view].label}（${totals[view].toLocaleString()}）`
        : VIEWS[view].label;
      li.replaceChildren(el);
    }
  }

  toggle.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    const view = a.closest('li').dataset.view;
    savePreference(view);
    navigate({ view, page: 1 }, true);
  });

  function setTotal(view, total) {
    totals[view] = total;
    renderToggle();
  }

  function showMessage(text, action) {
    message.replaceChildren(text);
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = action.label;
      btn.addEventListener('click', action.run);
      message.append(btn);
    }
  }

  function htmlToElement(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content.firstElementChild;
  }

  function renderPagination(sourceHtml, view) {
    for (const slot of pagerSlots) {
      slot.replaceChildren();
      if (!sourceHtml) continue;
      const pager = htmlToElement(sourceHtml);
      for (const a of pager.querySelectorAll('a[href]')) {
        const page = Number(new URL(a.getAttribute('href'), location.origin).searchParams.get('page')) || 1;
        a.href = urlFor({ view, page });
        a.dataset.page = String(page);
        a.removeAttribute('rel');
      }
      slot.append(pager);
    }
  }

  panel.addEventListener('click', (e) => {
    const a = e.target.closest('.ao3bn-pagination a[data-page]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    navigate({ view: currentView, page: Number(a.dataset.page) }, true);
    toggle.scrollIntoView({ block: 'start' });
  });

  function describeError(err) {
    if (err.status === 429) return 'AO3 暂时限制了请求频率（429），请稍等一会儿再试。';
    if (err.status >= 500) return `AO3 暂时无法访问（HTTP ${err.status}），可能在维护或负载过高。`;
    if (err instanceof TypeError) return '网络连接失败，请检查网络后再试。';
    return `加载失败：${err.message}`;
  }

  function describeAge(fetchedAt) {
    const minutes = Math.round((Date.now() - fetchedAt) / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`;
  }

  async function showFilteredPage(view, page, refresh = false) {
    const seq = ++requestSeq;
    const config = VIEWS[view];
    heading.textContent = config.heading;
    resultList.replaceChildren();
    renderPagination(null);
    showMessage('加载中…');

    const reload = { label: '重新加载', run: () => showFilteredPage(view, page, true) };
    let data;
    try {
      data = await getPage(view, page, {
        refresh,
        onRetry: (n, err) => {
          if (seq === requestSeq) showMessage(`${describeError(err)} 正在自动重试（第 ${n} 次）…`);
        },
      });
    } catch (err) {
      if (seq !== requestSeq) return;
      showMessage(describeError(err), reload);
      return;
    }
    if (seq !== requestSeq) return;

    setTotal(view, data.total);
    if (data.stale) {
      showMessage(`${describeError(data.error)} 下面显示的是 ${describeAge(data.fetchedAt)}缓存的内容。`, reload);
    } else if (Date.now() - data.fetchedAt > 60 * 1000) {
      showMessage(`${describeAge(data.fetchedAt)}加载的内容。`, reload);
    } else {
      showMessage('');
    }

    if (data.total === 0) {
      if (!data.stale) showMessage(config.empty);
      return;
    }

    const perPage = 20;
    const from = (page - 1) * perPage + 1;
    const to = from + data.items.length - 1;
    heading.textContent = data.items.length
      ? `${config.heading}：第 ${from} - ${to} 条，共 ${data.total.toLocaleString()} 条`
      : `${config.heading}：共 ${data.total.toLocaleString()} 条`;
    if (!data.items.length && !data.stale) showMessage('这一页没有结果。');
    resultList.replaceChildren(...data.items.map(htmlToElement));
    renderPagination(data.pagination, view);
  }

  // ---------- 状态与路由 ----------

  function urlFor({ view, page }) {
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.delete(VIEW_PARAM);
    url.searchParams.delete(PAGE_PARAM);
    if (view !== 'all') {
      url.searchParams.set(VIEW_PARAM, view);
      if (page > 1) url.searchParams.set(PAGE_PARAM, String(page));
    }
    return url.pathname + url.search;
  }

  function stateFromUrl() {
    const params = new URLSearchParams(location.search);
    const view = params.get(VIEW_PARAM);
    if (!(view in VIEWS)) return null;
    return { view, page: Math.max(1, parseInt(params.get(PAGE_PARAM), 10) || 1) };
  }

  function render({ view, page }) {
    currentView = view;
    main.classList.toggle('ao3bn-active', view !== 'all');
    renderToggle();
    if (view === 'all') requestSeq++; // 放弃仍在进行的请求结果
    else showFilteredPage(view, page);
  }

  function navigate(state, push) {
    if (push) history.pushState({ ao3bn: state }, '', urlFor(state));
    render(state);
  }

  window.addEventListener('popstate', (e) => {
    const state = (e.state && e.state.ao3bn) || stateFromUrl() || { view: 'all', page: 1 };
    render(state);
  });

  // 记住上次选择的视图
  async function loadPreference() {
    const view = (await storageGet([STORAGE_KEY]))[STORAGE_KEY];
    return view in VIEWS ? view : 'all';
  }

  function savePreference(view) {
    storageSet({ [STORAGE_KEY]: view });
  }

  (async () => {
    const fromUrl = stateFromUrl();
    const state = fromUrl || { view: await loadPreference(), page: 1 };
    // 原页面翻到第 2 页以后时，不自动切到筛选视图，免得打断原来的浏览
    if (!fromUrl && new URLSearchParams(location.search).has('page')) state.view = 'all';
    history.replaceState({ ...history.state, ao3bn: state }, '');
    render(state);

    // 依次取其他筛选视图的第一页（有缓存就不请求），用于在按钮上显示数量
    for (const view of FILTER_VIEWS) {
      if (view === state.view) continue;
      try {
        setTotal(view, (await getPage(view, 1)).total);
      } catch {
        /* 数量拿不到就不显示 */
      }
    }
  })();
})();
