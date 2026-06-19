"""
飞书多维表格 API 客户端

封装飞书 Open API 的鉴权和请求，提供 Bitable 读写能力。
"""

import json
import logging
import ssl
from dataclasses import dataclass
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

logger = logging.getLogger(__name__)

FEISHU_BASE = "https://open.feishu.cn/open-apis"


class FeishuAPIError(Exception):
    """飞书 API 调用异常"""

    def __init__(self, message: str, code: Optional[int] = None, data: Optional[dict] = None):
        self.code = code
        self.data = data
        super().__init__(f"[{code}] {message}" if code else message)


class AuthError(FeishuAPIError):
    """鉴权异常"""
    pass


@dataclass
class TenantToken:
    """租户级 token"""
    token: str
    expire_sec: int = 7200


class FeishuClient:
    """飞书 API 客户端"""

    def __init__(self, app_id: str, app_secret: str):
        self._app_id = app_id
        self._app_secret = app_secret
        self._token: Optional[TenantToken] = None

    # ── 鉴权 ──────────────────────────────────────────────

    def _ensure_token(self) -> str:
        """获取或刷新 tenant_access_token"""
        if self._token is None:
            self._refresh_token()
        return self._token.token

    def _refresh_token(self) -> None:
        """刷新 tenant_access_token"""
        url = f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal"
        body = json.dumps({
            "app_id": self._app_id,
            "app_secret": self._app_secret,
        }).encode("utf-8")
        req = Request(url, data=body, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")

        data = self._do_request(req)
        code = data.get("code", -1)
        if code != 0:
            raise AuthError(f"获取 token 失败: {data.get('msg', '')}", code=code)

        self._token = TenantToken(
            token=data["tenant_access_token"],
            expire_sec=data.get("expire", 7200),
        )

    # ── 通用请求 ─────────────────────────────────────────

    def _do_request(self, req: Request) -> dict:
        """执行 HTTP 请求并解析 JSON 响应"""
        # 创建 SSL context（兼容内网自签名证书）
        ssl_ctx = ssl.create_default_context()
        ssl_ctx.check_hostname = False
        ssl_ctx.verify_mode = ssl.CERT_NONE

        try:
            with urlopen(req, timeout=120, context=ssl_ctx) as resp:
                body = resp.read().decode("utf-8")
                return json.loads(body)
        except HTTPError as e:
            # 尝试读取响应体获取飞书错误详情
            detail = e.reason
            try:
                err_body = e.read().decode("utf-8", errors="replace")
                detail = f"{e.reason} | {err_body[:500]}"
            except Exception:
                pass
            raise FeishuAPIError(f"请求失败: {detail}") from e
        except URLError as e:
            raise FeishuAPIError(f"请求失败: {e.reason}") from e
        except TimeoutError as e:
            raise FeishuAPIError(f"请求超时: {e}") from e
        except json.JSONDecodeError as e:
            raise FeishuAPIError(f"响应解析失败: {e}") from e

    def _request(self, method: str, path: str, body: Any = None) -> dict:
        """带鉴权的 API 请求，自动处理 token 过期重试

        Feishu 在 token 失效时可能返回：
        - HTTP 200 + JSON body 中的 code=99991663（已处理）
        - HTTP 400 + JSON body 中的 code=99991663（_do_request 抛异常，需 catch）
        """
        token = self._ensure_token()
        url = f"{FEISHU_BASE}{path}"
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None

        def _build_req(tok: str) -> Request:
            r = Request(url, data=data, method=method)
            r.add_header("Authorization", f"Bearer {tok}")
            r.add_header("Content-Type", "application/json; charset=utf-8")
            return r

        def _is_auth_error(err: FeishuAPIError) -> bool:
            """判断 FeishuAPIError 是否因 token 失效导致"""
            msg = str(err)
            return "99991663" in msg or "99991664" in msg

        result: Optional[dict] = None

        try:
            result = self._do_request(_build_req(token))
        except FeishuAPIError as e:
            if _is_auth_error(e):
                logger.info("Token 失效（HTTP 错误路径），刷新重试")
                self._token = None
                try:
                    token = self._ensure_token()
                except AuthError:
                    raise e  # 刷新 token 也失败，抛原始错误
                result = self._do_request(_build_req(token))
            else:
                raise

        code = result.get("code", -1)
        if code != 0:
            # token 过期（JSON body code 路径），刷新重试一次
            if code in (99991663, 99991664):
                logger.info("Token 失效（JSON body 路径），刷新重试")
                self._token = None
                token = self._ensure_token()
                try:
                    result = self._do_request(_build_req(token))
                except FeishuAPIError:
                    raise  # 重试仍失败，让调用方处理
                code = result.get("code", -1)

            if code != 0:
                raise FeishuAPIError(
                    f"API 错误: {result.get('msg', '')}",
                    code=code,
                    data=result.get("data"),
                )

        return result

    # ── Bitable 操作 ─────────────────────────────────────

    def list_fields(self, app_token: str, table_id: str) -> list[dict]:
        """获取表的所有字段"""
        result = self._request(
            "GET",
            f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields",
        )
        return result.get("data", {}).get("items", [])

    def create_record(self, app_token: str, table_id: str, fields: dict) -> dict:
        """创建记录"""
        result = self._request(
            "POST",
            f"/bitable/v1/apps/{app_token}/tables/{table_id}/records",
            {"fields": fields},
        )
        return result.get("data", {}).get("record", {})

    def batch_create_records(self, app_token: str, table_id: str, records: list[dict]) -> list[dict]:
        """批量创建记录（每次最多 500 条）"""
        if not records:
            return []

        all_results = []
        # 每次最多 500 条
        batch_size = 500
        for i in range(0, len(records), batch_size):
            batch = records[i:i + batch_size]
            result = self._request(
                "POST",
                f"/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_create",
                {"records": [{"fields": r} for r in batch]},
            )
            items = result.get("data", {}).get("records", [])
            all_results.extend(items)

        return all_results

    def update_record(self, app_token: str, table_id: str, record_id: str, fields: dict) -> dict:
        """更新单条记录"""
        result = self._request(
            "PUT",
            f"/bitable/v1/apps/{app_token}/tables/{table_id}/records/{record_id}",
            {"fields": fields},
        )
        return result.get("data", {}).get("record", {})

    def batch_update_records(self, app_token: str, table_id: str, records: list[dict]) -> list[dict]:
        """批量更新记录。records 格式: [{"record_id": "xxx", "fields": {...}}]"""
        if not records:
            return []

        all_results = []
        batch_size = 500
        for i in range(0, len(records), batch_size):
            batch = records[i:i + batch_size]
            result = self._request(
                "POST",
                f"/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_update",
                {"records": batch},
            )
            items = result.get("data", {}).get("records", [])
            all_results.extend(items)

        return all_results

    def list_records(self, app_token: str, table_id: str, page_size: int = 500,
                     filter_formula: Optional[str] = None,
                     field_names: Optional[list[str]] = None) -> list[dict]:
        """列出记录，支持筛选和分页"""
        all_records = []
        page_token = None

        while True:
            body: dict = {"page_size": min(page_size, 500)}
            if page_token:
                body["page_token"] = page_token
            if filter_formula:
                body["filter"] = {"formula": filter_formula}
            if field_names:
                body["field_names"] = field_names

            result = self._request(
                "POST",
                f"/bitable/v1/apps/{app_token}/tables/{table_id}/records/search",
                body,
            )
            data = result.get("data", {})
            items = data.get("items", [])
            all_records.extend(items)

            if not data.get("has_more"):
                break
            page_token = data.get("page_token")

        return all_records

    def batch_delete_records(self, app_token: str, table_id: str, record_ids: list[str]) -> dict:
        """批量删除记录（每次最多 500 条）

        Feishu API: POST /bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_delete
        Body: {"records": ["rec1", "rec2", ...]}

        Args:
            app_token: Bitable app token
            table_id: 表 ID
            record_ids: 要删除的记录 ID 列表

        Returns:
            API 响应结果
        """
        if not record_ids:
            return {"code": 0}

        batch_size = 500
        last_result = {"code": 0}

        for i in range(0, len(record_ids), batch_size):
            batch = record_ids[i:i + batch_size]
            result = self._request(
                "POST",
                f"/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_delete",
                {"records": batch},
            )
            last_result = result

        return last_result

    def create_bitable_app(self, name: str) -> dict:
        """创建新的多维表格应用"""
        result = self._request(
            "POST",
            "/bitable/v1/apps",
            {"name": name},
        )
        return result.get("data", {})

    def create_table(self, app_token: str, name: str) -> dict:
        """在现有多维表格中创建新表"""
        result = self._request(
            "POST",
            f"/bitable/v1/apps/{app_token}/tables",
            {"table": {"name": name}},
        )
        return result.get("data", {})

    def create_field_option(self, app_token: str, table_id: str, field_id: str,
                            option_name: str) -> str:
        """为单选字段添加选项"""
        result = self._request(
            "POST",
            f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields/{field_id}/options",
            {"option": {"name": option_name}},
        )
        option = result.get("data", {}).get("option", {})
        return option.get("id", "")
