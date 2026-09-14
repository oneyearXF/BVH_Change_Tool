#!/usr/bin/env python3
"""BVH 剪辑工具 —— 本地静态服务器（禁用浏览器缓存）。

`python -m http.server` 不发送任何缓存头，浏览器会按启发式规则缓存
index.html，于是改完代码刷新时可能还在跑旧页面（表现就是小人骨骼错乱、
轨迹不对）。这个服务器强制 no-store，保证每次刷新都取磁盘上的最新文件。
"""

import argparse
import functools
import http.server
import os
import socketserver
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write('[server] %s\n' % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser(description='BVH 剪辑工具本地服务器（禁用缓存）')
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--dir', default=os.path.dirname(os.path.abspath(__file__)))
    args = parser.parse_args()

    handler = functools.partial(NoCacheHandler, directory=args.dir)
    with Server(('127.0.0.1', args.port), handler) as httpd:
        print('🌐 http://127.0.0.1:%d  (目录: %s, 已禁用浏览器缓存)' % (args.port, args.dir))
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n已停止')


if __name__ == '__main__':
    main()
