#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""bug-tracker 超期/停滞 BUG 提醒（飞书自定义机器人推送）

设计要点
- 纯标准库实现（urllib），不引入第三方依赖
- 配置来源（优先级：环境变量 > data/notify.json）：
    环境变量：BT_FEISHU_WEBHOOK / BT_FEISHU_SECRET / BT_NOTIFY_ENABLED
              BT_NOTIFY_TIME(HH:MM) / BT_NOTIFY_OVERDUE_DAYS / BT_NOTIFY_SEVERE_DAYS / BT_NOTIFY_TOP_N
    data/notify.json：{"webhook":"","secret":"","enabled":true,"time":"09:30",
                       "overdue_days":7,"severe_days":14,"top_n":5,"max_groups":8}
- 凭据安全：webhook / secret 绝不打印、绝不回显、绝不写入备份或日志
- 活跃判定口径必须与前端 js/engine.js 的 Engine.isActive 严格一致（由 test/test_notifier.py 锁定）
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import threading
import time
from urllib import request as _request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
STATE_FILE = os.path.join(DATA_DIR, 'state.json')
NOTIFY_CONFIG_FILE = os.path.join(DATA_DIR, 'notify.json')
NOTIFY_LOG_FILE = os.path.join(DATA_DIR, 'notify-log.json')
NOTIFY_LOG_MAX = 200           # 提醒日志最多保留条数
SEND_TIMEOUT = 8               # 秒
POLL_INTERVAL = 60             # 调度轮询间隔（秒）

DEFAULTS = {
    'webhook': '',
    'secret': '',
    'enabled': True,
    'time': '09:30',
    'overdue_days': 7,
    'severe_days': 14,
    'top_n': 5,
    'max_groups': 8,
    'title': 'BUG 超期提醒',
    'url': '',                 # 卡片里的「打开看板」链接（如 http://106.14.137.133:8092/）
}


# ---------------------------------------------------------------- 配置
def _env_bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    if v is None or v == '':
        return default
    return str(v).strip().lower() not in ('0', 'false', 'no', 'off')


def _env_int(name: str, default: int) -> int:
    try:
        v = os.environ.get(name)
        return int(str(v).strip()) if v not in (None, '') else default
    except (TypeError, ValueError):
        return default


def _load_file_config() -> dict:
    try:
        with open(NOTIFY_CONFIG_FILE, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}
    except Exception as e:  # noqa: BLE001
        print('[notify] 配置读取失败: %s' % e, file=sys.stderr)
        return {}


def load_config() -> dict:
    """读取提醒配置：环境变量优先，其次 data/notify.json，最后内置默认。"""
    cfg = dict(DEFAULTS)
    cfg.update({k: v for k, v in _load_file_config().items() if k in DEFAULTS})
    if os.environ.get('BT_FEISHU_WEBHOOK'):
        cfg['webhook'] = os.environ['BT_FEISHU_WEBHOOK'].strip()
    if os.environ.get('BT_FEISHU_SECRET'):
        cfg['secret'] = os.environ['BT_FEISHU_SECRET'].strip()
    cfg['enabled'] = _env_bool('BT_NOTIFY_ENABLED', bool(cfg['enabled']))
    t = os.environ.get('BT_NOTIFY_TIME')
    if t and _valid_hhmm(t):
        cfg['time'] = t.strip()
    cfg['overdue_days'] = _env_int('BT_NOTIFY_OVERDUE_DAYS', int(cfg['overdue_days']))
    cfg['severe_days'] = _env_int('BT_NOTIFY_SEVERE_DAYS', int(cfg['severe_days']))
    cfg['top_n'] = _env_int('BT_NOTIFY_TOP_N', int(cfg['top_n']))
    return cfg


def _valid_hhmm(s: str) -> bool:
    try:
        hh, mm = str(s).strip().split(':')
        return 0 <= int(hh) <= 23 and 0 <= int(mm) <= 59
    except (ValueError, AttributeError):
        return False


def _mask_webhook(url: str) -> str:
    """仅用于展示：不回显完整地址（可能含 token）。"""
    if not url:
        return ''
    if len(url) <= 18:
        return '***'
    return '%s***%s' % (url[:12], url[-4:])


