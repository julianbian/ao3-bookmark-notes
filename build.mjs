#!/usr/bin/env node
// 生成 bookmarklet 版本：
//   node build.mjs                 → dist/ao3-bookmark-notes.js（CSS + content.js 打包），并打印 SRI 哈希
//   node build.mjs --url <脚本地址>  → 另外生成 dist/bookmarklet.txt（带 SRI 校验的加载器）
//
// 加载器里写死了打包文件的 SHA-384 哈希，文件只要被改动，浏览器就会拒绝执行。
// 所以每次改了 content.js / content.css，都要重新构建、重新上传，并把书签换成新的加载器。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(root, name), 'utf8');

const css = read('content.css');
const js = read('content.js');

const bundle = `/* AO3 Bookmark Notes Filter — bookmarklet 版，由 build.mjs 生成，请勿手改 */
(() => {
  if (!/^\\/(works|series|external_works)\\/\\d+\\/bookmarks\\/?$/.test(location.pathname)) {
    alert('AO3 书签筛选：请在作品的书签页（/works/<id>/bookmarks）上使用');
    return;
  }
  if (!document.getElementById('ao3bn-style')) {
    const style = document.createElement('style');
    style.id = 'ao3bn-style';
    style.textContent = ${JSON.stringify(css)};
    document.head.append(style);
  }
})();
${js}`;

const distDir = join(root, 'dist');
mkdirSync(distDir, { recursive: true });
const bundlePath = join(distDir, 'ao3-bookmark-notes.js');
writeFileSync(bundlePath, bundle);

const integrity = `sha384-${createHash('sha384').update(bundle, 'utf8').digest('base64')}`;
console.log(`打包完成：${bundlePath}`);
console.log(`SRI：${integrity}`);

const urlIndex = process.argv.indexOf('--url');
if (urlIndex === -1) {
  console.log('\n上传打包文件后，用 --url <文件地址> 再跑一次以生成加载器。');
  process.exit(0);
}

const scriptUrl = process.argv[urlIndex + 1];
if (!scriptUrl || !/^https:\/\//.test(scriptUrl)) {
  console.error('--url 需要一个 https:// 开头的地址');
  process.exit(1);
}

// 加载器：插入一个带 integrity 的 <script>，哈希对不上浏览器就不执行；
// no-referrer 避免把当前 AO3 页面地址发给托管方
const loader = `(() => {
  const s = document.createElement('script');
  s.src = ${JSON.stringify(scriptUrl)};
  s.integrity = ${JSON.stringify(integrity)};
  s.crossOrigin = 'anonymous';
  s.referrerPolicy = 'no-referrer';
  s.onerror = () => alert('AO3 书签筛选：脚本加载失败，或文件校验不通过（可能已被改动），已拒绝运行。');
  s.onload = () => s.remove();
  document.head.append(s);
})();`;

const bookmarklet = `javascript:${encodeURIComponent(loader.replace(/\n\s*/g, ''))}`;
const outPath = join(distDir, 'bookmarklet.txt');
writeFileSync(outPath, `${bookmarklet}\n`);
console.log(`\n加载器已写入：${outPath}`);
console.log('把这一整行复制为书签的网址即可。');
