"""
晨会文本解析引擎单元测试
"""

import json
import sys
import unittest
from pathlib import Path

# 添加项目根到 path
_project_root = Path(__file__).parent.parent.resolve()
sys.path.insert(0, str(_project_root))

from parsers.text_parser import (
    parse_text, _rule_based_parse, _parse_ai_response, ParseResult,
    _detect_section_header, _assign_sequence_numbers,
)


class TestSectionDetection(unittest.TestCase):
    """测试段落标题识别"""

    def test_detect_yesterday(self):
        self.assertEqual(_detect_section_header("昨日完成"), "昨日完成")
        self.assertEqual(_detect_section_header("昨日完成："), "昨日完成")
        self.assertEqual(_detect_section_header("昨日完成:"), "昨日完成")
        self.assertEqual(_detect_section_header("昨日工作"), "昨日完成")
        self.assertEqual(_detect_section_header("已完成"), "昨日完成")
        self.assertEqual(_detect_section_header("完成事项"), "昨日完成")

    def test_detect_today(self):
        self.assertEqual(_detect_section_header("今日计划"), "今日计划")
        self.assertEqual(_detect_section_header("今日计划："), "今日计划")
        self.assertEqual(_detect_section_header("今日工作"), "今日计划")
        self.assertEqual(_detect_section_header("今日安排:"), "今日计划")
        self.assertEqual(_detect_section_header("待办事项"), "今日计划")
        self.assertEqual(_detect_section_header("明日计划"), "今日计划")

    def test_detect_blocked(self):
        self.assertEqual(_detect_section_header("阻塞事项"), "阻塞事项")
        self.assertEqual(_detect_section_header("阻塞"), "阻塞事项")
        self.assertEqual(_detect_section_header("阻塞："), "阻塞事项")
        self.assertEqual(_detect_section_header("风险"), "阻塞事项")
        self.assertEqual(_detect_section_header("问题"), "阻塞事项")
        self.assertEqual(_detect_section_header("卡点"), "阻塞事项")

    def test_detect_non_header(self):
        self.assertIsNone(_detect_section_header("1. 修复登录超时，张三"))
        self.assertIsNone(_detect_section_header("① 具体任务描述"))
        self.assertIsNone(_detect_section_header("普通文本行"))
        self.assertIsNone(_detect_section_header(""))


class TestSequenceNumbering(unittest.TestCase):
    """测试序号分配"""

    def test_basic_sequence(self):
        records = [
            {"站会环节": "昨日完成", "事项标题": "A"},
            {"站会环节": "昨日完成", "事项标题": "B"},
            {"站会环节": "今日计划", "事项标题": "C"},
            {"站会环节": "阻塞事项", "事项标题": "D"},
        ]
        result = _assign_sequence_numbers(records)
        self.assertEqual(result[0]["序号"], 1)
        self.assertEqual(result[1]["序号"], 2)
        self.assertEqual(result[2]["序号"], 1)
        self.assertEqual(result[3]["序号"], 1)

    def test_empty_section(self):
        records = [{"站会环节": "今日计划", "事项标题": "X"}]
        result = _assign_sequence_numbers(records)
        self.assertEqual(result[0]["序号"], 1)

    def test_no_section(self):
        records = [{"事项标题": "A"}, {"事项标题": "B"}]
        result = _assign_sequence_numbers(records)
        self.assertNotIn("序号", result[0])

    def test_mixed_ordering(self):
        records = [
            {"站会环节": "今日计划", "事项标题": "C"},
            {"站会环节": "昨日完成", "事项标题": "A"},
            {"站会环节": "今日计划", "事项标题": "D"},
            {"站会环节": "昨日完成", "事项标题": "B"},
        ]
        result = _assign_sequence_numbers(records)
        self.assertEqual(result[0]["序号"], 1)  # 今日计划 #1
        self.assertEqual(result[1]["序号"], 1)  # 昨日完成 #1
        self.assertEqual(result[2]["序号"], 2)  # 今日计划 #2
        self.assertEqual(result[3]["序号"], 2)  # 昨日完成 #2


