#!/usr/bin/env node
/**
 * SyMptOMS static site build.
 *
 * Renders src/pages/**.html into dist/ using src/layouts/base.html, the shared
 * partials in src/partials/ and the single source of truth in
 * src/site.config.json. No dependencies: plain Node, stdlib only.
 *
 *   node build.mjs            build into dist/
 *   node build.mjs --check    check EN/ES parity without writing anything
 *
 * See src/README.md for the template syntax and how to add a page.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist');

/* ------------------------------------------------------------------ *
 * Tiny template engine: {{ var }}, {{> partial }}, {{#if}}, {{#each}}
 * ------------------------------------------------------------------ */

const partialCache = new Map();

function readPartial(name) {
  if (!partialCache.has(name)) {
    const file = path.join(SRC, 'partials', name + '.html');
    if (!fs.existsSync(file)) throw new Error('missing partial: ' + name);
    partialCache.set(name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, ''));
  }
  return partialCache.get(name);
}

/** Indent every line after the first — the first already sits after the tag. */
function indentTail(text, indent) {
  if (!indent) return text;
  return text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : indent + line))
    .join('\n');
}

function expandPartials(tpl, depth = 0) {
  if (depth > 10) throw new Error('partial recursion too deep');
  let changed = false;
  // A partial alone on its line inherits that line's indentation.
  let out = tpl.replace(/^([ \t]*)\{\{>\s*([\w.-]+)\s*\}\}[ \t]*$/gm, (_, indent, name) => {
    changed = true;
    return indent + indentTail(readPartial(name), indent);
  });
  out = out.replace(/\{\{>\s*([\w.-]+)\s*\}\}/g, (_, name) => {
    changed = true;
    return readPartial(name);
  });
  return changed ? expandPartials(out, depth + 1) : out;
}

