#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Phaser 阶段 2 地图渲染冒烟自测（Edge headless + dump-dom）
用法: python tools/self_test_stage2.py [base_url]
对 frontend/tools/phaser_map_smoke.html 跑无头加载，检查 DOM 报告（smoke-report 内容全 PASS）
并检查 body data-smoke-ok=1（无 JS 异常）。
依赖：vite dev server 已启动（冒烟页 import /src/phaser/*.ts，需 vite 转换）。
参考：阶段 1 tools/self_test_stage1.py（同模式）。
"""
import re
import subprocess
import sys

# GBK 控制台打印 emoji（如全屏按钮 ⛶）会崩 → 强制 UTF-8 输出（replace 兜底）
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def dump(url: str) -> str:
    # --no-proxy-server：本机 HTTP_PROXY(127.0.0.1:7897) 会对回环地址 502，无头浏览器须绕过代理直连 vite
    r = subprocess.run(
        [EDGE, "--headless=new", "--disable-gpu", "--no-first-run", "--no-proxy-server",
         "--virtual-time-budget=15000", "--dump-dom", url],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=90,
    )
    return r.stdout.decode("utf-8", errors="replace")


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5199"
    url = base + "/tools/phaser_map_smoke.html"
    dom = dump(url)
    print(f"=== stage2 map smoke ({url}) ===")

    # 报告行：<div id="smoke-report">[PASS] ... [FAIL] ...</div>
    m = re.search(r'<div id="smoke-report">(.*?)</div>', dom, re.S)
    lines = m.group(1).split('<br>') if m else []
    lines = [re.sub(r'<[^>]+>', '', l).strip() for l in lines if l.strip()]
    if not lines:
        lines = re.findall(r'\[(PASS|FAIL)\][^<\n]*', dom)
        lines = ['[' + l + ']' for l in lines]

    all_ok = True
    seen = set()
    for line in lines:
        if line in seen:
            continue
        seen.add(line)
        pass_ = line.startswith('[PASS]')
        all_ok = all_ok and pass_
        print(f"  [{'PASS' if pass_ else 'FAIL'}] {line[7:] if pass_ else line[6:]}")

    title_ok = 'data-smoke-ok="1"' in dom or 'data-smoke-ok="1"' in re.sub(r'<[^>]+>', '', dom)
    print(f"  [{'PASS' if title_ok else 'FAIL'}] data-smoke-ok=1（全部断言通过，无 JS 异常）")
    all_ok = all_ok and title_ok

    print("RESULT:", "ALL PASS" if all_ok else "FAIL")
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
