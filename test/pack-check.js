#!/usr/bin/env node
/*
 * pack-check.js — prove the audiobook packer writes real, playable files.
 *
 * The userscript keeps its byte-level packer between the two ==pack: markers so
 * it can be lifted out without a browser. This test does exactly that, builds a
 * combined .mp3 and .m4b from three generated chapters, and checks the result
 * with ffprobe and a full decode. A mistake in the ID3 or MP4 writer fails here
 * instead of on someone's 10-hour audiobook.
 *
 *   node test/pack-check.js            keep the outputs in .tmp/pack-check
 *   node test/pack-check.js --clean    delete them afterwards
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'bookfunnel-downloader.user.js');
const OUT = path.join(__dirname, '..', '.tmp', 'pack-check');
const CLEAN = process.argv.includes('--clean');

const failures = [];
function ok(msg) { console.log('  ✓ ' + msg); }
function bad(msg) { failures.push(msg); console.log('  ✗ ' + msg); }

function check(name, cond, detail) {
  if (cond) ok(name);
  else bad(name + (detail ? ' — ' + detail : ''));
}

function run(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024
  }, opts || {}));
}

function ffprobe(file) {
  return JSON.parse(run('ffprobe', [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', '-show_chapters', file
  ]));
}

function close(a, b, tol) {
  return Math.abs(Number(a) - Number(b)) <= tol;
}

/* ------------------------------------------------------------------ *
 * lift the packer out of the userscript
 * ------------------------------------------------------------------ */

const src = fs.readFileSync(SRC, 'utf8');
const start = src.indexOf('/* ==pack:start== */');
const end = src.indexOf('/* ==pack:end== */');
if (start < 0 || end < 0) {
  console.error('pack markers not found in ' + SRC);
  process.exit(1);
}
const block = src.slice(start, end);
const pack = new Function(
  block + '\nreturn { buildId3Tag: buildId3Tag, mp3Audio: mp3Audio, muxM4b: muxM4b, muxMp3: muxMp3, mp3Walk: mp3Walk, zipStore: zipStore, crc32: crc32, zipRead: zipRead, chapterMarks: chapterMarks };'
)();
console.log('packer lifted from the userscript (' + block.split('\n').length + ' lines)\n');

/* ------------------------------------------------------------------ *
 * generate three chapters and a cover with ffmpeg
 * ------------------------------------------------------------------ */

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-'));

// 1.2 s, 1.7 s and 0.9 s of distinct tones, CBR 44.1 kHz mono, tagged, so the
// packer's ID3v2 stripping is actually exercised.
const CHAPTERS = [
  { title: 'Opening Credits', seconds: 1.2, freq: 440 },
  { title: 'The Long Road', seconds: 1.7, freq: 660 },
  { title: 'Last Light', seconds: 0.9, freq: 880 }
];

const chapterFiles = CHAPTERS.map(function (c, i) {
  const file = path.join(TMP, 'chapter' + (i + 1) + '.mp3');
  run('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=' + c.freq + ':duration=' + c.seconds,
    '-ac', '1', '-ar', '44100', '-b:a', '64k',
    '-write_id3v2', '1', '-id3v2_version', '3',
    '-metadata', 'title=' + c.title,
    '-metadata', 'artist=Test Author',
    file
  ]);
  return file;
});

const coverFile = path.join(TMP, 'cover.jpg');
run('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'color=c=0x2f6f63:s=300x300',
  '-frames:v', '1', coverFile
]);

const chapterBytes = chapterFiles.map(function (f) { return new Uint8Array(fs.readFileSync(f)); });
const coverBytes = new Uint8Array(fs.readFileSync(coverFile));

// The chapter table the app would build from BookFunnel's durations.
const durations = chapterFiles.map(function (f) {
  const p = ffprobe(f);
  return Math.round(Number(p.format.duration) * 1000);
});
let at = 0;
const chapters = CHAPTERS.map(function (c, i) {
  const entry = { title: c.title, startMs: at, endMs: at + durations[i] };
  at += durations[i];
  return entry;
});
const totalMs = at;
console.log('chapters: ' + durations.map(function (d) { return (d / 1000).toFixed(2) + 's'; }).join(', ') +
  ' (total ' + (totalMs / 1000).toFixed(2) + 's)\n');

