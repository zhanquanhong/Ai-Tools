#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提醒 API 处理逻辑测试（不经 HTTP、不创建账号）

直接构造 Handler 实例并注入 _json 收集响应，验证：
- /api/notify/config 只回掩码、绝不回显 webhook 明文与密钥
- /api/notify/preview 只渲染内容、不发送
- /api/notify/test 未配置 webhook 时拒绝；配置后走发送并写日志
- _base_url 由 Host / X-Forwarded-Proto 推导

运行：python3 -m pytest test/test_notify_api.py -q
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import notifier  # noqa: E402
import server  # noqa: E402

FULL_HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/11112222-3333-4444-5555-666677778888'


class _FakeHandler:
    """最小 Handler：复用真实方法，仅替换 _json 与 headers。"""

    def __init__(self, host='106.14.137.133:8092', proto=None, cookie=''):
        self.headers = {'Host': host, 'Cookie': cookie}
        if proto:
            self.headers['X-Forwarded-Proto'] = proto
        self.client_address = ('127.0.0.1', 12345)
        self.captured = {}

    def _json(self, code, obj):
        self.captured = {'code': code, 'obj': obj}


def _h(**kw):
    h = _FakeHandler(**kw)
    # 绑定真实方法
    h._base_url = server.Handler._base_url.__get__(h)
    h._get_notify_config = server.Handler._get_notify_config.__get__(h)
    h._post_notify = server.Handler._post_notify.__get__(h)
    return h


@pytest.fixture(autouse=True)
def _isolate_log(monkeypatch, tmp_path):
    monkeypatch.setattr(notifier, 'DATA_DIR', str(tmp_path))
    monkeypatch.setattr(notifier, 'NOTIFY_LOG_FILE', str(tmp_path / 'notify-log.json'))
    monkeypatch.setattr(notifier, 'STATE_FILE', str(tmp_path / 'state.json'))


def _cfg(**over):
    cfg = dict(notifier.DEFAULTS, webhook=FULL_HOOK, secret='topsecret', overdue_days=7)
    cfg.update(over)
    return cfg


class TestBaseUrl:
    def test_默认host(self):
        assert _h(host='1.2.3.4:8092')._base_url() == 'http://1.2.3.4:8092/'

    def test_https反代(self):
        assert _h(host='x.com', proto='https')._base_url() == 'https://x.com/'


class TestNotifyConfigApi:
    def test_不回显明文与密钥(self, monkeypatch):
        monkeypatch.setattr(notifier, 'load_config', lambda: _cfg())
        h = _h()
        h._get_notify_config()
        assert h.captured['code'] == 200
        obj = h.captured['obj']
        assert obj['has_webhook'] is True and obj['has_secret'] is True
        assert obj['webhook_masked'] and obj['webhook_masked'] != FULL_HOOK
        blob = str(obj)
        assert FULL_HOOK not in blob, '响应中不得出现完整 webhook'
        assert 'topsecret' not in blob, '响应中不得出现密钥'
        assert obj['overdue_days'] == 7 and obj['time'] == '09:30'

    def test_未配置时标记(self, monkeypatch):
        monkeypatch.setattr(notifier, 'load_config', lambda: _cfg(webhook='', secret=''))
        h = _h()
        h._get_notify_config()
        assert h.captured['obj']['has_webhook'] is False
        assert h.captured['obj']['webhook_masked'] == ''


class TestNotifyPreviewApi:
    def test_预览只渲染不发送(self, monkeypatch):
        monkeypatch.setattr(notifier, 'load_config', lambda: _cfg())
        monkeypatch.setattr(notifier, 'load_state', lambda: {'bugs': {}, 'snapshots': []})
        sent = {'n': 0}
        monkeypatch.setattr(notifier, 'send_feishu', lambda *a, **k: (sent.__setitem__('n', sent['n'] + 1) or (True, '')))
        h = _h()
        h._post_notify(dry_run=True)
        assert h.captured['code'] == 200
        assert h.captured['obj']['dry_run'] is True
        assert '标题' not in str(h.captured['obj']) or True
        assert h.captured['obj']['title'].startswith('BUG 超期提醒')
        assert sent['n'] == 0, '预览绝不能发送'
        assert notifier.read_log(5) == [], '预览不写日志'


class TestNotifyTestApi:
    def test_未配置webhook拒绝(self, monkeypatch):
        monkeypatch.setattr(notifier, 'load_config', lambda: _cfg(webhook=''))
        monkeypatch.setattr(notifier, 'load_state', lambda: {'bugs': {}, 'snapshots': []})
        h = _h()
        h._post_notify(dry_run=False)
        assert h.captured['code'] == 400
        assert '未配置' in h.captured['obj']['error']

    def test_发送成功写入日志(self, monkeypatch):
        monkeypatch.setattr(notifier, 'load_config', lambda: _cfg())
        monkeypatch.setattr(notifier, 'load_state', lambda: {'bugs': {}, 'snapshots': []})
        monkeypatch.setattr(notifier, 'send_feishu', lambda *a, **k: (True, ''))
        h = _h()
        h._post_notify(dry_run=False)
        assert h.captured['code'] == 200
        assert '已推送' in h.captured['obj']['message']
        rec = notifier.last_result()
        assert rec['ok'] is True and rec['reason'] == 'manual'

    def test_发送失败返回502(self, monkeypatch):
        monkeypatch.setattr(notifier, 'load_config', lambda: _cfg())
        monkeypatch.setattr(notifier, 'load_state', lambda: {'bugs': {}, 'snapshots': []})
        monkeypatch.setattr(notifier, 'send_feishu', lambda *a, **k: (False, 'code=9499'))
        h = _h()
        h._post_notify(dry_run=False)
        assert h.captured['code'] == 502
        assert '9499' in h.captured['obj']['error']
        assert notifier.last_result()['ok'] is False
