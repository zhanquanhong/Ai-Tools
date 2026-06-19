"""
晨会文本解析引擎

将非结构化的晨会速记文本解析为结构化记录。
支持通过 AI API（DeepSeek/OpenAI）自动解析，也支持纯规则兜底。
"""

import datetime
import json
import logging
import re
import ssl
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError

logger = logging.getLogger(__name__)

# ── 站会环节段落标题识别 ─────────────────────────────

# 段落标题与"站会环节"的映射
_SECTION_PATTERNS: list[tuple[re.Pattern, str]] = [
    # 昨日完成
    (re.compile(r'^(?:昨日完成|昨日工作|已完成|上周完成|上周工作|完成事项)(?:\s*[：:\-—]\s*)?$'), "昨日完成"),
    # 今日计划
    (re.compile(r'^(?:今日计划|今日工作|今日安排|今日待办|今日事项|接下来|明日计划|明日工作|待办事项)(?:\s*[：:\-—]\s*)?$'), "今日计划"),
    # 阻塞事项
    (re.compile(r'^(?:阻塞事项|阻塞|阻碍|风险|问题|需要帮助|求助|需协调|卡点)(?:\s*[：:\-—]\s*)?$'), "阻塞事项"),
]

# 段落标题行特征（以关键词开头，后面可能有冒号）
_SECTION_HEADER_PAIRS: list[tuple[str, str]] = [
    ("昨日完成", "昨日完成"),
    ("昨日工作", "昨日完成"),
    ("已完成", "昨日完成"),
    ("上周完成", "昨日完成"),
    ("完成事项", "昨日完成"),
    ("今日计划", "今日计划"),
    ("今日工作", "今日计划"),
    ("今日安排", "今日计划"),
    ("今日待办", "今日计划"),
    ("明日计划", "今日计划"),
    ("明日工作", "今日计划"),
    ("待办事项", "今日计划"),
    ("阻塞事项", "阻塞事项"),
    ("阻塞", "阻塞事项"),
    ("风险", "阻塞事项"),
    ("问题", "阻塞事项"),
    ("需要帮助", "阻塞事项"),
    ("卡点", "阻塞事项"),
    ("需协调", "阻塞事项"),
]


# ── 工具函数 ──────────────────────────────────────────

def _assign_sequence_numbers(records: list[dict]) -> list[dict]:
    """按站会环节分组，每组内从1开始分配序号

    Args:
        records: 解析后的记录列表（按原文顺序排列）

    Returns:
        补全了"序号"字段的记录列表
    """
    # 各环节序号计数器
    counters: dict[str, int] = {}
    for r in records:
        section = r.get("站会环节", "")
        if not section:
            continue
        if section not in counters:
            counters[section] = 0
        counters[section] += 1
        r["序号"] = counters[section]
    return records


def _detect_section_header(line: str) -> Optional[str]:
    """检测一行文本是否为站会环节段落标题

    Args:
        line: 单行文本（已 strip）

    Returns:
        匹配的环节名称，无匹配返回 None
    """
    for pattern, section in _SECTION_PATTERNS:
        if pattern.match(line):
            return section
    # 兜底：关键词匹配
    line_lower = line.replace(" ", "").replace("　", "").lower()
    for keyword, section in _SECTION_HEADER_PAIRS:
        if line_lower.startswith(keyword):
            return section
    return None


@dataclass
class ParseResult:
    """解析结果"""
    records: list[dict] = field(default_factory=list)
    raw_response: str = ""
    error: Optional[str] = None


# ── 解析提示词 ──────────────────────────────────────────

