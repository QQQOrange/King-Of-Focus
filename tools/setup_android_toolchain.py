"""一次性安装 Android 构建工具链（JDK 17 + SDK cmdline-tools + platform/build-tools）。

为什么需要它：这台机器上没有 Java / Gradle / Android SDK，
而交付要求是"工程能真正构建出 APK"，所以必须先把工具链备齐。

产物位置（都在 C:/dev，不污染项目目录）：
  C:/dev/jdk17           微软 OpenJDK 17（AGP 8.x 要求 JDK 17+）
  C:/dev/android-sdk     SDK（cmdline-tools / platform-tools / platforms;android-35 / build-tools;35.0.0）
"""

import os
import sys
import time
import zipfile
import urllib.request

ROOT = r"C:\dev"
JDK_DIR = os.path.join(ROOT, "jdk17")
SDK_DIR = os.path.join(ROOT, "android-sdk")

JDK_URL = "https://aka.ms/download-jdk/microsoft-jdk-17-windows-x64.zip"
CLT_URL = "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def download(url, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        log(f"已存在，跳过下载 {os.path.basename(dst)}（{os.path.getsize(dst)//1048576} MB）")
        return dst
    log(f"下载 {url}")
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(url, headers=UA)
    t0 = time.time()
    with op.open(req, timeout=60) as r, open(dst, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        step = 0
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if total and done // (50 << 20) > step:
                step = done // (50 << 20)
                log(f"  {done//1048576}/{total//1048576} MB  {done/1048576/max(time.time()-t0,0.1):.1f} MB/s")
    log(f"完成 {os.path.basename(dst)}  {os.path.getsize(dst)//1048576} MB")
    return dst


def unzip(zip_path, dest):
    os.makedirs(dest, exist_ok=True)
    log(f"解压 -> {dest}")
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(dest)


def main():
    os.makedirs(ROOT, exist_ok=True)

    # 1) JDK
    if not os.path.exists(os.path.join(JDK_DIR, "bin", "java.exe")):
        z = download(JDK_URL, os.path.join(ROOT, "_dl", "jdk17.zip"))
        tmp = os.path.join(ROOT, "_jdk_tmp")
        unzip(z, tmp)
        inner = [d for d in os.listdir(tmp) if os.path.isdir(os.path.join(tmp, d))]
        if not inner:
            log("JDK 压缩包结构异常")
            return 1
        os.makedirs(ROOT, exist_ok=True)
        if os.path.exists(JDK_DIR):
            import shutil
            shutil.rmtree(JDK_DIR, ignore_errors=True)
        os.rename(os.path.join(tmp, inner[0]), JDK_DIR)
    log("JDK 就绪: " + os.path.join(JDK_DIR, "bin", "java.exe"))

    # 2) cmdline-tools
    clt = os.path.join(SDK_DIR, "cmdline-tools")
    if not os.path.exists(os.path.join(clt, "latest", "bin", "sdkmanager.bat")):
        z = download(CLT_URL, os.path.join(ROOT, "_dl", "cmdline-tools.zip"))
        unzip(z, os.path.join(clt, "_tmp"))
        # 压缩包里是 cmdline-tools/bin，需要放到 cmdline-tools/latest/bin
        src = os.path.join(clt, "_tmp", "cmdline-tools")
        os.makedirs(clt, exist_ok=True)
        import shutil
        if os.path.exists(os.path.join(clt, "latest")):
            shutil.rmtree(os.path.join(clt, "latest"), ignore_errors=True)
        os.rename(src, os.path.join(clt, "latest"))
        shutil.rmtree(os.path.join(clt, "_tmp"), ignore_errors=True)
    log("cmdline-tools 就绪")

    log("需要用 sdkmanager 安装 platform/build-tools，交给下一步")
    return 0


if __name__ == "__main__":
    sys.exit(main())
