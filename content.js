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

  const cache = new Map(); // `${view}:${page}` -> Promise<{ total, items, pagination }>
  const totals = {}; // view -> 总数
  let requestSeq = 0;
  let currentView = 'all';

  // ---------- 搜索请求与解析 ----------

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

  function fetchPage(view, page) {
    const key = `${view}:${page}`;
    if (!cache.has(key)) {
      const promise = fetch(searchUrl(view, page), { credentials: 'same-origin' })
        .then((res) => {
          if (!res.ok) throw new HttpError(res.status);
          return res.text();
        })
        .then(parseSearchPage);
      // 失败的请求不缓存，方便重试
      promise.catch(() => cache.delete(key));
      cache.set(key, promise);
    }
    return cache.get(key);
  }

  // 确认搜索结果确实指向当前作品（防御性校验）
  const ownPath = new RegExp(`^/${kind}/${id}(?:[/?#]|$)`);
  function belongsHere(li) {
    return [...li.querySelectorAll('a[href]')].some((a) => ownPath.test(a.getAttribute('href')));
  }

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
      .filter(Boolean);

    const pagination = docMain.querySelector('ol.pagination');
    return { total, items, pagination };
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

  function showMessage(text, retry) {
    message.replaceChildren(text);
    if (retry) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = '重试';
      btn.addEventListener('click', retry);
      message.append(btn);
    }
  }

  function renderPagination(source, view) {
    for (const slot of pagerSlots) {
      slot.replaceChildren();
      if (!source) continue;
      const pager = source.cloneNode(true);
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

  async function showFilteredPage(view, page) {
    const seq = ++requestSeq;
    const config = VIEWS[view];
    heading.textContent = config.heading;
    resultList.replaceChildren();
    renderPagination(null);
    showMessage('加载中…');

    let data;
    try {
      data = await fetchPage(view, page);
    } catch (err) {
      if (seq !== requestSeq) return;
      const text = err.status === 429
        ? 'AO3 暂时限制了请求频率（429），请稍等一会儿再试。'
        : `加载失败：${err.message}`;
      showMessage(text, () => showFilteredPage(view, page));
      return;
    }
    if (seq !== requestSeq) return;

    setTotal(view, data.total);
    if (data.total === 0) {
      showMessage(config.empty);
      return;
    }

    const perPage = 20;
    const from = (page - 1) * perPage + 1;
    const to = from + data.items.length - 1;
    heading.textContent = data.items.length
      ? `${config.heading}：第 ${from} - ${to} 条，共 ${data.total.toLocaleString()} 条`
      : `${config.heading}：共 ${data.total.toLocaleString()} 条`;
    showMessage(data.items.length ? '' : '这一页没有结果。');
    // 节点只能挂在一处，从缓存再次渲染时用克隆
    resultList.replaceChildren(...data.items.map((li) => li.cloneNode(true)));
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

  // 记住上次选择的视图：插件里用 chrome.storage，bookmarklet 里用 AO3 域名下的 localStorage
  const hasExtensionStorage = typeof chrome !== 'undefined' && Boolean(chrome.storage && chrome.storage.local);

  function loadPreference() {
    return new Promise((resolve) => {
      const done = (view) => resolve(view in VIEWS ? view : 'all');
      try {
        if (hasExtensionStorage) chrome.storage.local.get(STORAGE_KEY, (r) => done(r && r[STORAGE_KEY]));
        else done(localStorage.getItem(STORAGE_KEY));
      } catch {
        done('all');
      }
    });
  }

  function savePreference(view) {
    try {
      if (hasExtensionStorage) chrome.storage.local.set({ [STORAGE_KEY]: view });
      else localStorage.setItem(STORAGE_KEY, view);
    } catch {
      /* ignore */
    }
  }

  (async () => {
    const fromUrl = stateFromUrl();
    const state = fromUrl || { view: await loadPreference(), page: 1 };
    // 原页面翻到第 2 页以后时，不自动切到筛选视图，免得打断原来的浏览
    if (!fromUrl && new URLSearchParams(location.search).has('page')) state.view = 'all';
    history.replaceState({ ...history.state, ao3bn: state }, '');
    render(state);

    // 依次预取其他筛选视图的第一页，用于在按钮上显示数量
    for (const view of FILTER_VIEWS) {
      if (view === state.view) continue;
      try {
        setTotal(view, (await fetchPage(view, 1)).total);
      } catch {
        /* 数量拿不到就不显示 */
      }
    }
  })();
})();
