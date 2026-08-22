#!/bin/bash
# 启动 bug-tracker 共享服务器（独立脚本，避免 pkill 自匹配）
cd /home/admin/.openclaw/workspace/output/bug-tracker
# 只杀真正的 server 进程（排除 bash/grep）
for pid in $(pgrep -f '^python3 -u server.py 8092$'); do
  kill "$pid" 2>/dev/null
done
sleep 1
nohup python3 -u server.py 8092 > /tmp/bug-server.log 2>&1 < /dev/null &
disown
sleep 2
echo "server pid: $(pgrep -f '^python3 -u server.py 8092$')"
curl -s --max-time 5 -o /dev/null -w "api/state: %{http_code}\n" http://127.0.0.1:8092/api/state