const meta = {
  title: 'Test Book',
  artist: 'Test Author',
  album: 'Test Book',
  comment: CHAPTERS.length + ' chapters',
  cover: coverBytes,
  chapters: chapters
};

/* ------------------------------------------------------------------ *
 * combined .mp3 — one ID3v2.3 tag with CHAP/CTOC, then the frames
 * ------------------------------------------------------------------ */

console.log('combined .mp3');
const mp3File = path.join(OUT, 'Test Book - Test Author.mp3');
const mp3Parts = pack.muxMp3(chapterBytes.map(pack.mp3Audio), meta);
fs.writeFileSync(mp3File, Buffer.concat(mp3Parts.map(function (b) { return Buffer.from(b); })));

const mp3Info = ffprobe(mp3File);
const mp3Duration = Number(mp3Info.format.duration);
const mp3Tags = mp3Info.format.tags || {};
const mp3Chapters = mp3Info.chapters || [];
const mp3Streams = mp3Info.streams || [];

check('plays as MP3', /mp3/.test(mp3Info.format.format_name || ''), mp3Info.format.format_name);
check('title tag', mp3Tags.title === 'Test Book', JSON.stringify(mp3Tags.title));
check('artist tag', mp3Tags.artist === 'Test Author', JSON.stringify(mp3Tags.artist));
check('album tag', (mp3Tags.album || '') === 'Test Book', JSON.stringify(mp3Tags.album));
check('three chapter marks', mp3Chapters.length === 3, String(mp3Chapters.length));
check('chapter titles', mp3Chapters.map(function (c) { return c.tags && c.tags.title; }).join('|') ===
  CHAPTERS.map(function (c) { return c.title; }).join('|'),
  JSON.stringify(mp3Chapters.map(function (c) { return c.tags && c.tags.title; })));
check('duration ' + mp3Duration.toFixed(2) + 's matches the source',
  close(mp3Duration * 1000, totalMs, 250), mp3Duration + ' vs ' + totalMs / 1000);
check('cover art attached', mp3Streams.some(function (s) {
  return s.codec_type === 'video' && (s.disposition || {}).attached_pic === 1;
}));
check('only the audio + cover streams', mp3Streams.length === 2, String(mp3Streams.length));

// Full decode catches a broken frame chain that metadata alone hides.
try {
  run('ffmpeg', ['-v', 'error', '-i', mp3File, '-f', 'null', '-']);
  ok('decodes end to end without errors');
} catch (err) {
  bad('decode failed: ' + String(err.stderr || err.message).split('\n').slice(-3).join(' '));
}

// Chapter marks should line up with the real audio, not just exist.
if (mp3Chapters.length === 3) {
  let cursor = 0;
  const drift = mp3Chapters.map(function (c, i) {
    const start = Number(c.start_time) * 1000;
    const d = Math.abs(start - cursor);
    cursor += durations[i];
    return d;
  });
  check('chapter marks line up (max drift ' + Math.round(Math.max.apply(null, drift)) + ' ms)',
    Math.max.apply(null, drift) <= 200);
}

/* ------------------------------------------------------------------ *
 * .m4b — MP3 frames muxed into MP4 with chpl and iTunes metadata
 * ------------------------------------------------------------------ */

console.log('\n.m4b');
const m4bFile = path.join(OUT, 'Test Book - Test Author.m4b');
const m4bParts = pack.muxM4b(chapterBytes, meta);
fs.writeFileSync(m4bFile, Buffer.concat(m4bParts.map(function (b) { return Buffer.from(b); })));

const m4bInfo = ffprobe(m4bFile);
const m4bDuration = Number(m4bInfo.format.duration);
const m4bTags = m4bInfo.format.tags || {};
const m4bChapters = m4bInfo.chapters || [];
const m4bAudio = (m4bInfo.streams || []).filter(function (s) { return s.codec_type === 'audio'; })[0] || {};

