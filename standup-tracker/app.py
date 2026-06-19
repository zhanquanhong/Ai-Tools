"""
每日站会闭环管理系统 - FastAPI Web 服务

提供 Web UI 用于：
1. 粘贴晨会文本 → AI 解析 → 预览 → 写入 Bitable
2. 查询未闭环记录
3. 更新进展
4. 多项目管理
"""

import datetime
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# 添加项目根到 path
_project_root = Path(__file__).parent.resolve()
sys.path.insert(0, str(_project_root))

from bitable.client import FeishuClient, FeishuAPIError, AuthError
from fastapi.responses import JSONResponse
from bitable.schema import discover_field_ids, STANDARD_FIELDS, FieldMap
from bitable.writer import (
    batch_write_records,
    query_open_records,
    batch_update_progress,
    batch_delete_records,
    WriteResult,
    DeleteResult,
)
from config import AppConfig, load_config, save_config, save_bitable_meta
from parsers.text_parser import parse_text, ParseResult

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("standup-tracker")

app = FastAPI(title="每日站会闭环管理系统", version="1.1.0")

# ── 全局状态 ────────────────────────────────────────────

config: AppConfig = load_config()
client: Optional[FeishuClient] = None
# 合并缓存：一次 API 调用完成 field_map + field_options
_field_meta_cache: dict[tuple[str, str], dict] = {}


# ── 全局异常处理 ─────────────────────────────────────────

@app.exception_handler(Exception)
def global_exception_handler(request: Request, exc: Exception):
    """所有未处理异常返回 JSON 而非 HTML"""
    logger.error("未处理异常: %s", exc, exc_info=True)
    status = 500
    detail = str(exc)
    if isinstance(exc, HTTPException):
        status = exc.status_code
        detail = exc.detail
    elif isinstance(exc, (FeishuAPIError, AuthError)):
        detail = f"飞书 API 错误: {exc}"
    return JSONResponse(status_code=status, content={"ok": False, "error": detail})


def _get_client() -> FeishuClient:
    """获取或初始化飞书客户端"""
    global client
    if client is None:
        if not config.feishu.app_id or not config.feishu.app_secret:
            raise HTTPException(status_code=400, detail="飞书 API 凭证未配置")
        client = FeishuClient(config.feishu.app_id, config.feishu.app_secret)
    return client


def _get_field_map() -> dict:
    """获取字段映射（带缓存，共用一次 API 调用）"""
    return _ensure_field_meta()["field_map"]


def _get_field_options() -> dict[str, list[str]]:
    """获取单选字段可选值（带缓存，共用一次 API 调用）"""
    return _ensure_field_meta()["field_options"]


def _ensure_field_meta() -> dict:
    """一次 API 调用获取 field_map 和 field_options 并缓存"""
    if not config.feishu.app_token or not config.feishu.table_id:
        raise HTTPException(status_code=400, detail="Bitable 未配置，请先完成初始化")
    key = (config.feishu.app_token, config.feishu.table_id)
    if key not in _field_meta_cache:
        try:
            c = _get_client()
            # 一次 API 调用拿到所有字段
            remote_fields = c.list_fields(config.feishu.app_token, config.feishu.table_id)

            # 解析 field_map
            field_map = discover_field_ids(
                c, config.feishu.app_token, config.feishu.table_id,
                remote_fields=remote_fields,
            )

            # 解析 field_options（复用已拉取的数据）
            field_options = {}
            for f in remote_fields:
                if f.get("type") == 3:  # SingleSelect
                    name = f["field_name"]
                    opts = [o["name"] for o in f.get("property", {}).get("options", [])]
                    if opts:
                        field_options[name] = opts

            _field_meta_cache[key] = {
                "field_map": field_map,
                "field_options": field_options,
            }
        except Exception as e:
            logger.error("获取 Bitable 元数据失败: %s", e)
            raise HTTPException(status_code=500, detail=f"获取 Bitable 元数据失败: {e}")
    return _field_meta_cache[key]


