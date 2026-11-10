#!/usr/bin/env python
"""一条命令跑完全部门禁。

为什么需要它：这个项目有 8 道自检（前端 harness、i18n 覆盖率、前后端接线、
规则匹配、更新清单、跨设备格式、Rust 单测、Android 单测），分散在几个语言里。
发布前靠人挨个记着跑——漏一道就是一次"线上才发现"。

用法：
    python tools/check_all.py              # 只跑桌面端（默认）
    python tools/check_all.py --android    # 连 Android 单测一起
    python tools/check_all.py --list       # 只列出会跑什么

退出码 0 = 全绿。任何一项失败都会继续跑完（好让人一次看到所有问题），最后返回 1。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 这台机器上的工具链不一定在 PATH 里，按"先找 PATH、再找已知位置"的顺序探测
NODE_HINTS = [
    r"C:\Users\64381\AppData\Local\Qianwen\User Data\qwen-agent\resources\bins\node.exe",
]
PY_HINTS = [r"D:\Local AI\image\python_embeded\python.exe"]
CARGO_HINTS = [r"C:\Users\64381\.cargo\bin\cargo.exe"]
GRADLE_HINTS = [r"C:\dev\gradle-8.9\bin\gradle.bat"]


def find(name: str, hints: list[str]) -> str | None:
    p = shutil.which(name)
    if p:
        return p
    for h in hints:
        if os.path.isfile(h):
            return h
    return None


NODE = find("node", NODE_HINTS) or "node"
PY = sys.executable
CARGO = find("cargo", CARGO_HINTS) or "cargo"
GRADLE = find("gradle", GRADLE_HINTS)


def node_tool(name: str) -> list[str]:
    return [NODE, os.path.join(ROOT, "tools", name)]


def py_tool(name: str) -> list[str]:
    return [PY, os.path.join(ROOT, "tools", name)]


# (显示名, 命令, 工作目录, 说明)
def gates(android: bool) -> list[tuple[str, list[str], str, str]]:
    g = [
        ("Rust 单测", [CARGO, "test"], os.path.join(ROOT, "src-tauri"), "cargo test"),
        ("前端 harness", node_tool("run_itest.js"), ROOT, "ui 的 DOM 级断言"),
        ("国际化覆盖", node_tool("check_i18n.js"), ROOT, "可见中文是否都有英文"),
        ("前后端接线", node_tool("check_wiring.js"), ROOT, "命令/参数/data-act 三者对齐"),
        ("规则匹配", node_tool("test_matcher.js"), ROOT, "域名/进程名匹配语义"),
        ("更新清单", node_tool("test_update.js"), ROOT, "版本比较与清单解析"),
        ("跨设备格式", node_tool("check_portable.js"), ROOT, "备份格式两端一致"),
        ("WebDAV 地址", node_tool("check_dav_url.js"), ROOT, "URL 归一化"),
    ]
    if android:
        g.append(
            (
                "Android 单测",
                [GRADLE, "testDebugUnitTest", "--no-daemon", "--console=plain"],
                os.path.join(ROOT, "android"),
                "gradle testDebugUnitTest",
            )
        )
    return g


def main() -> int:
    android = "--android" in sys.argv
    if "--list" in sys.argv:
        for name, _cmd, _cwd, note in gates(android):
            print(f"  {name:<12} {note}")
        return 0

    rows = []
    failed = 0
    t0 = time.time()
    for name, cmd, cwd, note in gates(android):
        if not os.path.isdir(cwd):
            rows.append((name, "跳过", "目录不存在"))
            continue
        if not os.path.isfile(cmd[0]) and shutil.which(cmd[0]) is None:
            rows.append((name, "跳过", f"找不到 {cmd[0]}"))
            continue
        start = time.time()
        env = dict(os.environ)
        env.setdefault("PYTHONIOENCODING", "utf-8")
        if name == "Android 单测":
            env.setdefault("JAVA_HOME", r"C:\dev\jdk17")
            env.setdefault("ANDROID_HOME", r"C:\dev\android-sdk")
            env.setdefault("ANDROID_SDK_ROOT", env["ANDROID_HOME"])
        p = subprocess.run(
            cmd,
            cwd=cwd,
            capture_output=True,
            # 必须显式 UTF-8：Windows 默认按 GBK 解码，cargo/测试输出的中文和 ✓ 会直接
            # 抛 UnicodeDecodeError（而且是在子进程读线程里抛，主进程只看到 stdout=None）。
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        dur = time.time() - start
        ok = p.returncode == 0
        if not ok:
            failed += 1
        out = (p.stdout or "") + "\n" + (p.stderr or "")
        tail = ""
        for line in reversed(out.splitlines()):
            s = line.strip()
            if s and not s.startswith("Compiling"):
                tail = s[:120]
                break
        rows.append((name, "通过" if ok else "失败", f"{dur:5.1f}s  {tail}"))

    print()
    width = max(len(r[0]) for r in rows) if rows else 8
    for name, status, detail in rows:
        mark = "✓" if status == "通过" else ("·" if status == "跳过" else "✗")
        print(f"  {mark} {name:<{width}}  {status:<4}  {detail}")
    print(f"\n  用时 {time.time() - t0:.1f}s")
    if failed:
        print(f"\n✗ {failed} 项未通过")
        return 1
    print("\n✅ 全部门禁通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
