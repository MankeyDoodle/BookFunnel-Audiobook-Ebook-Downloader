// ==UserScript==
// @name         BookFunnel Audiobook + Ebook Downloader
// @namespace    https://greasyfork.org/users/1560112
// @version      1.0.1
// @description  Play the books you bought in the apps you like. Saves your BookFunnel audiobooks as one chaptered .m4b or .mp3 and your ebooks as EPUB or PDF, with bulk download and a library view showing which books have no Download button. No re-encoding. Open source on GitHub.
// @author       MankeyDoodle
// @homepageURL  https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader
// @supportURL   https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/issues
// @license      MIT
// @match        https://play.bookfunnel.com/*
// @match        https://read.bookfunnel.com/*
// @match        https://my.bookfunnel.com/*
// @match        https://pr.bookfunnel.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      play.bookfunnel.com
// @connect      read.bookfunnel.com
// @connect      my.bookfunnel.com
// @connect      pr.bookfunnel.com
// @connect      prfiles.bookfunnel.com
// @connect      bookfunnel.com
// @connect      digitaloceanspaces.com
// @connect      *.digitaloceanspaces.com
// @connect      bookfunnelimages.com
// ==/UserScript==

/*
 * HOW IT WORKS
 *
 * BookFunnel is a thin front end over ordinary files.
 *
 * Audiobooks: the player page embeds a MANIFEST array of chapters, and
 *     /<book-id>/next?chapter=N
 * hands back a presigned URL to that chapter's MP3. The MP3s are not encrypted,
 * segmented or watermarked; the signature in the URL is the only authorisation.
 *
 * Ebooks and PDFs: the delivery page offers the finished file directly, at
 * prfiles.bookfunnel.com/<link>/<Title> - <Author>.epub (and .kepub.epub,
 * /kindle/…, .pdf). The delivery pages are
 *     https://my.bookfunnel.com/<book-id>/download     (in your library)
 *     https://pr.bookfunnel.com/<code>[/download]      (any delivery link)
 * and the cloud reader at read.bookfunnel.com/<book-id> carries the same
 * book, so from there the script asks my.bookfunnel.com for the files.
 *
 * Audiobooks that BookFunnel only offers as an archive point at
 *     https://pr.bookfunnel.com/<code>/download_media
 * which redirects to the finished .zip of every MP3, and that is followed too.
 *
 * So this script does what your browser already does when you press play or
 * download, and writes the bytes to disk instead of to a speaker or a temp file.
 *
 * Signed URLs expire. Because a chapter URL is requested immediately before
 * each download, and re-requested on a 403, long downloads keep working.
 *
 * Audiobook exports. Every chapter arrives as a plain MP3 stream, so nothing has
 * to be re-encoded:
 *
 *   .mp3    the chapter frames are concatenated and an ID3v2.3 tag is written in
 *           front of them with the book's title, author and cover plus a CHAP
 *           frame and a CTOC table for every chapter, so players that understand
 *           chapter marks (Plex, Audiobookshelf, foobar2000, Poweramp, VLC) show
 *           a labelled chapter list.
 *
 *   .m4b    the same frames are muxed, untouched, into an MP4 container with a
 *           Nero 'chpl' chapter atom and an iTunes metadata atom, which is the
 *           shape Apple Books, Plex and Audiobookshelf expect from a .m4b.
 *
 *   chapters  each chapter is handed to the browser's own download manager as a
 *           separate "01 - Chapter title.mp3".
 *
 * Everything lands in the browser's Downloads folder, like any other download.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * constants
   * ------------------------------------------------------------------ */

  var MIN_BYTES = 1024;                       // anything smaller is an error page, not a file
  var DOWNLOAD_TIMEOUT = 30 * 60 * 1000;     // a download the manager never reports on
  var CONCURRENCY = 3;
  var MAX_ATTEMPTS = 3;

  var PAGE_HOST = location.hostname;
  var PAGE_PATH = location.pathname;

  /* ------------------------------------------------------------------ *
   * helpers
   * ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // BookFunnel sometimes lists a title that loses its closing bracket, such as
  // "Talons and Treason (After Dark". A folder or file named that way looks like
  // a bug, so whatever is still open at the end is closed. A bracket with no text
  // after it (a trailing ":(") is left alone.
  function balanceBrackets(s) {
    s = String(s == null ? '' : s);
    var close = { '(': ')', '[': ']', '{': '}' };
    var open = { ')': '(', ']': '[', '}': '{' };
    var stack = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (close[c]) stack.push({ c: c, at: i });
      else if (open[c] && stack.length && stack[stack.length - 1].c === open[c]) stack.pop();
    }
    var tail = '';
    while (stack.length) {
      var top = stack.pop();
      if (/[A-Za-z0-9\u00C0-\uFFFF]/.test(s.slice(top.at + 1))) tail += close[top.c];
    }
    return s + tail;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function unique(list) {
    var seen = {};
    return list.filter(function (x) {
      if (seen[x]) return false;
      seen[x] = true;
      return true;
    });
  }

  // Cut to n UTF-16 units without leaving half of an emoji behind.
  function cut(s, n) {
    if (s.length <= n) return s;
    var c = s.charCodeAt(n - 1);
    return s.slice(0, c >= 0xD800 && c <= 0xDBFF ? n - 1 : n);
  }

  // Filename-safe: strip characters Windows and macOS reject. Trailing dots and
  // spaces are removed after the cut, so a shortened name never ends in one.
  function safeName(s) {
    return cut(clean(s)
      .replace(/[\/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .replace(/\.+$/, ''), 120).replace(/[\s.]+$/, '') || 'Untitled';
  }

  // "Tom &amp; Jerry&#39;s" -> "Tom & Jerry's". Markup read as text (a regex
  // over raw HTML) keeps its entities; the DOM decodes them for us.
  function decodeEntities(s) {
    s = String(s == null ? '' : s);
    if (s.indexOf('&') < 0) return s;
    try {
      var doc = new DOMParser().parseFromString(
        '<!doctype html><body><textarea>' + s.replace(/</g, '&lt;') + '</textarea>', 'text/html');
      var ta = doc.querySelector('textarea');
      return ta ? ta.value : s;
    } catch (e) {
      return s;
    }
  }

  // The array after "MANIFEST =", found by matching brackets (skipping over
  // strings) rather than stopping at the first "];" that a title might hold.
  function extractManifest(html) {
    var m = /MANIFEST\s*=\s*\[/.exec(html);
    if (!m) return null;
    var start = m.index + m[0].length - 1, depth = 0, quote = '';
    for (var j = start; j < html.length; j++) {
      var ch = html.charAt(j);
      if (quote) {
        if (ch === '\\') j++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) return html.slice(start, j + 1);
    }
    return null;
  }

  function humanDuration(sec) {
    sec = Math.round(sec || 0);
    var h = Math.floor(sec / 3600);
    var m = Math.round((sec % 3600) / 60);
    if (h) return h + ' h ' + m + ' min';
    if (m) return m + ' min';
    return sec + ' s';
  }

  function humanBytes(n) {
    if (!n) return '0 MB';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /* ------------------------------------------------------------------ *
   * network
   * ------------------------------------------------------------------ */

  function gmRequest(details) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('This script needs cross-origin network access. Allow it in your userscript manager and reload.'));
        return;
      }
      GM_xmlhttpRequest(Object.assign({
        method: 'GET',
        timeout: 900000,
        onload: resolve,
        onerror: function () { reject(new Error('Network error')); },
        ontimeout: function () { reject(new Error('Request timed out')); }
      }, details));
    });
  }

  function httpError(status) {
    var err = new Error('HTTP ' + status);
    err.status = status;
    return err;
  }

  function fetchText(url) {
    return gmRequest({ url: url, timeout: 45000 }).then(function (res) {
      if (res.status < 200 || res.status >= 300) throw httpError(res.status);
      return res.responseText;
    });
  }

  function fetchBytes(url) {
    return gmRequest({ url: url, responseType: 'arraybuffer' }).then(function (res) {
      if (res.status < 200 || res.status >= 300) throw httpError(res.status);
      var buf = res.response;
      if (!buf) throw new Error('Empty response');
      // GM_xmlhttpRequest hands back an ArrayBuffer. Everything downstream
      // treats the bytes as a typed array — `.length`, subarray(), set() — and
      // an ArrayBuffer's `.length` is undefined, which silently dropped the
      // cover from the combined file's tag. Convert once, here.
      return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    });
  }

  // Same-origin pages are fetched plainly, so the browser handles the session
  // cookie exactly as it would for you.
  function fetchPage(url) {
    return fetch(url, { credentials: 'same-origin', redirect: 'follow' }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        throw new Error('Not signed in, or this book is not in your account.');
      }
      if (!res.ok) throw httpError(res.status);
      return res.text();
    });
  }

  function resolveUrl(id, chapter) {
    var url = location.origin + '/' + id + '/next?chapter=' + chapter;
    return fetchText(url).then(function (txt) {
      var json;
      try { json = JSON.parse(txt); } catch (e) { throw new Error('Unreadable answer from /next'); }
      if (!json || json.status !== 'OK' || !json.url) {
        throw new Error('No URL for chapter ' + chapter);
      }
      return json.url;
    });
  }

  /* ------------------------------------------------------------------ *
   * what page are we on?
   * ------------------------------------------------------------------ */

  var RESERVED = /^(login|logout|forgot|signup|register|api|help|about|privacy|terms|download_media|static|images?)$/i;

  function detectPage() {
    var m;
    if (PAGE_HOST === 'play.bookfunnel.com') {
      m = PAGE_PATH.match(/^\/([a-z0-9]{6,})(?:\/|$)/i);
      return m && !RESERVED.test(m[1]) ? { kind: 'audio', bookId: m[1] } : null;
    }
    if (PAGE_HOST === 'read.bookfunnel.com') {
      // the reader, and the PDF reader, and any chapter path under either
      m = PAGE_PATH.match(/^\/(?:pdf\/)?([a-z0-9]{6,})(?:\/|$)/i);
      if (!m || RESERVED.test(m[1])) return null;
      return { kind: 'files', bookId: m[1], via: 'reader' };
    }
    if (PAGE_HOST === 'my.bookfunnel.com') {
      // only the per-book delivery page; the library itself is left alone
      m = PAGE_PATH.match(/^\/([a-z0-9]{6,})\/download\/?$/i);
      return m ? { kind: 'files', bookId: m[1], via: 'delivery' } : null;
    }
    if (PAGE_HOST === 'pr.bookfunnel.com') {
      // delivery links look like /<code> and /<code>/download
      m = PAGE_PATH.match(/^\/([a-z0-9]{5,})\/?$/i) ||
          PAGE_PATH.match(/^\/([a-z0-9]{5,})\/download\/?$/i);
      if (!m || RESERVED.test(m[1])) return null;
      return { kind: 'files', link: m[1], via: 'page' };
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * audiobook
   * ------------------------------------------------------------------ */

  function parseAudioPage(html, id) {
    var raw = extractManifest(html);
    if (!raw) {
      throw new Error('No chapter list on this page. Is this an audiobook you have access to?');
    }
    var manifest;
    try {
      manifest = JSON.parse(raw);
    } catch (e) {
      throw new Error('The chapter list on this page could not be read.');
    }
    if (!Array.isArray(manifest) || !manifest.length) throw new Error('This book has no chapters listed.');

    var pageTitle = clean(decodeEntities((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || id));
    var by = pageTitle.lastIndexOf(' by ');
    var title = balanceBrackets(by > 0 ? pageTitle.slice(0, by).trim() : pageTitle);
    var author = by > 0 ? pageTitle.slice(by + 4).trim() : '';

    // Covers live at bookfunnelimages.com/images/covers/<id>/cover_lg.jpg.
    // Not every book has the _lg size — the delivery pages advertise _md — so
    // fall back to whatever size the page offers, then to its og:image.
    var coverHit = (html.match(/bookfunnelimages\.com\/images\/covers\/[^"'\s)\\]+\/cover_lg\.jpe?g/) || [])[0] ||
      (html.match(/bookfunnelimages\.com\/images\/covers\/[^"'\s)\\]+\/cover_[a-z]+\.jpe?g/) || [])[0] ||
      (html.match(/content=["'](?:https?:)?\/\/([^"']*bookfunnelimages\.com\/images\/covers\/[^"']+)["']/i) || [])[1] ||
      '';
    if (coverHit && !/^https?:\/\//i.test(coverHit)) coverHit = 'https://' + coverHit.replace(/^\/\//, '');
    var width = Math.max(2, String(manifest.length).length);

    return {
      kind: 'audio',
      id: id,
      pageTitle: pageTitle,          // "Title (Series) by Author" — for the .tsv
      title: title,                  // "Title (Series)"         — for the folder
      author: author,
      cover: coverHit,
      items: manifest.map(function (e, i) {
        var chapterTitle = balanceBrackets(clean(e && e.title)) || 'Chapter ' + (i + 1);
        var duration = Number(e && e.duration) || 0;
        return {
          label: chapterTitle,
          sub: duration ? humanDuration(duration) : '',
          fileName: pad(i + 1, width) + ' - ' + safeName(chapterTitle) + '.mp3',
          chapter: i + 1,
          duration: duration
        };
      })
    };
  }

  /* ------------------------------------------------------------------ *
   * ebooks, PDFs and anything else the delivery page offers
   * ------------------------------------------------------------------ */

  var FORMATS = [
    [/\.kepub\.epub$/i, 'EPUB (Kobo)'],
    [/\/kindle\/[^\/]+\.epub$/i, 'EPUB (Kindle)'],
    [/\.epub$/i, 'EPUB'],
    [/\.mobi$/i, 'MOBI'],
    [/\.azw3?$/i, 'AZW3'],
    [/\.pdf$/i, 'PDF'],
    [/\.zip$/i, 'ZIP'],
    [/\.mp3$/i, 'MP3'],
    [/\.m4b$/i, 'M4B'],
    [/\.jpe?g$/i, 'JPEG'],
    [/\.png$/i, 'PNG']
  ];

  function formatLabel(url) {
    var file = String(url || '').split('#')[0].split('?')[0];
    for (var i = 0; i < FORMATS.length; i++) {
      if (FORMATS[i][0].test(file)) return FORMATS[i][1];
    }
    // bare /download_media links answer with the finished archive
    if (/\/download_media$/i.test(file)) return 'ZIP';
    var ext = file.match(/\.([a-z0-9]{1,5})$/i);
    return ext ? ext[1].toUpperCase() : 'FILE';
  }

  // Test pages, pages fetched by the script and pages the browser patched
  // itself can all differ, so parse the markup rather than trust one shape.
  function parseHtml(html) {
    try {
      return new DOMParser().parseFromString(String(html), 'text/html');
    } catch (e) {
      return null;
    }
  }

  function metaContent(doc, selector) {
    var node = doc && doc.querySelector(selector);
    return node ? clean(node.getAttribute('content')) : '';
  }

  function docTitle(doc, html) {
    var t = (doc && doc.querySelector('title') && doc.querySelector('title').textContent) ||
      (String(html).match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
    return clean(t).replace(/^Download\s+/i, '');
  }

  // "//host/x", "https://host/x" and the desktop app's "bookfunnel://host/x"
  // all name the same file, so they are folded onto one form before use.
  function normalizeUrl(raw) {
    // only the ends are trimmed: spaces inside a title are part of the name
    var s = String(raw == null ? '' : raw).replace(/^[\s ]+|[\s ]+$/g, '');
    if (!s) return '';
    s = s.replace(/^bookfunnel:\/\//i, '//');
    if (/^\/\//.test(s)) s = 'https:' + s;
    else if (/^\/[a-z0-9]+\/download_media(\?|$)/i.test(s)) s = 'https://pr.bookfunnel.com' + s;
    if (!/^https?:\/\//i.test(s)) return '';
    s = s.replace(/&amp;/g, '&');
    if (/^https?:\/\/prfiles\.bookfunnel\.com\//i.test(s)) {
      // File names sit in the path, unencoded, so a "#" or "?" in a title is
      // part of the name, not a fragment or a query.
      s = s.replace(/#/g, '%23').replace(/\?/g, '%3F');
    } else {
      s = s.split('#')[0];
    }
    // a bare "%" in a title ("100% Wolf") is not an escape
    s = s.replace(/%(?![0-9a-f]{2})/gi, '%25');
    // BookFunnel's own links really do contain spaces:
    //   //prfiles.bookfunnel.com/abc123/Title - Author.epub
    // A browser copes with that, but GM_download and some userscript managers
    // reject a raw space and report "download failed" or "not_supported".
    // Encode every space-like character once, so each stays distinct and
    // later consumers get an ordinary URL.
    return s.replace(/[\s ]/g, function (ch) { return encodeURIComponent(ch); });
  }

  function linkKey(url) {
    var s = url;
    try {
      s = decodeURIComponent(s);
    } catch (e) {
      try { s = decodeURI(s); } catch (e2) { /* leave it as it came */ }
    }
    return s.toLowerCase();
  }

  // Keep the delivered files and the archives the delivery page hands out.
  // A URL has to reach past its host to count, so a truncated match from a
  // half-parsed script string never becomes a phantom row.
  function isFileLink(url) {
    var u = String(url).toLowerCase();
    if (/^https?:\/\/prfiles\.bookfunnel\.com\/[a-z0-9]+\/.+/.test(u)) return true;
    if (/^https?:\/\/pr\.bookfunnel\.com\/[a-z0-9]+\/download_media(\?|$)/.test(u)) return true;
    if (/^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.digitaloceanspaces\.com\/.+\/.+/.test(u)) return true;
    return false;
  }

  // Signed storage URLs carry the name BookFunnel wants them saved under.
  function nameFromQuery(url) {
    function decoded(v) {
      for (var i = 0; i < 2; i++) {
        try { v = decodeURIComponent(v); } catch (e) { break; }
      }
      return v;
    }
    var m = String(url).match(/[?&]response-content-disposition=([^&]+)/i);
    if (m) {
      var name = decoded(m[1]).match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      return name ? clean(name[1]) : '';
    }
    var plain = String(url).match(/[?&]filename=([^&]+)/i);
    return plain ? clean(decoded(plain[1])) : '';
  }

  // A match from the raw-text scan runs on past the link: into the next
  // attribute, a closing "}]", a sentence. Decode its entities, cut it at a
  // quote, and where it names a known file type, end it there.
  function tidyScanned(candidate) {
    var c = decodeEntities(candidate).replace(/["<>\x60\\].*$/, '');
    var m = c.match(/^(.*?\.(?:kepub\.epub|epub|pdf|mobi|azw3?|zip|mp3|m4b|m4a|jpe?g|png))(\?[^\s)}\]]*)?(?=[\s)}\]]|$)/i);
    return m ? m[1] + (m[2] || '') : c;
  }

  // Links live in anchors, in data attributes and sometimes only inside
  // scripts, and real ones contain spaces:
  //   href='//prfiles.bookfunnel.com/abc123/Title - Author.epub'
  // so the scan stops at a quote or a bracket, not at a space.
  function collectLinks(html) {
    var raw = [];
    var doc = parseHtml(html);
    if (doc) {
      Array.prototype.forEach.call(
        doc.querySelectorAll('a[href], link[href], source[src], audio[src], video[src]'),
        function (node) {
          raw.push(node.getAttribute('href') || node.getAttribute('src') || '');
        }
      );
    }
    // JSON inside scripts escapes its slashes ("https:\/\/host\/x")
    var scanned = String(html).replace(/\\\//g, '/').match(
      /(?:https?:|bookfunnel:)?\/\/(?:[a-z0-9-]+\.)*(?:bookfunnel|digitaloceanspaces)\.com\/[^'"<>\x60\\\r\n\t]+/gi
    ) || [];
    scanned = scanned.map(tidyScanned);

    var seen = {};
    var out = [];
    raw.concat(scanned).forEach(function (candidate) {
      var url = normalizeUrl(candidate);
      if (!url || !isFileLink(url)) return;
      var key = linkKey(url);
      if (seen[key]) return;
      seen[key] = true;
      out.push(url);
    });
    return out;
  }

  // Keep the extension when a name has to be shortened.
  function limitName(name, limit) {
    if (name.length <= limit) return name;
    var ext = name.match(/(\.[^.\/]+)$/);
    if (!ext) return cut(name, limit);
    return cut(name.slice(0, -ext[1].length), Math.max(1, limit - ext[1].length)) + ext[1];
  }

  function fileNameFor(url, fallback, taken) {
    var path = String(url).split('#')[0].split('?')[0];
    var parts = path.split('/');
    var last = parts.pop() || '';
    var parent = (parts.pop() || '').toLowerCase();
    var name = nameFromQuery(url);

    if (!name) {
      try {
        name = decodeURIComponent(last);
      } catch (e) {
        name = last;
      }
    }

    // Shorten the title, never the suffix: safeName() alone would cut the
    // extension off a long title and leave a file the OS cannot open.
    function build(base, suffix) {
      return cut(safeName(base), Math.max(1, 120 - suffix.length)).replace(/[\s.]+$/, '') + suffix;
    }

    if (!name || /^download_media$/i.test(name) || /^book\.[a-z0-9]+$/i.test(name)) {
      // an archive named by the server, so name it after the book instead
      var guessed = String(url).split('#')[0].split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
      name = build(fallback || 'book', '.' + (guessed ? guessed[1].toLowerCase() : 'zip'));
    } else if (/^sample\.[a-z0-9]{2,5}$/i.test(name)) {
      // every audiobook's preview clip is called sample.mp3, and everything
      // lands in one flat Downloads folder, so name it after the book
      name = build(fallback || 'book', ' (sample)' + name.slice(name.lastIndexOf('.')).toLowerCase());
    } else if (/\.kepub\.epub$/i.test(name)) {
      name = build(name.replace(/\.kepub\.epub$/i, ''), ' (Kobo).epub');
    } else if (parent === 'kindle' && /\.epub$/i.test(name)) {
      name = build(name.replace(/\.epub$/i, ''), ' (Kindle).epub');
    } else {
      var ext = name.match(/(\.[a-z0-9]{1,5})$/i);
      name = ext ? build(name.slice(0, -ext[1].length), ext[1]) : safeName(name);
    }

    name = limitName(name, 120);

    // Never collide inside a folder. macOS and Windows ignore case, so the
    // check does too; a name with no extension gets its counter at the end
    // (replace() on a missing extension changed nothing and looped forever).
    var base = name, n = 2;
    var tail = base.match(/(\.[a-z0-9]{1,5})$/i);
    while (taken[name.toLowerCase()]) {
      name = tail
        ? base.slice(0, -tail[1].length) + ' (' + n + ')' + tail[1]
        : base + ' (' + n + ')';
      n++;
    }
    taken[name.toLowerCase()] = true;
    return name;
  }

  function parseDeliveryPage(html, context) {
    context = context || {};
    var doc = parseHtml(html);

    var title = docTitle(doc, html);
    var by = title.lastIndexOf(' by ');
    var author = '';
    if (by > 0) {
      author = title.slice(by + 4).trim();
      title = title.slice(0, by).trim();
    }
    author = metaContent(doc, 'meta[name="author" i]') || author || clean(context.author);
    title = balanceBrackets(title || clean(context.title) || 'Book');

    var cover = metaContent(doc, 'meta[property="og:image" i]') ||
      metaContent(doc, 'meta[name="twitter:image" i]');
    if (/^\/\//.test(cover)) cover = 'https:' + cover;       // GM requests need a scheme

    var urls = collectLinks(html);
    if (!urls.length) {
      if (/\/login\?save=|\bMy BookFunnel\b|sign in/i.test(html)) {
        throw new Error('BookFunnel sent us to the sign-in page. Open my.bookfunnel.com, sign in, and reload this page.');
      }
      throw new Error('This page offers no download links. Is the book in your account?');
    }

    var taken = {};
    var archiveName = [title, author].filter(Boolean).join(' - ');

    var items = urls.map(function (url) {
      var fileName = fileNameFor(url, archiveName, taken);
      return {
        label: fileName,
        sub: formatLabel(url),
        fileName: fileName,
        url: url
      };
    });

    return {
      kind: 'files',
      title: title,
      author: author,
      cover: cover,
      items: items
    };
  }

  /* ------------------------------------------------------------------ *
   * disk
   * ------------------------------------------------------------------ */

  function saveToDownloads(name, data) {
    // data arrives as bytes from a chapter or as a finished Blob from the
    // one-file packer; both end up as a download in the Downloads folder.
    var blob = data instanceof Blob ? data : new Blob([data]);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    return blob.size;
  }

  /* ------------------------------------------------------------------ *
   * packaging: one audiobook file, with the chapters marked
   *
   * The block between the pack markers is pure: no DOM, no network, no
   * userscript API. test/pack-check.js pulls it out of this file on its own and
   * checks the bytes it writes with ffprobe, so a mistake here fails loudly.
   * ------------------------------------------------------------------ */

  /* ==pack:start== */

  function packBytes(v) {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return new Uint8Array(v.buffer);
  }

  function u16(n) {
    return new Uint8Array([(n >>> 8) & 255, n & 255]);
  }

  function u32(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  function u64(n) {                       // safe for anything under 2^53
    var hi = Math.floor(n / 4294967296);
    var lo = n - hi * 4294967296;
    return new Uint8Array([(hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255]);
  }

  function joinBytes(list) {
    var total = 0, i, at = 0;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total);
    for (i = 0; i < list.length; i++) {
      out.set(list[i], at);
      at += list[i].length;
    }
    return out;
  }

  function utf8(s) {
    s = String(s == null ? '' : s);
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var d = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function ascii(s) {
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }

  // ID3v2.3 text frames are either Latin-1 (0) or UTF-16 with a BOM (1).
  function utf16(s) {
    s = String(s == null ? '' : s);
    var out = new Uint8Array(2 + s.length * 2);
    out[0] = 0xff;
    out[1] = 0xfe;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out[2 + i * 2] = c & 255;
      out[3 + i * 2] = (c >> 8) & 255;
    }
    return out;
  }

  /* --- MP3 ---------------------------------------------------------- */

  function id3v2Length(b) {
    if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
    var size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return 10 + size + ((b[5] & 0x10) ? 10 : 0);          // footer counts too
  }

  // Size in bytes of the Layer III frame whose header starts at `at`, or 0 when
  // the bytes there are not a real header (a stray 0xFF, a reserved version,
  // free-format or invalid bitrate, reserved sample rate).
  function mp3FrameSize(b, at) {
    if (at < 0 || at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return 0;
    var b1 = b[at + 1], b2 = b[at + 2];
    var version = (b1 >> 3) & 3;                 // 0 = 2.5, 1 = reserved, 2 = 2, 3 = 1
    var layer = (b1 >> 1) & 3;                   // 1 = layer III
    var brIdx = (b2 >> 4) & 15;
    var rateIdx = (b2 >> 2) & 3;
    if (version === 1 || layer !== 1 || !brIdx || brIdx === 15 || rateIdx === 3) return 0;
    var isV1 = version === 3;
    var kbit = (isV1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[brIdx];
    var sr = (isV1 ? MP3_RATES_V1 : version === 2 ? MP3_RATES_V2 : MP3_RATES_V25)[rateIdx];
    if (!kbit || !sr) return 0;
    return Math.floor((isV1 ? 144000 : 72000) * kbit / sr) + ((b2 >> 1) & 1);
  }

  // The first frame of an encoder's file is often a silent Xing/Info/VBRI
  // header, not audio. Left in, every chapter adds ~26 ms of silence and the
  // combined file carries a header that describes chapter 1 alone.
  function mp3IsInfoFrame(b, at, size) {
    var b1 = b[at + 1];
    var isV1 = ((b1 >> 3) & 3) === 3;
    var mono = ((b[at + 3] >> 6) & 3) === 3;
    var crc = (b1 & 1) === 0 ? 2 : 0;
    var side = isV1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    function tagAt(o) {
      return o + 4 <= at + size ? String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) : '';
    }
    var tag = tagAt(at + 4 + crc + side);
    return tag === 'Xing' || tag === 'Info' || tagAt(at + 36) === 'VBRI';
  }

  // The audio frames of one chapter, with BookFunnel's tags stripped off and
  // only real, whole frames kept: stray padding, junk, a trailing APE tag and a
  // cut-off last frame are all dropped, so the m4b's sample table lines up with
  // the bytes it points at.
  function mp3Audio(b) {
    b = packBytes(b);
    var at = id3v2Length(b);
    var end = b.length;
    if (end - at > 128 && b[end - 128] === 0x54 && b[end - 127] === 0x41 && b[end - 126] === 0x47) {
      end -= 128;                                          // trailing ID3v1
    }
    var runs = [], runStart = -1, first = true;
    while (at + 4 <= end) {
      var size = mp3FrameSize(b, at);
      // Finding the start of a run (or resyncing after junk) needs the next
      // header to agree; inside a run a header that fits is enough, so the
      // zero padding some encoders leave after the last frame costs nothing.
      var ok = size > 0 && at + size <= end &&
        (runStart >= 0 || at + size === end || mp3FrameSize(b, at + size) > 0);
      if (!ok) {
        if (runStart >= 0) { runs.push([runStart, at]); runStart = -1; }
        at++;
        continue;
      }
      if (first && mp3IsInfoFrame(b, at, size)) {
        first = false;
        at += size;
        continue;
      }
      first = false;
      if (runStart < 0) runStart = at;
      at += size;
    }
    if (runStart >= 0) runs.push([runStart, at]);
    if (!runs.length) return b.subarray(0, 0);
    if (runs.length === 1) return b.subarray(runs[0][0], runs[0][1]);
    return joinBytes(runs.map(function (r) { return b.subarray(r[0], r[1]); }));
  }

  var MP3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  var MP3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  var MP3_RATES_V1 = [44100, 48000, 32000];
  var MP3_RATES_V2 = [22050, 24000, 16000];
  var MP3_RATES_V25 = [11025, 12000, 8000];

  // Walk the frames: every one is a sample in the MP4 muxer.
  function mp3Walk(audio) {
    var sizes = [], at = 0, rate = 0, perFrame = 1152, kbps = 128, channels = 2, mixed = false;
    while (at + 4 <= audio.length) {
      if (audio[at] !== 0xff || (audio[at + 1] & 0xe0) !== 0xe0) { at++; continue; }
      var b1 = audio[at + 1], b2 = audio[at + 2], b3 = audio[at + 3];
      var version = (b1 >> 3) & 3;               // 0 = 2.5, 2 = 2, 3 = 1
      var layer = (b1 >> 1) & 3;                 // 1 = layer III
      var rateIdx = (b2 >> 2) & 3;
      var padding = (b2 >> 1) & 1;
      var brIdx = (b2 >> 4) & 15;                // bitrate lives in byte 3 of the header
      if (version === 1 || layer !== 1 || rateIdx === 3 || !brIdx) { at++; continue; }
      var isV1 = version === 3;
      var table = isV1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2;
      var rates = version === 3 ? MP3_RATES_V1 : version === 2 ? MP3_RATES_V2 : MP3_RATES_V25;
      var kbit = table[brIdx];
      var sr = rates[rateIdx];
      if (!kbit || !sr) { at++; continue; }
      var size = Math.floor((isV1 ? 144000 : 72000) * kbit / sr) + padding;
      if (size < 4 || at + size > audio.length) break;
      var ch = ((b3 >> 6) & 3) === 3 ? 1 : 2;
      if (!sizes.length) {
        rate = sr;
        perFrame = isV1 ? 1152 : 576;
        kbps = kbit;
        channels = ch;
      } else if (sr !== rate || (isV1 ? 1152 : 576) !== perFrame || ch !== channels) {
        mixed = true;
      }
      sizes.push(size);
      at += size;
    }
    return { sizes: sizes, sampleRate: rate || 44100, samplesPerFrame: perFrame, kbps: kbps, channels: channels, mixed: mixed };
  }

  // A silent MPEG frame carrying a Xing header with the real frame and byte
  // counts of the combined file. Players and ffprobe skip it as a header and
  // use the counts for the length, so VBR and mixed-bitrate books seek right.
  function mp3InfoFrame(firstAudio, frames, audioBytes) {
    if (!firstAudio || firstAudio.length < 4 || !frames) return null;
    var h = new Uint8Array(firstAudio.subarray(0, 4));
    h[1] |= 1;                                   // no CRC
    h[2] &= ~2;                                  // no padding
    var size = mp3FrameSize(h, 0);
    var isV1 = ((h[1] >> 3) & 3) === 3;
    var mono = ((h[3] >> 6) & 3) === 3;
    var at = 4 + (isV1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
    if (!size || size < at + 16) return null;    // too small a frame to hold the header
    var f = new Uint8Array(size);
    f.set(h, 0);
    f.set(ascii('Xing'), at);
    f.set(u32(3), at + 4);                       // flags: frame count + byte count
    f.set(u32(frames), at + 8);
    f.set(u32(audioBytes + size), at + 12);
    return f;
  }

  // The finished .mp3: ID3 tag (title, cover, chapter marks), the length header,
  // then the chapters' frames untouched. `chapters` are already tag-stripped.
  function muxMp3(chapters, meta) {
    var frames = 0, bytes = 0;
    chapters.forEach(function (audio) {
      frames += mp3Walk(audio).sizes.length;
      bytes += audio.length;
    });
    var info = chapters.length ? mp3InfoFrame(chapters[0], frames, bytes) : null;
    return [buildId3Tag(meta)].concat(info ? [info] : [], chapters);
  }

  function id3Frame(id, body) {
    return joinBytes([ascii(id), u32(body.length), new Uint8Array([0, 0]), body]);
  }

  function id3TextFrame(id, text) {
    return id3Frame(id, joinBytes([new Uint8Array([1]), utf16(text)]));
  }

  // PNG announces itself; BookFunnel covers are JPEG
  function coverIsPng(b) {
    return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  }

  function id3PictureFrame(mime, data) {
    return id3Frame('APIC', joinBytes([
      new Uint8Array([0]),
      ascii(mime), new Uint8Array([0]),
      new Uint8Array([3]),                    // front cover
      new Uint8Array([0]),                    // no description
      packBytes(data)
    ]));
  }

  function id3ChapterFrames(chapters) {
    var frames = [], ids = [];
    chapters.forEach(function (c, i) {
      var id = 'ch' + i;
      ids.push(id);
      frames.push(id3Frame('CHAP', joinBytes([
        ascii(id), new Uint8Array([0]),
        u32(Math.max(0, Math.round(c.startMs))),
        u32(Math.max(0, Math.round(c.endMs))),
        u32(0xffffffff), u32(0xffffffff),     // byte offsets: unused for MPEG audio
        id3TextFrame('TIT2', c.title)
      ])));
    });
    frames.push(id3Frame('CTOC', joinBytes([
      ascii('toc'), new Uint8Array([0]),
      new Uint8Array([0x03]),                 // top level, ordered
      new Uint8Array([Math.min(255, ids.length)]),         // one byte: the first 255 are listed
      joinBytes(ids.slice(0, 255).map(function (id) { return joinBytes([ascii(id), new Uint8Array([0])]); })),
      id3TextFrame('TIT2', 'Chapters')
    ])));
    return frames;
  }

  function buildId3Tag(meta) {
    var frames = [];
    if (meta.title) frames.push(id3TextFrame('TIT2', meta.title));
    if (meta.artist) frames.push(id3TextFrame('TPE1', meta.artist));
    if (meta.album) frames.push(id3TextFrame('TALB', meta.album));
    if (meta.track) frames.push(id3TextFrame('TRCK', meta.track));
    if (meta.comment) frames.push(id3TextFrame('TIT3', meta.comment));
    // packBytes first: the cover can arrive as a Uint8Array or an ArrayBuffer
    // (GM_xmlhttpRequest hands back the latter). An ArrayBuffer has no .length,
    // so testing meta.cover.length directly silently dropped the artwork.
    var cover = meta.cover ? packBytes(meta.cover) : null;
    if (cover && cover.length) frames.push(id3PictureFrame(coverIsPng(cover) ? 'image/png' : 'image/jpeg', cover));
    if (meta.chapters && meta.chapters.length) frames = frames.concat(id3ChapterFrames(meta.chapters));

    var body = joinBytes(frames);
    var size = body.length;
    var head = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0,
      (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
    return joinBytes([head, body]);
  }

  /* --- MP4 / M4B ---------------------------------------------------- */

  function box(type, parts) {
    var body = joinBytes(parts || []);
    return joinBytes([u32(body.length + 8), ascii(type), body]);
  }

  function fullBox(type, version, flags, parts) {
    var head = new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]);
    return box(type, [head].concat(parts || []));
  }

  function identityMatrix() {
    var m = new Uint8Array(36);
    m[3] = 1; m[19] = 1; m[32] = 0x40;        // 1.0, 1.0, 1073741824 in 16.16
    return m;
  }

  function esdsBox(kbps) {
    var rate = Math.max(8000, Math.round(kbps * 1000));
    var dsi = new Uint8Array([0x05, 0]);      // empty DecoderSpecificInfo
    var config = joinBytes([
      new Uint8Array([0x04, 13 + dsi.length, 0x6b, 0x15, 0, 0, 0]),
      u32(rate), u32(rate), dsi
    ]);
    var sl = new Uint8Array([0x06, 1, 0x02]);
    return fullBox('esds', 0, 0, [joinBytes([
      new Uint8Array([0x03, 3 + config.length + sl.length, 0, 1, 0]),
      config, sl
    ])]);
  }

  function audioSampleEntry(sampleRate, kbps, channels) {
    return box('mp4a', [
      new Uint8Array(6), u16(1),
      u16(0), u16(0), u32(0),
      u16(channels || 2), u16(16), u16(0), u16(0),
      u16(sampleRate), u16(0),
      esdsBox(kbps)
    ]);
  }

  function stringAtom(name, value) {
    return box(name, [box('data', [u32(1), u32(0), utf8(value)])]);
  }

  function metaBox(meta) {
    var items = [];
    if (meta.title) items.push(stringAtom('\u00a9nam', meta.title));
    if (meta.artist) items.push(stringAtom('\u00a9ART', meta.artist));
    if (meta.album) items.push(stringAtom('\u00a9alb', meta.album));
    if (meta.comment) items.push(stringAtom('\u00a9cmt', meta.comment));
    var cover = meta.cover ? packBytes(meta.cover) : null;
    if (cover && cover.length) items.push(box('covr', [box('data', [u32(coverIsPng(cover) ? 14 : 13), u32(0), cover])]));
    // 'meta' is a full box: version/flags first, then hdlr and ilst. Without
    // that header a reader walks into the hdlr size field and gives up.
    return fullBox('meta', 0, 0, [
      fullBox('hdlr', 0, 0, [u32(0), ascii('mdir'), ascii('appl'), new Uint8Array(8), new Uint8Array([0])]),
      box('ilst', items)
    ]);
  }

  // Nero chapter list, the atom iTunes, Apple Books and Plex read.
  // Layout: version 1 (1 byte) + flags (3 bytes) + reserved (4) + count (1),
  // then per chapter an 8-byte 100 ns time, a 1-byte title length and the
  // title. ffmpeg writes the same shape, so players agree on the marks.
  // The count and each title length are one byte, so a book can carry at most
  // 255 marks and a title 255 bytes (cut on a character boundary).
  function chplBox(chapters) {
    chapters = chapters.slice(0, 255);
    var parts = [new Uint8Array([1, 0, 0, 0]), new Uint8Array(4), new Uint8Array([chapters.length])];
    chapters.forEach(function (c) {
      var title = utf8(c.title);
      if (title.length > 255) {
        var n = 255;
        while (n > 0 && (title[n] & 0xc0) === 0x80) n--;      // never end inside a character
        title = title.subarray(0, n);
      }
      parts.push(u64(Math.round(c.startMs * 10000)));       // 100 ns units
      parts.push(new Uint8Array([title.length]));
      parts.push(title);
    });
    return box('chpl', parts);
  }

  // Mux the MP3 frames, untouched, into an .m4b. Returns Blob parts.
  function muxM4b(audios, meta) {
    var sizes = [], bodies = [], sampleRate = 44100, perFrame = 1152, kbps = 128, channels = 2;
    audios.forEach(function (raw) {
      var audio = mp3Audio(raw);
      var walk = mp3Walk(audio);
      if (!walk.sizes.length) throw new Error('One chapter was not MP3 audio.');
      if (!sizes.length) {
        sampleRate = walk.sampleRate;
        perFrame = walk.samplesPerFrame;
        kbps = walk.kbps;
        channels = walk.channels;
      } else if (walk.sampleRate !== sampleRate || walk.samplesPerFrame !== perFrame || walk.channels !== channels) {
        throw new Error('The chapters differ in sample rate or channels, which one .m4b cannot hold. Use the MP3 or the separate chapters.');
      }
      if (walk.mixed) {
        throw new Error('A chapter changes sample rate or channels part-way, which one .m4b cannot hold. Use the MP3 or the separate chapters.');
      }
      sizes = sizes.concat(walk.sizes);
      bodies.push(audio);
    });

    var sampleCount = sizes.length;
    var totalSamples = sampleCount * perFrame;
    var durationMs = Math.round(totalSamples / sampleRate * 1000);

    var sizeTable = new Uint8Array(sampleCount * 4);
    for (var i = 0; i < sampleCount; i++) {
      var s = sizes[i];
      sizeTable[i * 4] = (s >>> 24) & 255;
      sizeTable[i * 4 + 1] = (s >>> 16) & 255;
      sizeTable[i * 4 + 2] = (s >>> 8) & 255;
      sizeTable[i * 4 + 3] = s & 255;
    }

    var ftyp = box('ftyp', [ascii('M4B '), u32(0), ascii('M4B '), ascii('mp42'), ascii('isom'), ascii('mp41')]);
    var mdatHead = u32(0);                                  // patched below

    function buildMoov(dataOffset) {
      var mvhd = fullBox('mvhd', 0, 0, [
        u32(0), u32(0), u32(1000), u32(durationMs),
        u32(0x00010000), u16(0x0100), new Uint8Array(2), new Uint8Array(8),
        identityMatrix(), new Uint8Array(24), u32(2)
      ]);
      var tkhd = fullBox('tkhd', 0, 3, [
        u32(0), u32(0), u32(1), u32(0), u32(durationMs),
        new Uint8Array(8), u16(0), u16(0), u16(0x0100), u16(0),
        identityMatrix(), u32(0), u32(0)
      ]);
      var mdhd = fullBox('mdhd', 0, 0, [u32(0), u32(0), u32(sampleRate), u32(totalSamples), u16(0x55c4), u16(0)]);
      var hdlr = fullBox('hdlr', 0, 0, [u32(0), ascii('soun'), new Uint8Array(12), ascii('SoundHandler\0')]);
      var smhd = fullBox('smhd', 0, 0, [u16(0), u16(0)]);
      var dref = fullBox('dref', 0, 0, [u32(1), fullBox('url ', 0, 1, [])]);
      var stsd = fullBox('stsd', 0, 0, [u32(1), audioSampleEntry(sampleRate, kbps, channels)]);
      var stts = fullBox('stts', 0, 0, [u32(1), u32(sampleCount), u32(perFrame)]);
      var stsc = fullBox('stsc', 0, 0, [u32(1), u32(1), u32(sampleCount), u32(1)]);
      var stsz = fullBox('stsz', 0, 0, [u32(0), u32(sampleCount), sizeTable]);
      var stco = fullBox('stco', 0, 0, [u32(1), u32(dataOffset)]);
      var stbl = box('stbl', [stsd, stts, stsc, stsz, stco]);
      var minf = box('minf', [smhd, box('dinf', [dref]), stbl]);
      var mdia = box('mdia', [mdhd, hdlr, minf]);
      return box('moov', [
        mvhd,
        box('trak', [tkhd, mdia]),
        box('udta', [metaBox(meta), chplBox(meta.chapters || [])])
      ]);
    }

    var probe = buildMoov(0);
    var dataOffset = ftyp.length + probe.length + 8;
    var moov = buildMoov(dataOffset);
    var mdatSize = 0;
    bodies.forEach(function (b) { mdatSize += b.length; });
    if (mdatSize + 8 > 0xffffffff) {
      throw new Error('This book is over 4 GB, too large for one .m4b. Use the MP3 or the separate chapters.');
    }
    mdatHead = joinBytes([u32(mdatSize + 8), ascii('mdat')]);

    return [ftyp, moov, mdatHead].concat(bodies);
  }


  /* --- plain .zip, nothing compressed -------------------------------- */

  var crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function le16(n) { return new Uint8Array([n & 255, (n >>> 8) & 255]); }
  function le32(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }

  // entries: [{ name, data }] stored as they are, or [{ name, raw, size, crc }]
  // where raw is data already deflated (raw, no header) from size bytes with the
  // given crc. Returns the pieces of the .zip.
  function zipStore(entries, when) {
    if (entries.length > 65534) throw new Error('Too many files for one .zip.');
    var d = when || new Date();
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var parts = [];
    var central = [];
    var offset = 0;

    entries.forEach(function (e) {
      var name = utf8(e.name);
      var packed = e.raw ? packBytes(e.raw) : packBytes(e.data);
      var method = e.raw ? 8 : 0;
      var size = e.raw ? e.size : packed.length;
      var crc = e.raw ? e.crc : crc32(packed);
      if (packed.length >= 0xFFFFFFFF || size >= 0xFFFFFFFF || offset >= 0xFFFFFFFF) {
        throw new Error('These files are too large for one .zip.');
      }
      var head = joinBytes([
        le32(0x04034b50), le16(20), le16(0x0800), le16(method), le16(time), le16(date),
        le32(crc), le32(packed.length), le32(size), le16(name.length), le16(0), name
      ]);
      central.push(joinBytes([
        le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(method), le16(time), le16(date),
        le32(crc), le32(packed.length), le32(size), le16(name.length), le16(0), le16(0),
        le16(0), le16(0), le32(0), le32(offset), name
      ]));
      parts.push(head, packed);
      offset += head.length + packed.length;
    });

    var dir = joinBytes(central);
    var end = joinBytes([
      le32(0x06054b50), le16(0), le16(0), le16(entries.length), le16(entries.length),
      le32(dir.length), le32(offset), le16(0)
    ]);
    return parts.concat([dir, end]);
  }

  /* --- reading a .zip -------------------------------------------------- */

  function rdLe16(b, at) { return b[at] | (b[at + 1] << 8); }
  function rdLe32(b, at) { return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0; }

  function utf8Decode(b) {
    var out = '', i = 0, c, c2, c3, c4, cp;
    while (i < b.length) {
      c = b[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c >= 0xc0 && c < 0xe0 && i < b.length) {
        c2 = b[i++];
        out += String.fromCharCode(((c & 31) << 6) | (c2 & 63));
      } else if (c >= 0xe0 && c < 0xf0 && i + 1 < b.length) {
        c2 = b[i++]; c3 = b[i++];
        out += String.fromCharCode(((c & 15) << 12) | ((c2 & 63) << 6) | (c3 & 63));
      } else if (c >= 0xf0 && i + 2 < b.length) {
        c2 = b[i++]; c3 = b[i++]; c4 = b[i++];
        cp = (((c & 7) << 18) | ((c2 & 63) << 12) | ((c3 & 63) << 6) | (c4 & 63)) - 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
      } else out += '�';
    }
    return out;
  }

  // The files of a .zip, without unpacking them: each entry's bytes are a view
  // into the archive, still compressed unless method is 0 (stored). The sizes
  // come from the central directory, which is right even when an entry's own
  // header leaves them to a data descriptor.
  function zipRead(bytes) {
    var b = packBytes(bytes);
    var end = -1;
    for (var i = b.length - 22; i >= 0 && i >= b.length - 22 - 65535; i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { end = i; break; }
    }
    if (end < 0) throw new Error('not a .zip file');
    var count = rdLe16(b, end + 10);
    var dirAt = rdLe32(b, end + 16);
    if (count === 0xffff || dirAt === 0xffffffff || rdLe32(b, end + 12) === 0xffffffff) {
      throw new Error('a .zip64 archive');
    }
    var out = [], at = dirAt, n;
    for (n = 0; n < count; n++) {
      if (at + 46 > b.length || rdLe32(b, at) !== 0x02014b50) throw new Error('damaged .zip directory');
      var method = rdLe16(b, at + 10);
      var csize = rdLe32(b, at + 20);
      var usize = rdLe32(b, at + 24);
      var nlen = rdLe16(b, at + 28), elen = rdLe16(b, at + 30), clen = rdLe16(b, at + 32);
      var off = rdLe32(b, at + 42);
      var name = utf8Decode(b.subarray(at + 46, at + 46 + nlen));
      if (off + 30 > b.length || rdLe32(b, off) !== 0x04034b50) throw new Error('damaged .zip entry');
      var start = off + 30 + rdLe16(b, off + 26) + rdLe16(b, off + 28);
      if (start + csize > b.length) throw new Error('cut-off .zip');
      out.push({ name: name, method: method, size: usize, data: b.subarray(start, start + csize) });
      at += 46 + nlen + elen + clen;
    }
    return out;
  }

  // Chapter marks from the frames actually present, not from listed durations:
  // an encoder pads every chapter up to a whole frame, so listed times drift a
  // little more with every chapter. durations (seconds) are only a fallback.
  function chapterMarks(stripped, labels, durations) {
    var chapters = [], at = 0, fallback = false;
    stripped.forEach(function (audio, i) {
      var ms = 0;
      try {
        var walk = mp3Walk(audio);
        ms = walk.sizes.length ? walk.sizes.length * walk.samplesPerFrame / walk.sampleRate * 1000 : 0;
      } catch (e) { /* fall through to the listed duration */ }
      if (!ms) {
        ms = Math.max(0, Math.round(((durations && durations[i]) || 0) * 1000));
        fallback = true;
      }
      chapters.push({ title: labels[i], startMs: Math.round(at), endMs: Math.round(at + ms) });
      at += ms;
    });
    return { chapters: chapters, fallback: fallback };
  }

  /* ==pack:end== */

  /* ------------------------------------------------------------------ *
   * download engine
   * ------------------------------------------------------------------ */

  function pool(items, limit, worker) {
    var next = 0;
    var stopped = false;
    var runners = [];

    function run() {
      return new Promise(function (resolve) {
        function step() {
          if (stopped || next >= items.length) { resolve(); return; }
          var index = next++;
          Promise.resolve(worker(items[index], index)).catch(function () {}).then(step);
        }
        step();
      });
    }

    for (var i = 0; i < Math.min(limit, items.length); i++) runners.push(run());
    var api = Promise.all(runners);
    api.stop = function () { stopped = true; };
    return api;
  }

  var ui = null;            // set once mounted
  var book = null;          // parsed book or delivery page
  var run = {
    active: false, cancelled: false, stats: null, failed: [], cover: null,
    mode: '', total: 0,
    sel: [],           // rows chosen for a per-file run
    epoch: 0,          // bumps with every run, so a late callback can tell it is stale
    todo: {},          // rows of a per-file run that have not been saved yet
    keep: null         // chapters already fetched for a one-file build
  };
  var copying = false;  // a copy button is collecting links

  // Why these bytes are not the file: an error page is small, or starts with "<".
  function brokenBytes(buf) {
    if (!buf || buf.byteLength < MIN_BYTES) return 'response was only ' + (buf ? buf.byteLength : 0) + ' bytes';
    if (buf[0] === 0x3c) return 'got a web page instead of the file';
    return '';
  }

  function pendingRows() {
    return Object.keys(run.todo).map(Number).sort(function (a, b) { return a - b; });
  }

  function setTrackState(i, state, note) {
    ui.setTrack(i, state, note);
    ui.progress();
  }

  function itemUrl(item) {
    if (item.url) return Promise.resolve(item.url);
    return resolveUrl(book.id, item.chapter);
  }

  // One chapter, as bytes, with the 403-means-stale-signature retry.
  function fetchChapter(i) {
    var attempt = 0;

    function tryOnce() {
      attempt++;
      setTrackState(i, 'get', '');
      return itemUrl(book.items[i]).then(fetchBytes).then(function (buf) {
        var why = brokenBytes(buf);
        if (why) throw new Error(why);
        return buf;
      }).catch(function (err) {
        if (attempt < MAX_ATTEMPTS && !run.cancelled) {
          setTrackState(i, 'get', 'retry ' + attempt);
          return sleep(err && err.status === 403 ? 250 : 600 * attempt).then(tryOnce);
        }
        run.stats.failed++;
        run.failed.push(i);
        setTrackState(i, 'fail', String(err && err.message || err).slice(0, 60));
        throw err;
      });
    }

    return tryOnce();
  }

  // Downloads: greedy browsers throttle bursts of blob downloads, so hand the
  // URL to the userscript manager and let it own the download.
  function saveToBrowser(item, name) {
    if (typeof GM_download !== 'function') return saveViaAnchor(item, name);

    return itemUrl(item).then(function (url) {
      return new Promise(function (resolve, reject) {
        // Some managers never call back for a stalled download; without this
        // the run, Stop and every button would wait on it forever.
        var settled = false;
        var timer = setTimeout(function () {
          finish(reject, new Error('download timed out'));
        }, DOWNLOAD_TIMEOUT);
        function finish(fn, arg) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(arg);
        }
        GM_download({
          url: url,
          name: name,
          saveAs: false,
          timeout: DOWNLOAD_TIMEOUT,
          onload: function () { finish(resolve, 0); },
          ontimeout: function () { finish(reject, new Error('download timed out')); },
          onerror: function (e) {
            var detail = String((e && e.error) || 'download failed');
            if (e && e.details) detail += ' (' + String(e.details).slice(0, 80) + ')';
            var err = new Error(detail);
            err.status = /40[13]/.test(detail) ? 403 : 0;
            finish(reject, err);
          }
        });
      });
    }).catch(function (err) {
      // Tampermonkey only lets GM_download write extensions on its Downloads
      // whitelist (pdf, zip, mp3 … but not epub) and reports "not_whitelisted";
      // other managers say not_permitted / not_enabled / not_supported. None of
      // those say anything about the file, so save the bytes through a blob link.
      if (/not_whitelisted|not_permitted|not_enabled|not_supported|not_implemented|not_succeeded/i.test(err.message)) {
        return saveViaAnchor(item, name);
      }
      throw err;
    });
  }

  function saveViaAnchor(item, name) {
    return itemUrl(item).then(fetchBytes).then(function (buf) {
      var why = brokenBytes(buf);
      if (why) throw new Error(why);
      saveToDownloads(name, buf);
      return buf.byteLength;
    });
  }

  // cover.jpg next to the chapters: in the book's folder when the download
  // manager allows folders, otherwise a flat file named after the book (a plain
  // cover.jpg from every book would overwrite the last one).
  // GM_download as a promise, with a watchdog for managers that never answer.
  function gmDownloadFile(url, name, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var limit = timeoutMs || DOWNLOAD_TIMEOUT;
      var timer = setTimeout(function () { finish(reject, new Error('download timed out')); }, limit);
      function finish(fn, arg) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      }
      if (typeof GM_download !== 'function') { finish(reject, new Error('not_supported')); return; }
      GM_download({
        url: url,
        name: name,
        saveAs: false,
        timeout: limit,
        onload: function () { finish(resolve); },
        ontimeout: function () { finish(reject, new Error('download timed out')); },
        onerror: function (e) {
          var detail = String((e && e.error) || 'download failed');
          if (e && e.details) detail += ' (' + String(e.details).slice(0, 80) + ')';
          finish(reject, new Error(detail));
        }
      });
    });
  }

  // Several ebook files, fetched and stored in one .zip named after the book.
  // Files fetched by an earlier attempt are kept, so a retry only fetches the
  // ones that are missing.
  function startBundle() {
    if (!run.active || !book) return Promise.resolve('');
    var got = run.keep || (run.keep = {});
    var sel = run.sel.slice();

    var coverJob = book.cover
      ? fetchBytes(book.cover).then(function (buf) { run.cover = buf; }).catch(function () { run.cover = null; })
      : Promise.resolve();

    function fetchFile(i) {
      var item = book.items[i];
      function tryOnce(attempt) {
        return itemUrl(item).then(fetchBytes).then(function (buf) {
          var why = brokenBytes(buf);
          if (why) throw new Error(why);
          return buf;
        }).catch(function (err) {
          if (attempt < MAX_ATTEMPTS && !run.cancelled) {
            setTrackState(i, 'get', 'retry ' + attempt);
            return sleep(600 * attempt).then(function () { return tryOnce(attempt + 1); });
          }
          run.stats.failed++;
          run.failed.push(i);
          setTrackState(i, 'fail', String(err && err.message || err).slice(0, 60));
          throw err;
        });
      }
      setTrackState(i, 'get', '');
      return tryOnce(1);
    }

    var job = pool(sel, CONCURRENCY, function (i) {
      if (run.cancelled) return Promise.resolve();
      if (got[i]) {
        run.stats.done++;
        run.stats.bytes += got[i].byteLength;
        setTrackState(i, 'ok', humanBytes(got[i].byteLength));
        return Promise.resolve();
      }
      return fetchFile(i).then(function (buf) {
        got[i] = buf;
        delete run.todo[i];
        run.stats.done++;
        run.stats.bytes += buf.byteLength;
        setTrackState(i, 'ok', humanBytes(buf.byteLength));
      });
    });

    return job.then(function () { return coverJob; }).then(function () {
      if (run.cancelled) return 'Stopped before making the .zip.';
      if (!sel.every(function (i) { return got[i]; })) {
        throw new Error('Some files did not download, so the .zip was not made. Retry the ones that failed.');
      }

      var entries = sel.map(function (i) { return { name: book.items[i].fileName, data: got[i] }; });
      var base = fileBase(book) || 'Book';
      if (run.cover && run.cover.length) {
        var coverName = base + '.jpg';
        var clash = entries.some(function (e) { return e.name.toLowerCase() === coverName.toLowerCase(); });
        if (!clash) entries.push({ name: coverName, data: run.cover });
      }

      var name = base + '.zip';
      ui.note('Making ' + name + '…');
      return zipBlob(entries).then(function (blob) {
        var size = saveToDownloads(name, blob);
        run.keep = null;                                     // made: nothing left to resume
        run.stats.bytes = size;
        var line = 'Saved ' + name + ' — ' + sel.length + ' files' +
          (entries.length > sel.length ? ' and the cover' : '') + ', ' + humanBytes(size) + '.';
        ui.note(line);
        return line;
      });
    });
  }

  /* --- one file per book --------------------------------------------- */

  // Separate chapter files, tagged and named, in one .zip holding a folder.
  // The download manager is not asked to name or place anything: for a file
  // on another site some managers ignore the name and save it under the
  // address's own (a UUID), with no folder and no title.
  function zipChapters(audios, total, coverNote) {
    var folder = fileBase(book);
    ui.note('Tagging and zipping ' + total + ' chapters…');
    var untagged = 0;
    var entries = audios.map(function (buf, i) {
      var item = book.items[i];
      var data = buf;
      try {
        var parts = muxMp3([mp3Audio(buf)], {
          title: item.label, artist: book.author, album: book.title,
          track: (i + 1) + '/' + total, cover: run.cover, chapters: []
        });
        data = joinBytes(parts);
      } catch (e) {
        untagged++;                                    // keep the audio as it came
      }
      return { name: folder + '/' + item.fileName, data: data };
    });
    if (run.cover && run.cover.length) entries.push({ name: folder + '/cover.jpg', data: run.cover });

    var blob = new Blob(zipStore(entries), { type: 'application/zip' });
    var name = folder + '.zip';
    var size = saveToDownloads(name, blob);
    run.keep = null;                                    // made: nothing left to resume
    run.stats.bytes = size;
    var line = 'Saved ' + name + ' — ' + total + ' titled chapters in the folder "' + folder + '"' +
      (run.cover && run.cover.length ? ' with cover.jpg' : '') + ', ' + humanBytes(size) + '.' +
      (untagged ? ' ' + untagged + ' could not be tagged and were left as they came.' : '') + coverNote;
    ui.note(line);
    return line;
  }

  function startOneFile(format) {
    if (!run.active || !book) return Promise.resolve('');

    // chapters fetched by an earlier attempt are kept, so a retry only fetches
    // the ones that are missing
    var audios = run.keep || (run.keep = []);
    var total = book.items.length;
    var finished = 0;

    // The cover is part of the tag, so it has to be in hand before the file is
    // assembled. A missing cover is not fatal, but it is reported: a silent
    // failure here is how "the file has no cover art" happens without a word.
    var coverNote = '';
    var coverJob = book.cover
      ? fetchBytes(book.cover).then(function (buf) {
        run.cover = buf;
      }).catch(function (err) {
        run.cover = null;
        coverNote = ' The cover could not be fetched (' +
          String(err && err.message || err).slice(0, 60) + '), so the file has no cover art.';
      })
      : Promise.resolve();

    var indexes = book.items.map(function (_, i) { return i; });
    var job = pool(indexes, CONCURRENCY, function (i) {
      // after a stop, or once a chapter has failed for good, fetching the rest
      // would only fill memory for a book that cannot be assembled
      if (run.cancelled || run.failed.length) return Promise.resolve();
      if (audios[i]) {
        finished++;
        run.stats.done++;
        run.stats.bytes += audios[i].byteLength;
        setTrackState(i, 'ok', humanBytes(audios[i].byteLength));
        return Promise.resolve();
      }
      return fetchChapter(i).then(function (buf) {
        audios[i] = buf;
        finished++;
        run.stats.done++;
        run.stats.bytes += buf.byteLength;
        setTrackState(i, 'ok', humanBytes(buf.byteLength));
        ui.note('Chapter ' + finished + ' of ' + total + ' · ' + humanBytes(run.stats.bytes));
      });
    });

    return job.then(function () {
      return coverJob;
    }).then(function () {
      if (run.cancelled) return 'Stopped before assembling the file.';
      if (audios.filter(Boolean).length !== total) {
        throw new Error('Some chapters did not download, so the book was not assembled. Retry the chapters that failed.');
      }

      if (format === 'chapters') return zipChapters(audios, total, coverNote);

      var ext = format === 'm4b' ? '.m4b' : '.mp3';
      ui.note('Assembling ' + total + ' chapters into one ' + ext + '…');

      // Chapter marks come from the frames actually downloaded (see chapterMarks)
      var stripped = audios.map(mp3Audio);
      var marks = chapterMarks(stripped, book.items.map(function (t) { return t.label; }),
        book.items.map(function (t) { return t.duration; }));
      var chapters = marks.chapters;
      var fallback = marks.fallback;

      var name = fileBase(book) + ext;
      var meta = {
        title: book.title,
        artist: book.author,
        album: book.title,
        comment: total + ' chapters' + (fallback ? ', times from the chapter list' : ''),
        cover: run.cover,
        chapters: chapters
      };

      var pieces;
      if (format === 'm4b') {
        pieces = muxM4b(audios, meta);
      } else {
        // A Xing header with the true frame and byte counts, so players show
        // the real length and seek correctly even for VBR or mixed bitrates.
        pieces = muxMp3(stripped, meta);
      }
      run.keep = null;                                      // built: nothing left to resume

      var blob = new Blob(pieces, { type: format === 'm4b' ? 'audio/mp4' : 'audio/mpeg' });
      var size = saveToDownloads(name, blob);
      run.stats.bytes = size;
      var capped = format === 'm4b' && total > 255;
      var line = 'Saved ' + name + ' — ' + humanBytes(size) + ', ' + Math.min(total, capped ? 255 : total) +
        ' chapter marks' + (run.cover && run.cover.length ? ' and the cover' : '') + '.' +
        (capped ? ' An .m4b holds at most 255 marks, so the last ' + (total - 255) + ' chapters are unmarked.' : '') +
        coverNote;
      ui.note(line);
      return line;
    });
  }

  function fileBase(b) {
    var name = b.title || 'Audiobook';
    if (b.author) name += ' - ' + b.author;
    return safeName(name);
  }

  /* --- run bookkeeping ------------------------------------------------ */

  // Runs that save nothing until every row is in: one assembled audiobook,
  // or several ebook files zipped together.
  function isOneFile(mode) { return mode === 'mp3' || mode === 'm4b' || mode === 'bundle' || mode === 'chapters'; }

  function stoppedNote(mode) {
    return 'Stopped. Nothing was saved: ' + (mode === 'bundle' || mode === 'chapters'
      ? 'the .zip is only made once every ' + (mode === 'chapters' ? 'chapter' : 'file') + ' is in.'
      : 'the book is only assembled once every chapter is in.');
  }

  function start(mode) {
    if (run.active || copying || !book) return;

    // ebooks: only the rows ticked, and more than one goes into a single .zip
    // so Downloads does not fill with loose files
    var sel = book.kind === 'audio' ? book.items.map(function (_, i) { return i; }) : ui.selected();
    if (!sel.length) { ui.note('Tick at least one file.', true); return; }
    if (mode === 'downloads' && sel.length > 1) mode = 'bundle';

    run.active = true;
    run.cancelled = false;
    run.mode = mode;
    run.failed = [];
    run.cover = null;
    run.keep = null;
    run.sel = sel;
    run.total = sel.length;
    run.todo = {};
    sel.forEach(function (i) { run.todo[i] = true; });
    run.stats = { done: 0, skipped: 0, failed: 0, bytes: 0 };

    ui.setRunning(true);
    ui.showRetry(0);
    ui.resetTracks();

    // Ebooks and archives go straight to Downloads. Audiobooks choose between
    // one chaptered file (.mp3 or .m4b) and separate chapter files. A throw
    // while setting up must still end the run, or the buttons stay disabled.
    var token = ++run.epoch;
    var job;
    try {
      job = mode === 'bundle' ? startBundle()
        : book.kind !== 'audio' ? startFiles()
        : startOneFile(mode);
    } catch (e) {
      job = Promise.reject(e);
    }

    job.then(function (note) {
      if (!run.active || token !== run.epoch) return;
      run.active = false;
      ui.setRunning(false);

      // rows never reached (Stop) are as much still to do as the failed ones
      if (!isOneFile(mode)) run.failed = pendingRows();

      var s = run.stats;
      var parts = [s.done + ' saved'];
      if (s.skipped) parts.push(s.skipped + ' already there');
      if (s.failed) parts.push(s.failed + ' failed');
      if (s.bytes) parts.push(humanBytes(s.bytes));

      if (run.cancelled && isOneFile(mode)) ui.note(stoppedNote(mode));
      else if (run.cancelled) ui.note('Stopped. ' + parts.join(', ') + (run.failed.length ? '; ' + run.failed.length + ' still to do' : '') + '.');
      else if (s.failed) ui.note('Finished with problems: ' + parts.join(', ') + '.', true);
      else if (typeof note === 'string' && note) ui.note(note);
      else ui.note('Done: ' + parts.join(', ') + '.');
      ui.showRetry(run.cancelled && isOneFile(mode) ? 0 : run.failed.length);
    }).catch(function (err) {
      if (token !== run.epoch) return;
      abort(err && err.message ? err.message : String(err));
    });
  }

  // Stop waits for the files in flight. A download the manager never answers
  // would hold the run (and every button) for the full timeout, so after a
  // while the run is ended anyway and what is left stays retryable.
  function watchStop() {
    var token = run.epoch;
    setTimeout(function () {
      if (!run.active || !run.cancelled || token !== run.epoch) return;
      run.epoch++;                                      // later callbacks are ignored
      run.active = false;
      ui.setRunning(false);
      var oneFile = isOneFile(run.mode);
      if (!oneFile) run.failed = pendingRows();
      ui.note('Stopped. ' + (oneFile ? 'Nothing was saved.' : run.stats.done + ' saved; ' + run.failed.length +
        ' still to do.') + ' A download did not answer.', true);
      ui.showRetry(oneFile ? 0 : run.failed.length);
    }, 20000);
  }

  // Ebooks, PDFs and archives: the same bytes the site offers, straight to
  // Downloads. One item at a time, so a failure is recorded per row. This goes
  // through saveToBrowser, which also falls back to a blob link when the
  // userscript manager reports "not_supported" for the download API.
  function downloadFile(i) {
    var item = book.items[i];

    function tryOnce(attempt) {
      return saveToBrowser(item, item.fileName).then(function (size) {
        run.stats.done++;
        run.stats.bytes += size || 0;
        delete run.todo[i];
        setTrackState(i, 'ok', size ? humanBytes(size) : 'saved');
      }).catch(function (err) {
        if (attempt < MAX_ATTEMPTS && !run.cancelled) {
          setTrackState(i, 'get', 'retry ' + attempt);
          return sleep(600 * attempt).then(function () { return tryOnce(attempt + 1); });
        }
        run.stats.failed++;
        run.failed.push(i);
        setTrackState(i, 'fail', String(err && err.message || err).slice(0, 60));
        throw err;
      });
    }

    setTrackState(i, 'get', '');
    return tryOnce(1);
  }

  function startFiles() {
    var indexes = run.sel.slice();
    var job = pool(indexes, CONCURRENCY, function (i) {
      if (run.cancelled) return Promise.resolve();
      return downloadFile(i);
    });

    // No loose cover image: it would be one more file in Downloads. When several
    // files are chosen they are zipped, and the cover goes into the .zip.
    return job.then(function () { return ''; });
  }

  function abort(message) {
    run.active = false;
    ui.setRunning(false);
    ui.note(message, true);
    ui.showRetry(run.failed.length);       // a one-file run that lost chapters can be retried
  }

  function retryFailed() {
    if (run.active || !book || !run.failed.length) return;

    if (copying) return;
    var retries = run.failed.slice();
    var mode = run.mode;

    run.active = true;
    run.cancelled = false;
    run.failed = [];
    run.stats = { done: 0, skipped: 0, failed: 0, bytes: 0 };
    var token = ++run.epoch;
    // progress counts the rows being retried, not the whole book
    run.total = mode === 'bundle' ? run.sel.length : isOneFile(mode) ? book.items.length : retries.length;
    ui.setRunning(true);
    ui.showRetry(0);
    // only a whole-book rebuild starts every row over; otherwise the rows
    // that already saved keep their "saved" mark
    if (isOneFile(mode)) ui.resetTracks();

    // A one-file run starts over but keeps the chapters it already has;
    // per-file runs only redo the rows that are still to do.
    var job;
    try {
      if (isOneFile(mode)) {
        job = mode === 'bundle' ? startBundle() : startOneFile(mode);
      } else {
        job = pool(retries, CONCURRENCY, function (i) {
          if (run.cancelled) return Promise.resolve();
          return downloadFile(i);
        });
      }
    } catch (e) {
      job = Promise.reject(e);
    }

    job.then(function (note) {
      if (!run.active || token !== run.epoch) return;
      run.active = false;
      ui.setRunning(false);
      if (!isOneFile(mode)) run.failed = pendingRows();
      if (run.cancelled && isOneFile(mode)) {
        ui.note(stoppedNote(mode));
        ui.showRetry(0);
        return;
      }
      if (run.cancelled) ui.note('Stopped. ' + run.stats.done + ' saved, ' + run.failed.length + ' still to do.');
      else if (run.failed.length) ui.note(run.failed.length + ' file(s) still failed.', true);
      else ui.note(typeof note === 'string' && note ? note : 'Everything downloaded.', false);
      ui.showRetry(run.failed.length);
    }).catch(function (err) {
      if (token !== run.epoch) return;
      abort(err && err.message ? err.message : String(err));
    });
  }

  /* ------------------------------------------------------------------ *
   * extra copies of the list
   * ------------------------------------------------------------------ */

  // Audiobooks: a .tsv manifest for a local downloader.
  function copyTsv() {
    if (!book || run.active || copying) return;
    copying = true;
    ui.lock(true);
    ui.note('Collecting signed links…');

    var rows = [book.id + '\t' + book.pageTitle + '\t' + book.cover];
    var indexes = book.items.map(function (_, i) { return i; });
    var done = 0;

    pool(indexes, CONCURRENCY, function (i) {
      var chapter = book.items[i].chapter;
      return resolveUrl(book.id, chapter).then(function (url) {
        var u = new URL(url);
        var dir = u.origin + u.pathname.replace(/[^/]+$/, '');
        var file = u.pathname.split('/').pop() + u.search;
        var entry = book.items[i];
        rows[i + 1] = [chapter, Math.round(entry.duration), entry.label.replace(/\t/g, ' '), dir, file].join('\t');
        done++;
        ui.note('Collecting signed links… ' + done + '/' + book.items.length);
      });
    }).then(function () {
      // pool() swallows worker errors, so a chapter whose link could not be
      // fetched is simply absent; never hand over a manifest with holes.
      var got = rows.slice(1).filter(Boolean).length;
      if (got !== book.items.length) {
        throw new Error('only ' + got + ' of ' + book.items.length + ' chapter links could be fetched. Try again.');
      }
      return copyText(rows.join('\n')).then(function () {
        ui.note('Copied ' + book.items.length + ' chapter rows to the clipboard as a .tsv manifest.');
      });
    }).catch(function (err) {
      ui.note('Could not build the .tsv: ' + (err && err.message ? err.message : err), true);
    }).then(function () {
      copying = false;
      ui.lock(false);
    });
  }

  // Ebooks: just the resolved links, one per line.
  function copyLinks() {
    if (!book || run.active || copying) return;
    var lines = book.items.map(function (item) {
      return item.url || '';
    }).filter(Boolean);
    copyText(lines.join('\n')).then(function () {
      ui.note('Copied ' + lines.length + ' link(s) to the clipboard.');
    }).catch(function (err) {
      ui.note('Could not copy: ' + (err && err.message ? err.message : err), true);
    });
  }

  function copyText(text) {
    return new Promise(function (resolve, reject) {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');          // a throw here rejects the promise
        resolve();
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve, reject);
      } else {
        reject(new Error('Clipboard is not available'));
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * UI
   * ------------------------------------------------------------------ */

  var STYLE = [
    ':host{all:initial}',
    '*{box-sizing:border-box}',
    '.pill{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:flex;align-items:center;gap:6px;',
    '  padding:9px 13px;border:0;border-radius:999px;background:#14695b;color:#fff;cursor:pointer;',
    '  font:600 13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)}',
    '.pill:hover{background:#0f5045}',
    '.panel{position:fixed;right:18px;bottom:18px;z-index:2147483001;width:min(420px,calc(100vw - 36px));',
    '  max-height:min(76vh,620px);display:flex;flex-direction:column;overflow:hidden;',
    '  background:#17191c;color:#e9edf0;border:1px solid #2c3138;border-radius:14px;',
    '  box-shadow:0 18px 50px rgba(0,0,0,.5);font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    'header{display:flex;gap:10px;align-items:flex-start;padding:14px 14px 10px;border-bottom:1px solid #262b31}',
    '.logo{font-size:18px;line-height:1.2}',
    '.titles{flex:1;min-width:0}',
    '.name{font-weight:650;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sub{color:#8f9aa5;font-size:11.5px;margin-top:2px}',
    '.icon{background:none;border:0;color:#8f9aa5;cursor:pointer;font-size:14px;padding:2px 4px;border-radius:6px}',
    '.icon:hover{background:#242a30;color:#e9edf0}',
    '.body{padding:12px 14px 14px;overflow:auto}',
    '.cover{float:right;width:74px;height:74px;object-fit:cover;border-radius:8px;margin:0 0 8px 10px;',
    '  background:#242a30}',
    '.facts{color:#a7b2bd;font-size:12px;margin:0 0 12px}',
    '.actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;clear:both}',
    'button.b{flex:1 1 auto;padding:8px 11px;border-radius:9px;border:1px solid #333a42;background:#22272d;',
    '  color:#e9edf0;cursor:pointer;font:600 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;white-space:nowrap}',
    'button.b:hover{background:#2a3037}',
    'button.b:disabled{opacity:.45;cursor:default}',
    'button.primary{background:#14695b;border-color:#14695b}',
    'button.primary:hover:not(:disabled){background:#0f5045}',
    'button.wide{flex:1 1 100%}',
    '.bar{height:6px;border-radius:99px;background:#242a30;overflow:hidden;margin:4px 0 8px}',
    '.fill{height:100%;width:0;background:#1f8f7c;transition:width .2s}',
    '.status{font-size:11.5px;color:#9aa5b1;min-height:16px;margin-bottom:8px}',
    '.status.bad{color:#e5847b}',
    '.tracks{margin-top:4px;border-top:1px solid #262b31}',
    '.track{display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #1e2328;font-size:12px}',
    '.track .t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#c3cbd3}',
    '.track input{margin:0;accent-color:#14695b;cursor:pointer}',
    '.track .d{color:#6f7a85;font-variant-numeric:tabular-nums;font-size:11px}',
    '.track .s{width:78px;text-align:right;font-size:11px;color:#6f7a85;font-variant-numeric:tabular-nums;',
    '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.track.ok .s{color:#4caf93}',
    '.track.skip .s{color:#8f9aa5}',
    '.track.fail .s{color:#e5847b}',
    '.track.get .s{color:#d7b25a}'
  ].join('\n');

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
    if (text != null) node.textContent = text;
    return node;
  }

  function mountUI() {
    if (document.getElementById('bfdl-host')) return;
    var host = document.createElement('div');
    host.id = 'bfdl-host';
    var root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', null, STYLE));

    var pill = el('button', { class: 'pill', title: 'BookFunnel Downloader' }, '📚 Download');
    var panel = el('div', { class: 'panel' });
    panel.style.display = 'none';

    var header = el('header');
    header.appendChild(el('div', { class: 'logo' }, '📚'));

    var titles = el('div', { class: 'titles' });
    var nameEl = el('div', { class: 'name' }, 'BookFunnel Downloader');
    var subEl = el('div', { class: 'sub' }, 'Reading the page…');
    titles.appendChild(nameEl);
    titles.appendChild(subEl);
    header.appendChild(titles);

    var closeBtn = el('button', { class: 'icon', title: 'Close' }, '✕');
    header.appendChild(closeBtn);
    panel.appendChild(header);

    var body = el('div', { class: 'body' });
    var cover = el('img', { class: 'cover', alt: '' });
    cover.style.display = 'none';
    body.appendChild(cover);

    var facts = el('div', { class: 'facts' }, '');
    body.appendChild(facts);

    var actions = el('div', { class: 'actions' });
    var mp3Btn = el('button', { class: 'b primary wide' }, 'MP3 — one file, with chapter marks');
    var m4bBtn = el('button', { class: 'b wide' }, 'M4B — one file, with chapter marks');
    var chaptersBtn = el('button', { class: 'b wide' }, 'Separate titled MP3s, in a folder (.zip)');
    var dlBtn = el('button', { class: 'b primary wide' }, 'Download');
    var listBtn = el('button', { class: 'b wide' }, 'Copy .tsv');
    var allButtons = [mp3Btn, m4bBtn, chaptersBtn, dlBtn, listBtn];
    allButtons.forEach(function (btn) {
      btn.style.display = 'none';
      actions.appendChild(btn);
    });
    body.appendChild(actions);

    var runRow = el('div', { class: 'actions' });
    var stopBtn = el('button', { class: 'b' }, 'Stop');
    stopBtn.style.display = 'none';
    var retryBtn = el('button', { class: 'b' }, 'Retry failed');
    retryBtn.style.display = 'none';
    runRow.appendChild(stopBtn);
    runRow.appendChild(retryBtn);
    body.appendChild(runRow);

    var bar = el('div', { class: 'bar' });
    var fill = el('div', { class: 'fill' });
    bar.appendChild(fill);
    body.appendChild(bar);

    var status = el('div', { class: 'status' }, 'Ready.');
    body.appendChild(status);

    var tracks = el('div', { class: 'tracks' });
    body.appendChild(tracks);

    panel.appendChild(body);
    root.appendChild(pill);
    root.appendChild(panel);
    document.body.appendChild(host);

    var rows = [];
    var boxes = [];
    var locked = false;

    function chosen() {
      return boxes.map(function (b, i) { return b.checked ? i : -1; })
        .filter(function (i) { return i >= 0; });
    }

    // the Download button says what it will do, and cannot run on nothing
    function refresh() {
      boxes.forEach(function (b) { b.disabled = locked; });
      if (!book || book.kind === 'audio') return;
      var n = chosen().length;
      var total = book.items.length;
      dlBtn.textContent = total === 1 ? 'Download'
        : n === 0 ? 'Tick the files you want'
          : n === 1 ? 'Download 1 file'
            : 'Download ' + n + ' files as one .zip';
      dlBtn.disabled = locked || n === 0;
    }

    function openPanel() {
      panel.style.display = 'flex';
      pill.style.display = 'none';
    }
    function closePanel() {
      panel.style.display = 'none';
      pill.style.display = 'flex';
    }

    pill.addEventListener('click', openPanel);
    closeBtn.addEventListener('click', closePanel);

    mp3Btn.addEventListener('click', function () { start('mp3'); });
    m4bBtn.addEventListener('click', function () { start('m4b'); });
    chaptersBtn.addEventListener('click', function () { start('chapters'); });
    dlBtn.addEventListener('click', function () { start('downloads'); });
    listBtn.addEventListener('click', function () {
      if (book && book.kind === 'audio') copyTsv();
      else copyLinks();
    });
    stopBtn.addEventListener('click', function () {
      if (!run.active) return;
      run.cancelled = true;
      ui.note('Stopping after the files in flight…');
      watchStop();
    });
    retryBtn.addEventListener('click', retryFailed);

    function buildRows() {
      tracks.textContent = '';
      rows = [];
      boxes = [];
      var width = Math.max(2, String(book.items.length).length);
      book.items.forEach(function (item, i) {
        var row = el('div', { class: 'track' });
        var lead = el('div', { class: 'd' }, book.kind === 'audio' ? pad(i + 1, width) : '');
        if (book.kind !== 'audio') {
          var box = el('input', { type: 'checkbox', 'aria-label': 'Include ' + item.label });
          box.checked = true;
          box.addEventListener('change', refresh);
          // the whole row is the target, not only the small box
          row.addEventListener('click', function (e) {
            if (locked || e.target === box) return;
            box.checked = !box.checked;
            refresh();
          });
          row.style.cursor = 'pointer';
          lead.appendChild(box);
          boxes.push(box);
        }
        row.appendChild(lead);
        row.appendChild(el('div', { class: 't', title: item.label }, item.label));
        row.appendChild(el('div', { class: 's' }, item.sub || ''));
        tracks.appendChild(row);
        rows.push(row);
      });
    }

    function summary() {
      var formats = unique(book.items.map(function (i) { return i.sub; }).filter(Boolean));
      if (book.kind === 'audio') {
        var secs = book.items.reduce(function (a, t) { return a + (t.duration || 0); }, 0);
        return book.items.length + ' chapters · ' + humanDuration(secs) + (book.cover ? '' : ' · no cover found');
      }
      return book.items.length + (book.items.length === 1 ? ' file · ' : ' files · ') + formats.join(', ');
    }

    ui = {
      host: host,
      showBook: function (b) {
        nameEl.textContent = b.title;
        subEl.textContent = b.author ? 'by ' + b.author : 'BookFunnel';
        facts.textContent = summary();
        var audio = b.kind === 'audio';
        mp3Btn.style.display = audio ? 'block' : 'none';
        m4bBtn.style.display = audio ? 'block' : 'none';
        chaptersBtn.style.display = audio ? 'block' : 'none';
        dlBtn.style.display = audio ? 'none' : 'block';
        listBtn.style.display = 'block';
        listBtn.textContent = audio ? 'Copy .tsv' : 'Copy links';
        if (b.cover) {
          cover.src = b.cover;
          cover.style.display = 'block';
        }
        buildRows();
        refresh();
        openPanel();
      },
      progress: function () {
        var total = run.total || book.items.length;
        var s = run.stats || { done: 0, skipped: 0, failed: 0, bytes: 0 };
        var finished = s.done + s.skipped + s.failed;
        fill.style.width = Math.min(100, (finished / total) * 100) + '%';
        if (run.active) {
          // keep the Stop confirmation up until the run really ends
          ui.note(run.cancelled
            ? 'Stopping after the files in flight…'
            : finished + ' of ' + total + (s.bytes ? ' · ' + humanBytes(s.bytes) : ''));
        }
      },
      setTrack: function (i, state, note) {
        var row = rows[i];
        if (!row) return;
        row.className = 'track ' + state;
        if (note) row.title = note;
        var badge = row.lastChild;
        var base = book.items[i].sub || '';
        badge.textContent = state === 'ok' ? note || 'saved'
          : state === 'skip' ? 'on disk'
            : state === 'get' ? (note || 'getting…')
              : state === 'fail' ? 'failed'
                : base;
        if (state === 'get' && note) badge.textContent = note;
      },
      note: function (text, bad) {
        status.textContent = text;
        status.className = 'status' + (bad ? ' bad' : '');
      },
      selected: chosen,
      setRunning: function (active) {
        stopBtn.style.display = active ? 'block' : 'none';
        locked = active;
        allButtons.forEach(function (btn) { btn.disabled = active; });
        refresh();
        if (active) fill.style.width = '0';          // a finished run keeps its bar full
      },
      lock: function (on) {
        locked = on;
        allButtons.forEach(function (btn) { btn.disabled = on; });
        refresh();
      },
      resetTracks: function () {
        rows.forEach(function (row, i) {
          row.className = 'track';
          row.removeAttribute('title');
          row.lastChild.textContent = book.items[i].sub || '';
        });
      },
      showRetry: function (n) {
        retryBtn.style.display = n ? 'block' : 'none';
        retryBtn.textContent = 'Retry ' + n + ' failed';
      },
      showError: function (message) {
        nameEl.textContent = 'BookFunnel Downloader';
        subEl.textContent = 'Could not read this page';
        allButtons.forEach(function (btn) { btn.disabled = true; });
        ui.note(message, true);
        openPanel();
      }
    };

    return ui;
  }

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */

  function currentHtml() {
    return document.documentElement ? document.documentElement.outerHTML : '';
  }

  // The cloud reader carries the unpacked EPUB and its own settings block,
  // which names the book even when nothing else does.
  function readerInfo() {
    var hit = currentHtml().match(/var\s+metadata\s*=\s*\{[\s\S]*?\};/);
    if (!hit) return {};
    function field(name) {
      var m = hit[0].match(new RegExp('\\b' + name + '\\s*:\\s*["\']([^"\']*)'));
      return m ? clean(m[1]) : '';
    }
    return { id: field('id'), title: field('title'), author: field('author') };
  }

  function loadBook(page) {
    if (page.kind === 'audio') {
      return fetchPage('/' + page.bookId).then(function (html) {
        return parseAudioPage(html, page.bookId);
      });
    }
    if (page.via === 'page' || page.via === 'delivery') {
      // this is the page that lists the files, so read what it already shows
      return Promise.resolve().then(function () {
        return parseDeliveryPage(currentHtml(), { title: document.title });
      });
    }
    // Cloud reader: the reader only carries the unpacked EPUB chapter by
    // chapter, so ask BookFunnel's own delivery page for the finished files.
    var info = readerInfo();
    var url = 'https://my.bookfunnel.com/' + page.bookId + '/download';
    return fetchText(url).then(function (html) {
      return parseDeliveryPage(html, { title: info.title, author: info.author });
    });
  }

  /* ------------------------------------------------------------------ *
   * library: which books BookFunnel will hand over and which need this tool
   * ------------------------------------------------------------------ */

  // A library entry is "locked" when BookFunnel marks it restricted or gives it
  // no download address: its own Download button does nothing, and the player
  // page plus this script is the way to get it. Everything else downloads
  // normally from the library.
  function isLockedSlot(slot) {
    return slot.getAttribute('data-is-restricted') === 'true' || !slot.getAttribute('data-dl-url');
  }

  // The page that plays a library entry, where this tool's panel appears.
  function slotOpenUrl(slot) {
    var url = slot.getAttribute('data-open-url') ||
      (slot.getAttribute('data-id') ? 'https://play.bookfunnel.com/' + slot.getAttribute('data-id') : '');
    return /^https:\/\/[a-z0-9.-]*bookfunnel\.com\//i.test(url) ? url : '';
  }

  // A popup blocker lets one window through per click; the userscript
  // manager's own tab opener is not subject to it.
  function openTab(url) {
    if (typeof GM_openInTab === 'function') GM_openInTab(url, { active: false, insert: true });
    else window.open(url, '_blank', 'noopener');
  }


  /* --- download everything that downloads normally --------------------- */

  // The library's own entries, read from the page: the title, and BookFunnel's
  // delivery page for it, which lists the real files.
  function slotInfo(slot) {
    function text(sel) {
      var n = slot.querySelector(sel);
      return n ? clean(n.textContent) : '';
    }
    return { title: text('.title') || clean(slot.getAttribute('title')), author: text('.author'),
      page: slot.getAttribute('data-dl-url'), type: slot.getAttribute('data-type') };
  }

  // One file per book: the standard EPUB (or the PDF when that is all there is);
  // for an audiobook, the .zip of the audio. Kindle and Kobo copies and the
  // audiobook sample would only repeat or pad the pile.
  function pickBulkFile(items, audio) {
    if (audio) {
      return items.filter(function (i) { return /\.zip$/i.test(i.fileName); })[0] || null;
    }
    return items.filter(function (i) { return i.sub === 'EPUB'; })[0] ||
      items.filter(function (i) { return /PDF/i.test(i.sub); })[0] || items[0] || null;
  }

  function uniqueEntryName(taken, name) {
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var candidate = name;
    for (var n = 2; taken[candidate.toLowerCase()]; n++) candidate = stem + ' (' + n + ')' + ext;
    taken[candidate.toLowerCase()] = true;
    return candidate;
  }

  // slots: library entries. say(text) reports progress; stopped() says whether
  // Stop was pressed. Resolves with a closing message.
  function bulkEbooks(slots, say, stopped) {
    var entries = [], failed = [], taken = {}, finished = 0;

    var job = pool(slots, 3, function (slot) {
      if (stopped()) return Promise.resolve();
      var info = slotInfo(slot);
      return fetchText(info.page).then(function (html) {
        var found = parseDeliveryPage(html, { title: info.title, author: info.author });
        var item = pickBulkFile(found.items, false);
        if (!item) throw new Error('no file offered');
        return fetchBytes(item.url).then(function (buf) {
          var why = brokenBytes(buf);
          if (why) throw new Error(why);
          entries.push({ name: uniqueEntryName(taken, item.fileName), data: buf });
        });
      }).catch(function (err) {
        failed.push(info.title + ' (' + String(err && err.message || err).slice(0, 50) + ')');
      }).then(function () {
        finished++;
        say('Ebooks: ' + finished + ' of ' + slots.length + (failed.length ? ' · ' + failed.length + ' failed' : ''));
      });
    });

    return job.then(function () {
      if (stopped()) return 'Stopped. Nothing was saved: the .zip is only made once every ebook is in.';
      if (!entries.length) throw new Error('No ebook could be fetched.' + (failed[0] ? ' ' + failed[0] : ''));
      say('Making BookFunnel ebooks.zip…');
      return zipBlob(entries).then(function (blob) {
        var size = saveToDownloads('BookFunnel ebooks.zip', blob);
        return 'Saved BookFunnel ebooks.zip: ' + entries.length + ' ebooks, ' + humanBytes(size) + '.' +
          (failed.length ? ' Could not get ' + failed.length + ': ' + failed.join('; ') + '.' : '');
      });
    });
  }

  function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return Promise.reject(new Error('no CompressionStream'));
    var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  // A .zip as a Blob. A file that is itself a zip (an EPUB, say) is deflated
  // rather than stored: macOS Archive Utility cannot expand a zip that holds
  // another zip uncompressed ("unable to expand"), while every other file kind
  // is fine stored and is left that way.
  function zipBlob(entries) {
    var prepared = [];
    return entries.reduce(function (chain, e) {
      return chain.then(function () {
        var d = packBytes(e.data);
        var nested = d.length > 3 && d[0] === 0x50 && d[1] === 0x4b && d[2] === 3 && d[3] === 4;
        if (!nested) { prepared.push(e); return null; }
        return deflateRaw(d).then(function (raw) {
          prepared.push({ name: e.name, raw: raw, size: d.length, crc: crc32(d) });
        }, function () { prepared.push(e); });          // no compression here: stored still works elsewhere
      });
    }, Promise.resolve()).then(function () {
      return new Blob(zipStore(prepared), { type: 'application/zip' });
    });
  }

  function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('this browser cannot unpack compressed .zip entries'));
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  }

  function zipEntryBytes(entry) {
    if (entry.method === 0) return Promise.resolve(entry.data);
    if (entry.method === 8) return inflateRaw(entry.data);
    return Promise.reject(new Error('unsupported .zip method ' + entry.method));
  }

  // "001 Elva Birch - Dragon of Glass - audiobook - Opening Credits.mp3" is the
  // chapter "Opening Credits": the number, the author and the book title go.
  function chapterLabelFromName(name, found, i) {
    var base = String(name).replace(/^.*\//, '').replace(/\.mp3$/i, '').replace(/^\d+[\s._-]*/, '');
    [found.author, found.title].forEach(function (prefix) {
      if (prefix && base.toLowerCase().indexOf((prefix + ' - ').toLowerCase()) === 0) base = base.slice(prefix.length + 3);
    });
    return clean(base) || 'Chapter ' + (i + 1);
  }

  // A BookFunnel audiobook .zip of chapter MP3s → one chaptered .m4b, without
  // re-encoding. Resolves { blob, count, capped }; rejects when the zip is not
  // a book of MP3s this can join (mixed sample rates, too big, unreadable).
  function zipToM4b(zipBuf, found, cover) {
    var entries = zipRead(zipBuf);
    var mp3s = entries.filter(function (e) { return /\.mp3$/i.test(e.name); });
    if (!mp3s.length) return Promise.reject(new Error('no MP3 chapters in the .zip'));
    mp3s.sort(function (x, y) {
      var nx = parseInt(x.name.replace(/^.*\//, ''), 10), ny = parseInt(y.name.replace(/^.*\//, ''), 10);
      if (!isNaN(nx) && !isNaN(ny) && nx !== ny) return nx - ny;
      return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
    });

    var audios = [];
    return mp3s.reduce(function (chain, entry, i) {
      return chain.then(function () {
        return zipEntryBytes(entry).then(function (bytes) { audios[i] = bytes; });
      });
    }, Promise.resolve()).then(function () {
      var labels = mp3s.map(function (e, i) { return chapterLabelFromName(e.name, found, i); });
      var marks = chapterMarks(audios.map(mp3Audio), labels, []);
      var pieces = muxM4b(audios, {
        title: found.title, artist: found.author, album: found.title,
        comment: mp3s.length + ' chapters', cover: cover, chapters: marks.chapters
      });
      return { blob: new Blob(pieces, { type: 'audio/mp4' }), count: mp3s.length, capped: mp3s.length > 255 };
    });
  }

  // Audiobooks, one at a time: the book's .zip is fetched here, joined into one
  // chaptered <Title> - <Author>.m4b and saved. Handing the address to the
  // download manager instead does not work for these: for a file on another
  // site some managers ignore the requested name and save the book under the
  // address's own, a random code with no extension, which nothing can open. A
  // book that cannot be joined is saved as its .zip, under its own name, and the
  // result says so; one too large to hold in memory goes to the manager.
  function bulkAudiobooks(slots, say, stopped) {
    var failed = [], saved = 0, made = 0, finished = 0, viaManager = [], keptZip = [], capped = [];

    var job = pool(slots, 1, function (slot) {
      if (stopped()) return Promise.resolve();
      var info = slotInfo(slot);
      var shown = 'Audiobooks: ' + (finished + 1) + ' of ' + slots.length + ' — ' + info.title;
      say(shown);
      return fetchText(info.page).then(function (html) {
        var found = parseDeliveryPage(html, { title: info.title, author: info.author });
        var item = pickBulkFile(found.items, true);
        if (!item) throw new Error('no audio file offered');
        var base = fileBase(found);
        return gmRequest({
          url: item.url,
          responseType: 'arraybuffer',
          timeout: DOWNLOAD_TIMEOUT,
          onprogress: function (e) {
            if (e && e.loaded) say(shown + ' · ' + humanBytes(e.loaded) + (e.total > 0 ? ' of ' + humanBytes(e.total) : ''));
          }
        }).then(function (res) {
          if (res.status < 200 || res.status >= 300) throw httpError(res.status);
          if (!res.response) throw new Error('Empty response');
          var buf = res.response instanceof Uint8Array ? res.response : new Uint8Array(res.response);
          var why = brokenBytes(buf);
          if (why) throw new Error(why);

          say(shown + ' · making the .m4b…');
          var coverJob = found.cover ? fetchBytes(found.cover).catch(function () { return null; }) : Promise.resolve(null);
          return coverJob.then(function (cover) {
            return zipToM4b(buf, found, cover);
          }).then(function (m4b) {
            saveToDownloads(base + '.m4b', m4b.blob);
            made++;
            if (m4b.capped) capped.push(info.title);
          }, function (err) {
            keptZip.push(info.title + ' (' + String(err && err.message || err).slice(0, 140) + ')');
            saveToDownloads(base + '.zip', buf);
          });
        }, function (err) {
          if (err && err.status) throw err;            // the site said no: the manager would be told the same
          viaManager.push(info.title);                  // out of memory or a dropped connection
          return gmDownloadFile(item.url, base + '.zip');
        });
      }).then(function () {
        saved++;
      }).catch(function (err) {
        failed.push(info.title + ' (' + String(err && err.message || err).slice(0, 50) + ')');
      }).then(function () {
        finished++;
        say('Audiobooks: ' + finished + ' of ' + slots.length + (failed.length ? ' · ' + failed.length + ' failed' : ''));
      });
    });

    return job.then(function () {
      var notes = '';
      if (keptZip.length) {
        notes += ' Saved as .zip instead, because they could not be joined into one .m4b: ' + keptZip.join('; ') + '.';
      }
      if (viaManager.length) {
        notes += ' ' + viaManager.length + ' could not be held in memory, so the download manager saved ' +
          (viaManager.length === 1 ? 'it' : 'them') + ' as a .zip: if ' + (viaManager.length === 1 ? 'its name has' : 'their names have') +
          ' no ".zip" ending, add one (' + viaManager.join('; ') + ').';
      }
      if (capped.length) notes += ' An .m4b holds at most 255 chapter marks, so the last chapters of ' + capped.join('; ') + ' are unmarked.';
      if (stopped()) return 'Stopped. ' + saved + ' audiobook' + (saved === 1 ? '' : 's') + ' saved.' + notes;
      if (!saved && failed.length) throw new Error('No audiobook could be saved. ' + failed[0]);
      return 'Saved ' + saved + ' audiobook' + (saved === 1 ? '' : 's') +
        (made === saved ? ' as .m4b files.' : made ? ': ' + made + ' as .m4b, the rest as .zip.' : ' as .zip files.') + notes +
        (failed.length ? ' Could not get ' + failed.length + ': ' + failed.join('; ') + '.' : '');
    });
  }

  function markLibrary() {
    if (document.getElementById('bfdl-lib-style')) return;      // already running

    var style = document.createElement('style');
    style.id = 'bfdl-lib-style';
    style.textContent =
      '.library-slot[data-bfdl="locked"] .book-container{outline:10px solid #e5484d;outline-offset:-4px;border-radius:8px}' +
      '.library-slot[data-bfdl="open"] .book-container{outline:10px solid #2e9e5b;outline-offset:-4px;border-radius:8px}';
    document.head.appendChild(style);

    var host = document.createElement('div');
    host.id = 'bfdl-legend';
    var root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', null,
      '.l{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#0f1113;color:#fff;' +
      'font:700 19px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border-radius:14px;' +
      'border:3px solid #fff;padding:14px 18px;box-shadow:0 10px 32px rgba(0,0,0,.55);' +
      'display:flex;gap:16px;align-items:flex-start;max-width:min(430px,calc(100vw - 36px))}' +
      '.k{display:flex;align-items:center;gap:12px;margin:4px 0}' +
      '.sw{width:26px;height:26px;border-radius:6px;flex:none;border:2px solid #fff}' +
      '.n{font-size:26px;font-weight:800}.d{font-size:14px;font-weight:600;color:#c9d1d9;display:block}' +
      '.x{all:unset;cursor:pointer;color:#c9d1d9;font-size:20px;padding:0 4px}' +
      '.go{all:unset;box-sizing:border-box;display:block;margin-top:10px;width:100%;text-align:center;cursor:pointer;' +
      'background:#e5484d;color:#fff;font:800 18px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
      'padding:12px 14px;border-radius:10px}.go:hover{background:#cf3a3f}' +
      '.go[disabled]{background:#3a3f45;color:#8b95a0;cursor:default}' +
      '.go.alt{background:#2e9e5b}.go.alt:hover{background:#26874d}.go.alt[disabled]{background:#3a3f45}' +
      '.go.stop{background:#555c64}' +
      '.st{display:none;margin-top:10px;font-size:14px;font-weight:600;line-height:1.4;color:#c9d1d9;overflow-wrap:anywhere}'));
    var box = el('div', { class: 'l' });
    var rows = el('div');
    var lockedRow = el('div', { class: 'k' });
    var lockedSwatch = el('span', { class: 'sw' });
    lockedSwatch.style.background = '#e5484d';
    var lockedText = el('span');
    lockedRow.appendChild(lockedSwatch);
    lockedRow.appendChild(lockedText);
    var openRow = el('div', { class: 'k' });
    var openSwatch = el('span', { class: 'sw' });
    openSwatch.style.background = '#2e9e5b';
    var openText = el('span');
    openRow.appendChild(openSwatch);
    openRow.appendChild(openText);
    rows.appendChild(lockedRow);
    rows.appendChild(openRow);
    var goBtn = el('button', { class: 'go' }, 'Open Blocked');
    goBtn.addEventListener('click', function () {
      var urls = [];
      Array.prototype.forEach.call(document.querySelectorAll('.library-slot[data-bfdl="locked"]'), function (slot) {
        var url = slotOpenUrl(slot);
        if (url && urls.indexOf(url) < 0) urls.push(url);
      });
      urls.forEach(openTab);
    });
    rows.appendChild(goBtn);

    var ebBtn = el('button', { class: 'go alt' }, 'Download all ebooks');
    var abBtn = el('button', { class: 'go alt' }, 'Download all audiobooks');
    var stopBtn = el('button', { class: 'go stop' }, 'Stop');
    stopBtn.style.display = 'none';
    var statusEl = el('div', { class: 'st' });
    rows.appendChild(ebBtn);
    rows.appendChild(abBtn);
    rows.appendChild(stopBtn);
    rows.appendChild(statusEl);

    var counts = { eb: 0, ab: 0, locked: 0 };
    var running = false, stopFlag = false, armed = null, armTimer = null;

    function openSlots(kind) {
      return Array.prototype.filter.call(document.querySelectorAll('.library-slot[data-bfdl="open"]'), function (slot) {
        var type = slot.getAttribute('data-type');
        return kind === 'ab' ? type === 'audiobook' : type !== 'audiobook';
      });
    }

    function labels() {
      ebBtn.textContent = armed === 'eb' ? 'Click again: ' + counts.eb + ' ebooks into one .zip'
        : counts.eb ? 'Download all ebooks (' + counts.eb + ')' : 'Download all ebooks';
      abBtn.textContent = armed === 'ab' ? 'Click again: ' + counts.ab + ' audiobooks as .m4b (large)'
        : counts.ab ? 'Download all audiobooks (' + counts.ab + ')' : 'Download all audiobooks';
      ebBtn.disabled = running || !counts.eb;
      abBtn.disabled = running || !counts.ab;
      goBtn.disabled = running || !counts.locked;
      stopBtn.style.display = running ? 'block' : 'none';
    }

    function say(text, bad) {
      statusEl.style.display = text ? 'block' : 'none';
      statusEl.textContent = text;
      statusEl.style.color = bad ? '#ff9b95' : '#c9d1d9';
    }

    // A second click confirms: this can be a lot of data.
    function bulkClick(kind) {
      if (running) return;
      if (armed !== kind) {
        armed = kind;
        clearTimeout(armTimer);
        armTimer = setTimeout(function () { armed = null; labels(); }, 6000);
        labels();
        return;
      }
      clearTimeout(armTimer);
      armed = null;
      running = true;
      stopFlag = false;
      labels();
      var slots = openSlots(kind);
      say('Starting…');
      var task = kind === 'ab' ? bulkAudiobooks : bulkEbooks;
      Promise.resolve().then(function () {
        return task(slots, say, function () { return stopFlag; });
      }).then(function (message) {
        say(message);
      }).catch(function (err) {
        say(String(err && err.message || err), true);
      }).then(function () {
        running = false;
        labels();
      });
    }

    ebBtn.addEventListener('click', function () { bulkClick('eb'); });
    abBtn.addEventListener('click', function () { bulkClick('ab'); });
    stopBtn.addEventListener('click', function () {
      stopFlag = true;
      say('Stopping after the ones in flight…');
    });
    var hide = el('button', { class: 'x', title: 'Hide this key' }, '✕');
    hide.addEventListener('click', function () { host.style.display = 'none'; });
    box.appendChild(rows);
    box.appendChild(hide);
    root.appendChild(box);
    document.body.appendChild(host);

    function paint() {
      var locked = 0, open = 0;
      Array.prototype.forEach.call(document.querySelectorAll('.library-slot'), function (slot) {
        var state = isLockedSlot(slot) ? 'locked' : 'open';
        if (slot.getAttribute('data-bfdl') !== state) slot.setAttribute('data-bfdl', state);
        if (state === 'locked') locked++; else open++;
      });
      lockedText.textContent = '';
      lockedText.appendChild(el('span', { class: 'n' }, String(locked)));
      lockedText.appendChild(document.createTextNode(' need this tool'));
      lockedText.appendChild(el('span', { class: 'd' }, 'red border: open the book, use the panel'));
      openText.textContent = '';
      openText.appendChild(el('span', { class: 'n' }, String(open)));
      openText.appendChild(document.createTextNode(' download normally'));
      openText.appendChild(el('span', { class: 'd' }, 'green border'));
      goBtn.textContent = locked ? 'Open Blocked (' + locked + ')' : 'Open Blocked';
      counts.locked = locked;
      counts.eb = openSlots('eb').length;
      counts.ab = openSlots('ab').length;
      labels();
    }

    // more books load as the library scrolls
    var timer = null;
    new MutationObserver(function () {
      clearTimeout(timer);
      timer = setTimeout(paint, 200);
    }).observe(document.body, { childList: true, subtree: true });
    paint();
  }

  function boot() {
    if (PAGE_HOST === 'my.bookfunnel.com' && /^\/?$/.test(PAGE_PATH)) { markLibrary(); return; }
    var page = detectPage();
    if (!page) return;                   // not a book page
    mountUI();
    if (!ui) return;                      // another copy of the script owns the panel
    ui.note('Reading the page…');

    loadBook(page).then(function (b) {
      book = b;
      ui.showBook(book);
      if (book.kind === 'audio') {
        ui.note('Ready. ' + book.items.length + ' chapters.');
      } else if (book.items.length === 1 && /\.zip$/i.test(book.items[0].fileName)) {
        ui.note('Ready. BookFunnel offers this one as a single .zip.');
      } else {
        ui.note('Ready. ' + book.items.length + (book.items.length === 1 ? ' file' : ' files') + ' offered.');
      }
    }).catch(function (err) {
      ui.showError(err && err.message ? err.message : String(err));
    });
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Open BookFunnel downloader', function () {
      if (!ui) return;
      var panel = ui.host.shadowRoot.querySelector('.panel');
      var pill = ui.host.shadowRoot.querySelector('.pill');
      if (panel && pill) {
        panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        pill.style.display = panel.style.display === 'none' ? 'flex' : 'none';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