def _dedup_records(client: FeishuClient, field_map: FieldMap,
                   records: list[dict], project: str, meeting_date: str) -> tuple[list[dict], list[str]]:
    """
    基于 事项标题+项目+站会日期 去重

    查询 Bitable 中已有记录，过滤出真正需要写入的记录。
    返回 (去重后的记录列表, 跳过的标题列表)
    """
    if not records or not meeting_date:
        return records, []

    import datetime as dt

    # 查询同项目+同日的已有记录
    existing = query_open_records(
        client, config.feishu.app_token, config.feishu.table_id,
        field_map, project=project, meeting_date=meeting_date,
    )

    if not existing:
        return records, []

    # 提取已有事项标题（去重）
    existing_titles = set()
    for r in existing:
        fields = r.get("fields", {})
        # 优先 field_id，兼容字段名
        fid = field_map.get("事项标题")
        title = None
        if fid:
            val = fields.get(fid)
            if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                title = "".join(item.get("text", "") for item in val if isinstance(item, dict))
            elif isinstance(val, str):
                title = val
        if not title:
            real_name = field_map.get_real_name("事项标题")
            if real_name:
                val = fields.get(real_name)
                if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                    title = "".join(item.get("text", "") for item in val if isinstance(item, dict))
                elif isinstance(val, str):
                    title = val
        if title:
            existing_titles.add(title.strip())

    if not existing_titles:
        return records, []

    # 过滤重复
    filtered = []
    skipped = []
    for r in records:
        title = (r.get("事项标题") or "").strip()
        if title in existing_titles:
            skipped.append(title)
        else:
            filtered.append(r)

    if skipped:
        logger.info("去重跳过 %d 条: %s", len(skipped), skipped)

    return filtered, skipped


# ── API 模型 ─────────────────────────────────────────────

class ParseRequest(BaseModel):
    """解析请求"""
    text: str
    project: str = ""
    meeting_date: str = ""  # 站会日期 YYYY-MM-DD


class ParsePreview(BaseModel):
    """解析预览结果"""
    records: list[dict] = []
    error: str = ""


class WriteRequest(BaseModel):
    """写入请求"""
    records: list[dict]
    project: str = ""
    meeting_date: str = ""


class SetupRequest(BaseModel):
    """初始化请求"""
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    feishu_app_token: str = ""
    feishu_table_id: str = ""
    llm_api_key: str = ""
    llm_base_url: str = "https://api.deepseek.com"
    llm_model: str = "deepseek-chat"


class UpdateRequest(BaseModel):
    """更新进展请求"""
    updates: list[dict]  # [{"record_id": "...", "今日进展": "...", "当前状态": "..."}]


class QueryRequest(BaseModel):
    """查询请求"""
    project: str = ""
    date: str = ""  # 按站会日期筛选 YYYY-MM-DD
    status: str = ""  # 按状态筛选
    keyword: str = ""  # 按事项标题/子项描述模糊搜索


class DeleteRequest(BaseModel):
    """删除请求"""
    record_ids: list[str]  # 要删除的记录 ID 列表


class StatsRequest(BaseModel):
    """统计请求"""
    project: str = ""
    meeting_date: str = ""  # 按站会日期筛选 YYYY-MM-DD


class StatsResponse(BaseModel):
    """统计响应"""
    total: int = 0
    todo: int = 0
    in_progress: int = 0
    closed: int = 0
    overdue: int = 0
    overdue_in_todo: int = 0
    overdue_in_progress: int = 0


# ── API 路由 ─────────────────────────────────────────────

@app.get("/api/status")
def api_status():
    """获取系统状态"""
    c = config
    # 项目列表只从实际记录中查询，无数据则不显示
    projects = []
    seen = set()
    try:
        c_client = _get_client()
        fm = _get_field_map()
        all_records = query_open_records(
            c_client, config.feishu.app_token, config.feishu.table_id, fm,
        )
        for r in all_records:
            fields = r.get("fields", {})
            val = fields.get(fm.get("项目")) if fm.get("项目") else None
            if val is None:
                real_name = fm.get_real_name("项目")
                val = fields.get(real_name) if real_name else None
            if val is None:
                val = fields.get("项目")
            if val:
                if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                    text = "".join(item.get("text", "") for item in val if isinstance(item, dict))
                else:
                    text = str(val)
                if text and text not in seen:
                    seen.add(text)
                    projects.append(text)
    except (FeishuAPIError, AuthError):
        pass

    return {
        "configured": bool(c.feishu.app_id and c.feishu.app_token and c.feishu.table_id),
        "llm_configured": bool(c.llm.api_key),
        "feishu_ready": bool(c.feishu.app_id and c.feishu.app_secret),
        "bitable_url": (
            f"https://test-dgxyap5v2pus.feishu.cn/base/{c.feishu.app_token}"
            if c.feishu.app_token else ""
        ),
        "projects": projects,
    }


