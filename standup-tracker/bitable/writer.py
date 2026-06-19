"""
Bitable 写入/更新逻辑

提供批量写入、更新、查询记录的封装。

注意：飞书 Bitable API 使用字段名（中文名）作为 records 中 fields 的 key，
而非字段 ID（"fldxxxx"）。本模块直接使用字段名构造请求。
"""

import datetime
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

from .client import FeishuClient, FeishuAPIError
from .schema import FieldMap

logger = logging.getLogger(__name__)


@dataclass
class WriteResult:
    """写入结果"""
    success_count: int = 0
    fail_count: int = 0
    errors: list[str] = field(default_factory=list)
    created_records: list[dict] = field(default_factory=list)
    skipped_fields: list[str] = field(default_factory=list)


def build_fields_by_name(record: dict, field_map: FieldMap,
                         field_options: Optional[dict[str, list[str]]] = None) -> dict:
    """
    将业务字段 dict 转为飞书 API 接受的字段格式。

    使用 Bitable 实际的字段名（可能不同于规范名）作为 key。
    SingleSelect 字段的值会校验是否在可用选项中，不在则跳过该字段。

    Args:
        record: 业务记录
        field_map: 字段名↔ID 映射
        field_options: 单选字段可用选项 {字段名: [选项1, 选项2, ...]}

    Returns:
        飞书 API 字段 dict
    """

    def _rn(canonical_name: str) -> Optional[str]:
        """获取 Bitable 真实字段名"""
        return field_map.get_real_name(canonical_name)

    fields: dict[str, Any] = {}

    # 事项标题（主字段）
    title = record.get("事项标题") or record.get("每日站会闭环管理") or ""
    fname = _rn("事项标题")
    if title and fname:
        fields[fname] = _safe_text(title)

    # 文本类字段（无需校验，直接写）
    for fn in ("子项描述", "背景说明", "今日进展", "下一步计划", "风险阻塞", "闭环说明"):
        val = record.get(fn)
        fname = _rn(fn)
        if val and fname:
            fields[fname] = _safe_text(val)

    # 项目字段：用户自由输入，不校验 Bitable 预设选项
    val = record.get("项目")
    fname = _rn("项目")
    if val and fname:
        fields[fname] = _safe_text(val)

    # 其他单选字段：校验值是否在 Bitable 可用选项中，不在则跳过
    for fn in ("分类", "所属模块", "优先级", "当前状态", "站会环节"):
        val = record.get(fn)
        fname = _rn(fn)
        if val and fname:
            if field_options and fn in field_options:
                # 值在选项中 → 写入; 不在 → 跳过字段
                if val in field_options[fn]:
                    fields[fname] = _safe_text(val)
                else:
                    logger.info("跳过字段 '%s': 值 '%s' 不在可用选项中", fn, val)
            else:
                fields[fname] = _safe_text(val)

    # 日期字段 (timestamp_ms)
    due = record.get("截止日期")
    fname = _rn("截止日期")
    if due and fname:
        if isinstance(due, (int, float)):
            fields[fname] = int(due)
        elif isinstance(due, str):
            try:
                dt = datetime.datetime.strptime(due[:10], "%Y-%m-%d")
                fields[fname] = int(dt.timestamp() * 1000)
            except ValueError:
                logger.warning("无法解析日期: %s", due)

    # 站会日期
    meeting_date = record.get("站会日期")
    fname = _rn("站会日期")
    if meeting_date and fname:
        if isinstance(meeting_date, (int, float)):
            fields[fname] = int(meeting_date)
        elif isinstance(meeting_date, str):
            try:
                dt = datetime.datetime.strptime(meeting_date[:10], "%Y-%m-%d")
                fields[fname] = int(dt.timestamp() * 1000)
            except ValueError:
                logger.warning("无法解析站会日期: %s", meeting_date)

    # 复选框
    closed = record.get("是否闭环")
    fname = _rn("是否闭环")
    if closed is not None and fname:
        fields[fname] = bool(closed)

    # 负责人（Text 类型，直接写入中文名）
    owner = record.get("负责人")
    fname = _rn("负责人")
    if owner and fname:
        fields[fname] = _safe_text(owner)

    # 协作者（Text 类型，直接写入中文名）
    collab = record.get("协作者")
    fname = _rn("协作者")
    if collab and fname:
        fields[fname] = _safe_text(collab)

    return fields


def _safe_text(value: Any) -> str:
    """安全转为文本"""
    if value is None:
        return ""
    if not isinstance(value, str):
        return str(value)
    return value


def batch_write_records(client: FeishuClient, app_token: str, table_id: str,
                        field_map: FieldMap, records: list[dict],
                        field_options: Optional[dict[str, list[str]]] = None) -> WriteResult:
    """
    批量写入记录

    Args:
        client: 飞书客户端
        app_token: Bitable app_token
        table_id: 表 ID
        field_map: 字段映射
        records: 业务记录列表（字段名为中文名）
        field_options: 单选字段可用选项，用于验证字段值合法性

    Returns:
        写入结果
    """
    result = WriteResult()

    api_records = []
    for r in records:
        fields = build_fields_by_name(r, field_map, field_options)
        if not fields:
            result.fail_count += 1
            result.errors.append(f"记录无有效字段: {r.get('事项标题', '')}")
            logger.warning("写入跳过: 记录无有效字段 - %s", r.get('事项标题', ''))
            continue
        api_records.append(fields)

    if not api_records:
        result.errors.append("无有效记录可写入")
        return result

    try:
        created = client.batch_create_records(app_token, table_id, api_records)
        result.success_count = len(created)
        result.created_records = created
        logger.info("批量写入 %d 条，成功 %d 条", len(api_records), len(created))
    except FeishuAPIError as e:
        # 批量失败时逐条写入，跳过无效记录
        logger.warning("批量写入失败: %s，尝试逐条写入", e)
        for idx, rec in enumerate(api_records):
            try:
                created = client.create_record(app_token, table_id, rec)
                result.success_count += 1
                result.created_records.append(created)
            except FeishuAPIError as e2:
                title = rec.get(list(rec.keys())[0], "?")
                result.fail_count += 1
                result.errors.append(f"写入失败 [{title}]: {e2}")
                logger.warning("逐条写入失败 [idx=%d]: %s - %s", idx, title, e2)
        logger.info("逐条写入完成: 成功 %d, 失败 %d", result.success_count, result.fail_count)
    except Exception as e:
        result.fail_count = len(api_records)
        result.errors.append(f"批量写入异常: {e}")
        logger.error("批量写入异常: %s", e)

    return result


