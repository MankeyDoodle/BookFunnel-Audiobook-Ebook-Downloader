# Greasy Fork page text

Two things to paste into the script's page on Greasy Fork. Both are written for
version 1.0.0. Image links point at this repository's `main` branch, so push
first, or the pictures will not load.

## 1. Description (the one line under the title)

This is the `@description` line in the script header, so it updates itself when
the script is synced. Do not edit it by hand on the site.

> Save the books you bought on BookFunnel as ordinary files. Audiobooks: one chaptered .m4b or .mp3, or titled chapter files in a .zip. Ebooks: EPUB, Kindle EPUB, Kobo EPUB, PDF. Marks locked vs normal books in your library (red / green) and can download them all in bulk. No re-encoding. Open source on GitHub.

## 2. Additional info (Markdown)

Paste everything between the two lines below into **Additional info** on the
script's *Admin* page, with the format set to **Markdown**.

---8<---

**Source code, issues and release notes: [https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader)**

Save the books you **bought** from BookFunnel as ordinary files you keep, from
your own logged-in session. No terminal, no re-encoding.

### What it does

- **Audiobooks** from the player page: one chaptered **`.m4b`** (or `.mp3`) per
  book with chapter marks, title/author tags and the cover, or every chapter as
  a titled MP3 in a `.zip` folder.
- **Ebooks** from the reader and delivery pages: EPUB, Kindle EPUB, Kobo EPUB and
  PDF, with a tick box beside each file. Several ticked files are saved together
  in one `.zip`.
- **Your library, at a glance**: a **red** border on books BookFunnel locks (they
  need this script) and a **green** border on the ones that download normally,
  with a key that counts both.
- **Open Blocked**, **Download all ebooks** and **Download all audiobooks**
  buttons in that key. The bulk buttons ask for a second click before they start.
- **Stop** and **Retry failed**, per-file progress and honest error messages.

### Screenshots

Titles, authors and covers are blurred or replaced.

![Library with red and green borders](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/library.jpg)

![Audiobook panel](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/audiobook-panel.jpg)

![A locked audiobook saved as an .m4b](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/locked-audiobook-done.jpg)

![Ebook panel with tick boxes](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/ebook-panel.jpg)

![Bulk ebook download finished](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/bulk-ebooks-done.jpg)

![Bulk audiobook download finished](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/bulk-audiobooks-done.jpg)

### How to use

1. Install a userscript manager. This script is developed and tested with
   **Tampermonkey** in Chrome; other managers are untested.
2. Install this script.
3. Open <https://my.bookfunnel.com>. Red and green borders appear on your books.
4. Open any book: a **Download** pill appears in the corner and opens the panel.

Step-by-step directions with a screenshot for each step are in the
[README](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader#how-to-use).

### Good to know

- You need your own BookFunnel account and books you have access to. This does
  not bypass payment or break encryption (there is none).
- The script talks only to BookFunnel's own hosts and its storage hosts (the
  `@connect` lines in the header).
- Keep what you bought for your own use, and please respect the authors.
- Found a bug? Open an issue on [GitHub](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/issues). Please do not paste
  cookies, signed links or your email.

---8<---

## 3. Keeping Greasy Fork in sync with the repository

Greasy Fork can import the script straight from the repository, so the
repository stays the source of truth.

1. Sign in to Greasy Fork and open the script's **Admin** page.
2. Under **Sync**, set the source to the raw URL of the script:
   `https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/bookfunnel-downloader.user.js`
   and the sync type to **Automatic**.
3. Add the webhook so a push updates it at once: on GitHub open
   *Settings, Webhooks, Add webhook* and paste the **Webhook URL** and **secret**
   Greasy Fork shows on your account's *Webhooks* page
   (<https://greasyfork.org/en/users/webhook-info>). Choose *Just the push event*
   and content type `application/json`.
4. Greasy Fork requires the `@version` to increase on every update. Bump it in
   the header before you push a change.

Do not add `@updateURL` or `@downloadURL` pointing at GitHub: Greasy Fork
rejects scripts that update from another site.
