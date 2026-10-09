#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""notifier.py 单元测试（pytest）

运行：python3 -m pytest test/test_notifier.py -q
覆盖：活跃判定口径（与前端 Engine.isActive 一致）、超期聚合、推送内容渲染、
      飞书签名、卡片 payload、真实 HTTP 发送路径（本地 mock）、配置优先级、调度判定。
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import notifier  # noqa: E402


# ---------------------------------------------------------------- 工具
def mk(no, days, owner='张三', status='新建', title='标题', ver='V1.0', sev='一般', sysd=None):
    return {
        'id': no,
        'fields': {'编号': no, '标题': title, '停留天数': str(days), '当前责任人': owner,
                   '状态': status, '发现发布': ver, '严重程度': sev},
        'sys': sysd or {'firstSeenAt': '2026-09-01T09:00:00', 'lastSolvedAt': None,
                        'reactivatedAt': None, 'lastImportedAt': '2026-10-09T09:00:00'},
    }


def state_of(recs, snaps=None):
    return {'bugs': {r['id']: r for r in recs}, 'snapshots': snaps or []}


# ---------------------------------------------------------------- 活跃判定口径
class TestIsActive:
    """与 js/engine.js 的 Engine.isActive 逐条对齐"""

    def test_无lastSolved且未关闭_活跃(self):
        assert notifier.is_active({'lastSolvedAt': None, 'reactivatedAt': None}) is True

    def test_已解决未激活_不活跃(self):
        assert notifier.is_active({'lastSolvedAt': '2026-10-01T00:00:00', 'reactivatedAt': None}) is False

    def test_重新激活晚于解决_活跃(self):
        assert notifier.is_active({'lastSolvedAt': '2026-10-01T00:00:00',
                                   'reactivatedAt': '2026-10-05T00:00:00'}) is True

    def test_重新激活早于解决_不活跃(self):
        assert notifier.is_active({'lastSolvedAt': '2026-10-05T00:00:00',
                                   'reactivatedAt': '2026-10-01T00:00:00'}) is False

    def test_手动关闭优先_不活跃(self):
        assert notifier.is_active({'manualClosedAt': '2026-10-02T00:00:00',
                                   'lastSolvedAt': None, 'reactivatedAt': None}) is False

    def test_空sys_活跃(self):
        assert notifier.is_active({}) is True


# ---------------------------------------------------------------- 超期聚合
class TestCollectOverdue:
    def test_过滤与统计(self):
        st = state_of([
            mk('B1', 10, '张三'),                      # 超期
            mk('B2', 6, '张三'),                       # 未达阈值
            mk('B3', 20, '李四'),                      # 超期 + 严重
            mk('B4', 8, ''),                           # 未分配
            mk('B5', 30, '李四', sysd={'lastSolvedAt': '2026-10-08T00:00:00'}),  # 不活跃 → 不计
        ])
        out = notifier.collect_overdue(st, 7, 14)
        ids = [r['id'] for r in out['rows']]
        assert ids == ['B3', 'B1', 'B4'], '按停留天数降序'
        assert out['stats']['active'] == 4, 'active 只数活跃'
        assert out['stats']['overdue'] == 3
        assert out['stats']['severe'] == 1
        assert out['stats']['unassigned'] == 1
        assert out['rows'][0]['severe'] is True and out['rows'][1]['severe'] is False

    def test_无超期(self):
        st = state_of([mk('B1', 1), mk('B2', 3)])
        out = notifier.collect_overdue(st, 7, 14)
        assert out['rows'] == [] and out['stats']['overdue'] == 0

    def test_停留天数非数字按0(self):
        st = state_of([mk('B1', 'n/a')])
        out = notifier.collect_overdue(st, 7, 14)
        assert out['stats']['overdue'] == 0


