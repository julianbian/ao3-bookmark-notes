#!/usr/bin/env node
// 生成 bookmarklet 版本：
//   node build.mjs                    → dist/ 下的打包文件，并打印各自的 SRI 哈希
//   node build.mjs --base <目录地址>    → 另外生成 dist/bookmarklet-*.txt（带 SRI 校验的加载器）
//
// --base 是 dist/ 目录在网上的地址（以 / 结尾），比如
//   https://cdn.jsdelivr.net/gh/<用户名>/<仓库>@<commit哈希>/dist/
//
// 加载器里写死了打包文件的 SHA-384 哈希，文件只要被改动，浏览器就会拒绝执行。
// 所以每次改了源码，都要重新构建、重新上传，并把书签换成新的加载器。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(root, name), 'utf8');
const header = '/* 由 build.mjs 生成，请勿手改 */\n';

const bundles = [
  {
    name: 'notes',
    file: 'ao3-bookmark-notes.js',
    source: `/* AO3 Bookmark Notes Filter — bookmarklet 版，由 build.mjs 生成，请勿手改 */
(() => {
  if (!/^\\/(works|series|external_works)\\/\\d+\\/bookmarks\\/?$/.test(location.pathname)) {
    alert('AO3 书签筛选：请在作品的书签页（/works/<id>/bookmarks）上使用');
    return;
  }
  if (!document.getElementById('ao3bn-style')) {
    const style = document.createElement('style');
    style.id = 'ao3bn-style';
    style.textContent = ${JSON.stringify(read('content.css'))};
    document.head.append(style);
  }
})();
${read('content.js')}`,
  },
  {
    name: 'timeline',
    file: 'ao3-timeline.js',
    // 用块作用域定义标记，timeline.js 据此进入 bookmarklet 模式
    source: `${header}{
const AO3TL_BOOKMARKLET = true;
${read('timeline.js')}}
`,
  },
];

const distDir = join(root, 'dist');
mkdirSync(distDir, { recursive: true });

for (const bundle of bundles) {
  writeFileSync(join(distDir, bundle.file), bundle.source);
  bundle.integrity = `sha384-${createHash('sha384').update(bundle.source, 'utf8').digest('base64')}`;
  console.log(`dist/${bundle.file}  ${bundle.integrity}`);
}

const baseIndex = process.argv.indexOf('--base');
if (baseIndex === -1) {
  console.log('\n上传 dist/ 后，用 --base <dist 目录地址> 再跑一次以生成加载器。');
  process.exit(0);
}

const base = process.argv[baseIndex + 1];
if (!base || !/^https:\/\/.+\/$/.test(base)) {
  console.error('--base 需要一个 https:// 开头、以 / 结尾的目录地址');
  process.exit(1);
}

// 加载器：插入一个带 integrity 的 <script>，哈希对不上浏览器就不执行；
// no-referrer 避免把当前 AO3 页面地址发给托管方
for (const bundle of bundles) {
  const loader = `(() => {
    const s = document.createElement('script');
    s.src = ${JSON.stringify(base + bundle.file)};
    s.integrity = ${JSON.stringify(bundle.integrity)};
    s.crossOrigin = 'anonymous';
    s.referrerPolicy = 'no-referrer';
    s.onerror = () => alert('脚本加载失败，或文件校验不通过（可能已被改动），已拒绝运行。');
    s.onload = () => s.remove();
    document.head.append(s);
  })();`;
  const bookmarklet = `javascript:${encodeURIComponent(loader.replace(/\n\s*/g, ''))}`;
  const outFile = `bookmarklet-${bundle.name}.txt`;
  writeFileSync(join(distDir, outFile), `${bookmarklet}\n`);
  console.log(`加载器：dist/${outFile}`);
}