/** A control tag alone on its line contributes no output and no blank line. */
function stripStandaloneTags(tpl) {
  return tpl.replace(/^[ \t]*(\{\{\s*(?:#if|#each|\/if|\/each|else)[^}]*\}\})[ \t]*\r?\n/gm, '$1');
}

function tokenize(tpl) {
  const re = /\{\{\s*(#if|#each|\/if|\/each|else)?\s*([^}]*?)\s*\}\}/g;
  const tokens = [];
  let last = 0;
  let m;
  while ((m = re.exec(tpl))) {
    if (m.index > last) tokens.push({ t: 'text', v: tpl.slice(last, m.index) });
    tokens.push({ t: m[1] || 'var', v: m[2] });
    last = m.index + m[0].length;
  }
  if (last < tpl.length) tokens.push({ t: 'text', v: tpl.slice(last) });

  // Record the indentation of any {{var}} that starts its own line, so that
  // multi-line values (main content, inline scripts) stay aligned.
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].t !== 'var') continue;
    const prev = tokens[i - 1];
    const trailing = prev && prev.t === 'text' ? prev.v.match(/(?:^|\n)([ \t]*)$/) : null;
    tokens[i].indent = trailing ? trailing[1] : '';
  }
  return tokens;
}

function parse(tokens, i = 0) {
  const nodes = [];
  while (i < tokens.length) {
    const tk = tokens[i];
    if (tk.t === '/if' || tk.t === '/each' || tk.t === 'else') return [nodes, i];
    if (tk.t === '#if') {
      const [cons, j] = parse(tokens, i + 1);
      let alt = [];
      let k = j;
      if (tokens[k] && tokens[k].t === 'else') {
        const parsed = parse(tokens, k + 1);
        alt = parsed[0];
        k = parsed[1];
      }
      nodes.push({ t: 'if', path: tk.v, cons, alt });
      i = k + 1;
    } else if (tk.t === '#each') {
      const [body, j] = parse(tokens, i + 1);
      nodes.push({ t: 'each', path: tk.v, body });
      i = j + 1;
    } else {
      nodes.push(tk);
      i++;
    }
  }
  return [nodes, i];
}

function lookup(ctx, dotted) {
  if (dotted === 'this') return ctx.this;
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), ctx);
}

function renderNodes(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') {
      out += n.v;
    } else if (n.t === 'var') {
      const v = lookup(ctx, n.v);
      out += v == null ? '' : indentTail(String(v), n.indent || '');
    } else if (n.t === 'if') {
      const v = lookup(ctx, n.path);
      const truthy = Array.isArray(v) ? v.length > 0 : Boolean(v);
      out += renderNodes(truthy ? n.cons : n.alt, ctx);
    } else if (n.t === 'each') {
      for (const item of lookup(ctx, n.path) || []) {
        const scope = item && typeof item === 'object'
          ? { ...ctx, ...item, this: item }
          : { ...ctx, this: item };
        out += renderNodes(n.body, scope);
      }
    }
  }
  return out;
}

function render(tpl, ctx) {
  const prepared = stripStandaloneTags(expandPartials(tpl.replace(/\r\n/g, '\n')));
  const [nodes] = parse(tokenize(prepared));
  return renderNodes(nodes, ctx);
}

/* ------------------------------------------------------------------ *
 * Page sources
 * ------------------------------------------------------------------ */

/**
 * A page source is its <section id="main"> block, optionally accompanied by
 * these named blocks:
 *   <!-- @head -->     ... <!-- /@head -->     extra tags for <head>
 *   <!-- @prelude -->  ... <!-- /@prelude -->  markup inside #masthead, after the nav
 *   <!-- @scripts -->  ... <!-- /@scripts -->  scripts after the shared ones
 */
function parsePageSource(text) {
  let rest = text.replace(/\r\n/g, '\n');
  const grab = (tag) => {
    const found = [];
    const re = new RegExp(
      '<!--\\s*@' + tag + '\\s*-->\\n?([\\s\\S]*?)\\n?<!--\\s*/@' + tag + '\\s*-->[ \\t]*\\n?',
      'g'
    );
    rest = rest.replace(re, (_, body) => {
      found.push(body);
      return '';
    });
    return found.join('\n\n');
  };
  const headExtra = grab('head');
  const prelude = grab('prelude');
  const tailScripts = grab('scripts');
  return { headExtra, prelude, tailScripts, main: rest.trim() };
}

/* ------------------------------------------------------------------ *
 * Build
 * ------------------------------------------------------------------ */

let config;
let layout;
let localeIds;
let problems;

/** (Re)read everything that a build depends on, so --watch picks up edits. */
function loadSources() {
  partialCache.clear();
  // The asset hashes must be recomputed on every build too. Until 2026-09-14
  // they were not: a --watch process kept the hashes from its first build, so
  // after a CSS change every rebuild still wrote the OLD ?v= into the pages and
  // any browser holding that URL in cache kept the old stylesheet -- the exact
  // stale pairing the hashing exists to prevent. One-shot builds (and
  // therefore deploys) were never affected: each is a fresh process.
  hashCache.clear();
  config = JSON.parse(fs.readFileSync(path.join(SRC, 'site.config.json'), 'utf8'));
  layout = fs.readFileSync(path.join(SRC, 'layouts', 'base.html'), 'utf8');
  localeIds = Object.keys(config.locales);
  problems = [];
}

/** Path to `file` in locale `toId`, as seen from a page in locale `fromId`. */
function relHref(fromId, toId, file) {
  const fromDir = config.locales[fromId].dir;
  const toDir = config.locales[toId].dir;
  if (fromDir === toDir) return file;
  const up = fromDir ? '../'.repeat(fromDir.split('/').length) : '';
  return up + (toDir ? toDir + '/' : '') + file;
}

/**
 * Which nav item this page marks as current. Defaults to the page's own id, so
 * a page named like its nav entry needs no configuration; set "nav": null for
 * a page that should not highlight anything (e.g. one not in the nav at all).
 */
function navKeyFor(pageId) {
  const page = config.pages[pageId];
  return page.nav === undefined ? pageId : page.nav;
}

/** The locales a page is built in: every locale unless it lists its own. */
function pageLocales(pageId) {
  return config.pages[pageId].locales ?? localeIds;
}

/* ------------------------------------------------------------------ *
 * Public URLs and head metadata
 * ------------------------------------------------------------------ */

/**
 * The canonical public URL of a page. Homepages are the directory form
 * ("/", "/es/"), which is what GEOTEC links to and what Hosting serves;
 * every other page is its .html file, as the site's own links have it.
 */
function publicUrl(pageId, localeId) {
  const dir = config.locales[localeId].dir;
  const base = config.siteUrl.replace(/\/+$/, '') + '/' + (dir ? dir + '/' : '');
  return pageId === 'index' ? base : base + pageId + '.html';
}

/**
 * Escape for a double-quoted attribute. The engine inserts values raw, which
 * is fine for markup authored here but not for a title carrying a quote.
 * Existing entities are left alone, so "&copy;" is not double-escaped.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function headMeta(pageId, localeId) {
  const page = config.pages[pageId];
  const locale = config.locales[localeId];
  const locales = pageLocales(pageId);
  const indexable = !page.noindex;
  const canonical = indexable ? publicUrl(pageId, localeId) : '';

  return {
    indexable,
    canonical,
    description: escapeHtml(page.description?.[localeId] ?? page.description?.en),
    ogTitle: escapeHtml(page.title[localeId] ?? page.title.en),
    ogLocale: locale.ogLocale,
    ogImage: config.siteUrl.replace(/\/+$/, '') + '/' + config.share.image,
    ogImageAlt: escapeHtml(config.strings[localeId].shareImageAlt),
    // hreflang must be reciprocal and include the page itself; generating the
    // same list on every locale's copy of a page makes that true by construction.
    alternates:
      indexable && locales.length > 1
        ? [
            ...locales.map((id) => ({ hreflang: config.locales[id].lang, href: publicUrl(pageId, id) })),
            { hreflang: 'x-default', href: publicUrl(pageId, locales[0]) },
          ]
        : [],
    ogLocaleAlternates: indexable
      ? locales.filter((id) => id !== localeId).map((id) => ({ value: config.locales[id].ogLocale }))
      : [],
  };
}

/*
 * Cache busting. Hosting serves these with a default max-age and the repo
 * sets no `headers` block, so a browser can pair new markup with yesterday's
 * stylesheet. A content hash in the query string gives a changed file a new
 * URL; a query string rather than a renamed file, so paths stay stable.
 */
const hashCache = new Map();

function assetUrl(href) {
  if (!hashCache.has(href)) {
    const file = path.join(ROOT, href);
    let tag = '';
    if (fs.existsSync(file)) {
      tag = '?v=' + crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
    }
    hashCache.set(href, href + tag);
  }
  return hashCache.get(href);
}

function pageSourcePath(pageId, localeId) {
  return path.join(SRC, 'pages', config.locales[localeId].dir, pageId + '.html');
}

function buildPage(pageId, localeId) {
  const page = config.pages[pageId];
  const locale = config.locales[localeId];

  // A "rootRelative" page is served at arbitrary depths -- 404.html is what
  // Firebase Hosting returns for /es/anything/missing.html -- so relative paths
  // would resolve against the requested URL and break. Its assets and links are
  // root-absolute instead.
  const rootRelative = Boolean(page.rootRelative);
  const localeBase = rootRelative ? '/' + (locale.dir ? locale.dir + '/' : '') : '';
  const prefix = rootRelative ? '/' : locale.dir ? '../'.repeat(locale.dir.split('/').length) : '';
  const source = parsePageSource(fs.readFileSync(pageSourcePath(pageId, localeId), 'utf8'));

  const ctx = {
    ...config,
    prefix,
    lang: locale.lang,
    title: escapeHtml(page.title[localeId] ?? page.title.en),
    meta: headMeta(pageId, localeId),
    homeHref: localeBase + 'index.html',
    bodyAttr: page.bodyClass ? ' class="' + page.bodyClass + '"' : '',
    strings: config.strings[localeId],
    stylesheets: config.stylesheets.map((href) => ({ href: prefix + assetUrl(href) })),
    // Site-wide scripts, then this page's own. Both go through assetUrl, so a
    // page script gets the same content hash as a shared one -- without that, a
    // deploy could pair new page markup with a cached old blog.js, which is the
    // exact trap the hashing was added for.
    scripts: [...config.scripts, ...(page.scripts ?? [])].map((href) => ({
      href: prefix + assetUrl(href),
    })),
    nav: config.nav.map((item) => ({
      href: localeBase + item.page + '.html',
      label: item.label[localeId] ?? item.label.en,
      current: navKeyFor(pageId) === item.page,
    })),
    langs: localeIds.map((id) => {
      // A page that does not exist in the other locale switches to that
      // locale's homepage rather than to a 404.
      const file = pageLocales(pageId).includes(id) ? pageId + '.html' : 'index.html';
      const targetDir = config.locales[id].dir;
      return {
        code: id.toUpperCase(),
        href: rootRelative ? '/' + (targetDir ? targetDir + '/' : '') + file : relHref(localeId, id, file),
        cls: id === localeId ? 'lang-disabled' : 'lang',
      };
    }),
  };

  // Page bodies run through the same engine, so {{prefix}} and the shared
  // strings work inside page content — the same markup then serves both locales.
  for (const [key, value] of Object.entries(source)) {
    ctx[key] = value ? render(value, ctx) : value;
  }

  const outFile = path.join(OUT, locale.dir, pageId + '.html');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, render(layout, ctx), 'utf8');
}

