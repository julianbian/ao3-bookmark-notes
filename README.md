# AO3 Bookmark Notes Filter

在 AO3 作品（以及系列、外部作品）的书签页 `/works/<id>/bookmarks` 顶部加三个视图切换：

| 按钮 | 内容 |
|---|---|
| **全部书签（N）** | 原页面 |
| **附 note（N）** | 所有附了 note 的公开书签 |
| **推荐 · 附 note（N）** | 标为推荐（Rec）且附了 note 的公开书签 |

后两个视图通过 AO3 书签搜索获取：
`bookmark_query=bookmarkable_id:<id> AND bookmarkable_type:Work` + `with_notes=1`（推荐视图再加 `rec=1`），
按书签时间倒序、每页 20 条显示。

## 安装

1. 打开 `chrome://extensions`，开启右上角「开发者模式」
2. 点「加载已解压的扩展程序」，选择本目录

## 手机版（安卓 Chrome 等不支持扩展的浏览器）：bookmarklet

同一份代码打包成一个脚本文件托管在网上，书签里只放一小段**带 SRI 校验的加载器**：
每次点书签时，浏览器会下载脚本并核对 SHA-384 哈希，文件被改过一个字节都会拒绝执行。

### 发布

1. 打包：`node build.mjs`，生成 `dist/ao3-bookmark-notes.js`
2. 把它提交到你自己的公开 GitHub 仓库并 push，记下这次 commit 的哈希
3. 用锁定 commit 的 jsDelivr 地址生成加载器：
   ```bash
   node build.mjs --url https://cdn.jsdelivr.net/gh/<用户名>/<仓库>@<commit哈希>/dist/ao3-bookmark-notes.js
   ```
   加载器写在 `dist/bookmarklet.txt`

> 改了 `content.js` 或 `content.css` 后，要重新走一遍上面三步，并把手机上的书签换成新的加载器
> （哈希变了，旧书签会因为校验不通过而拒绝运行）。

### 在安卓 Chrome 上安装和使用

1. 随便给一个页面加书签，然后编辑这个书签：名称改成好输入的，比如 `ao3note`；网址换成 `bookmarklet.txt` 里的那一整行
2. 打开作品的书签页，在**地址栏**输入 `ao3note`，点下拉建议里的那个书签
   （安卓 Chrome 从书签菜单里直接点 `javascript:` 书签不会执行，必须从地址栏调用）
3. 页面上出现三个切换按钮；之后翻页、切换视图都不用再点书签

bookmarklet 版用 AO3 域名下的 localStorage 记住上次选择的视图。

## 说明

- 视图和页码保存在 URL（`?bn_view=recs&bn_page=2`），可刷新、可后退、可分享链接
- 会记住上次选择的视图，下次打开书签页时自动沿用
- 打开页面时会依次预取另外两个筛选视图的第一页，用来在按钮上显示数量
- 书签进入搜索索引有延迟，刚添加的书签可能要过几分钟才出现
- 遇到 AO3 限流（429）时会提示，可点「重试」