check('reads as MP4', /mp4|mov/.test(m4bInfo.format.format_name || ''), m4bInfo.format.format_name);
check('audio codec is mp3', m4bAudio.codec_name === 'mp3', String(m4bAudio.codec_name));
check('title tag', m4bTags.title === 'Test Book', JSON.stringify(m4bTags.title));
check('artist tag', m4bTags.artist === 'Test Author', JSON.stringify(m4bTags.artist));
check('three chapter marks', m4bChapters.length === 3, String(m4bChapters.length));
check('chapter titles', m4bChapters.map(function (c) { return c.tags && c.tags.title; }).join('|') ===
  CHAPTERS.map(function (c) { return c.title; }).join('|'),
  JSON.stringify(m4bChapters.map(function (c) { return c.tags && c.tags.title; })));
check('duration ' + m4bDuration.toFixed(2) + 's matches the source',
  close(m4bDuration * 1000, totalMs, 250), m4bDuration + ' vs ' + totalMs / 1000);
check('cover art attached', (m4bInfo.streams || []).some(function (s) {
  return s.codec_type === 'video' && (s.disposition || {}).attached_pic === 1;
}));

try {
  run('ffmpeg', ['-v', 'error', '-i', m4bFile, '-f', 'null', '-']);
  ok('decodes end to end without errors');
} catch (err) {
  bad('decode failed: ' + String(err.stderr || err.message).split('\n').slice(-3).join(' '));
}

if (m4bChapters.length === 3) {
  let cursor = 0;
  const drift = m4bChapters.map(function (c, i) {
    const start = Number(c.start_time) * 1000;
    const d = Math.abs(start - cursor);
    cursor += durations[i];
    return d;
  });
  check('chapter marks line up (max drift ' + Math.round(Math.max.apply(null, drift)) + ' ms)',
    Math.max.apply(null, drift) <= 200);
}

/* ------------------------------------------------------------------ *
 * the cover as an ArrayBuffer
 *
 * GM_xmlhttpRequest hands the userscript an ArrayBuffer, and an ArrayBuffer
 * has no .length — so a guard written as `meta.cover.length` silently drops
 * the artwork. These checks pin the conversion that keeps the cover in the
 * file no matter which of the two shapes arrives.
 * ------------------------------------------------------------------ */

console.log('\ncover as ArrayBuffer');
const abMeta = Object.assign({}, meta, { cover: coverBytes.buffer.slice(0) });
check('the fixture really is an ArrayBuffer',
  abMeta.cover instanceof ArrayBuffer && abMeta.cover.length === undefined);

const abMp3File = path.join(OUT, 'ArrayBuffer cover.mp3');
const abMp3Parts = pack.muxMp3(chapterBytes.map(pack.mp3Audio), abMeta);
fs.writeFileSync(abMp3File, Buffer.concat(abMp3Parts.map(function (b) { return Buffer.from(b); })));

const abMp3Info = ffprobe(abMp3File);
check('mp3 keeps its cover art', (abMp3Info.streams || []).some(function (s) {
  return s.codec_type === 'video' && (s.disposition || {}).attached_pic === 1;
}), JSON.stringify((abMp3Info.streams || []).map(function (s) { return s.codec_type; })));
check('mp3 keeps its title', (abMp3Info.format.tags || {}).title === 'Test Book');
check('mp3 keeps its chapter marks', (abMp3Info.chapters || []).length === 3);

const abM4bFile = path.join(OUT, 'ArrayBuffer cover.m4b');
const abM4bParts = pack.muxM4b(chapterBytes, abMeta);
fs.writeFileSync(abM4bFile, Buffer.concat(abM4bParts.map(function (b) { return Buffer.from(b); })));

const abM4bInfo = ffprobe(abM4bFile);
check('m4b keeps its cover art', (abM4bInfo.streams || []).some(function (s) {
  return s.codec_type === 'video' && (s.disposition || {}).attached_pic === 1;
}), JSON.stringify((abM4bInfo.streams || []).map(function (s) { return s.codec_type; })));
check('m4b keeps its title', (abM4bInfo.format.tags || {}).title === 'Test Book');
check('m4b keeps its chapter marks', (abM4bInfo.chapters || []).length === 3);

