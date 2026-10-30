![BookFunnel Audiobook + Ebook Downloader](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/assets/banner.png)

**Source code, issues and release notes: [https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader)**

I made this because the BookFunnel app has far fewer accessibility and quality-of-life features than the audiobook and ebook apps I use every day. It saves the books you have bought and can already open in your own BookFunnel account as ordinary files, so your own reader, screen reader or audiobook app can use them. No terminal, no re-encoding.

### What this is, and what it is not

- **A personal-use tool** for people with **their own BookFunnel account**. It only works while you are signed in to an account that already has the book.
- **Not a hack or a security exploit.** It finds no vulnerability and does not decrypt, crack or defeat any encryption. It does not bypass a login, a payment or an access check. It uses the same addresses the BookFunnel page and player already load for your signed-in account in order to deliver or play the book, and saves what comes back.
- **Not a way to share books.** It hosts and uploads nothing. Please do not share, resell or redistribute the files or the links.
- **Not meant to undermine authors**, or to override an author's choice about downloads. Some authors offer a book only inside the BookFunnel app. This is for personal use and accessibility. If you would like a download for a book that has none, ask the author or BookFunnel support.
- **Not affiliated with BookFunnel.**

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
  (one `.m4b` per book) and **Open app-only books**, which opens the red books. The bulk
  buttons ask for a second click before they start.
- **Stop** and **Retry failed**, per-file progress and plain error messages.

### Screenshots

Titles, authors and covers are blurred or replaced.

![Your library, with red and green borders](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/library.jpg)

![An audiobook with no Download button, saved as one .m4b](https://raw.githubusercontent.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/main/docs/screenshots/locked-audiobook-done.jpg)

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

- Use it only with your own account, for books you have access to, for your own personal use on your own devices.
- Terms and laws differ by country. Saving files may go against BookFunnel's terms or an author's or publisher's wishes for some titles. You are responsible for how you use this and for following the laws and terms that apply to you. This is not legal advice.
- The script talks only to BookFunnel's own hosts and its storage hosts (the `@connect` lines in the header). It sends your data nowhere else.
- Provided "as is" under the MIT license, without warranty.
- Authors, publishers or BookFunnel with a concern: please [open an issue](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/issues) or contact me through my GitHub profile. I will read it and respond.
- Found a bug? Open an issue on [GitHub](https://github.com/MankeyDoodle/BookFunnel-Audiobook-Ebook-Downloader/issues). Please do not paste cookies, signed links or your email.
