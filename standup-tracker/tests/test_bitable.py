"""
Bitable 模块单元测试
"""

import sys
import unittest
from pathlib import Path

# 添加项目根到 path
_project_root = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(_project_root))

from bitable.writer import build_fields_by_name, WriteResult
from bitable.schema import FieldMap, STANDARD_FIELDS


class TestBuildFields(unittest.TestCase):
    """测试字段构建"""

    def setUp(self):
        # 模拟的 FieldMap（字段名作为 key）
        self.fm = FieldMap(mapping={
            "事项标题": "fld001",
            "子项描述": "fld002",
            "背景说明": "fld003",
            "分类": "fld004",
            "优先级": "fld005",
            "项目": "fld006",
            "是否闭环": "fld007",
            "截止日期": "fld008",
            "今日进展": "fld009",
            "当前状态": "fld010",
            "站会环节": "fld011",
            "序号": "fld012",
        }, name_mapping={
            "事项标题": "事项标题",
            "子项描述": "子项描述",
            "背景说明": "背景说明",
            "分类": "分类",
            "优先级": "优先级",
            "项目": "项目",
            "是否闭环": "是否闭环",
            "截止日期": "截止日期",
            "今日进展": "今日进展",
            "当前状态": "当前状态",
            "负责人": "负责人",
            "站会环节": "站会环节",
            "序号": "序号",
        })

    def test_basic_text_fields(self):
        """基本文本字段"""
        record = {
            "事项标题": "测试事项",
            "子项描述": "测试描述",
            "背景说明": "测试背景",
        }
        fields = build_fields_by_name(record, self.fm)
        self.assertEqual(fields.get("事项标题"), "测试事项")
        self.assertEqual(fields.get("子项描述"), "测试描述")
        self.assertEqual(fields.get("背景说明"), "测试背景")

    def test_priority_field(self):
        """单选字段"""
        record = {"优先级": "P1重要"}
        fields = build_fields_by_name(record, self.fm)
        self.assertEqual(fields.get("优先级"), "P1重要")

    def test_checkbox_field(self):
        """复选框字段"""
        record = {"是否闭环": True}
        fields = build_fields_by_name(record, self.fm)
        self.assertEqual(fields.get("是否闭环"), True)

        record2 = {"是否闭环": False}
        fields2 = build_fields_by_name(record2, self.fm)
        self.assertEqual(fields2.get("是否闭环"), False)

    def test_date_field_int(self):
        """日期字段 - 时间戳"""
        record = {"截止日期": 1718352000000}
        fields = build_fields_by_name(record, self.fm)
        self.assertEqual(fields.get("截止日期"), 1718352000000)

    def test_date_field_str(self):
        """日期字段 - 字符串"""
        record = {"截止日期": "2026-06-15"}
        fields = build_fields_by_name(record, self.fm)
        self.assertIsNotNone(fields.get("截止日期"))
        self.assertIsInstance(fields.get("截止日期"), int)

    def test_date_field_invalid(self):
        """日期字段 - 无效格式"""
        record = {"截止日期": "invalid-date"}
        fields = build_fields_by_name(record, self.fm)
        self.assertIsNone(fields.get("截止日期"))

    def test_empty_record(self):
        """空记录"""
        fields = build_fields_by_name({}, self.fm)
        self.assertEqual(len(fields), 0)

    def test_none_values(self):
        """None 值"""
        record = {"事项标题": None, "子项描述": None}
        fields = build_fields_by_name(record, self.fm)
        self.assertEqual(len(fields), 0)

    def test_user_field(self):
        """用户字段"""
        fm_with_owner = FieldMap(mapping={"负责人": "fld020"}, name_mapping={"负责人": "负责人"})
        fields = build_fields_by_name({"负责人": "ou_xxxxx"}, fm_with_owner)
        self.assertEqual(fields.get("负责人"), "ou_xxxxx")

    def test_full_record(self):
        """完整记录"""
        record = {
            "事项标题": "完整测试",
            "子项描述": "所有字段",
            "背景说明": "背景",
            "分类": "问题修复",
            "优先级": "P0紧急",
            "项目": "Alpha项目",
            "是否闭环": False,
            "今日进展": "修复中",
        }
        fields = build_fields_by_name(record, self.fm)
        # 8 个有效字段：事项标题 + 子项描述 + 背景说明 + 分类 + 优先级 + 项目 + 是否闭环 + 今日进展
        self.assertEqual(len(fields), 8)

    def test_old_title_field_name(self):
        """兼容旧字段名"""
        record = {"每日站会闭环管理": "旧标题"}
        fields = build_fields_by_name(record, self.fm)
        self.assertEqual(fields.get("事项标题"), "旧标题")

    def test_section_field(self):
        """站会环节字段"""
        record = {"站会环节": "昨日完成"}
        fields = build_fields_by_name(record, self.fm)
        self.assertEqual(fields.get("站会环节"), "昨日完成")

    def test_section_field_invalid(self):
        """无效站会环节值"""
        record = {"站会环节": "无效环节"}
        fields = build_fields_by_name(record, self.fm,
            field_options={"站会环节": ["昨日完成", "今日计划", "阻塞事项"]})
        self.assertNotIn("站会环节", fields)

    def test_full_record_with_section(self):
        """含站会环节的完整记录"""
        record = {
            "事项标题": "完整测试",
            "子项描述": "所有字段",
            "站会环节": "今日计划",
            "分类": "新功能",
            "优先级": "P2一般",
        }
        fields = build_fields_by_name(record, self.fm)
        self.assertEqual(fields.get("站会环节"), "今日计划")
        self.assertEqual(fields.get("事项标题"), "完整测试")


class TestWriteResult(unittest.TestCase):
    """测试 WriteResult"""

    def test_default_values(self):
        result = WriteResult()
        self.assertEqual(result.success_count, 0)
        self.assertEqual(result.fail_count, 0)
        self.assertEqual(len(result.errors), 0)
        self.assertEqual(len(result.created_records), 0)

    def test_custom_values(self):
        result = WriteResult(success_count=5, fail_count=1)
        self.assertEqual(result.success_count, 5)
        self.assertEqual(result.fail_count, 1)


class TestStandardFields(unittest.TestCase):
    """测试标准字段定义"""

    def test_has_all_required_fields(self):
        """包含所有必需的字段名"""
        field_names = {f["name"] for f in STANDARD_FIELDS}
        required = {"事项标题", "项目", "站会日期", "站会环节", "子项描述", "背景说明",
                     "分类", "所属模块", "优先级", "负责人", "协作者", "当前状态", "截止日期",
                     "今日进展", "下一步计划", "风险阻塞", "是否闭环", "闭环说明"}
        for name in required:
            self.assertIn(name, field_names, f"缺少字段: {name}")

    def test_field_count(self):
        """正好18个字段（含站会环节）"""
        self.assertEqual(len(STANDARD_FIELDS), 18, "字段数量应为18")


if __name__ == "__main__":
    unittest.main()