class TestRuleBasedParse(unittest.TestCase):
    """测试规则兜底解析"""

    def test_three_section_format(self):
        """三段式标准格式"""
        text = ("昨日完成：\n"
                "1. 修复登录超时，张三，跟进\n"
                "①确认超时时间为30秒\n"
                "2. AI模型更新，学文+俊祺，跟进\n"
                "①对接苍穹平台模型\n"
                "今日计划：\n"
                "1. 目录创建，黄翔，跟进\n"
                "阻塞事项：\n"
                "1. 测试环境不稳定，小勇，跟进")
        result = _rule_based_parse(text)
        self.assertEqual(len(result.records), 4)
        # 检查环节分配
        self.assertEqual(result.records[0]["站会环节"], "昨日完成")
        self.assertEqual(result.records[1]["站会环节"], "昨日完成")
        self.assertEqual(result.records[2]["站会环节"], "今日计划")
        self.assertEqual(result.records[3]["站会环节"], "阻塞事项")

    def test_sequence_in_sections(self):
        """环节内序号从1开始"""
        text = ("昨日完成：\n"
                "1. 任务A，张三\n"
                "2. 任务B，李四\n"
                "今日计划：\n"
                "1. 任务C，王五")
        result = _rule_based_parse(text)
        self.assertEqual(result.records[0]["序号"], 1)  # 昨日完成 #1
        self.assertEqual(result.records[1]["序号"], 2)  # 昨日完成 #2
        self.assertEqual(result.records[2]["序号"], 1)  # 今日计划 #1

    def test_standard_format(self):
        """标准格式解析（无段落标题时）"""
        text = ("1. 定时任务回调及文件丢失问题，法广 + 俊祺，跟进\n"
                "①定时任务回调接口存在报错，今天15日补充日志监控。\n"
                "②生产环境对话文件丢失问题，需增加兜底逻辑。\n"
                "  -- 容器内无法找到对应的JSONL文件。")
        result = _rule_based_parse(text)
        self.assertTrue(len(result.records) > 0)
        self.assertIsNone(result.error)

        # 检查第一条记录（主项行创建的）
        r = result.records[0]
        self.assertEqual(r["事项标题"], "定时任务回调及文件丢失问题")
        # "法广 + 俊祺"作为负责人整体抓取
        self.assertIn("法广", r["负责人"])

    def test_multiple_items(self):
        """多项并存"""
        text = ("1. AI模型更新，学文跟进\n"
                "①新增对接2个苍穹平台的模型，预计16日更新测试环境\n"
                "②完成3.6、3.7及豆包模型的上线配置，今天15日优先完成\n\n"
                "2. 2级目录创建，懋鲜 + 黄翔，跟进\n"
                "①2级目录创建功能仍在开发中，需安排测试，16日前提交测试")
        result = _rule_based_parse(text)
        self.assertTrue(len(result.records) >= 1)
        r1 = result.records[0]
        self.assertIn("AI模型更新", r1["事项标题"])

    def test_empty_text(self):
        """空文本"""
        result = _rule_based_parse("")
        self.assertEqual(len(result.records), 0)

    def test_no_matches(self):
        """无匹配格式的文本"""
        result = _rule_based_parse("这是一段普通的文本\n没有标准格式")
        self.assertEqual(len(result.records), 0)

    def test_background_lines(self):
        """-- 背景行"""
        text = ("1. 文件丢失问题，张三，跟进\n"
                "①容器内找不到JSONL文件\n"
                "-- 用户执行重置操作导致覆盖原有会话数据\n"
                "-- 初步怀疑是还原操作导致的")
        result = _rule_based_parse(text)
        self.assertTrue(len(result.records) > 0)
        bg = result.records[0].get("背景说明", "")
        self.assertIn("重置操作", bg)
        self.assertIn("还原操作", bg)

    def test_indented_detail(self):
        """缩进补充行"""
        text = ("1. 回调问题，张三，跟进\n"
                "①session_id为空，需与算法侧对齐\n"
                "  不落盘的模式，session_id允许为空\n"
                "  该模式仅在内存中执行")
        result = _rule_based_parse(text)
        self.assertTrue(len(result.records) > 0)
        bg = result.records[0].get("背景说明", "")
        self.assertIn("不落盘的模式", bg)

    def test_collaborators(self):
        """协作者字段"""
        text = ("1. 目录创建，懋鲜 + 黄翔，跟进\n"
                "①测试环境先创建少量目录")
        result = _rule_based_parse(text)
        self.assertTrue(len(result.records) > 0)

    def test_parse_text_with_api_key_empty(self):
        """无 API Key 时自动降级为规则解析"""
        text = ("昨日完成：\n"
                "1. 测试任务，张三，跟进\n"
                "①测试子项描述")
        result = parse_text(text, api_key="")
        self.assertTrue(len(result.records) > 0)
        self.assertIsNone(result.error)
        # 验证段落识别
        self.assertEqual(result.records[0]["站会环节"], "昨日完成")

    def test_parse_text_empty(self):
        """parse_text 空文本"""
        result = parse_text("", api_key="")
        self.assertIsNotNone(result.error)

    def test_parse_ai_response_normal(self):
        """解析 AI 返回的正常 JSON"""
        content = '[{"事项标题": "Test", "子项描述": "Desc", "分类": "问题修复", "优先级": "P1重要"}]'
        result = _parse_ai_response(content)
        self.assertEqual(len(result.records), 1)
        self.assertEqual(result.records[0]["事项标题"], "Test")

    def test_parse_ai_response_with_markdown(self):
        """解析带 markdown 包裹的 AI 返回"""
        content = """```json
[{"事项标题": "Test", "子项描述": "Desc"}]
```"""
        result = _parse_ai_response(content)
        self.assertEqual(len(result.records), 1)

    def test_parse_ai_response_with_extra_text(self):
        """解析带多余文本的 AI 返回"""
        content = ("这是分析过程...\n"
                   '[{"事项标题": "Test1", "子项描述": "Desc1"}, '
                   '{"事项标题": "Test2", "子项描述": "Desc2"}]\n'
                   "--- 结论 ---")
        result = _parse_ai_response(content)
        self.assertEqual(len(result.records), 2)

    def test_parse_ai_response_invalid(self):
        """解析无效 JSON"""
        content = "这不是一个 JSON 格式的内容"
        result = _parse_ai_response(content)
        self.assertIsNotNone(result.error)

    def test_parse_ai_response_null_values(self):
        """处理 null 值"""
        content = '[{"事项标题": "Test", "子项描述": null, "背景说明": null}]'
        result = _parse_ai_response(content)
        self.assertEqual(len(result.records), 1)
        self.assertEqual(result.records[0]["子项描述"], "")


if __name__ == "__main__":
    unittest.main()
