# BUILD-AN-APP.md — turning this into an app

A portable spec for wrapping the extractor in a real application. It documents
the API contract, the data model, the state machine and the failure cases, so it
maps onto whatever you're building with.

> **One open question:** your message said "my hobwork app" — I couldn't tell
> whether that's a typo for *Homebrew* (macOS package manager), *homework*, or
> the name of an app you're building. This file is deliberately
> framework-agnostic so it's useful either way. Tell me which, and I'll add the
> concrete code (SwiftUI / React Native / Electron / a Homebrew formula / CLI).

---

## 1. The problem to solve

A GUI needs four things the shell script gets for free:

| Need | Shell version | App version |
|---|---|---|
| Authenticated requests | you're already logged in in the browser | must obtain and persist a session |
| Manifest | you paste it in | must fetch and parse it |
| Progress | stdout lines | streaming progress + cancel |
| Resume | filesystem check | same, plus a persisted job record |

**The session is the hard part.** `play.bookfunnel.com` gates every request
behind a login cookie. Options, best first:

1. **Embedded web view for login only.** Show the real login page, let the user
   sign in normally, then read the resulting cookies from the web view's store
   and use them for API calls. No password ever touches your code — which also
   keeps you clear of credential-handling obligations.
2. **Manual cookie import.** Ask the user to copy the `Cookie` header from
   DevTools. Ugly, but zero risk and fine for a personal tool.
3. **Native login form.** Requires reverse-engineering the login POST and
   handling 2FA and captchas. Fragile — avoid.

---

## 2. API contract

All calls need the session cookie. Base: `https://play.bookfunnel.com`

### 2.1 Book metadata

```
GET /{book_id}
```

HTML, not JSON. Two things are needed from it:

```js
// chapter list
MANIFEST = [{"title": "Chapter 1", "duration": 2042, "start": 202}, ...]

// cover url (also in the html as a plain string)
bookfunnelimages.com/images/covers/{coverHash}/cover_lg.jpg
```

Parse with a regex on `MANIFEST = (\[[\s\S]*?\]);` then `JSON.parse`. Do **not**
parse the DOM — the markup changes; the embedded JS payload is stable.

Derive:
- `title`, `author` from `<title>`, which reads `Title (Series) by Author`
  — split on the *last* `" by "`.

### 2.2 Track URL

```
GET /{book_id}/next?chapter=N     // N is 1-based
→ {"status":"OK","message":"","url":"https://bookfunnel.nyc3.digitaloceanspaces.com/{hash}/0001.mp3?AWSAccessKeyId=…&Expires=…&Signature=…"}
```

Two things that will bite you:

- **It never 404s.** Ask for chapter 9999 and you get a well-formed URL for a
  file that doesn't exist. The `MANIFEST` length is the only reliable bound —
  never loop until failure.
- **One URL per track.** The signature is per-file, so URLs can't be derived or
  shared. Request every chapter.

The MP3s themselves need no cookie — the signature is the authorization. Fetch
them with a plain HTTP client.

---

## 3. Data model

```ts
type Track = {
  index: number          // 1-based, matches manifest order
  title: string          // "Chapter 1", "Opening Credits"
  durationSec: number    // from manifest, used for verification
  url: string            // presigned, expires
  state: 'pending' | 'downloading' | 'done' | 'failed'
  bytesWritten: number
  error?: string
}

type Book = {
  id: string
  title: string
  author: string
  coverUrl: string
  tracks: Track[]
}

type Job = {              // persist this; it's the resume record
  books: Book[]
  outputDir: string
  createdAt: string
  manifestExpiresAt: number   // min(Expires) across all track URLs
}
```

`manifestExpiresAt` is what makes the app feel competent: if URLs have expired
mid-job, say so up front instead of failing on track 41 of 68.

---

## 4. State machine

```
idle
 └─ signIn ────────→ authenticated
     └─ addBooks ──→ resolving ──→ ready
                        │            └─ starting ─→ downloading ─┬→ paused
                        └─ error                          │      └→ cancelled
                                                          └→ verifying → done
                                                              └─ repair ─┘
```

States worth modelling explicitly:

- **`verifying`** — compare actual duration to manifest duration, ±3 s. Surface
  mismatches as *warnings*, not errors: a re-encode may shift a frame.
- **`paused`** — must be resumable, because audiobooks are multi-GB.
- **`repair`** — re-download only tracks in `failed` state.

---

## 5. Concurrency

Use **2–3 parallel downloads**. You're pulling from a CDN with small files
(mostly 5–18 MB); one connection underuses it, and more than ~4 gains nothing
while making progress reporting jumpy and cancel slower.

Per track:
1. Stream to `name.mp3.part`
2. On success, size-check, then atomic rename to `name.mp3`
3. Verify duration, then tag

Never tag a partially-written file, and never leave `.part` files behind on
cancel — sweep them on next start.

---

## 6. Tagging

Shelling out to `ffmpeg` is the pragmatic choice — it's a stream copy, so it
costs ~50 ms per file and no quality loss:

```
ffmpeg -i in.mp3 -i cover.jpg -map 0:a -map 1:v -c copy -id3v2_version 3
       -metadata title=… -metadata album=… -metadata artist=…
       -metadata album_artist=… -metadata track=N/T
       -metadata genre=Audiobook out.mp3
```