@app.post("/api/setup", response_model=dict)
def api_setup(req: SetupRequest):
    """初始化配置"""
    if req.feishu_app_id:
        config.feishu.app_id = req.feishu_app_id
    if req.feishu_app_secret:
        config.feishu.app_secret = req.feishu_app_secret
    if req.feishu_app_token:
        config.feishu.app_token = req.feishu_app_token
    if req.feishu_table_id:
        config.feishu.table_id = req.feishu_table_id
    if req.llm_api_key:
        config.llm.api_key = req.llm_api_key
    if req.llm_base_url:
        config.llm.base_url = req.llm_base_url
    if req.llm_model:
        config.llm.model = req.llm_model

    # 重置客户端和缓存
    global client
    client = None
    _field_meta_cache.clear()

    save_config(config)
    return {"ok": True, "message": "配置已保存"}


@app.post("/api/parse")
def api_parse(req: ParseRequest):
    """解析晨会文本"""
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="文本不能为空")

    # 获取 Bitable 单选字段可选值，约束 LLM 输出
    field_opts = _get_field_options()

    result = parse_text(
        text=req.text,
        api_key=config.llm.api_key,
        base_url=config.llm.base_url,
        model=config.llm.model,
        field_options=field_opts,
    )

    if result.error:
        return ParsePreview(records=[], error=result.error)

    # 注入项目字段和站会日期（默认今天）
    today_str = datetime.date.today().isoformat()
    for r in result.records:
        if req.project:
            r["项目"] = req.project
        r["站会日期"] = req.meeting_date or today_str

    # 自动写入 Bitable（只要配置了就写入）
    if config.feishu.app_token and config.feishu.table_id:
        try:
            c = _get_client()
            fm = _get_field_map()
            project = req.project or ""
            meeting = req.meeting_date or today_str
            # 去重：同项目+同日+同事项标题不重复写
            deduped, skipped = _dedup_records(c, fm, result.records, project, meeting)
            if not deduped:
                msg = f"全部 {len(result.records)} 条已存在"
                logger.info("写入跳过: %s", msg)
                return {
                    "ok": True,
                    "records": result.records,
                    "write_result": {
                        "success_count": 0,
                        "fail_count": 0,
                        "dedup_skipped": skipped,
                        "message": msg,
                    },
                }
            wr = batch_write_records(
                c, config.feishu.app_token, config.feishu.table_id,
                fm, deduped, field_options=field_opts,
            )
            dedup_msg = f"，跳过 {len(skipped)} 条已存在" if skipped else ""
            return {
                "ok": wr.fail_count == 0,
                "records": result.records,
                "write_result": {
                    "success_count": wr.success_count,
                    "fail_count": wr.fail_count,
                    "dedup_skipped": skipped,
                    "errors": wr.errors[:5],
                    "message": f"成功写入 {wr.success_count} 条{dedup_msg}"
                    + (f"，{wr.fail_count} 条失败" if wr.fail_count else ""),
                },
            }
        except Exception as e:
            logger.error("自动写入失败: %s", e, exc_info=True)
            return {
                "ok": False,
                "records": result.records,
                "write_result": {
                    "success_count": 0,
                    "fail_count": len(result.records),
                    "errors": [str(e)],
                    "message": f"写入失败: {e}",
                },
            }

    return ParsePreview(records=result.records)


