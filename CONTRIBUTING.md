# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome.

## Before you file an issue

- Say which page you were on (library, player, reader or delivery page), the
  script version (`@version` in the header) and the userscript manager.
- Paste the text the panel shows, especially a red error line.
- **Never paste cookies, signed download URLs, claim-link codes or your
  account email.** Blur or replace book titles if you would rather not share them.

## Running the tests

```bash
npm install          # jsdom, for the DOM-dependent parser checks
npm test             # parser checks + packer checks
```

The packer checks need `ffmpeg`, `ffprobe`, `unzip` and `python3` on the path.
They build real MP3, M4B and ZIP files and verify them with those tools, so a
byte-level mistake fails loudly instead of producing a file that only some
players accept.

## How the script is laid out

`bookfunnel-downloader.user.js` is one file with no dependencies, written in
plain ES5-style JavaScript so it runs in every userscript manager:

- the **parser** block (HTML to a list of files) is pure and is extracted and
  tested against the saved pages in `test/fixtures/`;
- the **packer** block between `==pack:start==` and `==pack:end==` is pure and
  is tested by `test/pack-check.js`;
- the rest is the download engine and the Shadow-DOM UI.

Keep changes inside those boundaries where you can, and add a test next to any
bug you fix.

## Fixtures

Fixtures in `test/fixtures/` are saved pages with personal data removed (email,
session ids, claim-link codes, signed URL keys). Do the same to anything you add.

## Pull requests

- One change per pull request, with the test that covers it.
- Update `CHANGELOG.md` and bump `@version` in the userscript header for
  user-visible changes.
- Greasy Fork requires the version to go up on every update.