const { spawnSync } = require('child_process');
function sh(c, a) { return spawnSync(c, a, { encoding: 'utf8' }); }

/* ------------------------------------------------------------------ *
 * .zip for several ebook files
 * ------------------------------------------------------------------ */
{
  const zlib = require('zlib');
  const crypto = require('crypto');
  const names = ['Tidal Stars - E.M. Rensing.epub', 'Tidal Stars - E.M. Rensing (Kindle).epub', 'Tïdal ★ 日本語.pdf', 'Tidal Stars - E.M. Rensing.jpg', 'empty-ish.bin'];
  const datas = [crypto.randomBytes(300000), crypto.randomBytes(5), crypto.randomBytes(70000), Buffer.alloc(0), Buffer.from('x')];
  check('crc32 matches zlib', pack.crc32(datas[0]) === zlib.crc32(datas[0]));
  const parts = pack.zipStore(names.map((n, i) => ({ name: n, data: new Uint8Array(datas[i]) })));
  const zipPath = path.join(TMP, 'bundle.zip');
  fs.writeFileSync(zipPath, Buffer.concat(parts.map((x) => Buffer.from(x))));
  const t = sh('unzip', ['-t', zipPath]);
  check('unzip -t accepts the .zip', t.status === 0 && /No errors/.test(t.stdout), t.stdout + t.stderr);
  const outDir = path.join(TMP, 'unz');
  fs.mkdirSync(outDir, { recursive: true });
  // Info-ZIP's unzip on macOS mangles UTF-8 names and gives up on the rest, so
  // the round trip is read back with Python's reader, which honours the flag
  const ex = sh('python3', ['-c', 'import zipfile,sys;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zipPath, outDir]);
  check('python extracts every entry', ex.status === 0, ex.stderr);
  names.forEach((n, i) => {
    const f = path.join(outDir, n);
    check('zip entry round-trips: ' + n, fs.existsSync(f) && Buffer.compare(fs.readFileSync(f), datas[i]) === 0);
  });
  const py = sh('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(len(z.namelist()))', zipPath]);
  check('python zipfile agrees', py.stdout.trim() === 'None\n' + names.length, py.stdout + py.stderr);
  const empty = pack.zipStore([]);
  check('empty zip is just the end record', Buffer.concat(empty.map((x) => Buffer.from(x))).length === 22);
}


/* ------------------------------------------------------------------ *
 * reading a .zip back, and chapter marks
 * ------------------------------------------------------------------ */
{
  const zlib = require('zlib');
  const crypto = require('crypto');
  const names = ['001 Ann - Book - Opening Credits.mp3', '002 Ann - Book - Chapter 1.mp3', 'Tïtle ★.bin', 'empty.bin'];
  const datas = [crypto.randomBytes(5000), crypto.randomBytes(777), Buffer.from('héllo'), Buffer.alloc(0)];
  const rt = pack.zipRead(Buffer.concat(pack.zipStore(names.map((n, i) => ({ name: n, data: new Uint8Array(datas[i]) }))).map((x) => Buffer.from(x))));
  check('zipRead reads back our own zip', rt.length === 4 && rt.every((e, i) => e.name === names[i] && e.method === 0 && Buffer.compare(Buffer.from(e.data), datas[i]) === 0), JSON.stringify(rt.map((e) => e.name)));

  for (const mode of ['ZIP_STORED', 'ZIP_DEFLATED']) {
    const zp = path.join(TMP, mode + '.zip');
    const py = sh('python3', ['-c', 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w",getattr(zipfile,sys.argv[2]))\nz.writestr("a/one.txt","hello "*500)\nz.writestr("b.txt","x"*2000)\nz.close()', zp, mode]);
    check('python made a ' + mode + ' zip', py.status === 0, py.stderr);
    const got = pack.zipRead(fs.readFileSync(zp));
    const want = ['hello '.repeat(500), 'x'.repeat(2000)];
    const ok = got.length === 2 && got.every((e, i) => {
      const raw = Buffer.from(e.data);
      const text = (e.method === 8 ? zlib.inflateRawSync(raw) : raw).toString();
      return text === want[i] && e.size === want[i].length;
    });
    check('zipRead handles ' + mode + ' (method ' + (got[0] && got[0].method) + ')', ok);
    check(mode + ' names read right', got[0].name === 'a/one.txt' && got[1].name === 'b.txt', got.map((e) => e.name).join());
  }
  const throwsOn = (label, bytes) => { let t = false; try { pack.zipRead(bytes); } catch (e) { t = true; } check('zipRead rejects ' + label, t); };
  throwsOn('garbage', Buffer.from('this is not a zip file at all, just text'));
  throwsOn('an empty buffer', new Uint8Array(0));
  const good = Buffer.concat(pack.zipStore([{ name: 'a.bin', data: new Uint8Array(crypto.randomBytes(500)) }]).map((x) => Buffer.from(x)));
  throwsOn('a cut-off zip', good.subarray(0, good.length - 40));

  const stripped = chapterBytes.map(pack.mp3Audio);
  const marks = pack.chapterMarks(stripped, ['One', 'Two', 'Three'], []);
  const contiguous = marks.chapters.every((c, i) => c.endMs > c.startMs && (i === 0 ? c.startMs === 0 : c.startMs === marks.chapters[i - 1].endMs));
  check('chapterMarks: three contiguous marks, no fallback', marks.chapters.length === 3 && contiguous && !marks.fallback, JSON.stringify(marks));
  const fb = pack.chapterMarks([new Uint8Array(0)], ['x'], [7]);
  check('chapterMarks falls back to the listed duration', fb.fallback && fb.chapters[0].endMs === 7000, JSON.stringify(fb));
}

/* deflated entries in the zip writer (an EPUB inside a zip must be compressed) */
{
  const zlib = require('zlib');
  const crypto = require('crypto');
  const epubLike = Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('mimetype'.repeat(5000)), crypto.randomBytes(2000)]);
  const pdfLike = crypto.randomBytes(50000);
  const raw = zlib.deflateRawSync(epubLike);
  const parts = pack.zipStore([
    { name: 'Book - A.epub', raw: new Uint8Array(raw), size: epubLike.length, crc: pack.crc32(new Uint8Array(epubLike)) },
    { name: 'Book - A.pdf', data: new Uint8Array(pdfLike) }
  ]);
  const zp = path.join(TMP, 'mixed-method.zip');
  fs.writeFileSync(zp, Buffer.concat(parts.map((x) => Buffer.from(x))));
  const t = sh('unzip', ['-t', zp]);
  check('mixed deflated + stored zip passes unzip -t', t.status === 0 && /No errors/.test(t.stdout), t.stdout + t.stderr);
  const py = sh('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print([i.compress_type for i in z.infolist()]);print(len(z.read("Book - A.epub")))', zp]);
  check('python: epub entry deflated (8), pdf stored (0), sizes right', py.stdout.trim() === 'None\n[8, 0]\n' + epubLike.length, py.stdout + py.stderr);
  const rd = pack.zipRead(Buffer.concat(parts.map((x) => Buffer.from(x))));
  check('zipRead sees both methods and the real size', rd[0].method === 8 && rd[0].size === epubLike.length && rd[1].method === 0);
  check('inflating the deflated entry gives the original bytes', Buffer.compare(zlib.inflateRawSync(Buffer.from(rd[0].data)), epubLike) === 0);
}

/* ------------------------------------------------------------------ */

console.log('\noutputs in ' + OUT);
console.log('  ' + path.basename(mp3File) + '  ' + (fs.statSync(mp3File).size / 1024).toFixed(1) + ' KB');
console.log('  ' + path.basename(m4bFile) + '  ' + (fs.statSync(m4bFile).size / 1024).toFixed(1) + ' KB');

fs.rmSync(TMP, { recursive: true, force: true });

if (failures.length) {
  console.error('\n' + failures.length + ' check(s) failed.');
  process.exit(1);
}
console.log('\nall checks passed.');
if (CLEAN) fs.rmSync(OUT, { recursive: true, force: true });
