// collect.js — build a track manifest for BookFunnel audiobooks you own.
//
// HOW TO USE
//   1. Sign in at https://my.bookfunnel.com/
//   2. Open one of your audiobooks: https://play.bookfunnel.com/<BOOK_ID>
//   3. Open the browser console (Safari: Develop > Show JavaScript Console).
//      In Chrome you may need to type "allow pasting" first.
//   4. Edit IDS below to your book IDs, paste this whole file, press Enter.
//   5. The manifest is copied to your clipboard AND printed. Save it as tracks.tsv
//   6. Run: python3 download.py tracks.tsv
//
// The page already holds everything needed: a MANIFEST array of chapters, and a
// /<id>/next?chapter=N endpoint that returns a presigned MP3 URL per chapter.
// Nothing here is decryption. It just reads the player's own data.

(async () => {
  // Put every book ID you want, e.g. ['g192apldg8', '97ukw818pb']
  const IDS = ['g192apldg8', '97ukw818pb'];

  const clean = (s) => String(s).replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();

  async function grabBook(id) {
    const html = await fetch('/' + id).then((r) => {
      if (!r.ok) throw new Error(id + ': HTTP ' + r.status + ' (not signed in?)');
      return r.text();
    });

    const m = html.match(/MANIFEST = (\[[\s\S]*?\]);/);
    if (!m) throw new Error(id + ': no MANIFEST on page — is this an audiobook?');
    const manifest = JSON.parse(m[1]);

    const pageTitle = (html.match(/<title>([^<]*)/) || [])[1] || id;
    const coverHits = [...new Set(
      html.match(/bookfunnelimages\.com\/images\/covers\/[^"'\s)\\]+\/cover_lg\.jpg/g) || []
    )];
    const cover = coverHits.length ? 'https://' + coverHits[0] : '';

    const lines = [id + '\t' + clean(pageTitle) + '\t' + cover];

    for (let c = 1; c <= manifest.length; c++) {
      const j = JSON.parse(await fetch('/' + id + '/next?chapter=' + c).then((r) => r.text()));
      if (!j || j.status !== 'OK' || !j.url) {
        throw new Error(id + ': chapter ' + c + ' returned no URL');
      }
      const u = new URL(j.url);
      const dir = u.origin + u.pathname.replace(/[^/]+$/, '');
      const file = u.pathname.split('/').pop() + u.search;
      const entry = manifest[c - 1];
      lines.push([c, entry.duration, clean(entry.title), dir, file].join('\t'));
    }

    return lines.join('\n');
  }

  const out = [];
  for (const id of IDS) out.push(await grabBook(id));
  const tsv = out.join('\n');

  if (typeof copy === 'function') { copy(tsv); console.log('Manifest copied to clipboard.'); }
  console.log('Books:', IDS.length, '| chars:', tsv.length);
  return tsv;
})();
