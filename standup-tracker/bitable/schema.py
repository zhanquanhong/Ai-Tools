"""
Bitable 表结构定义与字段映射

通过字段名自动发现 field_id，支持多表结构兼容。
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

from .client import FeishuClient

logger = logging.getLogger(__name__)


# ── 标准字段定义 ──────────────────────────────────────────

# 字段定义: (字段名, 字段类型, 是否为单选预定义)
STANDARD_FIELDS: list[dict] = [
    {"name": "事项标题", "type": 1},       # 主字段，Text
    {"name": "项目", "type": 3},            # SingleSelect
    {"name": "站会日期", "type": 5},        # DateTime - 所属晨会日期
    {"name": "站会环节", "type": 3},        # SingleSelect: 昨日完成/今日计划/阻塞事项
    {"name": "子项描述", "type": 1},        # Text
    {"name": "背景说明", "type": 1},        # Text
    {"name": "分类", "type": 3},            # SingleSelect: 问题修复/新功能/配置变更/方案评估
    {"name": "所属模块", "type": 3},        # SingleSelect
    {"name": "优先级", "type": 3},          # SingleSelect: P0紧急/P1重要/P2一般/P3低优
    {"name": "负责人", "type": 11},         # User
    {"name": "协作者", "type": 11},         # User
    {"name": "当前状态", "type": 3},        # SingleSelect: 待处理/处理中/待验证/已闭环
    {"name": "截止日期", "type": 5},        # DateTime
    {"name": "今日进展", "type": 1},        # Text
    {"name": "下一步计划", "type": 1},       # Text
    {"name": "风险阻塞", "type": 1},        # Text
    {"name": "是否闭环", "type": 7},        # Checkbox
    {"name": "闭环说明", "type": 1},        # Text
]

# 预定义选项
FIELD_OPTIONS: dict[str, list[str]] = {
    "分类": ["问题修复", "新功能", "配置变更", "方案评估"],
    "优先级": ["P0紧急", "P1重要", "P2一般", "P3低优"],
    "当前状态": ["待处理", "处理中", "待验证", "已闭环"],
    "站会环节": ["昨日完成", "今日计划", "阻塞事项"],
}

# 前端动态生成的字段（不在 Bitable 中存储）
FRONTEND_ONLY_FIELDS = {"序号"}

# 自动编号字段
AUTO_NUMBER_FIELDS = {"编号"}


@dataclass
class FieldMap:
    """字段名到 field_id 的映射"""
    mapping: dict[str, str] = field(default_factory=dict)
    # field_id 到原始字段名的反向映射
    reverse_mapping: dict[str, str] = field(default_factory=dict)
    # 规范字段名到 Bitable 实际字段名的映射
    name_mapping: dict[str, str] = field(default_factory=dict)

    def get(self, name: str) -> Optional[str]:
        """按字段名获取 field_id"""
        return self.mapping.get(name)

    def get_by_id(self, field_id: str) -> Optional[str]:
        """按 field_id 获取原始字段名"""
        return self.reverse_mapping.get(field_id)

    def __getitem__(self, name: str) -> str:
        v = self.mapping.get(name)
        if not v:
            raise KeyError(f"字段 '{name}' 不存在，可用字段: {list(self.mapping.keys())}")
        return v

    def get_real_name(self, canonical_name: str) -> Optional[str]:
        """获取规范名对应的 Bitable 实际字段名"""
        return self.name_mapping.get(canonical_name)


def discover_field_ids(client: FeishuClient, app_token: str, table_id: str,
                        remote_fields: Optional[list[dict]] = None) -> FieldMap:
    """从飞书自动发现字段名→ID 映射

    Args:
        client: 飞书客户端
        app_token: Bitable app_token
        table_id: 表 ID
        remote_fields: 可选，已拉取的字段列表（避免重复 API 调用）

    Returns:
        FieldMap 对象
    """
    if remote_fields is None:
        remote_fields = client.list_fields(app_token, table_id)

    name_to_id = {}
    id_to_name = {}
    name_mapping = {}

    for f in remote_fields:
        fname = f["field_name"]
        fid = f["field_id"]
        name_to_id[fname] = fid
        id_to_name[fid] = fname

        # 兼容：每日站会闭环管理 → 事项标题
        if fname == "每日站会闭环管理":
            name_to_id["事项标题"] = fid
            name_mapping["事项标题"] = fname
        else:
            name_mapping[fname] = fname

    # 补充字段名映射（确保所有标准字段都有映射）
    for sf in STANDARD_FIELDS:
        name = sf["name"]
        if name not in name_mapping and name in name_to_id:
            name_mapping[name] = name

    return FieldMap(mapping=name_to_id, reverse_mapping=id_to_name, name_mapping=name_mapping)
