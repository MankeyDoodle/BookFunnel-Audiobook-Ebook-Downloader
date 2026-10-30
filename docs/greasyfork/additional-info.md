![BookFunnel Audiobook + Ebook Downloader](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/assets/banner.png)

**Source code, issues and release notes: [https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader)**

I paid for these books and wanted to read and listen to them in the apps I actually
like. This script saves what you have bought on BookFunnel as ordinary files you
keep, from your own logged-in session. No terminal, no re-encoding.

### What it does

- **Audiobooks:** one chaptered **`.m4b`** (or `.mp3`) per book, with chapter marks,
  title and author tags and the cover, ready for the player you prefer. Or every
  chapter as a titled MP3 in a `.zip` folder.
- **Ebooks:** EPUB, Kindle EPUB, Kobo EPUB and PDF, with a tick box beside each
  file. Several ticked files are saved together in one `.zip`.
- **Your library at a glance:** a **green** border on books with a normal download
  and a **red** border on books BookFunnel offers only inside its own app (no
  Download button). A key counts both.
- **Bulk buttons** in that key: **Download all ebooks**, **Download all audiobooks**
  (one `.m4b` per book) and **Open Blocked**, which opens the red books. The bulk
  buttons ask for a second click before they start.
- **Stop** and **Retry failed**, per-file progress and plain error messages.

### Screenshots

Titles, authors and covers are blurred or replaced.

![Your library, with red and green borders](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/library.jpg)

![An audiobook saved as one .m4b](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/locked-audiobook-done.jpg)

![Ebook panel with tick boxes](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/ebook-panel.jpg)

![Bulk ebook download finished](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/bulk-ebooks-done.jpg)

![Bulk audiobook download finished](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/bulk-audiobooks-done.jpg)

### How to use

1. Install a userscript manager. I develop and test with **Tampermonkey** in
   Chrome; other managers are untested.
2. Install this script.
3. Open <https://my.bookfunnel.com>. Your books get green and red borders.
4. Open any book: a **Download** pill appears in the corner and opens the panel.

Step-by-step directions with a screenshot for each step are in the
[README](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader#how-to-use).

### Good to know

- You need your own BookFunnel account and books you have access to. It does not
  bypass payment, and it reads only what the page already loads for you.
- The script talks only to BookFunnel's own hosts and its storage hosts (the
  `@connect` lines in the header).
- It is for keeping and playing what you bought. Please respect authors.
- A book with no Download button is the author's or publisher's choice. If you
  would like one, it is worth asking them or BookFunnel support to enable
  downloads; some authors do not realise readers want them.
- Found a bug? Open an issue on
  [GitHub](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/issues).
  Please do not paste cookies, signed links or your email.
