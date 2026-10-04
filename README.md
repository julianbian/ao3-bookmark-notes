# AO3 Bookmark Notes & Timeline

两个 AO3 小功能，电脑上是 Chrome 插件，手机上是带 SRI 校验的 bookmarklet，共用同一份代码。

## 功能一：书签页只看附 note / 推荐的书签

在作品（以及系列、外部作品）的书签页 `/works/<id>/bookmarks` 顶部加三个视图切换：

| 按钮 | 内容 |
|---|---|
| **全部书签（N）** | 原页面 |
| **附 note（N）** | 所有附了 note 的公开书签 |
| **推荐 · 附 note（N）** | 标为推荐（Rec）且附了 note 的公开书签 |

后两个视图通过 AO3 书签搜索获取：
`bookmark_query=bookmarkable_id:<id> AND bookmarkable_type:Work` + `with_notes=1`（推荐视图再加 `rec=1`），
按书签时间倒序、每页 20 条显示。

- 视图和页码保存在 URL（`?bn_view=recs&bn_page=2`），可刷新、可后退、可分享链接
- 会记住上次选择的视图，下次打开书签页时自动沿用
- 打开页面时会依次预取另外两个筛选视图的第一页，用来在按钮上显示数量
- 加载过的页面缓存在本地，30 分钟内再看（包括刷新、后退、重新打开）不会再请求 AO3；
  AO3 返回 5xx / Cloudflare 52x 时自动重试两次，仍然失败就先显示旧缓存，可点「重新加载」
- 书签进入搜索索引有延迟，刚添加的书签可能要过几分钟才出现
- 遇到 AO3 限流（429）时会提示，可点「重试」

## 功能二：订阅作者时间线

把你订阅的所有作者拼成一个 `creators:(a OR b OR ...)` 搜索，按更新时间排序，
相当于"我订阅的作者最近发了/更新了什么"。

- **插件**：AO3 导航栏多一个 **My Timeline** 菜单：
  「M/M（带筛选侧栏）」「全部分类」「立即同步订阅列表」，在新标签页打开
- **bookmarklet**：点一下直接跳到 M/M 时间线
- 订阅列表缓存在本地，超过一天才重新抓（插件在你浏览 AO3 时顺手刷新，bookmarklet 在点它时刷新）
- 抓取中途失败（限流、登录过期）不会覆盖已有的缓存
- M/M 视图用 `/works?tag_id=M/M`，所以有 AO3 自带的筛选侧栏；代价是只显示 M/M 分类的作品

> 如果之前在 Tampermonkey 里装过 `ao3-subscribed-authors-timeline.user.js`，装了插件之后可以停用它，
> 否则导航栏会出现两个 My Timeline 菜单。

## 电脑：安装插件

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录

## 手机（安卓 Chrome 等不支持扩展的浏览器）：bookmarklet

代码打包成脚本文件托管在网上，书签里只放一小段**带 SRI 校验的加载器**：
每次点书签时，浏览器会下载脚本并核对 SHA-384 哈希，文件被改过一个字节都会拒绝执行。

| 书签 | 加载器文件 | 在哪里用 |
|---|---|---|
| `ao3note` | `dist/bookmarklet-notes.txt` | 作品的书签页 |
| `ao3tl` | `dist/bookmarklet-timeline.txt` | AO3 任意页面（需已登录） |

### 安装和使用

1. 随便给一个页面加书签，然后编辑这个书签：名称改成好输入的（如上表）；网址换成对应加载器文件里的那一整行。
   也可以在电脑 Chrome 上建好，通过书签同步到手机
2. 在 AO3 页面上，点**地址栏**、删掉原网址、输入书签名，点下拉建议里带星形图标的那一项
   （安卓 Chrome 从书签菜单里直接点 `javascript:` 书签不会执行，必须从地址栏调用）

bookmarklet 版的数据存在 AO3 域名下的 localStorage 里。

### 发布新版本

1. 打包：`node build.mjs`，生成 `dist/` 下的脚本
2. 提交并 push，记下这次 commit 的哈希
3. 用锁定 commit 的 jsDelivr 目录地址生成加载器：
   ```bash
   node build.mjs --base https://cdn.jsdelivr.net/gh/<用户名>/<仓库>@<commit哈希>/dist/
   ```

> 改了源码后，要重新走一遍上面三步，并把手机上对应的书签换成新的加载器
> （哈希变了，旧书签仍指向旧 commit 的旧版本，不会自动更新）。