# ---------------------------------------------------------------- 数据口径
def is_active(sysd: dict) -> bool:
    """与 js/engine.js 的 Engine.isActive 严格一致（字典序字符串比较）。

    ⚠️ 改动此处必须同步 js/engine.js，并由 test/test_notifier.py 的对照用例兜底。
    """
    sysd = sysd or {}
    if sysd.get('manualClosedAt'):
        return False
    if not sysd.get('lastSolvedAt'):
        return True
    if sysd.get('reactivatedAt') and str(sysd['reactivatedAt']) > str(sysd['lastSolvedAt']):
        return True
    return False


def _stay_days(rec: dict) -> int:
    v = (rec.get('fields') or {}).get('停留天数')
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return 0


def _owner(rec: dict) -> str:
    o = str((rec.get('fields') or {}).get('当前责任人', '') or '').strip()
    return o or '未分配'


def load_state(path: str = STATE_FILE) -> dict:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except (FileNotFoundError, ValueError):
        return {}
    except Exception as e:  # noqa: BLE001
        print('[notify] 状态读取失败: %s' % e, file=sys.stderr)
        return {}


def collect_overdue(state: dict, overdue_days: int, severe_days: int) -> dict:
    """汇总超期/停滞清单。返回 {rows, stats}（rows 已按停留天数降序）。"""
    bugs = state.get('bugs') or {}
    rows = []
    active = 0
    for bid, rec in bugs.items():
        if not isinstance(rec, dict):
            continue
        if not is_active(rec.get('sys') or {}):
            continue
        active += 1
        days = _stay_days(rec)
        if days >= overdue_days:
            rows.append({
                'id': str(bid),
                'title': str((rec.get('fields') or {}).get('标题', '') or '').strip(),
                'owner': _owner(rec),
                'days': days,
                'severity': str((rec.get('fields') or {}).get('严重程度', '') or '').strip(),
                'version': str((rec.get('fields') or {}).get('发现发布', '') or '').strip(),
                'severe': days >= severe_days,
            })
    rows.sort(key=lambda r: (-r['days'], r['owner']))
    last_snap = None
    snaps = state.get('snapshots') or []
    if snaps and isinstance(snaps[-1], dict):
        last_snap = snaps[-1]
    stats = {
        'active': active,
        'overdue': len(rows),
        'severe': sum(1 for r in rows if r['severe']),
        'unassigned': sum(1 for r in rows if r['owner'] == '未分配'),
        'overdue_days': overdue_days,
        'severe_days': severe_days,
        'last_import_at': (last_snap or {}).get('at'),
        'last_import_new': (last_snap or {}).get('imported'),
        'last_import_solved': (last_snap or {}).get('solved'),
    }
    return {'rows': rows, 'stats': stats}


# ---------------------------------------------------------------- 渲染
def _fmt_time(iso: str) -> str:
    if not iso:
        return '—'
    try:
        dt = time.strptime(iso.replace('T', ' ')[:19], '%Y-%m-%d %H:%M:%S')
        return time.strftime('%m-%d %H:%M', dt)
    except (ValueError, TypeError):
        return str(iso)[:16]