@dataclass
class DeleteResult:
    """删除结果"""
    success_count: int = 0
    fail_count: int = 0
    errors: list[str] = field(default_factory=list)


def batch_delete_records(client: FeishuClient, app_token: str, table_id: str,
                         record_ids: list[str]) -> DeleteResult:
    """批量删除记录"""
    result = DeleteResult()
    if not record_ids:
        return result

    try:
        client.batch_delete_records(app_token, table_id, record_ids)
        result.success_count = len(record_ids)
        logger.info("批量删除 %d 条记录", len(record_ids))
    except FeishuAPIError as e:
        logger.warning("批量删除失败: %s，尝试逐条删除", e)
        for rid in record_ids:
            try:
                client.batch_delete_records(app_token, table_id, [rid])
                result.success_count += 1
            except FeishuAPIError as e2:
                result.fail_count += 1
                result.errors.append(f"删除失败 [{rid}]: {e2}")
        logger.info("逐条删除完成: 成功 %d, 失败 %d", result.success_count, result.fail_count)
    except Exception as e:
        result.fail_count = len(record_ids)
        result.errors.append(f"批量删除异常: {e}")
        logger.error("批量删除异常: %s", e)

    return result


def query_open_records(client: FeishuClient, app_token: str, table_id: str,
                       field_map: FieldMap, project: Optional[str] = None,
                       meeting_date: Optional[str] = None,
                       status: Optional[str] = None,
                       keyword: Optional[str] = None) -> list[dict]:
    """
    查询记录（获取全部后在服务端过滤）

    Feishu API 返回的字段 key 可能是 field_id 或字段名，两种都兼容。
    """
    records = client.list_records(app_token, table_id)

    def _get(fields: dict, canonical_name: str):
        """从字段 dict 中取值，兼容 field_id 和字段名两种 key"""
        fid = field_map.get(canonical_name)
        val = fields.get(fid) if fid else None
        if val is None:
            real_name = field_map.get_real_name(canonical_name)
            val = fields.get(real_name) if real_name else None
        if val is None:
            val = fields.get(canonical_name)
        return val

    def _extract_text(val):
        if val is None:
            return None
        if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
            return "".join(item.get("text", "") for item in val if isinstance(item, dict))
        if isinstance(val, bool):
            return None if val else ""
        return str(val)

    filtered = []

    for r in records:
        fields = r.get("fields", {})

        if project:
            project_val = _extract_text(_get(fields, "项目"))
            if project_val != project:
                continue

        if meeting_date:
            date_val = _get(fields, "站会日期")
            if date_val:
                import datetime as dt
                try:
                    md = dt.datetime.strptime(meeting_date[:10], "%Y-%m-%d")
                    md_ts = int(md.timestamp() * 1000)
                    date_end = md_ts + 86400000
                    if isinstance(date_val, (int, float)):
                        if not (md_ts <= date_val < date_end):
                            continue
                except ValueError:
                    continue

        if status:
            status_val = _extract_text(_get(fields, "当前状态"))
            if not status_val:
                continue
            if status_val != status:
                continue

        if keyword:
            title_val = _extract_text(_get(fields, "事项标题")) or ""
            desc_val = _extract_text(_get(fields, "子项描述")) or ""
            if keyword not in title_val and keyword not in desc_val:
                continue

        filtered.append(r)

    return filtered


def batch_update_progress(client: FeishuClient, app_token: str, table_id: str,
                          field_map: FieldMap, updates: list[dict],
                          field_options: Optional[dict[str, list[str]]] = None) -> WriteResult:
    """
    批量更新进展

    Args:
        client: 飞书客户端
        app_token: Bitable app_token
        table_id: 表 ID
        field_map: 字段映射
        updates: [{"record_id": "...", "今日进展": "...", "当前状态": "..."}]
        field_options: 单选字段可用选项，用于验证字段值合法性

    Returns:
        更新结果
    """
    result = WriteResult()

    api_records = []
    for u in updates:
        record_id = u.pop("record_id", None)
        if not record_id:
            result.fail_count += 1
            result.errors.append("缺少 record_id")
            continue
        fields = build_fields_by_name(u, field_map, field_options)
        if fields:
            api_records.append({"record_id": record_id, "fields": fields})

    if not api_records:
        return result

    try:
        updated = client.batch_update_records(app_token, table_id, api_records)
        result.success_count = len(updated)
        logger.info("批量更新 %d 条，成功 %d 条", len(api_records), len(updated))
    except Exception as e:
        result.fail_count = len(api_records)
        result.errors.append(f"批量更新失败: {e}")
        logger.error("批量更新失败: %s", e)

    return result
