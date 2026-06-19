# ── 每日站会闭环管理系统 ──
FROM python:3.11-slim

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制代码
COPY . .

# 默认配置通过环境变量注入
ENV FEISHU_APP_ID=""
ENV FEISHU_APP_SECRET=""
ENV FEISHU_APP_TOKEN=""
ENV FEISHU_TABLE_ID=""
ENV LLM_API_KEY=""
ENV LLM_BASE_URL="https://api.deepseek.com"
ENV LLM_MODEL="deepseek-chat"
ENV PORT=8899
ENV HOST=0.0.0.0

EXPOSE 8899

CMD ["python", "app.py"]
