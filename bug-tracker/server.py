#!/usr/bin/env python3
"""
bug-tracker 共享服务器（含登录认证）
- 静态文件服务（index.html / css / js / vendor）
- 共享状态 API：GET/POST /api/state（数据存 data/state.json，原子写入）
- 登录认证：登录页 + Session Cookie，防止未授权访问
- 版本管理：启动自动备份（保留 7 天）、管理员一键回滚（二次确认）、更新日志 API

认证配置（auth.json，与 server.py 同目录）：
  {"user": "admin", "pass": "你的密码"}
未配置时默认 admin / admin123（请务必修改！）

启动：python3 server.py [port]   （默认 8092）
"""
import hashlib
import json
import os
import re
import secrets
import shutil
import sys
import tempfile
import threading
import time
import zipfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
STATE_FILE = os.path.join(DATA_DIR, 'state.json')
AUTH_FILE = os.path.join(BASE_DIR, 'auth.json')
LOGIN_LOG_FILE = os.path.join(DATA_DIR, 'login-records.json')
LOGIN_LOG_MAX = 5000   # 最多保留 5000 条
DEFAULT_PORT = 8092
LOCK = threading.Lock()

# ---------- 版本管理（备份 / 回滚 / 更新日志） ----------
BACKUP_DIR = os.path.join(BASE_DIR, 'backup')
CHANGELOG_FILE = os.path.join(DATA_DIR, 'changelog.json')
BACKUP_LOG_FILE = os.path.join(DATA_DIR, 'backup-log.json')
BACKUP_KEEP_DAYS = 7          # 备份保留 7 天，超过自动清理
BACKUP_META_FILE = os.path.join(DATA_DIR, 'backup-meta.json')
# 参与版本备份/回滚的代码文件（不含 data/ 用户数据、test/、backup/ 自身）
BACKUP_PATHS = ['index.html', 'server.py', 'auth.json', 'css', 'js', 'vendor']


def _code_hash():
    """计算当前代码文件集合的 SHA256，用于判断代码是否有变更（避免重复备份）"""
    h = hashlib.sha256()
    for rel in BACKUP_PATHS:
        p = os.path.join(BASE_DIR, rel)
        if os.path.isdir(p):
            for root, _dirs, files in os.walk(p):
                for fn in sorted(files):
                    fp = os.path.join(root, fn)
                    h.update(os.path.relpath(fp, BASE_DIR).encode('utf-8'))
                    with open(fp, 'rb') as f:
                        h.update(f.read())
        elif os.path.isfile(p):
            h.update(rel.encode('utf-8'))
            with open(p, 'rb') as f:
                h.update(f.read())
    return h.hexdigest()


def _read_version_from_dir(base):
    """从 base/js/app.js 解析 APP_VERSION（备份对应的版本号）；解析失败返回 ''"""
    try:
        p = os.path.join(base, 'js', 'app.js')
        with open(p, 'r', encoding='utf-8') as f:
            m = re.search(r"APP_VERSION\s*=\s*'([^']+)'", f.read())
            return m.group(1) if m else ''
    except Exception:  # noqa: BLE001
        return ''


def _read_version_from_zip(zip_path):
    """从备份 zip 内的 js/app.js 解析版本号；失败返回 ''"""
    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            content = zf.read('js/app.js').decode('utf-8', errors='ignore')
            m = re.search(r"APP_VERSION\s*=\s*'([^']+)'", content)
            return m.group(1) if m else ''
    except Exception:  # noqa: BLE001
        return ''


def _create_backup(reason='manual', source_ip=''):
    """打包当前代码文件到 backup/ 目录；返回备份 id（文件名），失败返回 None。
    同时记录版本号与来源 IP 到备份日志（版本管理页展示，用于与更新日志对应判断回滚）。"""
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        ts = time.strftime('%Y%m%d_%H%M%S') + '_%03d' % (int(time.time() * 1000) % 1000)
        backup_id = 'v_%s_%s.zip' % (ts, reason)
        path = os.path.join(BACKUP_DIR, backup_id)
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for rel in BACKUP_PATHS:
                p = os.path.join(BASE_DIR, rel)
                if os.path.isdir(p):
                    for root, _dirs, files in os.walk(p):
                        for fn in sorted(files):
                            fp = os.path.join(root, fn)
                            zf.write(fp, os.path.relpath(fp, BASE_DIR))
                elif os.path.isfile(p):
                    zf.write(p, rel)
        _append_backup_log(backup_id, reason, version=_read_version_from_dir(BASE_DIR), source_ip=source_ip)
        return backup_id
    except Exception as e:  # noqa: BLE001
        print('[backup] 备份失败: %s' % e, file=sys.stderr)
        return None


