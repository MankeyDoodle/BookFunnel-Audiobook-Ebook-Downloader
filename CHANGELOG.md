# Changelog

All notable changes are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.3] - 2026-10-30

### Changed
- The library key and its buttons use plainer wording: **Open app-only books**
  (was "Open Blocked"), "app-only" and "with a Download button" (was "need this
  tool" and "download normally"). Internal names and a code comment were
  reworded to match. No change in behaviour.
- The on-page screenshots in the documentation were taken with 1.0.2 and still
  show the earlier labels.

## [1.0.2] - 2026-10-30

### Changed
- Clearer wording everywhere about what the tool is and is not: a personal-use,
  accessibility-minded tool for people with their own BookFunnel account; not a
  hack or exploit; nothing is decrypted and no login, payment or access check is
  bypassed; no sharing. Added a plain disclaimer and a note for authors,
  publishers and BookFunnel on how to raise a concern.
- The "How it works" section now describes the player's own requests without
  characterising the site's settings.
- The one-line description says "personal-use tool for your own BookFunnel
  account". No change in behaviour.

## [1.0.1] - 2026-10-30

### Changed
- The one-line description now says what the script does for the reader, and
  describes red library borders as books with no Download button. No change in
  behaviour.
- The Greasy Fork page address is now
  <https://greasyfork.org/en/scripts/602959-bookfunnel-audiobook-ebook-downloader>.

## [1.0.0] - 2026-10-30

First public release.

### Added
- **Audiobooks** from BookFunnel's player page: one combined `.mp3` or `.m4b`
  with chapter marks, title/author/cover tags and a correct length, or every
  chapter as a titled, tagged MP3 in one `.zip` folder. No re-encoding.
- **Ebooks, PDFs and archives** from the delivery pages and the cloud reader:
  EPUB, Kindle EPUB, Kobo EPUB, PDF and ZIP, with a tick box beside each file.
  Several ticked files are saved together in one `.zip`.
- **Library page highlighting**: red border for books BookFunnel offers
  only inside its own app (no Download button), green for books that download
  normally,
  with a key, an **Open Blocked** button, and **Download all ebooks** /
  **Download all audiobooks** buttons (one `.m4b` per audiobook).
- Stop and **Retry failed** buttons, per-file progress, honest error messages.
- A Python pipeline (`download.py`) for building tagged `.m4b` files outside the
  browser.
- Test suites for the HTML parser and for the byte-level MP3 / M4B / ZIP
  writers, checked against `ffprobe`, `ffmpeg`, `unzip` and Python's `zipfile`.