# ---------------------------------------------------------------- 推送内容
class TestBuildDigest:
    def test_无超期文案(self):
        cfg = dict(notifier.DEFAULTS, overdue_days=7)
        d = notifier.build_digest(state_of([mk('B1', 1)]), cfg, now=time.time())
        assert '当前无超期 BUG' in d['markdown']
        assert d['stats']['overdue'] == 0

    def test_按责任人分组与阈值展示(self):
        st = state_of([mk('B1', 30, '张三'), mk('B2', 20, '张三', sev='严重'),
                       mk('B3', 9, '李四'), mk('B4', 7, '王五')])
        cfg = dict(notifier.DEFAULTS, overdue_days=7, severe_days=14, top_n=5, max_groups=8)
        d = notifier.build_digest(st, cfg, now=time.time())
        md = d['markdown']
        assert '活跃 BUG 4 条' in md and '超期(≥7天) 4 条' in md and '≥14 天 2 条' in md
        assert '**张三**（2 条）' in md and '**李四**（1 条）' in md and '**王五**（1 条）' in md
        assert md.index('**张三**') < md.index('**李四**'), '责任人按超期条数降序'
        assert '🔴' in md and '🟠' in md, '严重/普通标记'
        assert '停留 30 天' in md

    def test_topn与maxgroups截断(self):
        recs = [mk('B%d' % i, 30 - i, '人%d' % (i % 3)) for i in range(1, 12)]
        cfg = dict(notifier.DEFAULTS, overdue_days=7, top_n=2, max_groups=2)
        d = notifier.build_digest(state_of(recs), cfg, now=time.time())
        md = d['markdown']
        assert md.count('另有') >= 1, '有截断提示'
        assert '另有' in md

    def test_最近导入与看板链接(self):
        st = state_of([mk('B1', 30)],
                      snaps=[{'at': '2026-10-09T09:30:00', 'imported': 5, 'solved': 3}])
        cfg = dict(notifier.DEFAULTS, overdue_days=7)
        d = notifier.build_digest(st, cfg, now=time.time(), url='http://1.2.3.4:8092/')
        assert '最近导入 10-09 09:30：新增 5 · 判定解决 3' in d['markdown']
        assert '[打开 BUG 处理进展跟踪](http://1.2.3.4:8092/)' in d['markdown']
        assert '**' not in d['text'], '纯文本兜底去掉 markdown 加粗'


# ---------------------------------------------------------------- 签名 / payload
class TestSignAndPayload:
    def test_签名固定向量(self):
        assert notifier.sign('S3cr#t!', '1700000000') == 'e3bmejANITB04zOd97/4u6DagrVZlNRiu0xe68uYhTY='

    def test_签名等于独立实现(self):
        s = '1700000000\nS3cr#t!'
        expect = base64.b64encode(hmac.new(s.encode(), b'', hashlib.sha256).digest()).decode()
        assert notifier.sign('S3cr#t!', '1700000000') == expect

    def test_payload_无密钥无签名字段(self):
        p = notifier.build_payload({'secret': ''}, 'T', 'M')
        assert 'timestamp' not in p and 'sign' not in p
        assert p['msg_type'] == 'interactive'
        assert p['card']['elements'][0]['content'] == 'M'

    def test_payload_有密钥带签名且可校验(self):
        p = notifier.build_payload({'secret': 'S3cr#t!'}, 'T', 'M')
        assert 'timestamp' in p and 'sign' in p
        assert p['sign'] == notifier.sign('S3cr#t!', p['timestamp'])


# ---------------------------------------------------------------- 发送（真实 HTTP 路径 → 本地 mock）
class _Resp:
    def __init__(self, body):
        self._b = body.encode('utf-8')

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class _MockOpener:
    def __init__(self, body='{"code":0,"msg":"success"}'):
        self.body = body
        self.captured = {}

    def open(self, req, timeout=None):
        self.captured['url'] = req.full_url
        self.captured['body'] = json.loads(req.data.decode('utf-8'))
        return _Resp(self.body)


