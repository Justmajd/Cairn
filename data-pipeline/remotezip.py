"""Read single members out of a remote .zip with HTTP range requests (no full download)."""
import urllib.request, zipfile

UA = {"User-Agent": "Mozilla/5.0 (data-pipeline)"}


class HttpFile:
    def __init__(self, url):
        self.url, self.pos = url, 0
        head = urllib.request.urlopen(urllib.request.Request(url, method="HEAD", headers=UA))
        self.size = int(head.headers["content-length"])

    def seekable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def read(self, n=-1):
        if n < 0: n = self.size - self.pos
        if n == 0 or self.pos >= self.size: return b""
        rng = f"bytes={self.pos}-{min(self.size, self.pos + n) - 1}"
        data = urllib.request.urlopen(urllib.request.Request(self.url, headers={**UA, "Range": rng})).read()
        self.pos += len(data)
        return data


def open_remote_zip(url):
    return zipfile.ZipFile(HttpFile(url))
