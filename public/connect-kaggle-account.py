#!/usr/bin/env python3
"""将已有 Kaggle 账户接入 H3 工作室；不注册 Kaggle 账号。仅使用 Python 标准库。"""
import argparse
import getpass
import json
import os
import sys
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="工作室地址")
    parser.add_argument("--name", default="脚本添加的账户", help="账户显示名称")
    args = parser.parse_args()
    if not args.url.startswith("https://"):
        parser.error("工作室地址必须使用 HTTPS")
    studio_key = os.getenv("H3_STUDIO_API_KEY") or getpass.getpass("工作室 API 密钥（隐藏输入）: ")
    kaggle_token = os.getenv("KAGGLE_API_TOKEN") or getpass.getpass("Kaggle API Token（隐藏输入）: ")
    request = urllib.request.Request(
        args.url.rstrip("/") + "/api/v1/accounts",
        data=json.dumps({"name": args.name, "token": kaggle_token}).encode(),
        headers={"Authorization": "Bearer " + studio_key, "Content-Type": "application/json"},
        method="POST",
    )
    # 不跟随重定向，避免把密钥转交到其他地址。
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=60) as response:
            result = json.load(response)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        try:
            result = json.loads(error.read())
            message = result.get("error", "接入失败")
        except (ValueError, UnicodeDecodeError):
            message = "服务器暂时无法响应"
        message = str(message).replace(studio_key, "[隐藏]").replace(kaggle_token, "[隐藏]")
        print(f"请求失败（HTTP {error.code}）: {message}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError):
        print("网络连接失败，请核对工作室地址并重试。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