@app.post("/api/write", response_model=dict)
def api_write(req: WriteRequest):
    """批量写入 Bitable"""
    if not req.records:
        raise HTTPException(status_code=400, detail="无记录可写入")
    if not config.feishu.app_token or not config.feishu.table_id:
        raise HTTPException(status_code=400, detail="Bitable 未配置")

    c = _get_client()
    fm = _get_field_map()
    field_opts = _get_field_options()

    # 注入项目字段和站会日期（默认今天）
    today_str = datetime.date.today().isoformat()
    records = req.records
    for r in records:
        if req.project:
            r["项目"] = req.project
        r["站会日期"] = req.meeting_date or today_str

    # 去重
    project = req.project or ""
    meeting = req.meeting_date or today_str
    deduped, skipped = _dedup_records(c, fm, records, project, meeting)
    if not deduped:
        return {
            "ok": True,
            "success_count": 0,
            "fail_count": 0,
            "dedup_skipped": skipped,
            "message": f"全部 {len(records)} 条已存在",
        }

    result = batch_write_records(c, config.feishu.app_token, config.feishu.table_id, fm, deduped, field_options=field_opts)
    dedup_msg = f"，跳过 {len(skipped)} 条已存在" if skipped else ""

    return {
        "ok": result.fail_count == 0,
        "success_count": result.success_count,
        "fail_count": result.fail_count,
        "dedup_skipped": skipped,
        "errors": result.errors[:5],
        "message": f"成功写入 {result.success_count} 条{dedup_msg}"
        + (f"，{result.fail_count} 条失败" if result.fail_count else ""),
    }


@app.post("/api/query", response_model=dict)
def api_query(req: QueryRequest):
    """查询未闭环记录"""
    if not config.feishu.app_token or not config.feishu.table_id:
        raise HTTPException(status_code=400, detail="Bitable 未配置")

    try:
        c = _get_client()
        fm = _get_field_map()

        records = query_open_records(
            c, config.feishu.app_token, config.feishu.table_id, fm,
            project=req.project or None,
            meeting_date=req.date or None,
            status=req.status or None,
            keyword=req.keyword or None,
        )
    except (FeishuAPIError, AuthError) as e:
        logger.error("查询 API 失败: %s", e)
        return {"ok": False, "error": f"飞书查询失败: {e}", "total": 0, "records": []}

    # 把飞书格式转成前端易用格式
    simplified = []
    for r in records:
        record_id = r.get("record_id", "")
        fields = r.get("fields", {})

        def extract_text(val):
            if val is None:
                return ""
            if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                return "".join(item.get("text", "") for item in val if isinstance(item, dict))
            if isinstance(val, bool):
                return "是" if val else "否"
            return str(val)

        row = {"record_id": record_id}
        for key, val in fields.items():
            # key 可能是 field_id 或字段名
            if key in fm.reverse_mapping:
                field_name = fm.reverse_mapping[key]
            else:
                field_name = key
            row[field_name] = extract_text(val)
        simplified.append(row)

    return {
        "total": len(simplified),
        "records": simplified,
    }


