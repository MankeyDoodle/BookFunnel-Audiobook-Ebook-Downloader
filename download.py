#!/usr/bin/env python3
"""
download.py — fetch, tag and organise BookFunnel audiobooks you own.

Two output modes:

  default        one MP3 per chapter, tagged, Plex "Music" friendly
  --single       one chaptered .m4b per book (Apple Books, Prologue, Audiobookshelf)

Reads the tracks.tsv produced by collect.js.

    python3 download.py tracks.tsv --single

Requires: python3, curl, ffmpeg/ffprobe on PATH.

Re-running is safe: finished files are skipped, so you can resume after a
dropped connection. If every request returns HTTP 403 the presigned URLs have
expired — re-run collect.js to get a fresh manifest.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys

# ---------- helpers -------------------------------------------------------

def die(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


def need(binary):
    if shutil.which(binary) is None:
        die("'%s' not found on PATH" % binary)


def slug(s):
    """Filename-safe version of a chapter or book title."""
    s = re.sub(r'[/\\:*?"<>|]', '-', s)
    return re.sub(r'\s+', ' ', s).strip().strip('.')


def ffmeta_escape(s):
    """Escape a value for an FFMETADATA1 file."""
    s = str(s).replace("\\", "\\\\")
    for ch in ("=", ";", "#", "\n"):
        s = s.replace(ch, "\\" + ch)
    return s


def parse_tsv(path):
    """
    Header line : id <TAB> "Title by Author" <TAB> cover_url
    Track lines : n <TAB> duration <TAB> title <TAB> url_dir <TAB> url_file
    """
    if not os.path.exists(path):
        die("manifest not found: %s (run collect.js first)" % path)

    books, cur = [], None
    for lineno, raw in enumerate(open(path, encoding="utf-8"), 1):
        line = raw.rstrip("\n")
        if not line.strip():
            continue
        p = line.split("\t")

        # 3 fields = book header, 5 fields = track. Anything else is a typo.
        if len(p) == 3:
            title, author = (p[1].rsplit(" by ", 1) if " by " in p[1] else (p[1], "Unknown"))
            cur = {
                "id": p[0],
                "album": title.strip(),
                "artist": author.strip(),
                "cover": p[2].strip(),
                "tracks": [],
            }
            books.append(cur)
            continue

        if len(p) == 5:
            if cur is None:
                die("line %d: track before any book header" % lineno)
            n, dur, title, url_dir, url_file = p
            cur["tracks"].append({
                "n": int(n),
                "dur": int(float(dur)),
                "title": title,
                "url": url_dir + url_file,
            })
            continue

        die("line %d: expected 3 fields (book header) or 5 (track), got %d" % (lineno, len(p)))

    for b in books:
        if not b["tracks"]:
            die("book %r has no tracks" % b["album"])
        b["tracks"].sort(key=lambda t: t["n"])
    return books


def load_overrides(path):
    """Optional {"book_id": {title, series, part, narrator, description, album}}."""
    if not path:
        return {}
    if not os.path.exists(path):
        die("metadata file not found: %s" % path)
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


# ---------- network -------------------------------------------------------

def fetch(url, dest):
    tmp = dest + ".part"
    r = subprocess.run(
        ["curl", "-sS", "--fail", "--location", "--retry", "3", "--retry-delay", "2",
         "-o", tmp, url],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        return False, (r.stderr or "curl exit %d" % r.returncode).strip()[:200]
    size = os.path.getsize(tmp)
    if size < 10_000:
        os.remove(tmp)
        return False, "suspiciously small (%d bytes)" % size
    os.replace(tmp, dest)
    return True, "%d bytes" % size


# ---------- audio ---------------------------------------------------------

def probe_duration(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def probe_chapters(path):
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_chapters", "-of", "json", path],
        capture_output=True, text=True,
    )
    try:
        return json.loads(r.stdout or "{}").get("chapters", [])
    except ValueError:
        return []


def make_embed_art(src, dest, px):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", src,
         "-vf", "scale=%d:%d" % (px, px), "-q:v", "4", dest],
        capture_output=True, text=True,
    )
    return os.path.exists(dest)


def tag_file(path, album, artist, title, track_no, track_total, art, extra=None):
    tmp = path + ".tmp.mp3"
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", path]
    if art:
        cmd += ["-i", art]
    cmd += ["-map", "0:a"]
    if art:
        cmd += ["-map", "1:v", "-c:v", "copy",
                "-disposition:v", "attached_pic",
                "-metadata:s:v", "title=Album cover",
                "-metadata:s:v", "comment=Cover (front)"]
    cmd += ["-c:a", "copy", "-id3v2_version", "3", "-write_id3v1", "1",
            "-metadata", "title=" + title,
            "-metadata", "album=" + album,
            "-metadata", "artist=" + artist,
            "-metadata", "album_artist=" + artist,
            "-metadata", "track=%d/%d" % (track_no, track_total),
            "-metadata", "genre=Audiobook",
            tmp]
    for k, v in (extra or {}).items():
        if v:
            cmd += ["-metadata", "%s=%s" % (k, v)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        if os.path.exists(tmp):
            os.remove(tmp)
        return False, (r.stderr or "").strip()[:200]
    os.replace(tmp, path)
    return True, "ok"


def album_name(book, ov):
    """'Scales & Steel (The Gilded Prince, Book 1)' when series info is known."""
    if ov.get("album"):
        return ov["album"]
    base = ov.get("title") or book["album"]
    series, part = ov.get("series"), ov.get("part")
    # drop an existing parenthetical so we don't stack two
    base = re.sub(r'\s*\([^)]*\)\s*$', '', base).strip()
    if series and part:
        return "%s (%s, Book %s)" % (base, series, part)
    if series:
        return "%s (%s)" % (base, series)
    return base


def build_m4b(book, book_dir, out_path, tracks, art, bitrate, ov):
    """Concatenate chapter MP3s into one .m4b carrying chapter marks."""
    out_path = os.path.abspath(out_path)
    concat = out_path + ".concat.txt"
    meta = out_path + ".meta.txt"
    album = album_name(book, ov)

    durations = []
    with open(concat, "w", encoding="utf-8") as fh:
        for t in tracks:
            # absolute: the concat demuxer resolves paths relative to the list file
            f = os.path.abspath(os.path.join(book_dir, t["file"]))
            if not os.path.exists(f):
                return False, "missing chapter file: %s" % f
            fh.write("file '%s'\n" % f.replace("'", r"'\''"))
            durations.append(probe_duration(f))

    with open(meta, "w", encoding="utf-8") as fh:
        fh.write(";FFMETADATA1\n")
        fh.write("title=%s\n" % ffmeta_escape(ov.get("title") or album))
        fh.write("album=%s\n" % ffmeta_escape(album))
        fh.write("artist=%s\n" % ffmeta_escape(book["artist"]))
        fh.write("album_artist=%s\n" % ffmeta_escape(book["artist"]))
        fh.write("genre=Audiobook\n")
        if ov.get("narrator"):
            fh.write("composer=%s\n" % ffmeta_escape(ov["narrator"]))
        if ov.get("description"):
            fh.write("description=%s\n" % ffmeta_escape(ov["description"]))
        if ov.get("year"):
            fh.write("date=%s\n" % ffmeta_escape(ov["year"]))
        acc = 0.0
        for t, dur in zip(tracks, durations):
            start, acc = acc, acc + dur
            fh.write("[CHAPTER]\nTIMEBASE=1/1000\nSTART=%d\nEND=%d\ntitle=%s\n"
                     % (int(round(start * 1000)), int(round(acc * 1000)),
                        ffmeta_escape(t["title"])))

    cmd = ["ffmpeg", "-y", "-v", "error",
           "-f", "concat", "-safe", "0", "-i", concat]
    if art:
        cmd += ["-i", art]
    cmd += ["-f", "ffmetadata", "-i", meta,
            "-map", "0:a"]
    if art:
        cmd += ["-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic"]
    cmd += ["-map_metadata", "2",
            "-c:a", "aac", "-b:a", bitrate, "-ac", "1",
            "-movflags", "+faststart", out_path]

    r = subprocess.run(cmd, capture_output=True, text=True)
    for tmp in (concat, meta):
        if os.path.exists(tmp):
            os.remove(tmp)

    if r.returncode != 0:
        return False, (r.stderr or "").strip()[-400:]

    # verify: chapter count and total length
    got = probe_chapters(out_path)
    if len(got) != len(tracks):
        return False, "wrote %d chapters, expected %d" % (len(got), len(tracks))
    expected = sum(durations)
    actual = probe_duration(out_path)
    if expected and abs(actual - expected) > 4:
        return False, "duration %.0fs vs expected %.0fs" % (actual, expected)

    return True, "%d chapters, %.1f MB" % (len(got), os.path.getsize(out_path) / 1e6)


# ---------- main ----------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Download and tag your BookFunnel audiobooks.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="examples:\n"
               "  python3 download.py tracks.tsv --single\n"
               "  python3 download.py tracks.tsv --single --bitrate 64k --remove-chapters\n")
    ap.add_argument("manifest", nargs="?", default="tracks.tsv")
    ap.add_argument("--out", default=".", help="output root (default: current dir)")
    ap.add_argument("--art", type=int, default=600, help="embedded cover size in px (0 = skip)")
    ap.add_argument("--no-tag", action="store_true", help="download only, leave files untouched")
    ap.add_argument("--flat", action="store_true", help="no per-book subfolder")

    single = ap.add_argument_group("chapterized single file")
    single.add_argument("--single", action="store_true",
                        help="produce one chaptered .m4b per book instead of per-chapter MP3s")
    single.add_argument("--bitrate", default="96k", help="AAC bitrate for --single (default 96k)")
    single.add_argument("--remove-chapters", action="store_true",
                        help="with --single, delete the per-chapter MP3s after a verified build")
    single.add_argument("--meta", help='JSON with per-book metadata, keyed by book id')

    args = ap.parse_args()

    need("curl")
    need("ffmpeg")
    need("ffprobe")

    books = parse_tsv(args.manifest)
    overrides = load_overrides(args.meta)

    print("manifest: %s" % os.path.abspath(args.manifest))
    for b in books:
        hrs = sum(t["dur"] for t in b["tracks"]) / 3600
        print("  %-45s %2d tracks  %.1f h" % (album_name(b, overrides.get(b["id"], {})),
                                              len(b["tracks"]), hrs))
    print("mode: %s" % ("single chaptered .m4b" if args.single else "one MP3 per chapter"))
    print()

    failures, warned = [], []
    art_cache = {}

    for b in books:
        ov = overrides.get(b["id"], {})
        book_dir = args.out if args.flat else os.path.join(args.out, slug(album_name(b, ov)))
        os.makedirs(book_dir, exist_ok=True)

        # cover: full-res into the folder, downscaled copy for embedding
        full = os.path.join(book_dir, "cover.jpg")
        if b["cover"] and not os.path.exists(full):
            ok, msg = fetch(b["cover"], full)
            if not ok:
                warned.append((b["album"], "cover", msg))

        embed_art = None
        if os.path.exists(full) and args.art > 0:
            scaled = os.path.join(book_dir, ".embed_cover.jpg")
            key = (full, args.art)
            if key not in art_cache:
                art_cache[key] = make_embed_art(full, scaled, args.art)
            if art_cache[key]:
                embed_art = scaled

        total = len(b["tracks"])
        got_all = True
        for t in b["tracks"]:
            name = "%02d - %s.mp3" % (t["n"], slug(t["title"]))
            t["file"] = name
            dest = os.path.join(book_dir, name)

            if os.path.exists(dest) and os.path.getsize(dest) > 10_000:
                print("skip  %s" % name)
            else:
                ok, msg = fetch(t["url"], dest)
                print("%s  %s  %s" % ("ok   " if ok else "FAIL ", name, msg))
                if not ok:
                    failures.append((b["album"], t["n"], t["title"], msg))
                    got_all = False
                    continue

            actual = probe_duration(dest)
            if actual and abs(actual - t["dur"]) > 3:
                warned.append((b["album"], name,
                               "duration %.0fs vs manifest %ds" % (actual, t["dur"])))

        if args.single:
            if not got_all:
                print("  ! skipping .m4b build for %r — tracks are missing\n" % b["album"])
                continue
            out = os.path.join(book_dir, album_name(b, ov) + ".m4b")
            print("  building %s ..." % os.path.basename(out))
            ok, msg = build_m4b(b, book_dir, out, b["tracks"], embed_art, args.bitrate, ov)
            print("  %s  %s\n" % ("built " if ok else "FAILED", msg))
            if not ok:
                failures.append((b["album"], 0, "m4b build", msg))
                continue
            if args.remove_chapters:
                for t in b["tracks"]:
                    p = os.path.join(book_dir, t["file"])
                    if os.path.exists(p):
                        os.remove(p)
                print("  removed %d chapter MP3s\n" % total)
        elif not args.no_tag:
            for t in b["tracks"]:
                dest = os.path.join(book_dir, t["file"])
                if not os.path.exists(dest):
                    continue
                ok, msg = tag_file(dest, album_name(b, ov), b["artist"], t["title"],
                                   t["n"], total, embed_art, ov)
                if not ok:
                    warned.append((b["album"], t["file"], "tagging: " + msg))

    for (full, _px) in art_cache:
        scaled = os.path.join(os.path.dirname(full), ".embed_cover.jpg")
        if os.path.exists(scaled):
            os.remove(scaled)

    print()
    if warned:
        print("WARNINGS:")
        for w in warned:
            print("  %s / %s — %s" % w)
    if failures:
        print("FAILED (%d):" % len(failures))
        for f in failures:
            print("  %s / %s — %s" % (f[0], f[2], f[3]))
        print("\nIf these are HTTP 403 the signed URLs expired: re-run collect.js.")
        return 1

    print("Done. %d book(s), %d tracks." % (len(books), sum(len(b["tracks"]) for b in books)))
    print("Point a Plex *Music* library at: %s" % os.path.abspath(args.out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