def _build_prompt(today: Optional[datetime.date] = None,
                  field_options: Optional[dict[str, list[str]]] = None) -> str:
    """构建解析提示词（动态注入当前日期和字段可选值）

    Args:
        today: 当前日期，默认今天
        field_options: Bitable 单选字段的可用选项列表
    """
    if today is None:
        today = datetime.date.today()
    date_str = today.strftime("%Y-%m-%d")
    chinese_date = f"{today.year}年{today.month}月{today.day}日"

    # 单选字段可选值提示
    option_hints = {
        "分类": "问题修复/新功能/配置变更/方案评估",
        "优先级": "P0紧急/P1重要/P2一般/P3低优",
        "当前状态": "待处理/处理中/待验证/已闭环",
        "站会环节": "昨日完成/今日计划/阻塞事项",
    }

    # 从 Bitable 实际选项中覆盖
    if field_options:
        for field_name, opts in field_options.items():
            if opts:
                option_hints[field_name] = "/".join(opts)

    prompt = f"""你是一个项目助理，将每日站会（晨会）的会议记录解析为 JSON 数组。

当前日期：{chinese_date}（{date_str}）
注意：今天是{chinese_date}！不是其他日期！

## 输入格式
晨会记录通常按三个阶段组织，示例如下：

昨日完成：
1. 修复登录超时问题，张三，跟进
   ① 确认超时时间为30秒，已增加到配置项
2. AI模型更新，学文+俊祺，跟进
   ① 已对接苍穹平台2个模型，预计今天更新测试环境
   ② 完成豆包模型的上线配置
   -- 3.6/3.7 模型需联调确认

今日计划：
1. 二级目录创建，懋鲜+黄翔，跟进
   ① 功能仍处开发阶段，安排16日前测试
2. 日志补充监控，法广，跟进

阻塞事项：
1. 测试环境不稳定，小勇，跟进
   -- 容器频繁重启，需运维协助排查

## 输出格式
每条记录是一个 JSON 对象，严格输出 JSON 数组（不要 markdown 包裹）：

  "事项标题": "大项标题，如修复登录超时问题",
  "子项描述": "具体任务描述，如确认超时时间为30秒",
  "背景说明": "从--后的内容提取，没有则留空",
  "站会环节": "从以下可选值中选择: {option_hints['站会环节']}",
  "分类": "从以下可选值中选择: {option_hints['分类']}",
  "所属模块": "从以下可选值中选择: {option_hints['所属模块']}",
  "优先级": "从以下可选值中选择: {option_hints['优先级']}",
  "负责人": "主要责任人姓名",
  "协作者": "协作者，无则留空",
  "当前状态": "从以下可选值中选择: {option_hints['当前状态']}",
  "截止日期": "YYYY-MM-DD格式，无则留空",
  "今日进展": "已有进展描述，无则留空",
  "下一步计划": "下一步行动，无则留空",
  "风险阻塞": "卡点，无则留空"

## 规则
1. 站会环节识别：通过段落标题（"昨日完成"/"今日计划"/"阻塞事项"）判断每条记录所属环节，标题下的所有事项归入该环节
2. 序号：你不需要输出序号，系统会自动分配
3. 每条带①、②标记的子项拆成一条独立记录，大项标题不变
4. 截止日期："今天"=今天，"15日"=本月15日
5. 分类：报错/丢失/修复=问题修复，开发/新增/创建=新功能，更新/配置/上线=配置变更，评估/方案/调研=方案评估
6. 优先级：生产问题=P1，有截止日期的功能=P2，优化类=P3
7. **【重要】负责人必须从"1. 事项名称，负责人，跟进"中的负责人位置提取。多人合作时保留"A+B"格式，如"学文+俊祺"**
8. **【重要】尽量填充更多字段：今日进展、下一步计划、风险阻塞从原文中提取，不要留空**
9. 没有明确信息的字段留空字符串，不要编造
10. **【重要】单选字段的值必须从上方"可选值"中选择，不能编造不存在的值**
11. 严格输出 JSON 数组，不要输出其他内容"""

    return prompt


def parse_text(text: str, api_key: str, base_url: str = "https://api.deepseek.com",
               model: str = "deepseek-v4-flash",
               field_options: Optional[dict[str, list[str]]] = None) -> ParseResult:
    """
    解析晨会文本

    Args:
        text: 晨会记录文本
        api_key: LLM API Key
        base_url: API 地址
        model: 模型名
        field_options: Bitable 单选字段可选值，用于约束 LLM 输出

    Returns:
        解析结果
    """
    if not text.strip():
        return ParseResult(error="文本为空")

    if not api_key:
        logger.warning("未配置 API Key，使用规则兜底解析")
        return _rule_based_parse(text)

    return _ai_parse(text, api_key, base_url, model, field_options)


