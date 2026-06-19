"""
standup-tracker 配置管理
"""

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class FeishuConfig:
    """飞书 API 配置"""
    app_id: str = ""
    app_secret: str = ""
    app_token: str = ""
    table_id: str = ""


@dataclass
class LLMConfig:
    """AI 模型配置"""
    provider: str = "deepseek"  # deepseek | openai
    api_key: str = ""
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-v4-flash"
    timeout: int = 60


@dataclass
class AppConfig:
    """应用配置"""
    host: str = "0.0.0.0"
    port: int = 8899
    debug: bool = False

    feishu: FeishuConfig = field(default_factory=FeishuConfig)
    llm: LLMConfig = field(default_factory=LLMConfig)


# 默认配置路径
CONFIG_DIR = Path.home() / ".standup-tracker"
CONFIG_FILE = CONFIG_DIR / "config.json"
BITABLE_META_FILE = CONFIG_DIR / "bitable_meta.json"

# 环境变量到配置字段的映射
_ENV_MAP: list[tuple[str, str, str]] = [
    ("FEISHU_APP_ID", "feishu", "app_id"),
    ("FEISHU_APP_SECRET", "feishu", "app_secret"),
    ("FEISHU_APP_TOKEN", "feishu", "app_token"),
    ("FEISHU_TABLE_ID", "feishu", "table_id"),
    ("LLM_API_KEY", "llm", "api_key"),
    ("LLM_BASE_URL", "llm", "base_url"),
    ("LLM_MODEL", "llm", "model"),
    ("LLM_PROVIDER", "llm", "provider"),
    ("PORT", "", "port"),
    ("HOST", "", "host"),
]


def load_config() -> AppConfig:
    """
    加载配置，优先级：环境变量 > 配置文件 > 默认值

    流程：
    1. 先读取配置文件（如果存在）
    2. 环境变量覆盖（环境变量 > 配置文件）
    """
    cfg = AppConfig()

    # 1. 读取配置文件
    if CONFIG_FILE.exists():
        try:
            file_cfg = json.loads(CONFIG_FILE.read_text())
            _apply_dict(cfg, file_cfg)
        except (json.JSONDecodeError, OSError) as e:
            import logging
            logging.getLogger(__name__).warning("配置解析失败: %s", e)

    # 2. 读取 bitable meta（比配置文件优先级低）
    if BITABLE_META_FILE.exists():
        try:
            meta = json.loads(BITABLE_META_FILE.read_text())
            if not cfg.feishu.app_token:
                cfg.feishu.app_token = meta.get("app_token", "")
            if not cfg.feishu.table_id:
                cfg.feishu.table_id = meta.get("table_id", "")
        except (json.JSONDecodeError, OSError):
            pass

    # 3. 环境变量覆盖（最高优先级）
    for env_key, section, field in _ENV_MAP:
        val = os.environ.get(env_key)
        if val is not None and val != "":
            if section == "":
                setattr(cfg, field, _convert_val(cfg, field, val))
            else:
                sub = getattr(cfg, section)
                setattr(sub, field, _convert_val(sub, field, val))

    return cfg


def _convert_val(obj: object, field: str, val: str):
    """将环境变量字符串转为字段期望的类型"""
    if field in ("port", "timeout"):
        return int(val)
    if field in ("debug",):
        return val.lower() in ("1", "true", "yes")
    return val


def _apply_dict(cfg: AppConfig, data: dict) -> None:
    """将配置文件中的值应用到配置对象（覆盖默认值，但会被后续环境变量覆盖）"""
    if "feishu" in data and isinstance(data["feishu"], dict):
        f = data["feishu"]
        if f.get("app_id"):
            cfg.feishu.app_id = f["app_id"]
        if f.get("app_secret"):
            cfg.feishu.app_secret = f["app_secret"]
        if f.get("app_token"):
            cfg.feishu.app_token = f["app_token"]
        if f.get("table_id"):
            cfg.feishu.table_id = f["table_id"]

    if "llm" in data and isinstance(data["llm"], dict):
        l = data["llm"]
        if l.get("api_key"):
            cfg.llm.api_key = l["api_key"]
        if l.get("base_url"):
            cfg.llm.base_url = l["base_url"]
        if l.get("model"):
            cfg.llm.model = l["model"]
        if l.get("provider"):
            cfg.llm.provider = l["provider"]


def save_config(cfg: AppConfig) -> None:
    """保存配置到文件"""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    data = {
        "feishu": {
            "app_id": cfg.feishu.app_id,
            "app_secret": cfg.feishu.app_secret,
            "app_token": cfg.feishu.app_token,
            "table_id": cfg.feishu.table_id,
        },
        "llm": {
            "provider": cfg.llm.provider,
            "api_key": cfg.llm.api_key,
            "base_url": cfg.llm.base_url,
            "model": cfg.llm.model,
        },
    }
    CONFIG_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    os.chmod(CONFIG_FILE, 0o600)


def save_bitable_meta(app_token: str, table_id: str) -> None:
    """保存 Bitable 元数据（自动创建时写入）"""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    BITABLE_META_FILE.write_text(
        json.dumps({"app_token": app_token, "table_id": table_id}, indent=2, ensure_ascii=False)
    )