class TestSendFeishu:
    def test_未配置webhook直接失败(self):
        ok, err = notifier.send_feishu({'webhook': ''}, 'T', 'M')
        assert ok is False and '未配置' in err

    def test_发送成功并校验载荷(self):
        op = _MockOpener('{"code":0,"msg":"success"}')
        ok, err = notifier.send_feishu({'webhook': 'https://example.invalid/hook', 'secret': 'S3cr#t!'}, '标题', '正文', opener=op)
        assert ok is True and err == ''
        assert op.captured['url'] == 'https://example.invalid/hook'
        body = op.captured['body']
        assert body['msg_type'] == 'interactive'
        assert body['card']['header']['title']['content'] == '标题'
        assert body['card']['elements'][0]['content'] == '正文'
        assert body['sign'] == notifier.sign('S3cr#t!', body['timestamp']), '签名随请求一并携带'

    def test_飞书返回错误码(self):
        op = _MockOpener('{"code":9499,"msg":"Bad Request"}')
        ok, err = notifier.send_feishu({'webhook': 'https://example.invalid/hook'}, 'T', 'M', opener=op)
        assert ok is False and '9499' in err

    def test_响应非JSON(self):
        op = _MockOpener('not-json')
        ok, err = notifier.send_feishu({'webhook': 'https://example.invalid/hook'}, 'T', 'M', opener=op)
        assert ok is False and '响应非 JSON' in err

    def test_网络异常不抛出(self):
        class _Boom:
            def open(self, req, timeout=None):
                raise TimeoutError('timed out')
        ok, err = notifier.send_feishu({'webhook': 'https://example.invalid/hook'}, 'T', 'M', opener=_Boom())
        assert ok is False and 'TimeoutError' in err


# ---------------------------------------------------------------- 配置优先级
class TestLoadConfig:
    def test_env优先于文件(self, monkeypatch, tmp_path):
        cfgfile = tmp_path / 'notify.json'
        cfgfile.write_text(json.dumps({'webhook': 'file-hook', 'overdue_days': 3, 'time': '08:00'}), encoding='utf-8')
        monkeypatch.setattr(notifier, 'NOTIFY_CONFIG_FILE', str(cfgfile))
        monkeypatch.setenv('BT_FEISHU_WEBHOOK', 'env-hook')
        monkeypatch.setenv('BT_NOTIFY_OVERDUE_DAYS', '9')
        monkeypatch.setenv('BT_NOTIFY_TIME', '10:15')
        cfg = notifier.load_config()
        assert cfg['webhook'] == 'env-hook'
        assert cfg['overdue_days'] == 9
        assert cfg['time'] == '10:15'

    def test_文件回落默认(self, monkeypatch, tmp_path):
        monkeypatch.setattr(notifier, 'NOTIFY_CONFIG_FILE', str(tmp_path / 'nope.json'))
        for k in ('BT_FEISHU_WEBHOOK', 'BT_NOTIFY_OVERDUE_DAYS', 'BT_NOTIFY_TIME'):
            monkeypatch.delenv(k, raising=False)
        cfg = notifier.load_config()
        assert cfg['webhook'] == '' and cfg['overdue_days'] == 7 and cfg['time'] == '09:30'

    def test_非法时间不覆盖默认(self, monkeypatch, tmp_path):
        monkeypatch.setattr(notifier, 'NOTIFY_CONFIG_FILE', str(tmp_path / 'nope.json'))
        monkeypatch.setenv('BT_NOTIFY_TIME', '99:99')
        assert notifier.load_config()['time'] == '09:30'

    def test_掩码不回显完整地址(self):
        url = 'https://open.feishu.cn/open-apis/bot/v2/hook/12345678-aaaa-bbbb-cccc-ddddeeeeffff'
        m = notifier._mask_webhook(url)
        assert m != url and m.endswith('ffff') and len(m) < len(url)