/**
 * Copy a tree into dist, skipping files identical in size and mtime. With
 * `mirror`, anything no longer in the source is deleted too, or a file removed
 * from assets/ keeps shipping. Not used for src/standalone/, which copies into
 * the root of dist/ beside the generated pages.
 */
function syncDir(from, to, stats, mirror = false) {
  if (!fs.existsSync(from)) return;
  const names = new Set();
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    names.add(entry.name);
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      syncDir(src, dst, stats, mirror);
    } else {
      const s = fs.statSync(src);
      const d = fs.existsSync(dst) ? fs.statSync(dst) : null;
      if (d && d.size === s.size && d.mtimeMs >= s.mtimeMs) {
        stats.skipped++;
        continue;
      }
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      stats.copied++;
    }
  }
  if (mirror && fs.existsSync(to)) {
    for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
      if (names.has(entry.name)) continue;
      fs.rmSync(path.join(to, entry.name), { recursive: true, force: true });
      stats.removed++;
    }
  }
}

/**
 * Delete generated pages that no longer have a source, so that removing a page
 * from site.config.json actually removes it from the deploy.
 */
function pruneStaleHtml(expected, stats) {
  if (!fs.existsSync(OUT)) return;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.html') && !expected.has(path.resolve(p))) {
        fs.rmSync(p);
        stats.pruned++;
      }
    }
  })(OUT);
}

