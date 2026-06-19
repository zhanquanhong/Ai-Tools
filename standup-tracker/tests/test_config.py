"""
配置模块单元测试
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# 添加项目根到 path
_project_root = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(_project_root))

from config import AppConfig, FeishuConfig, LLMConfig


class TestAppConfig(unittest.TestCase):
    """测试 AppConfig"""

    def test_default_values(self):
        cfg = AppConfig()
        self.assertEqual(cfg.host, "0.0.0.0")
        self.assertEqual(cfg.port, 8899)
        self.assertEqual(cfg.feishu.app_id, "")
        self.assertEqual(cfg.llm.provider, "deepseek")
        self.assertEqual(cfg.llm.base_url, "https://api.deepseek.com")

    def test_custom_values(self):
        cfg = AppConfig(
            host="127.0.0.1",
            port=9000,
            feishu=FeishuConfig(app_id="test_id"),
            llm=LLMConfig(api_key="test_key"),
        )
        self.assertEqual(cfg.host, "127.0.0.1")
        self.assertEqual(cfg.port, 9000)
        self.assertEqual(cfg.feishu.app_id, "test_id")
        self.assertEqual(cfg.llm.api_key, "test_key")


class TestConfigFile(unittest.TestCase):
    """测试配置文件读写"""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        # 清理环境变量
        for k in ["FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_APP_TOKEN",
                   "FEISHU_TABLE_ID", "LLM_API_KEY"]:
            os.environ.pop(k, None)

        # 动态导入 config 并使用 mock
        import config as cfg_mod
        self.cfg_mod = cfg_mod

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_and_load(self):
        cfg = AppConfig(
            feishu=FeishuConfig(app_id="id1", app_secret="secret1"),
            llm=LLMConfig(api_key="key1", base_url="https://test.api.com"),
        )
        # Mock 配置路径到临时目录
        mock_config_dir = Path(self.tmpdir) / ".standup-tracker"
        with patch.object(self.cfg_mod, 'CONFIG_DIR', mock_config_dir):
            with patch.object(self.cfg_mod, 'CONFIG_FILE', mock_config_dir / "config.json"):
                self.cfg_mod.save_config(cfg)
                config_path = mock_config_dir / "config.json"
                self.assertTrue(config_path.exists())

                # 读回来验证
                loaded = self.cfg_mod.load_config()
                self.assertEqual(loaded.feishu.app_id, "id1")
                self.assertEqual(loaded.feishu.app_secret, "secret1")
                self.assertEqual(loaded.llm.api_key, "key1")
                self.assertEqual(loaded.llm.base_url, "https://test.api.com")

    def test_save_bitable_meta(self):
        mock_config_dir = Path(self.tmpdir) / ".standup-tracker"
        with patch.object(self.cfg_mod, 'CONFIG_DIR', mock_config_dir):
            with patch.object(self.cfg_mod, 'BITABLE_META_FILE', mock_config_dir / "bitable_meta.json"):
                self.cfg_mod.save_bitable_meta("test_app_token", "test_table_id")
                meta_path = mock_config_dir / "bitable_meta.json"
                self.assertTrue(meta_path.exists())
                data = json.loads(meta_path.read_text())
                self.assertEqual(data["app_token"], "test_app_token")
                self.assertEqual(data["table_id"], "test_table_id")

    def test_env_override(self):
        """环境变量优先于配置文件"""
        mock_config_dir = Path(self.tmpdir) / ".standup-tracker"
        mock_config_file = mock_config_dir / "config.json"

        # 先存配置文件
        cfg = AppConfig(
            feishu=FeishuConfig(app_id="from_file"),
            llm=LLMConfig(api_key="key_from_file"),
        )
        with patch.object(self.cfg_mod, 'CONFIG_DIR', mock_config_dir):
            with patch.object(self.cfg_mod, 'CONFIG_FILE', mock_config_file):
                self.cfg_mod.save_config(cfg)

                # 设置环境变量
                os.environ["FEISHU_APP_ID"] = "from_env"

                loaded = self.cfg_mod.load_config()
                self.assertEqual(loaded.feishu.app_id, "from_env")
                self.assertEqual(loaded.llm.api_key, "key_from_file")  # 无环境变量，沿用配置文件


if __name__ == "__main__":
    unittest.main()
