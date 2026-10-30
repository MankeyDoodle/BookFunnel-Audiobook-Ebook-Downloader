#!/usr/bin/env python3
"""Tiny mock BookFunnel server used to test bookfunnel-downloader.user.js.

Serves the harness page on every path, plus the userscript source itself and
the markup saved from the real site under test/fixtures/.
Run:  python3 test/serve.py   then open http://localhost:8777/g192apldg8
"""
import http.server
import os
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "bookfunnel-downloader.user.js")
HARNESS = os.path.join(ROOT, "test", "harness.html")
FIXTURES = os.path.join(ROOT, "test", "fixtures")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        if self.path == "/_dump":
            open(os.path.join(ROOT, "test", "tracks-test.tsv"), "wb").write(body)
            self.send_response(204)
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/userscript.txt":
            body = open(SCRIPT, "rb").read()
            ctype = "text/plain; charset=utf-8"
        elif path.startswith("/fixtures/"):
            name = os.path.basename(path)
            body = open(os.path.join(FIXTURES, name), "rb").read()
            ctype = "text/html; charset=utf-8"
        elif path.endswith(".user.js"):
            # a real install URL, so Tampermonkey offers to install it
            body = open(SCRIPT, "rb").read()
            ctype = "text/javascript; charset=utf-8"
        elif path == "/harness.js":
            body = open(HARNESS, "rb").read()
            ctype = "text/html; charset=utf-8"
        else:
            body = open(HARNESS, "rb").read()
            ctype = "text/html; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", 8777), Handler) as httpd:
        print("mock bookfunnel on http://127.0.0.1:8777/g192apldg8")
        httpd.serve_forever()