def _ai_parse(text: str, api_key: str, base_url: str, model: str,
              field_options: Optional[dict[str, list[str]]] = None) -> ParseResult:
    """使用 AI 解析"""
    provider = "deepseek"
    if "openai" in base_url.lower():
        provider = "openai"

    messages = [
        {"role": "system", "content": _build_prompt(field_options=field_options)},
        {"role": "user", "content": f"请解析以下晨会记录：\n\n{text}"},
    ]

    request_body = json.dumps({
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "response_format": {"type": "json_object"},
        "max_tokens": 4096,
    }).encode("utf-8")

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    # OpenAI API 兼容格式
    url = f"{base_url.rstrip('/')}/chat/completions"

    if provider == "deepseek" and "deepseek.com" in base_url:
        pass  # 已经是兼容格式

    req = Request(url, data=request_body, headers=headers, method="POST")

    try:
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        with urlopen(req, timeout=120, context=ssl_ctx) as resp:
            response_data = json.loads(resp.read().decode("utf-8"))
    except URLError as e:
        return ParseResult(error=f"AI 请求失败: {e.reason}")
    except json.JSONDecodeError as e:
        return ParseResult(error=f"AI 响应解析失败: {e}")
    except TimeoutError as e:
        return ParseResult(error=f"AI 请求超时: {e}")
    except Exception as e:
        return ParseResult(error=f"解析异常: {e}")

    content = ""
    try:
        content = response_data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        return ParseResult(error=f"AI 返回格式异常: {e}", raw_response=str(response_data))

    result = _parse_ai_response(content)
    if result.error:
        logger.warning("AI 解析失败，降级到规则兜底: %s", result.error)
        fallback = _rule_based_parse(text)
        if fallback.records:
            return fallback
        return result

    # 分配序号
    result.records = _assign_sequence_numbers(result.records)
    return result


def _parse_ai_response(content: str) -> ParseResult:
    """解析 AI 返回的 JSON，支持多种格式的清理"""
    cleaned = content.strip()

    # Step 1: 去掉 markdown 包裹
    if "```" in cleaned:
        lines = cleaned.split("\n")
        fences = [i for i, l in enumerate(lines) if l.strip().startswith("```")]
        if len(fences) >= 2:
            start = fences[0] + 1
            end = fences[-1]
            cleaned = "\n".join(lines[start:end]).strip()
        elif len(fences) == 1:
            cleaned = "\n".join(lines[fences[0] + 1:]).strip()

    cleaned = cleaned.replace("```json", "").replace("```", "").strip()

    # Step 3: 尝试直接解析 JSON
    try:
        records = json.loads(cleaned)
        if not isinstance(records, list):
            records = [records]
        for r in records:
            for k, v in list(r.items()):
                if v is None:
                    r[k] = ""
        return ParseResult(records=records, raw_response=content)
    except json.JSONDecodeError:
        pass

    # Step 4: 尝试提取 JSON 数组片段
    json_match = re.search(r'\[([\s\S]*)\]', cleaned)
    if json_match:
        candidate = "[" + json_match.group(1) + "]"
        try:
            records = json.loads(candidate)
            if isinstance(records, list):
                return ParseResult(records=records, raw_response=content)
        except json.JSONDecodeError:
            pass

    logger.warning("AI 返回无法解析为 JSON. 原始响应(前500字): %s", content[:500])
    return ParseResult(error="AI 返回内容非 JSON 格式", raw_response=content)