def _append_backup_log(backup_id, reason, version='', source_ip=''):
    """备份/回滚操作日志：时间点 / 备份id / 原因 / 版本号 / 来源IP / 操作者（回滚时记录）"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        rec = {
            'time': time.strftime('%Y-%m-%d %H:%M:%S'),
            'backup_id': backup_id,
            'reason': reason,
            'version': version,
            'source_ip': source_ip,
        }
        with LOCK:
            records = []
            try:
                with open(BACKUP_LOG_FILE, 'r', encoding='utf-8') as f:
                    records = json.load(f)
                    if not isinstance(records, list):
                        records = []
            except (FileNotFoundError, ValueError):
                records = []
            records.append(rec)
            tmp = BACKUP_LOG_FILE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(records, f, ensure_ascii=False, indent=1)
            os.replace(tmp, BACKUP_LOG_FILE)
    except Exception as e:  # noqa: BLE001
        print('[backup] 操作日志写入失败: %s' % e, file=sys.stderr)


def _cleanup_old_backups():
    """清理超过 7 天的备份文件（保留最近 7 天内全部版本）"""
    try:
        if not os.path.isdir(BACKUP_DIR):
            return
        cutoff = time.time() - BACKUP_KEEP_DAYS * 24 * 3600
        removed = 0
        for fn in os.listdir(BACKUP_DIR):
            if not fn.endswith('.zip'):
                continue
            fp = os.path.join(BACKUP_DIR, fn)
            try:
                if os.path.getmtime(fp) < cutoff:
                    os.remove(fp)
                    removed += 1
            except OSError:
                pass
        if removed:
            print('[backup] 已清理 %d 个超过 %d 天的旧备份' % (removed, BACKUP_KEEP_DAYS), file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print('[backup] 清理旧备份失败: %s' % e, file=sys.stderr)


def auto_backup_if_changed():
    """启动时自动备份：代码文件内容有变化才备份（防抖：避免频繁重启刷备份）；
    备份后清理 7 天前的旧备份。"""
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        cur = _code_hash()
        meta = {}
        try:
            with open(BACKUP_META_FILE, 'r', encoding='utf-8') as f:
                meta = json.load(f)
        except (FileNotFoundError, ValueError):
            meta = {}
        if meta.get('hash') == cur:
            _cleanup_old_backups()
            return
        backup_id = _create_backup(reason='auto', source_ip='本地(服务器)')
        if backup_id:
            with LOCK:
                tmp = BACKUP_META_FILE + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump({'hash': cur, 'last_backup': backup_id}, f, ensure_ascii=False)
                os.replace(tmp, BACKUP_META_FILE)
            print('[backup] 检测到代码变更，已自动备份: %s' % backup_id, file=sys.stderr)
        _cleanup_old_backups()
    except Exception as e:  # noqa: BLE001
        print('[backup] 启动自动备份失败: %s' % e, file=sys.stderr)


def list_backups():
    """列出全部备份：id / 备份时间 / 版本号 / 文件大小 / 类型 / 来源IP。
    版本号与来源IP 优先取备份日志，老备份（无日志记录）从 zip 内解析版本号。"""
    # 备份日志 → backup_id 索引（version / source_ip）
    log_index = {}
    try:
        with open(BACKUP_LOG_FILE, 'r', encoding='utf-8') as f:
            logs = json.load(f)
        if isinstance(logs, list):
            for rec in logs:
                bid = rec.get('backup_id')
                if bid:
                    log_index[bid] = {
                        'version': rec.get('version', ''),
                        'source_ip': rec.get('source_ip', ''),
                    }
    except (FileNotFoundError, ValueError):
        pass
    except Exception as e:  # noqa: BLE001
        print('[backup] 读取备份日志失败: %s' % e, file=sys.stderr)
    out = []
    try:
        if not os.path.isdir(BACKUP_DIR):
            return out
        for fn in sorted(os.listdir(BACKUP_DIR), reverse=True):
            if not fn.endswith('.zip'):
                continue
            fp = os.path.join(BACKUP_DIR, fn)
            try:
                st = os.stat(fp)
                info = log_index.get(fn, {})
                version = info.get('version') or _read_version_from_zip(fp)
                out.append({
                    'id': fn,
                    'time': time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(st.st_mtime)),
                    'version': version,
                    'size': st.st_size,
                    'reason': 'auto' if '_auto' in fn else ('rollback' if '_rollback' in fn else 'manual'),
                    'source_ip': info.get('source_ip') or '—',
                })
            except OSError:
                continue
    except Exception as e:  # noqa: BLE001
        print('[backup] 列出备份失败: %s' % e, file=sys.stderr)
    return out


def do_rollback(backup_id, source_ip=''):
    """回滚到指定备份：先自动备份当前版本（防后悔）→ 解压覆盖代码文件（不碰 data/ 用户数据）。
    返回 (ok, message)"""
    if not backup_id or '..' in backup_id or not backup_id.endswith('.zip'):
        return False, '无效的备份标识'
    src = os.path.join(BACKUP_DIR, backup_id)
    if not os.path.isfile(src):
        return False, '备份文件不存在：%s' % backup_id
    # 1. 回滚前自动备份当前版本
    guard = _create_backup(reason='rollback', source_ip=source_ip)
    # 2. 解压到临时目录，校验成员路径（防 zip 路径穿越）
    tmpdir = tempfile.mkdtemp(prefix='bt_rollback_')
    try:
        with zipfile.ZipFile(src, 'r') as zf:
            for member in zf.infolist():
                name = member.filename
                if name.startswith('/') or '..' in name.split('/'):
                    return False, '备份文件包含非法路径，已中止'
            zf.extractall(tmpdir)
        # 3. 覆盖代码文件（跳过 data/ backup/ test/ __pycache__）
        for rel in BACKUP_PATHS:
            srcp = os.path.join(tmpdir, rel)
            dstp = os.path.join(BASE_DIR, rel)
            if os.path.isdir(srcp):
                if os.path.isdir(dstp):
                    shutil.rmtree(dstp)
                shutil.copytree(srcp, dstp)
            elif os.path.isfile(srcp):
                os.makedirs(os.path.dirname(dstp), exist_ok=True)
                shutil.copy2(srcp, dstp)
        # 4. 重置备份指纹：下次启动时若代码与回滚后一致则不重复备份
        meta = {'hash': _code_hash(), 'last_backup': backup_id, 'rolled_back': True}
        with LOCK:
            tmp = BACKUP_META_FILE + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(meta, f, ensure_ascii=False)
            os.replace(tmp, BACKUP_META_FILE)
        return True, '已回滚到 %s（回滚前当前版本已自动备份为 %s）；服务端代码需重启服务后完全生效' % (backup_id, guard or '—')
    except Exception as e:  # noqa: BLE001
        return False, '回滚失败: %s' % e
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def load_changelog():
    """读取更新日志（data/changelog.json）；缺失时返回空列表"""
    try:
        with open(CHANGELOG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except (FileNotFoundError, ValueError):
        pass
    except Exception as e:  # noqa: BLE001
        print('[changelog] 读取失败: %s' % e, file=sys.stderr)
    return []

# 登录页与静态资源不校验（登录页需独立可访问，静态资源无敏感数据）
PUBLIC_PATHS = {'/login.html', '/favicon.ico'}
PUBLIC_PREFIXES = ('/css/', '/js/', '/vendor/')
# 受保护路径：页面与 API
API_LOGIN = '/api/login'
API_LOGOUT = '/api/logout'

# ---------- 认证配置 ----------
def load_auth():
    """读取账号配置（多账号 + 角色）；兼容旧单账号格式 {user, pass}（角色=user）"""
    try:
        with open(AUTH_FILE, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        accounts = cfg.get('accounts')
        if isinstance(accounts, list) and accounts:
            out = []
            for a in accounts:
                u = str(a.get('user', '')).strip()
                p = str(a.get('pass', '')).strip()
                if u and p:
                    out.append({'user': u, 'pass': p, 'role': str(a.get('role', 'user')).strip() or 'user'})
            if out:
                return out
        # 兼容旧格式：单账号
        user = str(cfg.get('user', '')).strip()
        pwd = str(cfg.get('pass', '')).strip()
        if user and pwd:
            return [{'user': user, 'pass': pwd, 'role': 'user'}]
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        print('[auth] 配置读取失败: %s' % e, file=sys.stderr)
    print('⚠️  未找到有效 auth.json，使用默认账密 admin / admin123（请尽快修改！）', file=sys.stderr)
    return [{'user': 'admin', 'pass': 'admin123', 'role': 'admin'}]

AUTH_ACCOUNTS = load_auth()

# ---------- Session 管理（内存 + 7 天过期） ----------
SESSIONS = {}          # token -> {'exp': expire_ts, 'user': user, 'role': role}
SESSION_TTL = 7 * 24 * 3600
SESSIONS_LOCK = threading.Lock()


def new_session(user, role='user'):
    token = secrets.token_hex(24)
    with SESSIONS_LOCK:
        SESSIONS[token] = {'exp': time.time() + SESSION_TTL, 'user': user, 'role': role}
    return token


def check_session(token):
    if not token:
        return False
    with SESSIONS_LOCK:
        s = SESSIONS.get(token)
        if not s:
            return False
        if time.time() > s['exp']:
            del SESSIONS[token]
            return False
        return True


def session_user(token):
    """返回当前会话的用户名；无效会话返回 None"""
    if not token:
        return None
    with SESSIONS_LOCK:
        s = SESSIONS.get(token)
        if not s:
            return None
        if time.time() > s['exp']:
            del SESSIONS[token]
            return None
        return s.get('user')


def session_role(token):
    """返回当前会话的角色（admin/user）；无效会话返回 None"""
    if not token:
        return None
    with SESSIONS_LOCK:
        s = SESSIONS.get(token)
        if not s:
            return None
        if time.time() > s['exp']:
            del SESSIONS[token]
            return None
        return s.get('role')


def drop_session(token):
    with SESSIONS_LOCK:
        SESSIONS.pop(token, None)


def parse_cookie(header):
    """从 Cookie header 提取 session token"""
    if not header:
        return None
    for part in header.split(';'):
        part = part.strip()
        if part.startswith('bugtracker_session='):
            return part[len('bugtracker_session='):]
    return None


class Handler(SimpleHTTPRequestHandler):
    """静态文件 + 认证 + 状态 API"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    # ---------- 认证判定 ----------
    def _is_public(self, path):
        if path in PUBLIC_PATHS:
            return True
        for p in PUBLIC_PREFIXES:
            if path.startswith(p):
                return True
        return False

    def _is_authed(self):
        cookie = self.headers.get('Cookie')
        token = parse_cookie(cookie)
        return check_session(token)

    def _is_admin(self):
        """当前会话是否为管理员；未登录返回 False"""
        cookie = self.headers.get('Cookie')
        token = parse_cookie(cookie)
        return session_role(token) == 'admin'

    # ---------- 路由 ----------
    def do_GET(self):
        path = urlparse(self.path).path
        if path == API_LOGIN:
            self._json(405, {'ok': False, 'error': '请使用 POST 登录'})
            return
        if path == API_LOGOUT:
            cookie = self.headers.get('Cookie')
            token = parse_cookie(cookie)
            if token:
                drop_session(token)
            self._json(200, {'ok': True})
            return
        if path == '/api/state':
            if not self._is_authed():
                self._json(401, {'ok': False, 'error': '未登录或登录已过期'})
                return
            self._get_state()
            return
        if path == '/api/login-records':
            if not self._is_authed():
                self._json(401, {'ok': False, 'error': '未登录或登录已过期'})
                return
            self._get_login_records()
            return
        if path == '/api/me':
            if not self._is_authed():
                self._json(401, {'ok': False, 'error': '未登录或登录已过期'})
                return
            cookie = self.headers.get('Cookie')
            token = parse_cookie(cookie)
            self._json(200, {'ok': True, 'user': session_user(token) or '', 'role': session_role(token) or 'user'})
            return
        if path == '/api/changelog':
            if not self._is_authed():
                self._json(401, {'ok': False, 'error': '未登录或登录已过期'})
                return
            self._json(200, {'ok': True, 'changelog': load_changelog()})
            return
        if path == '/api/backups':
            if not self._is_authed():
                self._json(401, {'ok': False, 'error': '未登录或登录已过期'})
                return
            if not self._is_admin():
                self._json(403, {'ok': False, 'error': '仅管理员可查看版本备份'})
                return
            self._json(200, {'ok': True, 'backups': list_backups(), 'keep_days': BACKUP_KEEP_DAYS})
            return
        # 页面：受保护，未登录跳登录页
        if not self._is_public(path):
            if not self._is_authed():
                self.send_response(302)
                self.send_header('Location', '/login.html')
                self.end_headers()
                return
        super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == API_LOGIN:
            self._post_login()
            return
        if path == '/api/state':
            if not self._is_authed():
                self._json(401, {'ok': False, 'error': '未登录或登录已过期'})
                return
            self._post_state()
            return
        if path == '/api/backup/rollback':
            if not self._is_authed():
                self._json(401, {'ok': False, 'error': '未登录或登录已过期'})
                return
            if not self._is_admin():
                self._json(403, {'ok': False, 'error': '仅管理员可执行回滚操作'})
                return
            self._post_rollback()
            return
        if path == '/api/backup/create':
            if not self._is_authed():
                self._json(401, {'ok': False, 'error': '未登录或登录已过期'})
                return
            if not self._is_admin():
                self._json(403, {'ok': False, 'error': '仅管理员可执行备份操作'})
                return
            backup_id = _create_backup(reason='manual', source_ip=self.client_address[0])
            if not backup_id:
                self._json(500, {'ok': False, 'error': '备份失败，请查看服务日志'})
                return
            self._json(200, {'ok': True, 'backup_id': backup_id, 'message': '备份完成：%s' % backup_id})
            return
        self.send_error(404, 'Not Found')

    # ---------- API：登录 ----------
    def _post_login(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            data = json.loads(self.rfile.read(length).decode('utf-8'))
            user = str(data.get('user', ''))
            pwd = str(data.get('pass', ''))
        except Exception:  # noqa: BLE001
            self._json(400, {'ok': False, 'error': '请求体无效'})
            return
        # 常量时间比较，防时序攻击；多账号遍历匹配
        matched = None
        for acc in AUTH_ACCOUNTS:
            if secrets.compare_digest(user, acc['user']) and secrets.compare_digest(pwd, acc['pass']):
                matched = acc
                break
        ok = matched is not None
        # 记录登录请求：时间 / IP / 设备 / 账号 / 结果
        self._record_login(user, ok)
        if not ok:
            self._json(401, {'ok': False, 'error': '账密错误'})
            return
        role = matched['role']
        token = new_session(user, role)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Set-Cookie',
                         'bugtracker_session=%s; Path=/; Max-Age=%d; SameSite=Lax; HttpOnly' % (token, SESSION_TTL))
        body = json.dumps({'ok': True, 'user': user, 'role': role}, ensure_ascii=False).encode('utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record_login(self, user, ok):
        """记录登录请求：时间 / IP / 设备(UA) / 账号 / 成功与否，落盘 JSON 文件"""
        try:
            ua = self.headers.get('User-Agent', '')
            # 简单设备识别
            ua_low = ua.lower()
            if 'mobile' in ua_low or 'iphone' in ua_low or 'android' in ua_low:
                device = '手机'
            elif 'ipad' in ua_low:
                device = '平板'
            elif 'windows' in ua_low:
                device = 'Windows 电脑'
            elif 'macintosh' in ua_low or 'mac os' in ua_low:
                device = 'Mac 电脑'
            elif 'linux' in ua_low:
                device = 'Linux 电脑'
            else:
                device = '未知设备'
            # 浏览器识别
            browser = '未知浏览器'
            if 'edg/' in ua_low:
                browser = 'Edge'
            elif 'chrome/' in ua_low:
                browser = 'Chrome'
            elif 'firefox/' in ua_low:
                browser = 'Firefox'
            elif 'safari/' in ua_low:
                browser = 'Safari'
            elif 'micromessenger' in ua_low:
                browser = '微信内置浏览器'
            record = {
                'time': time.strftime('%Y-%m-%d %H:%M:%S'),
                'ip': self.client_address[0],
                'device': device,
                'browser': browser,
                'ua': ua[:300],
                'user': user,
                'result': '成功' if ok else '失败'
            }
            with LOCK:
                records = []
                try:
                    with open(LOGIN_LOG_FILE, 'r', encoding='utf-8') as f:
                        records = json.load(f)
                        if not isinstance(records, list):
                            records = []
                except (FileNotFoundError, ValueError):
                    records = []
                records.append(record)
                # 保留最近 N 条
                if len(records) > LOGIN_LOG_MAX:
                    records = records[-LOGIN_LOG_MAX:]
                os.makedirs(DATA_DIR, exist_ok=True)
                tmp = LOGIN_LOG_FILE + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(records, f, ensure_ascii=False, indent=1)
                os.replace(tmp, LOGIN_LOG_FILE)
        except Exception as e:  # noqa: BLE001
            print('[auth] 登录记录写入失败: %s' % e, file=sys.stderr)

    # ---------- API：读取共享状态 ----------
    def _get_state(self):
        try:
            with LOCK:
                with open(STATE_FILE, 'r', encoding='utf-8') as f:
                    body = f.read().encode('utf-8')
        except FileNotFoundError:
            body = b'{}'
        except Exception as e:  # noqa: BLE001
            self._json(500, {'ok': False, 'error': '读取失败: %s' % e})
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    # ---------- API：登录记录 ----------
    def _get_login_records(self):
        try:
            with LOCK:
                with open(LOGIN_LOG_FILE, 'r', encoding='utf-8') as f:
                    records = json.load(f)
        except FileNotFoundError:
            records = []
        except Exception as e:  # noqa: BLE001
            self._json(500, {'ok': False, 'error': '读取失败: %s' % e})
            return
        # 倒序（最新在前）
        records = list(reversed(records))
        body = json.dumps({'ok': True, 'records': records}, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    # ---------- API：保存共享状态 ----------
    def _post_state(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length)
            data = json.loads(raw.decode('utf-8'))
            if not isinstance(data, dict):
                raise ValueError('状态必须是 JSON 对象')
        except Exception as e:  # noqa: BLE001
            self._json(400, {'ok': False, 'error': '请求体无效: %s' % e})
            return
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            with LOCK:
                tmp = STATE_FILE + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False)
                os.replace(tmp, STATE_FILE)
        except Exception as e:  # noqa: BLE001
            self._json(500, {'ok': False, 'error': '保存失败: %s' % e})
            return
        self._json(200, {'ok': True})

    # ---------- API：回滚备份（仅管理员，二次确认） ----------
    def _post_rollback(self):
        try:
            length = int(self.headers.get('Content-Length', 0))
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except Exception:  # noqa: BLE001
            self._json(400, {'ok': False, 'error': '请求体无效'})
            return
        backup_id = str(data.get('id', ''))
        # 二次确认：必须显式传 confirm=true，防止误操作/误触发
        if data.get('confirm') is not True:
            self._json(400, {'ok': False, 'error': '请二次确认后再执行回滚'})
            return
        ok, msg = do_rollback(backup_id, source_ip=self.client_address[0])
        if not ok:
            self._json(500, {'ok': False, 'error': msg})
            return
        # 回滚操作记录操作人
        cookie = self.headers.get('Cookie')
        token = parse_cookie(cookie)
        user = session_user(token) or ''
        try:
            with LOCK:
                records = []
                try:
                    with open(BACKUP_LOG_FILE, 'r', encoding='utf-8') as f:
                        records = json.load(f)
                        if not isinstance(records, list):
                            records = []
                except (FileNotFoundError, ValueError):
                    records = []
                records.append({
                    'time': time.strftime('%Y-%m-%d %H:%M:%S'),
                    'backup_id': backup_id,
                    'reason': 'rollback',
                    'version': _read_version_from_dir(BASE_DIR),
                    'source_ip': self.client_address[0],
                    'operator': user,
                })
                tmp = BACKUP_LOG_FILE + '.tmp'
                with open(tmp, 'w', encoding='utf-8') as f:
                    json.dump(records, f, ensure_ascii=False, indent=1)
                os.replace(tmp, BACKUP_LOG_FILE)
        except Exception as e:  # noqa: BLE001
            print('[backup] 回滚操作日志写入失败: %s' % e, file=sys.stderr)
        self._json(200, {'ok': True, 'message': msg})

    # ---------- 工具 ----------
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write('[bug-tracker] %s\n' % (fmt % args))

    def end_headers(self):
        """所有响应统一禁止缓存，防止浏览器缓存旧版本页面/脚本"""
        has_cc = any(b'Cache-Control' in h for h in self._headers_buffer)
        if not has_cc:
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    # 启动时自动备份（代码有变更才备份）+ 清理 7 天前旧备份
    auto_backup_if_changed()
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    print('✅ BUG 跟踪共享服务器启动: http://0.0.0.0:%d' % port)
    print('   登录账号: %s' % '、'.join(a['user'] for a in AUTH_ACCOUNTS))
    print('   管理员: %s' % '、'.join(a['user'] for a in AUTH_ACCOUNTS if a['role'] == 'admin') or '（无）')
    print('   共享状态文件: %s' % STATE_FILE)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n服务器已停止')
        server.server_close()


if __name__ == '__main__':
    main()
