#!/usr/bin/env python3
"""
test_backup.py — 版本管理（备份/回滚/清理/更新日志）单元测试

运行：python3 test/test_backup.py
"""
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import server  # noqa: E402


class BackupTest(unittest.TestCase):
    def setUp(self):
        """每个用例独立临时目录，隔离备份/数据文件"""
        self.tmp = tempfile.mkdtemp(prefix='bt_backup_test_')
        self.old_base = server.BASE_DIR
        server.BASE_DIR = self.tmp
        server.DATA_DIR = os.path.join(self.tmp, 'data')
        server.BACKUP_DIR = os.path.join(self.tmp, 'backup')
        server.STATE_FILE = os.path.join(server.DATA_DIR, 'state.json')
        server.AUTH_FILE = os.path.join(self.tmp, 'auth.json')
        server.LOGIN_LOG_FILE = os.path.join(server.DATA_DIR, 'login-records.json')
        server.CHANGELOG_FILE = os.path.join(server.DATA_DIR, 'changelog.json')
        server.BACKUP_LOG_FILE = os.path.join(server.DATA_DIR, 'backup-log.json')
        server.BACKUP_META_FILE = os.path.join(server.DATA_DIR, 'backup-meta.json')
        os.makedirs(server.DATA_DIR, exist_ok=True)
        os.makedirs(os.path.join(self.tmp, 'js'), exist_ok=True)
        with open(os.path.join(self.tmp, 'index.html'), 'w', encoding='utf-8') as f:
            f.write('<html>v1</html>')
        with open(os.path.join(self.tmp, 'js', 'app.js'), 'w', encoding='utf-8') as f:
            f.write('var APP=1;')
        with open(os.path.join(self.tmp, 'auth.json'), 'w', encoding='utf-8') as f:
            json.dump({'accounts': []}, f)
        with open(server.STATE_FILE, 'w', encoding='utf-8') as f:
            json.dump({'bugs': [1, 2, 3]}, f)

    def tearDown(self):
        server.BASE_DIR = self.old_base
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_auto_backup_on_change(self):
        """代码变更时启动自动备份；无变更不重复备份"""
        server.auto_backup_if_changed()
        backups = server.list_backups()
        self.assertEqual(len(backups), 1, '首次启动（代码存在）应自动备份 1 份')
        # 再次启动：代码未变，不重复备份
        server.auto_backup_if_changed()
        self.assertEqual(len(server.list_backups()), 1, '代码未变更不应重复备份')
        # 修改代码后启动：新增备份
        with open(os.path.join(self.tmp, 'js', 'app.js'), 'w', encoding='utf-8') as f:
            f.write('var APP=2;')
        server.auto_backup_if_changed()
        self.assertEqual(len(server.list_backups()), 2, '代码变更后应新增备份')

    def test_cleanup_old_backups(self):
        """超过 7 天的备份自动清理，7 天内保留"""
        os.makedirs(server.BACKUP_DIR, exist_ok=True)
        old = os.path.join(server.BACKUP_DIR, 'v_20200101_000000_auto.zip')
        new = os.path.join(server.BACKUP_DIR, 'v_20990101_000000_auto.zip')
        for p in (old, new):
            with open(p, 'w') as f:
                f.write('x')
        # 把 old 的 mtime 改到 8 天前
        past = time.time() - 8 * 24 * 3600
        os.utime(old, (past, past))
        server._cleanup_old_backups()
        self.assertFalse(os.path.exists(old), '8 天前的备份应被清理')
        self.assertTrue(os.path.exists(new), '7 天内的备份应保留')

    def test_rollback_restores_code_not_data(self):
        """回滚：代码文件恢复为备份版本，data/ 用户数据不受影响"""
        # 备份 v1
        server._create_backup(reason='auto')
        # 修改代码到 v2
        with open(os.path.join(self.tmp, 'js', 'app.js'), 'w', encoding='utf-8') as f:
            f.write('var APP=2;')
        # 回滚到 v1 备份
        backups = server.list_backups()
        ok, msg = server.do_rollback(backups[0]['id'])
        self.assertTrue(ok, '回滚应成功: %s' % msg)
        with open(os.path.join(self.tmp, 'js', 'app.js'), encoding='utf-8') as f:
            self.assertEqual(f.read(), 'var APP=1;', '代码应恢复为备份版本')
        with open(server.STATE_FILE, encoding='utf-8') as f:
            self.assertEqual(json.load(f), {'bugs': [1, 2, 3]}, '回滚不应触碰 data/ 用户数据')
        # 回滚前自动备份了当前版本（防后悔）
        self.assertEqual(len(server.list_backups()), 2, '回滚前应自动备份当前版本')

    def test_backup_log_has_version_and_ip(self):
        """备份日志记录版本号与来源 IP（版本管理页展示，用于与更新日志对应判断回滚）"""
        with open(os.path.join(self.tmp, 'js', 'app.js'), 'w', encoding='utf-8') as f:
            f.write("const APP_VERSION = '1.35.0';")
        server._create_backup(reason='manual', source_ip='192.168.1.100')
        with open(server.BACKUP_LOG_FILE, encoding='utf-8') as f:
            logs = json.load(f)
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]['version'], '1.35.0', '备份日志应记录版本号')
        self.assertEqual(logs[0]['source_ip'], '192.168.1.100', '备份日志应记录来源 IP')
        # list_backups 应带出版本号与来源 IP
        backups = server.list_backups()
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0]['version'], '1.35.0')
        self.assertEqual(backups[0]['source_ip'], '192.168.1.100')

    def test_rollback_invalid_id(self):
        """非法备份 id 拒绝回滚（路径穿越防护）"""
        ok, _ = server.do_rollback('../../etc/passwd.zip')
        self.assertFalse(ok, '非法备份 id 应拒绝')
        ok, _ = server.do_rollback('not-exist.zip')
        self.assertFalse(ok, '不存在的备份应拒绝')

    def test_changelog_load(self):
        """更新日志读取：缺失返回空列表；非法内容返回空列表"""
        self.assertEqual(server.load_changelog(), [])
        with open(server.CHANGELOG_FILE, 'w', encoding='utf-8') as f:
            json.dump([{'ver': '1.34.0', 'date': '2026-08-18 09:35', 'items': ['x']}], f, ensure_ascii=False)
        data = server.load_changelog()
        self.assertEqual(len(data), 1)
        self.assertEqual(data[0]['ver'], '1.34.0')
        # 非法内容（非列表）返回空
        with open(server.CHANGELOG_FILE, 'w', encoding='utf-8') as f:
            f.write('{broken')
        self.assertEqual(server.load_changelog(), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