def build_digest(state: dict, cfg: dict, now: float | None = None, url: str = '') -> dict:
    """构建提醒内容（不发送）。返回 {title, markdown, text, stats, rows}。"""
    now = now if now is not None else time.time()
    od = max(1, int(cfg.get('overdue_days') or 7))
    sv = max(od, int(cfg.get('severe_days') or 14))
    top_n = max(1, int(cfg.get('top_n') or 5))
    max_groups = max(1, int(cfg.get('max_groups') or 8))

    data = collect_overdue(state, od, sv)
    rows, stats = data['rows'], data['stats']

    date_str = time.strftime('%Y-%m-%d', time.localtime(now))
    title = '%s · %s' % (str(cfg.get('title') or DEFAULTS['title']), date_str)

    lines = []
    if not rows:
        lines.append('**当前无超期 BUG**（活跃 %d 条，均未超过 %d 天）👍' % (stats['active'], od))
    else:
        pct = round(stats['overdue'] * 100.0 / stats['active'], 1) if stats['active'] else 0.0
        lines.append('**活跃 BUG %d 条 · 超期(≥%d天) %d 条（%s%%）· 其中 ≥%d 天 %d 条**'
                     % (stats['active'], od, stats['overdue'], pct, sv, stats['severe']))
        # 按责任人分组
        by_owner: dict = {}
        for r in rows:
            by_owner.setdefault(r['owner'], []).append(r)
        groups = sorted(by_owner.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        shown_groups = groups[:max_groups]
        for owner, lst in shown_groups:
            lines.append('')
            lines.append('**%s**（%d 条）' % (owner, len(lst)))
            for r in lst[:top_n]:
                flag = '🔴' if r['severe'] else '🟠'
                t = r['title'][:28] + ('…' if len(r['title']) > 28 else '')
                lines.append('%s %s · 停留 %d 天 · %s' % (flag, r['id'], r['days'], t or '（无标题）'))
            if len(lst) > top_n:
                lines.append('　└ 另有 %d 条，见看板' % (len(lst) - top_n))
        if len(groups) > max_groups:
            lines.append('')
            lines.append('…另有 %d 位责任人，共 %d 条超期，见看板' % (len(groups) - max_groups, stats['overdue'] - sum(len(v) for _, v in shown_groups)))

    if stats['last_import_at']:
        lines.append('')
        lines.append('最近导入 %s：新增 %s · 判定解决 %s'
                     % (_fmt_time(stats['last_import_at']), stats['last_import_new'], stats['last_import_solved']))
    if url:
        lines.append('')
        lines.append('[打开 BUG 处理进展跟踪](%s)' % url)

    markdown = '\n'.join(lines)
    text = markdown.replace('**', '')
    return {'title': title, 'markdown': markdown, 'text': text, 'stats': stats, 'rows': rows}


# ---------------------------------------------------------------- 飞书发送
def sign(secret: str, timestamp: str) -> str:
    """飞书自定义机器人签名：base64(HMAC-SHA256(key='<ts>\\n<secret>', msg=''))"""
    string_to_sign = '%s\n%s' % (timestamp, secret)
    digest = hmac.new(string_to_sign.encode('utf-8'), b'', digestmod=hashlib.sha256).digest()
    return base64.b64encode(digest).decode('utf-8')


def build_payload(cfg: dict, title: str, markdown: str, timestamp: str | None = None) -> dict:
    payload = {
        'msg_type': 'interactive',
        'card': {
            'header': {
                'title': {'tag': 'plain_text', 'content': title},
                'template': 'red',
            },
            'elements': [{'tag': 'markdown', 'content': markdown}],
        },
    }
    secret = str(cfg.get('secret') or '').strip()
    if secret:
        ts = timestamp if timestamp is not None else str(int(time.time()))
        payload['timestamp'] = ts
        payload['sign'] = sign(secret, ts)
    return payload


def send_feishu(cfg: dict, title: str, markdown: str, opener=None) -> tuple:
    """推送飞书自定义机器人。返回 (ok: bool, err: str)。

    opener：可注入的 opener（测试用），默认 urllib.request.build_opener()。
    失败只返回错误字符串，绝不抛出（调用方据此写日志），也不打印凭据。
    """
    webhook = str(cfg.get('webhook') or '').strip()
    if not webhook:
        return False, '未配置 webhook'
    payload = build_payload(cfg, title, markdown)
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = _request.Request(webhook, data=body, method='POST',
                           headers={'Content-Type': 'application/json; charset=utf-8'})
    try:
        op = opener or _request.build_opener()
        with op.open(req, timeout=SEND_TIMEOUT) as resp:
            raw = resp.read().decode('utf-8', errors='ignore')
        try:
            data = json.loads(raw)
        except ValueError:
            return False, '响应非 JSON：%s' % raw[:120]
        code = data.get('code', data.get('StatusCode', 0))
        if code in (0, '0', None):
            return True, ''
        return False, '飞书返回错误 code=%s msg=%s' % (code, data.get('msg', ''))
    except Exception as e:  # noqa: BLE001
        return False, '%s: %s' % (type(e).__name__, e)


# ---------------------------------------------------------------- 日志
def append_log(entry: dict) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        records = []
        try:
            with open(NOTIFY_LOG_FILE, 'r', encoding='utf-8') as f:
                records = json.load(f)
                if not isinstance(records, list):
                    records = []
        except (FileNotFoundError, ValueError):
            records = []
        records.append(entry)
        records = records[-NOTIFY_LOG_MAX:]
        tmp = NOTIFY_LOG_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(records, f, ensure_ascii=False, indent=1)
        os.replace(tmp, NOTIFY_LOG_FILE)
    except Exception as e:  # noqa: BLE001
        print('[notify] 日志写入失败: %s' % e, file=sys.stderr)


def read_log(limit: int = 20) -> list:
    try:
        with open(NOTIFY_LOG_FILE, 'r', encoding='utf-8') as f:
            records = json.load(f)
        return records[-limit:] if isinstance(records, list) else []
    except (FileNotFoundError, ValueError):
        return []


def last_sent_date() -> str:
    """最近一次成功发送的日期（YYYY-MM-DD）；用于避免当日重复发送。"""
    for rec in reversed(read_log(50)):
        if rec.get('ok'):
            return str(rec.get('time', ''))[:10]
    return ''


def last_result() -> dict:
    recs = read_log(1)
    return recs[-1] if recs else {}


# ---------------------------------------------------------------- 发送编排
def send_now(cfg: dict | None = None, state: dict | None = None, url: str | None = None, reason: str = 'manual') -> dict:
    """构建并发送一次；写日志。返回 {ok, err, stats, title}。"""
    cfg = cfg or load_config()
    state = state if state is not None else load_state()
    if url is None:
        url = str(cfg.get('url') or '')
    digest = build_digest(state, cfg, url=url)
    ok, err = send_feishu(cfg, digest['title'], digest['markdown'])
    append_log({
        'time': time.strftime('%Y-%m-%d %H:%M:%S'),
        'reason': reason,
        'ok': bool(ok),
        'err': '' if ok else str(err),
        'active': digest['stats'].get('active'),
        'overdue': digest['stats'].get('overdue'),
        'severe': digest['stats'].get('severe'),
    })
    if ok:
        print('[notify] 已推送（%s）：超期 %s 条' % (reason, digest['stats'].get('overdue')), file=sys.stderr)
    else:
        print('[notify] 推送失败（%s）：%s' % (reason, err), file=sys.stderr)
    return {'ok': ok, 'err': err, 'stats': digest['stats'], 'title': digest['title']}


# ---------------------------------------------------------------- 调度
def _should_send_now(cfg: dict, now: float) -> bool:
    if not cfg.get('enabled') or not str(cfg.get('webhook') or '').strip():
        return False
    hhmm = time.strftime('%H:%M', time.localtime(now))
    if not _valid_hhmm(cfg.get('time')):
        return False
    if hhmm < str(cfg['time']):
        return False
    return last_sent_date() != time.strftime('%Y-%m-%d', time.localtime(now))


def start_scheduler(url: str | None = None, interval: int = POLL_INTERVAL) -> threading.Thread:
    """后台 daemon 线程：到点（默认 09:30）每日推送一次。任何异常只记日志，不影响主服务。"""
    def _loop() -> None:  # pragma: no cover - 线程体（逻辑由 _should_send_now 单测覆盖）
        while True:
            try:
                time.sleep(interval)
                cfg = load_config()
                if _should_send_now(cfg, time.time()):
                    send_now(cfg, url=url, reason='schedule')
            except Exception as e:  # noqa: BLE001
                print('[notify] 调度异常: %s' % e, file=sys.stderr)
    t = threading.Thread(target=_loop, name='notify-scheduler', daemon=True)
    t.start()
    return t


if __name__ == '__main__':  # 手动调试：python3 notifier.py preview|send
    os.makedirs(DATA_DIR, exist_ok=True)
    cfg = load_config()
    if len(sys.argv) > 1 and sys.argv[1] == 'send':
        print(json.dumps(send_now(cfg, reason='cli'), ensure_ascii=False, indent=2))
    else:
        d = build_digest(load_state(), cfg)
        print(d['title'])
        print(d['markdown'])