def _rule_based_parse(text: str) -> ParseResult:
    """
    纯规则兜底解析（无 AI 时使用）

    解析格式：
    昨日完成：
    1. 事项名称，负责人，跟进
       ① 子项描述
       -- 背景说明

    今日计划：
    1. 事项名称，负责人

    阻塞事项：
    1. 问题描述，负责人
    """
    records = []
    lines = text.strip().split("\n")
    current_section = ""
    current_title = ""
    last_main_lineno = -1  # 主项所在行号，用于检测子项归属

    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped:
            continue

        # 检测段落标题
        detected_section = _detect_section_header(stripped)
        if detected_section:
            current_section = detected_section
            continue

        # 匹配主项 "1. xxx，负责人，跟进"
        main_match = re.match(r"^(\d+)\.\s*(.+?)(?:，|,\s*)(.+?)(?:，|,\s*)(跟进|处理|负责)", stripped)
        if main_match:
            current_title = main_match.group(2).strip()
            owner = main_match.group(3).strip()
            last_main_lineno = i
            records.append({
                "事项标题": current_title,
                "站会环节": current_section,
                "子项描述": "",
                "背景说明": "",
                "分类": _default_classification(current_section),
                "所属模块": "",
                "优先级": "P1重要" if current_section == "阻塞事项" else "P2一般",
                "负责人": owner,
                "协作者": "",
                "当前状态": "处理中",
                "截止日期": "",
                "今日进展": "",
                "下一步计划": "",
                "风险阻塞": "",
            })
            continue

        # 匹配 "2. xxx，负责人"（没有跟进）
        main_match2 = re.match(r"^(\d+)\.\s*(.+?)(?:，|,\s*)(.+?)$", stripped)
        if main_match2:
            parts = stripped.split("。")[0]  # 避免句号截断
            # 重新解析
            main_match2 = re.match(r"^(\d+)\.\s*(.+?)(?:，|,\s*)(.+?)$", parts)
            if main_match2:
                current_title = main_match2.group(2).strip()
                owner = main_match2.group(3).strip()
                last_main_lineno = i
                records.append({
                    "事项标题": current_title,
                    "站会环节": current_section,
                    "子项描述": "",
                    "背景说明": "",
                    "分类": _default_classification(current_section),
                    "所属模块": "",
                    "优先级": "P1重要" if current_section == "阻塞事项" else "P2一般",
                    "负责人": owner,
                    "协作者": "",
                    "当前状态": "处理中",
                    "截止日期": "",
                    "今日进展": "",
                    "下一步计划": "",
                    "风险阻塞": "",
                })
                continue

        # 匹配子项 "① xxx" 或 "(1) xxx" 或 "- xxx"
        sub_match = re.match(r"[①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩]+\s*(.*)", stripped)
        if not sub_match:
            sub_match = re.match(r"^[\(\（]?[①|②|③|④|⑤|⑥|⑦|⑧|⑨|⑩|0-9]+[\)\）]?\s*(.*)", stripped)
        if sub_match:
            desc = sub_match.group(1).strip()
            if records:
                if records[-1]["子项描述"]:
                    records[-1]["子项描述"] += "\n" + desc
                else:
                    records[-1]["子项描述"] = desc
            else:
                records.append({
                    "事项标题": current_title or "未分类事项",
                    "站会环节": current_section,
                    "子项描述": desc,
                    "背景说明": "",
                    "分类": _default_classification(current_section),
                    "所属模块": "",
                    "优先级": "P2一般",
                    "负责人": "",
                    "协作者": "",
                    "当前状态": "待处理",
                    "截止日期": "",
                    "今日进展": "",
                    "下一步计划": "",
                    "风险阻塞": "",
                })
            continue

        # 匹配背景补充 "-- xxx"
        bg_match = re.match(r"--\s*(.*)", stripped)
        if bg_match and records:
            bg = bg_match.group(1).strip()
            if records[-1]["背景说明"]:
                records[-1]["背景说明"] += "\n" + bg
            else:
                records[-1]["背景说明"] = bg
            continue

        # 缩进补充行
        if line.startswith("  ") or line.startswith("\t"):
            if records:
                if records[-1]["背景说明"]:
                    records[-1]["背景说明"] += "\n" + stripped
                else:
                    records[-1]["背景说明"] = stripped
            continue

    if not records:
        return ParseResult(error="无法解析文本格式")

    # 分配序号
    records = _assign_sequence_numbers(records)

    return ParseResult(records=records)


def _default_classification(section: str) -> str:
    """根据站会环节返回默认分类"""
    if section == "阻塞事项":
        return "问题修复"
    return "新功能"