@app.post("/api/stats")
def api_stats(req: StatsRequest):
    """获取全局统计（不受筛选条件影响）"""
    if not config.feishu.app_token or not config.feishu.table_id:
        return StatsResponse()

    try:
        c = _get_client()
        fm = _get_field_map()

        # 按项目+日期统计（不按状态）
        all_records = query_open_records(
            c, config.feishu.app_token, config.feishu.table_id, fm,
            project=req.project or None,
            meeting_date=req.meeting_date or None,
        )
    except (FeishuAPIError, AuthError) as e:
        logger.error("统计查询失败: %s", e)
        return StatsResponse()

    today = datetime.date.today()
    todo = 0
    in_progress = 0
    closed = 0
    overdue = 0
    overdue_in_todo = 0
    overdue_in_progress = 0

    for r in all_records:
        fields = r.get("fields", {})

        def _extract_text(val):
            if val is None:
                return ""
            if isinstance(val, list) and len(val) > 0 and isinstance(val[0], dict):
                return "".join(item.get("text", "") for item in val if isinstance(item, dict))
            if isinstance(val, bool):
                return "是" if val else "否"
            return str(val)

        def _get_field(canonical_name):
            fid = fm.get(canonical_name)
            val = fields.get(fid) if fid else None
            if val is None:
                real_name = fm.get_real_name(canonical_name)
                val = fields.get(real_name) if real_name else None
            if val is None:
                val = fields.get(canonical_name)
            return val

        status = _extract_text(_get_field("当前状态"))
        is_overdue = False

        # 超期检测
        due_val = _get_field("截止日期")
        if due_val and isinstance(due_val, (int, float)):
            import datetime as dt
            if due_val > 86400000:
                due_date = dt.datetime.fromtimestamp(due_val / 1000).date()
                if due_date < today:
                    is_overdue = True

        if status == "已闭环":
            closed += 1
            if is_overdue:
                overdue += 1
            continue
        if status == "待处理":
            todo += 1
            if is_overdue:
                overdue += 1
                overdue_in_todo += 1
        elif status == "处理中":
            in_progress += 1
            if is_overdue:
                overdue += 1
                overdue_in_progress += 1
        else:
            # 无状态或未知状态的记录，也检查超期
            if is_overdue:
                overdue += 1

    return StatsResponse(
        total=len(all_records),
        todo=todo,
        in_progress=in_progress,
        closed=closed,
        overdue=overdue,
        overdue_in_todo=overdue_in_todo,
        overdue_in_progress=overdue_in_progress,
    )


@app.post("/api/update", response_model=dict)
def api_update(req: UpdateRequest):
    """批量更新进展"""
    if not req.updates:
        raise HTTPException(status_code=400, detail="无更新数据")
    if not config.feishu.app_token or not config.feishu.table_id:
        raise HTTPException(status_code=400, detail="Bitable 未配置")

    c = _get_client()
    fm = _get_field_map()
    field_opts = _get_field_options()

    result = batch_update_progress(
        c, config.feishu.app_token, config.feishu.table_id, fm, req.updates, field_options=field_opts,
    )

    return {
        "ok": result.fail_count == 0,
        "success_count": result.success_count,
        "fail_count": result.fail_count,
        "errors": result.errors[:5],
        "message": f"成功更新 {result.success_count} 条"
        + (f"，{result.fail_count} 条失败" if result.fail_count else ""),
    }


@app.post("/api/delete", response_model=dict)
def api_delete(req: DeleteRequest):
    """批量删除记录"""
    if not req.record_ids:
        raise HTTPException(status_code=400, detail="record_ids 不能为空")
    if not config.feishu.app_token or not config.feishu.table_id:
        raise HTTPException(status_code=400, detail="Bitable 未配置")

    c = _get_client()

    result = batch_delete_records(c, config.feishu.app_token, config.feishu.table_id, req.record_ids)

    return {
        "ok": result.fail_count == 0,
        "success_count": result.success_count,
        "fail_count": result.fail_count,
        "errors": result.errors[:5],
        "message": f"成功删除 {result.success_count} 条"
        + (f"，{result.fail_count} 条失败" if result.fail_count else ""),
    }


# ── 前端页面 ─────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
def index():
    """返回 Web UI"""
    html_path = Path(__file__).parent / "templates" / "index.html"
    if not html_path.exists():
        return HTMLResponse("<h1>页面未找到</h1>", status_code=404)
    return HTMLResponse(html_path.read_text(encoding="utf-8"), headers={
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
    })


# ── 启动 ─────────────────────────────────────────────────

def main():
    """主入口"""
    c = config

    logger.info("=" * 50)
    logger.info("  每日站会闭环管理系统 v1.1")
    logger.info("=" * 50)
    logger.info("  Feishu 配置: %s", "✅ 已配置" if c.feishu.app_id else "❌ 未配置")
    logger.info("  Bitable 配置: %s", "✅ 已配置" if c.feishu.app_token else "❌ 未配置")
    logger.info("  LLM 配置: %s", "✅ 已配置" if c.llm.api_key else "❌ 未配置")
    logger.info("  Web UI: http://%s:%d", c.host, c.port)
    logger.info("=" * 50)

    uvicorn.run(
        app,
        host=c.host,
        port=c.port,
        log_level="info" if not c.debug else "debug",
    )


if __name__ == "__main__":
    main()
