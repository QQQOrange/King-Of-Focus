"""最小的 WebDAV 服务器：只实现列目录 / PUT / GET / DELETE。

用途：在模拟器里真实验证"手机 ↔ 桌面"的云端备份通道（桌面端逻辑走同样的
PROPFIND / PUT / GET / DELETE）。不是生产代码，只是测试脚手架。

    python tools/dav_stub.py <root> [port]
"""
import email.utils
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "shots/dav")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765


def target(handler):
    name = urllib.parse.unquote(handler.path).rstrip("/").split("/")[-1]
    if not name or "/" in name or "\\" in name:
        return None
    return os.path.join(ROOT, name)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _simple(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_PROPFIND(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        items = []
        for name in sorted(os.listdir(ROOT)):
            full = os.path.join(ROOT, name)
            if not os.path.isfile(full):
                continue
            st = os.stat(full)
            items.append(
                "<d:response><d:href>/%s</d:href><d:propstat><d:prop>"
                "<d:getcontentlength>%d</d:getcontentlength>"
                "<d:getlastmodified>%s</d:getlastmodified>"
                "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                % (urllib.parse.quote(name), st.st_size,
                   email.utils.formatdate(st.st_mtime, usegmt=True))
            )
        xml = ('<?xml version="1.0" encoding="utf-8"?>'
               '<d:multistatus xmlns:d="DAV:">' + "".join(items) + "</d:multistatus>")
        self._simple(207, xml.encode(), "application/xml; charset=utf-8")

    def do_PUT(self):
        full = target(self)
        if not full:
            return self._simple(400)
        data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        with open(full, "wb") as f:
            f.write(data)
        self._simple(201)

    def do_GET(self):
        full = target(self)
        if not full or not os.path.isfile(full):
            return self._simple(404)
        with open(full, "rb") as f:
            self._simple(200, f.read(), "application/octet-stream")

    def do_DELETE(self):
        full = target(self)
        if full and os.path.isfile(full):
            os.remove(full)
        self._simple(204)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    print(f"dav root={ROOT} port={PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
