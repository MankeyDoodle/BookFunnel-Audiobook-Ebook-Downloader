// Pull the parser half out of the userscript and run it on the saved fixtures.
// The userscript is an IIFE that boots on load, so the parser functions are
// lifted out by their markers and evaluated in a sandbox with no DOM.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'bookfunnel-downloader.user.js'), 'utf8');

const START = '  function clean(s) {';
const END = '  /* ------------------------------------------------------------------ *\n   * disk';
const start = src.indexOf(START);
const end = src.indexOf(END, start);
if (start < 0 || end < 0) {
  console.error('could not find the parser block');
  process.exit(1);
}
const block = src.slice(start, end);

const sandbox = {
  console,
  location: { hostname: 'pr.bookfunnel.com', pathname: '/codetwo/download', origin: 'https://pr.bookfunnel.com' },
  navigator: {},
  URL,
  setTimeout,
  GM_xmlhttpRequest: function () {},
  fetch: function () {}
};
// A real DOMParser is only needed by the checks that read markup; jsdom is
// optional (npm i jsdom), and those checks are skipped without it.
let hasDom = false;
try {
  const { JSDOM } = require('jsdom');
  sandbox.DOMParser = new JSDOM('').window.DOMParser;
  hasDom = true;
} catch (e) { /* no jsdom: DOM-dependent checks are skipped below */ }
vm.createContext(sandbox);
vm.runInContext(block, sandbox);

const fixtures = [
  ['ebook-delivery.html', 'https://pr.bookfunnel.com/codetwo/download'],
  ['pdf-delivery.html', 'https://my.bookfunnel.com/codethr/download'],
  ['audio-archive-delivery.html', 'https://pr.bookfunnel.com/codeone/download']
];

let failures = 0;

function check(label, ok, detail) {
  if (ok) {
    console.log('ok   ' + label);
  } else {
    failures++;
    console.log('FAIL ' + label + (detail ? ' — ' + detail : ''));
  }
}

for (const [file, pageUrl] of fixtures) {
  const html = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', file), 'utf8');
  console.log('\n== ' + file);

  let urls;
  try {
    urls = sandbox.collectLinks(html);
  } catch (e) {
    check(file + ' collectLinks', false, e.message);
    continue;
  }

  urls.forEach(function (u) { console.log('   ' + u); });

  check(file + ' found links', urls.length > 0, 'none');

  const spaced = urls.filter(function (u) { return /%20/.test(u); });
  if (/Talons and Treason/.test(html)) {
    check('spaces are percent-encoded', spaced.length >= 3, spaced.length + ' encoded URLs');
    check('no raw spaces left', !urls.some(function (u) { return / /.test(u); }));
    check('bookfunnel:// copies folded', !urls.some(function (u) { return /^bookfunnel:/i.test(u); }));
    const kinds = urls.map(function (u) { return sandbox.formatLabel(u); }).sort();
    check('EPUB, EPUB (Kindle) and EPUB (Kobo) all present',
      kinds.indexOf('EPUB') >= 0 && kinds.indexOf('EPUB (Kindle)') >= 0 && kinds.indexOf('EPUB (Kobo)') >= 0,
      kinds.join(', '));
  }

  // What the panel would actually call each row.
  const taken = {};
  const book = sandbox.parseDeliveryPage(html, { title: 'Fixture' });
  console.log('   title: ' + book.title + (book.author ? ' — ' + book.author : ''));
  book.items.forEach(function (item) {
    console.log('   row: ' + item.fileName + '  [' + item.sub + ']');
  });
  check(file + ' rows built', book.items.length === urls.length);
  check(file + ' row names look sane', book.items.every(function (i) { return i.fileName && !/^\s*$/.test(i.fileName); }));
}

// normalizeUrl specifics
const n = sandbox.normalizeUrl;
check('bookfunnel:// folded', n('bookfunnel://prfiles.bookfunnel.com/x/Title.epub') === 'https://prfiles.bookfunnel.com/x/Title.epub');
check('protocol-relative gets https', n('//prfiles.bookfunnel.com/x/a.epub') === 'https://prfiles.bookfunnel.com/x/a.epub');
check('spaces encoded', n('//prfiles.bookfunnel.com/x/Title - Author.epub') === 'https://prfiles.bookfunnel.com/x/Title%20-%20Author.epub');
check('amp entity fixed', n('https://bookfunnel.nyc3.digitaloceanspaces.com/x/a.epub?a=1&amp;b=2') === 'https://bookfunnel.nyc3.digitaloceanspaces.com/x/a.epub?a=1&b=2');
check('fragment dropped', n('https://bookfunnel.nyc3.digitaloceanspaces.com/x/a.epub#frag') === 'https://bookfunnel.nyc3.digitaloceanspaces.com/x/a.epub');