Notes:
- Downscale the cover before embedding (600×600, ~q4). The source art is
  1000×1000 and ~1.8 MB; embedding it 68 times wastes ~120 MB and slows Plex
  thumbnail generation.
- Also write `cover.jpg` into the folder — folder art is what most players show.
- If you'd rather avoid the subprocess, a pure ID3v2.3 writer is ~200 lines and
  gives you finer control, but `ffmpeg` gets you shipped first.

---

## 6a. Single-file (.m4b) output

`download.py --single` collapses a book into one chaptered M4B. If you build this
into an app, offer both modes — they suit different players.

Pipeline:

1. Concatenate the chapter MP3s with the ffmpeg **concat demuxer**, writing
   **absolute** paths into the list file. The demuxer resolves relative paths
   against the list file, not the working directory — this is the single most
   common bug in this pipeline and it fails with a confusing "No such file".
2. Emit an `FFMETADATA1` file with one `[CHAPTER]` block per track,
   `TIMEBASE=1/1000`, and cumulative `START`/`END` in **milliseconds** computed
   from *probed* durations, not the manifest's — they can differ slightly.
3. Mux to `.m4b`:

```
ffmpeg -f concat -safe 0 -i list.txt -i cover.jpg -f ffmetadata -i meta.txt \
  -map 0:a -map 1:v -map_metadata 2 \
  -c:a aac -b:a 96k -ac 1 -c:v mjpeg -disposition:v attached_pic \
  -movflags +faststart out.m4b
```

Notes that will save you a day:

- **MP4 cannot carry MP3 audio.** Any M4B means re-encoding. Do not re-encode at
  a bitrate *below* the source, or artifacts stack audibly. Read the source
  bitrate first (`ffprobe -select_streams a:0 -show_entries stream=bit_rate`)
  and encode at or above it.
- Escape `=`, `;`, `#`, `\` and newlines in every ffmetadata value, or the file
  silently misparses — chapter titles with an `=` will otherwise truncate.
- `-movflags +faststart` matters for streaming; without it the moov atom sits at
  the end of a 300 MB file.
- **Verify before deleting anything.** Check `ffprobe -show_chapters` returns the
  expected count and that total duration matches. An app that deletes chapter
  MP3s after a failed build has destroyed the user's download.
- Chapter marks are a separate track in the MP4. Most players read them; Plex
  does not — it shows one very long item. Say so in your UI rather than letting
  users think chapters were lost.

---

## 7. Failure cases to handle

| Case | Detection | Behaviour |
|---|---|---|
| Session expired | `302` to `/login`, or HTML lacks `MANIFEST` | prompt re-auth, keep job |
| URLs expired | `403` from the CDN | offer "refresh manifest" — re-hits `/next` only |
| Track 403 mid-job | `403` on one file | refresh that one URL, retry once |
| Truncated file | size < expected, or duration mismatch | mark failed, offer repair |
| Disk full | `ENOSPC` | pause job, show required space |
| Cancel | user | delete `.part` files, keep finished tracks |
| Offline | network error | `paused`, auto-retry with backoff |

---

## 8. UI, minimum viable

Three screens beat a settings panel:

1. **Library** — sign in, list books from `my.bookfunnel.com`, checkbox each.
2. **Job** — per-book progress, per-track rows, overall ETA, pause/cancel.
3. **Done** — "68 tracks, 733 MB, 24.6 h — open in Finder", plus any warnings.

Show ETA from *bytes*, not track count: tracks vary from 428 seconds to 41
minutes, so a track-count ETA is wildly wrong.

---

## 9. If "hobwork" meant Homebrew

A personal formula is straightforward — wrap `download.py` in a tap:

```ruby
class BookfunnelExtract < Formula
  desc "Download audiobooks you own from BookFunnel as tagged MP3s"
  homepage "https://example.local/bookfunnel-extract"
  url "https://example.local/bookfunnel-extract-1.0.0.tar.gz"
  sha256 "…"
  license "MIT"
  depends_on "python@3.12"
  depends_on "ffmpeg"

  def install
    libexec.install "download.py", "collect.js"
    (bin/"bookfunnel-extract").write <<~SH
      #!/bin/bash
      exec "#{Formula["python@3.12"].opt_bin}/python3" "#{libexec}/download.py" "$@"
    SH
  end

  test do
    system "#{bin}/bookfunnel-extract", "--help"
  end
end
```

Test with `brew install --build-from-source ./bookfunnel-extract.rb`, then
`brew audit --new-formula bookfunnel-extract`.

Homebrew won't distribute it in core/`homebrew-cask` — scraping a login-gated
site is exactly what their rules exclude. A personal tap is fine.

---

## 10. Things not to build

- **Don't ship the cookies or signed URLs to a server.** Downloads should go
  direct from the CDN to the user's disk. There is no backend in this design.
- **Don't add a "download all my books" mass-scraper.** Rate-limit and go
  library-by-library; it keeps the tool defensible as a personal-use utility.
- **Don't hardcode a manifest.** URLs expire; always resolve fresh.

---

## 11. Legal / ToS reality check

Personal-use copying of content you bought is generally fine. What gets tools
in trouble, and what you should avoid in an app:

- redistributing files or working links,
- a public service that extracts on behalf of anonymous users,
- circumventing an actual technical protection measure (there isn't one here —
  this is an access-control convenience, not DRM).

Keep it local, keep it to the user's own account, and state that clearly in the
app's UI. That's the line the script in this folder sits on, and it's a
defensible one.