/**
 * robots.txt and sitemap.xml, generated so they cannot drift from the page
 * list. Before these existed the catch-all rewrite in firebase.json answered
 * /robots.txt with the homepage's HTML and a 200.
 */
function writeCrawlerFiles() {
  const site = config.siteUrl.replace(/\/+$/, '');
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  fs.writeFileSync(
    path.join(OUT, 'robots.txt'),
    '# Generated by build.mjs from src/site.config.json.\n' +
      'User-agent: *\n' +
      'Allow: /\n\n' +
      'Sitemap: ' + site + '/sitemap.xml\n',
    'utf8'
  );

  const urls = [];
  for (const pageId of Object.keys(config.pages)) {
    if (config.pages[pageId].noindex) continue;
    const alternates = headMeta(pageId, pageLocales(pageId)[0]).alternates;
    for (const localeId of pageLocales(pageId)) {
      if (!fs.existsSync(pageSourcePath(pageId, localeId))) continue;
      const links = alternates
        .map((a) => '    <xhtml:link rel="alternate" hreflang="' + xml(a.hreflang) + '" href="' + xml(a.href) + '"/>\n')
        .join('');
      urls.push('  <url>\n    <loc>' + xml(publicUrl(pageId, localeId)) + '</loc>\n' + links + '  </url>\n');
    }
  }
  for (const file of config.sitemapExtra ?? []) {
    urls.push('  <url>\n    <loc>' + xml(site + '/' + file) + '</loc>\n  </url>\n');
  }

  fs.writeFileSync(
    path.join(OUT, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!-- Generated by build.mjs from src/site.config.json. -->\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
      urls.join('') +
      '</urlset>\n',
    'utf8'
  );
}

/** Every .html the current sources say should exist in dist. */
function expectedHtml() {
  const set = new Set();
  for (const pageId of Object.keys(config.pages)) {
    for (const localeId of pageLocales(pageId)) {
      if (config.locales[localeId] && fs.existsSync(pageSourcePath(pageId, localeId))) {
        set.add(path.resolve(OUT, config.locales[localeId].dir, pageId + '.html'));
      }
    }
  }
  for (const root of [path.join(SRC, 'standalone')]) {
    if (!fs.existsSync(root)) continue;
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else set.add(path.resolve(OUT, path.relative(root, p)));
      }
    })(root);
  }
  return set;
}