// fileNameFor naming rules
const t = {};
check('kepub renamed Kobo', sandbox.fileNameFor('https://prfiles.bookfunnel.com/x/a.kepub.epub', 'b', t) === 'a (Kobo).epub');
check('kindle renamed Kindle', sandbox.fileNameFor('https://prfiles.bookfunnel.com/x/kindle/a.epub', 'b', t) === 'a (Kindle).epub');
check('plain epub kept', sandbox.fileNameFor('https://prfiles.bookfunnel.com/x/Talons%20and%20Treason.epub', 'b', t) === 'Talons and Treason.epub');
check('download_media named after book', /^b\.zip$/.test(sandbox.fileNameFor('https://pr.bookfunnel.com/x/download_media', 'b', t)));

// regressions: names must keep their extension and stay unique
const long = 'L'.repeat(150);
const t2 = {};
const longEpub = sandbox.fileNameFor('https://prfiles.bookfunnel.com/x/' + long + '.epub', 'b', t2);
check('long title keeps .epub', /\.epub$/.test(longEpub) && longEpub.length <= 120);
const longKindle = sandbox.fileNameFor('https://prfiles.bookfunnel.com/x/kindle/' + long + '.epub', 'b', t2);
check('long Kindle keeps suffix', / \(Kindle\)\.epub$/.test(longKindle) && longKindle.length <= 120 && longKindle !== longEpub);
const longKobo = sandbox.fileNameFor('https://prfiles.bookfunnel.com/x/' + long + '.kepub.epub', 'b', t2);
check('long Kobo keeps suffix', / \(Kobo\)\.epub$/.test(longKobo) && longKobo.length <= 120);
const t3 = {};
const s1 = sandbox.fileNameFor('https://bookfunnel.nyc3.digitaloceanspaces.com/aaa/sample.mp3?x=1', 'Book One', t3);
const s2 = sandbox.fileNameFor('https://bookfunnel.nyc3.digitaloceanspaces.com/bbb/sample.mp3?x=1', 'Book Two', t3);
check('sample.mp3 named after its book', s1 === 'Book One (sample).mp3' && s2 === 'Book Two (sample).mp3');
check('uppercase extension kept', sandbox.fileNameFor('https://prfiles.bookfunnel.com/x/A.EPUB', 'b', {}) === 'A.EPUB');