# ---------------------------------------------------------------- 日志与调度
class TestLogAndSchedule:
    @pytest.fixture(autouse=True)
    def _isolate(self, monkeypatch, tmp_path):
        monkeypatch.setattr(notifier, 'DATA_DIR', str(tmp_path))
        monkeypatch.setattr(notifier, 'NOTIFY_LOG_FILE', str(tmp_path / 'notify-log.json'))

    def test_日志写入与last_sent_date(self):
        assert notifier.last_sent_date() == ''
        notifier.append_log({'time': '2026-10-09 09:30:00', 'ok': False, 'reason': 'schedule'})
        notifier.append_log({'time': '2026-10-09 09:31:00', 'ok': True, 'reason': 'schedule'})
        assert notifier.last_sent_date() == '2026-10-09'
        assert notifier.last_result()['ok'] is True

    def test_日志截断到上限(self, monkeypatch):
        monkeypatch.setattr(notifier, 'NOTIFY_LOG_MAX', 3)
        for i in range(6):
            notifier.append_log({'time': '2026-10-09 09:0%d:00' % i, 'ok': False})
        assert len(notifier.read_log(99)) == 3

    def test_调度判定(self):
        base = dict(notifier.DEFAULTS, webhook='https://example.invalid/h', enabled=True, time='09:30')
        # 未到点
        t = time.mktime(time.strptime('2026-10-09 08:00:00', '%Y-%m-%d %H:%M:%S'))
        assert notifier._should_send_now(dict(base), t) is False
        # 到点且当日未发
        t = time.mktime(time.strptime('2026-10-09 09:31:00', '%Y-%m-%d %H:%M:%S'))
        assert notifier._should_send_now(dict(base), t) is True
        # 已发过（写当日成功日志）
        notifier.append_log({'time': '2026-10-09 09:31:05', 'ok': True, 'reason': 'schedule'})
        assert notifier._should_send_now(dict(base), t) is False
        # 未配置 webhook / 未启用
        assert notifier._should_send_now(dict(base, webhook=''), t) is False
        assert notifier._should_send_now(dict(base, enabled=False), t) is False

    def test_send_now_无webhook不发送但写日志(self):
        cfg = dict(notifier.DEFAULTS, webhook='')
        out = notifier.send_now(cfg, state_of([mk('B1', 30)]), reason='test')
        assert out['ok'] is False and out['stats']['overdue'] == 1
        assert notifier.last_result()['ok'] is False


# ---------------------------------------------------------------- v1.49.0：责任人 / 版本范围过滤
class TestOwnerAndVersionFilter:
    def test_按责任人过滤_含未分配(self):
        st = state_of([
            mk('B1', 30, '张三'), mk('B2', 10, '张三'), mk('B3', 20, '李四'), mk('B4', 9, '')
        ])
        out = notifier.collect_overdue(st, 7, 14, owner='张三')
        assert [r['id'] for r in out['rows']] == ['B1', 'B2']
        assert out['stats']['overdue'] == 2 and out['stats']['active'] == 2 and out['stats']['owner'] == '张三'
        un = notifier.collect_overdue(st, 7, 14, owner='未分配')
        assert [r['id'] for r in un['rows']] == ['B4'], '空责任人按「未分配」匹配'

    def test_按版本过滤(self):
        st = state_of([
            mk('B1', 30, '张三', ver='V1.0'), mk('B2', 30, '张三', ver='V2.0')
        ])
        out = notifier.collect_overdue(st, 7, 14, versions=['V2.0'])
        assert [r['id'] for r in out['rows']] == ['B2']
        assert notifier.collect_overdue(st, 7, 14, versions=[])['stats']['overdue'] == 2, '空列表=全部'

    def test_build_digest_责任人标题与首行(self):
        st = state_of([mk('B1', 30, '张三'), mk('B2', 9, '李四')], snaps=[{'at': '2026-10-09T09:30:00', 'imported': 1, 'solved': 0}])
        cfg = dict(notifier.DEFAULTS, overdue_days=7, severe_days=14)
        d = notifier.build_digest(st, cfg, now=time.time(), owner='张三')
        assert '张三' in d['title']
        assert '**责任人：张三**' in d['markdown']
        assert d['stats']['overdue'] == 1
        assert '李四' not in d['markdown'], '只含该责任人的清单'

    def test_send_now_带责任人写日志(self, monkeypatch, tmp_path):
        monkeypatch.setattr(notifier, 'DATA_DIR', str(tmp_path))
        monkeypatch.setattr(notifier, 'NOTIFY_LOG_FILE', str(tmp_path / 'notify-log.json'))
        cfg = dict(notifier.DEFAULTS, webhook='')
        out = notifier.send_now(cfg, state_of([mk('B1', 30, '张三')]), reason='owner', owner='张三')
        assert out['ok'] is False and out['stats']['overdue'] == 1
        assert notifier.last_result()['owner'] == '张三'
