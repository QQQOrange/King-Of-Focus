"""最小的 WebDAV 服务器：列目录 / PUT / GET / DELETE / MKCOL。

用途：在模拟器里真实验证"手机 ↔ 桌面"的云端备份通道（两端逻辑走同样的
PROPFIND / PUT / GET / DELETE / MKCOL）。不是生产代码，只是测试脚手架。

    python tools/dav_stub.py <root> [port]

支持多级目录，是为了能验证「默认地址带一层子目录 + 目录不存在时自动 MKCOL」：
真正的网盘（坚果云等）PUT 到不存在的目录会回 409，只有 MKCOL 是唯一的出路。
"""
import email.utils
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "shots/dav")
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765


def rel_path(handler):
    """URL 路径 → ROOT 下的绝对路径（拒绝 .. 越界）。"""
    raw = urllib.parse.unquote(handler.path.split("?", 1)[0])
    parts = [p for p in raw.split("/") if p]
    if any(p in (".", "..") for p in parts):
        return None
    return os.path.join(ROOT, *parts) if parts else ROOT


def rel_name(handler):
    """URL 里的文件名（用于列表回 href）"""
    raw = urllib.parse.unquote(handler.path.split("?", 1)[0])
    return raw.strip("/")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _simple(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _dir(self):
        """请求指向的目录（HTTP 路径以 / 结尾，或指向一个已存在的目录）"""
        full = rel_path(self)
        if full is None:
            return None
        if self.path.endswith("/") or os.path.isdir(full):
            return full
        return os.path.dirname(full)

    def do_PROPFIND(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        d = self._dir()
        if d is None or not os.path.isdir(d):
            return self._simple(404)
        base = "/" + rel_name(self).strip("/")
        base = base.rstrip("/")
        items = []
        for name in sorted(os.listdir(d)):
            full = os.path.join(d, name)
            # 目录也列出来（WebDAV 标准会带以 / 结尾的 href），
            # 客户端两种都要能跳过——这里顺便把它当"解析健壮性"的测试样本。
            if os.path.isdir(full):
                href = "%s/%s/" % (base, urllib.parse.quote(name))
                size = 0
            else:
                href = "%s/%s" % (base, urllib.parse.quote(name))
                size = os.path.getsize(full)
            st = os.stat(full)
            items.append(
                "<d:response><d:href>%s</d:href><d:propstat><d:prop>"
                "<d:getcontentlength>%d</d:getcontentlength>"
                "<d:getlastmodified>%s</d:getlastmodified>"
                "</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                % (href, size, email.utils.formatdate(st.st_mtime, usegmt=True))
            )
        xml = ('<?xml version="1.0" encoding="utf-8"?>'
               '<d:multistatus xmlns:d="DAV:">' + "".join(items) + "</d:multistatus>")
        self._simple(207, xml.encode(), "application/xml; charset=utf-8")

    def do_MKCOL(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        full = rel_path(self)
        if full is None:
            return self._simple(400)
        if os.path.isdir(full):
            # RFC 4918：资源已存在 → 405。桌面端/手机端都把它当"已就绪"
            return self._simple(405)
        parent = os.path.dirname(full)
        if not os.path.isdir(parent):
            # 父目录不存在 → 409（逐级创建时上层先建成，所以正常不会走到）
            return self._simple(409)
        os.makedirs(full, exist_ok=True)
        self._simple(201)

    def do_PUT(self):
        full = rel_path(self)
        if not full:
            return self._simple(400)
        data = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not os.path.isdir(os.path.dirname(full)):
            # 真实网盘就是这样回 409 的：PUT 不会自动建父目录
            return self._simple(409)
        with open(full, "wb") as f:
            f.write(data)
        self._simple(201)

    def do_GET(self):
        full = rel_path(self)
        if not full or not os.path.isfile(full):
            return self._simple(404)
        with open(full, "rb") as f:
            self._simple(200, f.read(), "application/octet-stream")

    def do_DELETE(self):
        full = rel_path(self)
        if full and os.path.isfile(full):
            os.remove(full)
        self._simple(204)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    print(f"dav root={ROOT} port={PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