// regressions found by review: each of these once hung, mis-named or invented a file
{
  const tk = {};
  const a = sandbox.fileNameFor('https://prfiles.bookfunnel.com/a/Title', 'F', tk);
  const b = sandbox.fileNameFor('https://prfiles.bookfunnel.com/b/Title', 'F', tk);
  check('duplicate name without extension terminates', a === 'Title' && b === 'Title (2)');
  const c1 = sandbox.fileNameFor('https://prfiles.bookfunnel.com/a/Book.epub', 'F', tk);
  const c2 = sandbox.fileNameFor('https://prfiles.bookfunnel.com/b/book.EPUB', 'F', tk);
  check('duplicate names differing only in case are kept apart', c1 !== c2.toLowerCase() || c1 !== c2);
}
check('double space survives', n('//prfiles.bookfunnel.com/abc123/A  B - X.epub') === 'https://prfiles.bookfunnel.com/abc123/A%20%20B%20-%20X.epub');
check('non-breaking space survives', n('//prfiles.bookfunnel.com/abc123/A\u00a0B.epub') === 'https://prfiles.bookfunnel.com/abc123/A%C2%A0B.epub');
check('# in a title is part of the name', n('//prfiles.bookfunnel.com/abc123/Title #1 - Author.epub') === 'https://prfiles.bookfunnel.com/abc123/Title%20%231%20-%20Author.epub');
check('? in a title is part of the name', n('//prfiles.bookfunnel.com/abc123/Who? - Author.epub') === 'https://prfiles.bookfunnel.com/abc123/Who%3F%20-%20Author.epub');
check('bare % is escaped', n('//prfiles.bookfunnel.com/abc123/100% Wolf.epub') === 'https://prfiles.bookfunnel.com/abc123/100%25%20Wolf.epub');
check('% name decodes back', sandbox.fileNameFor(n('//prfiles.bookfunnel.com/abc123/100% Wolf.epub'), 'b', {}) === '100% Wolf.epub');
check('? name keeps extension', sandbox.fileNameFor(n('//prfiles.bookfunnel.com/abc123/Who? - Author.epub'), 'b', {}) === 'Who- - Author.epub');
check('relative download_media resolved', n('/codeone/download_media') === 'https://pr.bookfunnel.com/codeone/download_media');
check('filename= query names the file', sandbox.fileNameFor('https://bookfunnel.nyc3.digitaloceanspaces.com/u/a.epub?filename=My%20Book.epub', 'b', {}) === 'My Book.epub');
{
  const emoji = '\u{1F600}'.repeat(100) + '.epub';
  const nm = sandbox.fileNameFor('https://prfiles.bookfunnel.com/x/' + encodeURIComponent(emoji), 'b', {});
  check('cut never splits an emoji', !/[\ud800-\udbff](?![\udc00-\udfff])/.test(nm) && /\.epub$/.test(nm));
}
check('chapter-style name has no trailing space', !/\s\.mp3$/.test(sandbox.safeName('a'.repeat(119) + ' b. c') + '.mp3'));
if (hasDom) {
  const links = (h) => sandbox.collectLinks(h).map((u) => decodeURIComponent(u));
  const one = (name, html, want) => {
    const got = links(html);
    check(name, got.length === 1 && got[0] === want, JSON.stringify(got));
  };
  one('unquoted attribute leaves no tail', '<a href=//prfiles.bookfunnel.com/abc123/A.epub class=btn>x</a>', 'https://prfiles.bookfunnel.com/abc123/A.epub');
  one('entity-encoded JSON leaves no tail', '<div data-files="[{&quot;u&quot;:&quot;//prfiles.bookfunnel.com/abc123/A.epub&quot;}]"></div>', 'https://prfiles.bookfunnel.com/abc123/A.epub');
  one('CSS url() leaves no tail', '<style>a{background:url(//prfiles.bookfunnel.com/abc123/A.epub)}</style>', 'https://prfiles.bookfunnel.com/abc123/A.epub');
  one('prose leaves no tail', '<p>Visit https://prfiles.bookfunnel.com/abc123/A.epub for it</p>', 'https://prfiles.bookfunnel.com/abc123/A.epub');
  one('apostrophe entity is one row', '<a href="//prfiles.bookfunnel.com/abc123/Don&#39;t Look - X.epub">d</a>', "https://prfiles.bookfunnel.com/abc123/Don't Look - X.epub");
  one('named entity is one row', '<a href="//prfiles.bookfunnel.com/abc123/Don&rsquo;t Look - X.epub">d</a>', 'https://prfiles.bookfunnel.com/abc123/Don\u2019t Look - X.epub');
  one('escaped-slash JSON link found', '<script>var f="https:\\/\\/bookfunnel.nyc3.digitaloceanspaces.com\\/u\\/Book.epub";</script>', 'https://bookfunnel.nyc3.digitaloceanspaces.com/u/Book.epub');
  const ap = sandbox.parseAudioPage('<title>Tom &amp; Jerry&#39;s Tale by A &amp; B</title><script>var MANIFEST = [{"title":"Part [1];x","duration":5},{"title":"Two","duration":6}];</script>', 'abc123');
  check('entities in the audio title are decoded', ap.title === "Tom & Jerry's Tale" && ap.author === 'A & B', ap.title + ' | ' + ap.author);
  check('MANIFEST with "];" inside a title parses', ap.items.length === 2 && ap.items[0].label === 'Part [1];x');
  const tt = sandbox.parseAudioPage('<title>Talons and Treason (After Dark by Amy Campbell</title><script>var MANIFEST = [{"title":"Chapter 1 (Part A","duration":5}];</script>', 'abc123');
  check('audio title with a lost bracket is closed', tt.title === 'Talons and Treason (After Dark)' && tt.author === 'Amy Campbell', tt.title + ' | ' + tt.author);
  check('chapter title with a lost bracket is closed', tt.items[0].label === 'Chapter 1 (Part A)' && /^01 - Chapter 1 \(Part A\)\.mp3$/.test(tt.items[0].fileName), tt.items[0].fileName);
  const dp = sandbox.parseDeliveryPage('<html><head><title>Download Scales and Steel (After Dark by Amy Campbell</title></head><body><a href="//prfiles.bookfunnel.com/abc123/x.epub">x</a></body></html>', {});
  check('delivery page title with a lost bracket is closed', dp.title === 'Scales and Steel (After Dark)', dp.title);
} else {
  console.log('skip  DOM-dependent regression checks (npm i jsdom to run them)');
}

// Titles that lose a closing bracket are closed again; nothing else is touched
{
  const bal = sandbox.balanceBrackets;
  const cases = [
    ['Talons and Treason (After Dark', 'Talons and Treason (After Dark)'],
    ['Talons and Treason (After Dark)', 'Talons and Treason (After Dark)'],
    ['A [B (C', 'A [B (C)]'],
    ['Plain Title', 'Plain Title'],
    ['Fine :(', 'Fine :('],
    ['Odd ) stray', 'Odd ) stray'],
    ['Mixed (a]', 'Mixed (a])'],
    ['', ''],
  ];
  cases.forEach(([input, want]) => check('balanceBrackets ' + JSON.stringify(input), bal(input) === want, JSON.stringify(bal(input))));
  check('balanceBrackets is idempotent', bal(bal('X (Y [Z')) === bal('X (Y [Z'));
}

console.log('\n' + (failures ? failures + ' check(s) failed' : 'all checks passed'));
process.exit(failures ? 1 : 0);