function checkParity() {
  if (!/^https:\/\/[^/]+\/?$/.test(config.siteUrl || '')) {
    problems.push('siteUrl must be an https origin such as "https://symptoms-app.com" (canonical, hreflang and the sitemap are built from it)');
  }
  for (const [pageId, page] of Object.entries(config.pages)) {
    for (const localeId of pageLocales(pageId)) {
      if (!config.locales[localeId]) {
        problems.push('page "' + pageId + '" lists unknown locale "' + localeId + '"');
        continue;
      }
      if (!fs.existsSync(pageSourcePath(pageId, localeId))) {
        problems.push(
          'page "' + pageId + '" has no ' + localeId.toUpperCase() + ' source (' +
          path.relative(ROOT, pageSourcePath(pageId, localeId)).replace(/\\/g, '/') + ')'
        );
      }
      if (!page.title[localeId]) {
        problems.push('page "' + pageId + '" has no ' + localeId.toUpperCase() + ' title in site.config.json');
      }
      // Search results and link previews show this; an indexable page without
      // one gets whatever a crawler scrapes, which is how 10 of 18 pages ended
      // up with no preview at all.
      if (!page.noindex && !page.description?.[localeId]) {
        problems.push('page "' + pageId + '" has no ' + localeId.toUpperCase() + ' description in site.config.json');
      }
    }
    // A source file for a locale the page opts out of would be silently ignored.
    for (const localeId of localeIds) {
      if (!pageLocales(pageId).includes(localeId) && fs.existsSync(pageSourcePath(pageId, localeId))) {
        problems.push(
          path.relative(ROOT, pageSourcePath(pageId, localeId)).replace(/\\/g, '/') +
          ' exists, but page "' + pageId + '" is not built in ' + localeId.toUpperCase()
        );
      }
    }
    const navKey = navKeyFor(pageId);
    if (navKey && !config.nav.some((n) => n.page === navKey)) {
      problems.push('page "' + pageId + '" marks nav item "' + navKey + '" current, but no such nav item exists');
    }
    // A mistyped page script would otherwise ship as a silent 404.
    for (const href of page.scripts ?? []) {
      if (!fs.existsSync(path.join(ROOT, href))) {
        problems.push('page "' + pageId + '" lists script "' + href + '", which does not exist');
      }
    }
  }
  for (const item of config.nav) {
    if (!config.pages[item.page]) {
      problems.push('nav item "' + item.page + '" points at a page that is not listed in "pages"');
    }
    for (const localeId of localeIds) {
      if (!item.label[localeId]) {
        problems.push('nav item "' + item.page + '" has no ' + localeId.toUpperCase() + ' label');
      }
    }
  }
  for (const file of config.sitemapExtra ?? []) {
    if (!fs.existsSync(path.join(SRC, 'standalone', file))) {
      problems.push('sitemapExtra lists "' + file + '", which is not in src/standalone/');
    }
  }
  // Page sources with no entry in the config are never built — easy to miss.
  for (const localeId of localeIds) {
    const dir = path.join(SRC, 'pages', config.locales[localeId].dir);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.html')) continue;
      if (!config.pages[f.replace(/\.html$/, '')]) {
        const where = config.locales[localeId].dir ? config.locales[localeId].dir + '/' : '';
        problems.push('src/pages/' + where + f + ' is not listed in "pages" and will not be built');
      }
    }
  }
}

function runBuild({ checkOnly = false, quiet = false } = {}) {
  loadSources();
  checkParity();

  if (!checkOnly) {
    let built = 0;
    for (const pageId of Object.keys(config.pages)) {
      for (const localeId of pageLocales(pageId)) {
        if (config.locales[localeId] && fs.existsSync(pageSourcePath(pageId, localeId))) {
          buildPage(pageId, localeId);
          built++;
        }
      }
    }

    const stats = { copied: 0, skipped: 0, pruned: 0, removed: 0 };
    syncDir(path.join(ROOT, 'assets'), path.join(OUT, 'assets'), stats, true);
    syncDir(path.join(ROOT, 'images'), path.join(OUT, 'images'), stats, true);
    syncDir(path.join(SRC, 'standalone'), OUT, stats);
    pruneStaleHtml(expectedHtml(), stats);
    writeCrawlerFiles();

    console.log('built ' + built + ' pages -> ' + path.relative(ROOT, OUT) + '/');
    if (stats.pruned) console.log('pruned ' + stats.pruned + ' stale page(s)');
    if (stats.removed) console.log('removed ' + stats.removed + ' file(s)/folder(s) no longer in assets/ or images/');
    if (!quiet) console.log('assets: ' + stats.copied + ' copied, ' + stats.skipped + ' unchanged');
  }

  if (problems.length) {
    console.error(problems.length + ' problem(s):');
    for (const p of problems) console.error('  - ' + p);
    return false;
  }
  if (!quiet) console.log('EN/ES parity OK');
  return true;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const watch = process.argv.includes('--watch');

  const ok = runBuild({ checkOnly });
  if (!ok && !watch) process.exitCode = 1;
  if (!watch) return;

  // assets/ is watched as well as src/: the stylesheets and scripts live there,
  // and a change to custom.css used to reach dist/ only on the next src/ edit.
  // images/ is not watched -- it is large and rarely edited; rebuild by hand.
  console.log('watching src/ and assets/ for changes — Ctrl+C to stop');
  let timer = null;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      process.stdout.write(new Date().toLocaleTimeString() + '  ');
      try {
        runBuild({ quiet: true });
      } catch (err) {
        console.error('build failed: ' + err.message);
      }
    }, 80);
  };
  fs.watch(SRC, { recursive: true }, rebuild);
  fs.watch(path.join(ROOT, 'assets'), { recursive: true }, rebuild);
}

main();
