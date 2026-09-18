#!/usr/bin/env bash
# local_verify.sh —— 本地「不花积分」回归验收（两段式）
#
#   第 1 段：报文级离线断言（verify_payload.ts）——直接调用报文构建器，逐条检查
#            `abilities.gen_option.gen_count` 的层级与取值、默认模型、模型校验、n 的越界拒绝。
#   第 2 段：链路级验证 —— 起真实服务（端口 5111），打真实 HTTP，覆盖
#            `/v1/models` 清单、`n=9` 越界、未知模型报错、N-9 落盘可写性预检。
#
# 为什么必须有它：FIX_PLAN_v3.0 §四 的 V-1/V-2/V-5/V-6/V-7/V-8 都可以**离线**证伪或证实，
# 不必花积分去线上试错。真正的线上回归只保留必须联网的 V-3/V-4（张数与扣分）。
#
# 用法： bash local_verify.sh
# 退出码： 全绿 0；任一段失败 非 0
#
# ⚠️ 本环境踩坑留痕（已复现，勿再犯）：
#  ① **不要**用 `C="curl --noproxy *"` 字符串拼接再 `$C url` —— `*` 会被 bash 做
#     **文件名展开**，同目录的 verify.sh 等文件名会被当成 URL，请求打到外网返回 nginx 301，
#     结果是"验证全绿但其实一个都没测到"。必须用数组：C=(curl --noproxy '*' -m 20)
#  ② 服务进程会随命令行结束被回收 → "起服务 + 跑用例 + 收尾"必须收敛进**同一条命令**。
set -u
cd "$(dirname "$0")"

PORT=5111
BASE="http://127.0.0.1:$PORT"
CURL=(curl -s --noproxy '*' -m 20)
# 假 token：刻意写成**不像真 sessionid** 的形式（真 token = 32 位 hex 且带 us-/jp-/cn- 前缀）。
# 原因：本文件随包发布并上库，仓库侧凭证扫描会把「区域前缀 + 32 位 hex」判为疑似泄漏。
# 这里用非 hex 占位符，既自解释又不会触发扫描（曾在 2026-09-18 触发过一次误报）。
FAKE_TOKEN='us-EXAMPLE-NOT-A-REAL-SESSIONID'
PY="$(command -v python || command -v python3)"
TMP=_tmp_verify
RC=0

rm -rf "$TMP"
mkdir -p "$TMP"

# ─────────────────────────────────────────────── 第 1 段：报文级离线断言
echo "################## 第 1 段 · 报文级离线断言 ##################"
if [ ! -f verify_payload.ts ]; then
  echo "✗ 缺少 verify_payload.ts，跳过第 1 段"; RC=1
else
  ./node_modules/.bin/esbuild verify_payload.ts --bundle --platform=node --format=cjs \
    --outfile="$TMP/verify_payload.cjs" --log-level=warning || { echo "✗ 打包断言脚本失败"; RC=1; }
  if [ -f "$TMP/verify_payload.cjs" ]; then
    node "$TMP/verify_payload.cjs" | tee "$TMP/payload_assert.txt"
    # 取 node 的退出码（bash 默认不给管道退出码）
    if grep -qE "^PASS [0-9]+ / FAIL 0 " "$TMP/payload_assert.txt"; then
      echo "✅ 第 1 段通过"
    else
      echo "❌ 第 1 段失败"; RC=1
    fi
  fi
fi

# ─────────────────────────────────────────────── 第 2 段：链路级验证
echo
echo "################## 第 2 段 · 链路级验证 ##################"
SERVER_PORT=$PORT JIMENG_BENEFIT_COUNT=1 node dist/index.js > "$TMP/svc.log" 2>&1 &
SVC=$!
trap 'kill $SVC 2>/dev/null' EXIT

UP=0
for _ in $(seq 1 20); do
  if "${CURL[@]}" "$BASE/ping" 2>/dev/null | grep -q pong; then UP=1; break; fi
  sleep 1
done
if [ "$UP" != "1" ]; then
  echo "❌ 服务 20s 内未就绪，第 2 段中止"; tail -20 "$TMP/svc.log"; exit 1
fi
echo "✓ 服务已就绪（端口 $PORT）"

step() { printf '\n----- %s -----\n' "$1"; }

step "2.1 /v1/models 清单（V-6：图片模型是否齐全、清单与映射表是否一致）"
"${CURL[@]}" "$BASE/v1/models" > "$TMP/models.json"
"$PY" - "$TMP/models.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
data = d["data"]
img = [m for m in data if m.get("type") == "image"]
vid = [m for m in data if m.get("type") == "video"]
print(f"总条目={len(data)} | 图片模型={len(img)} | 视频模型={len(vid)}")
print("图片:", ", ".join(m["id"] for m in img))
print("warnings:", d.get("warnings", "（无 —— 清单与映射表一致）"))
ok = len(img) >= 5 and not d.get("warnings")
print("判定:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
PY
[ $? -ne 0 ] && RC=1

step "2.2 n=9 越界（V-8：必须被拒，且不得触达上游）"
RESP=$("${CURL[@]}" -X POST "$BASE/v1/images/generations" -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer '"$FAKE_TOKEN" \
  -d '{"prompt":"n9-probe","n":9}')
echo "$RESP"
echo "$RESP" | grep -q "必须是 1-8 之间的整数" && echo "判定: PASS" || { echo "判定: FAIL"; RC=1; }

step "2.2b n 的非法取值必须给出**同一条**可读报错（口径一致性）"
# 2026-09-18 新增：线上实测发现 "abc" 被前置类型闸挡成通用的 “Params body.n invalid”，
# 与数值越界的 “必须是 1-8 之间的整数” 口径不一致。同一个参数不该有两类提示。
# 现在三种非法输入（非数字 / 0 / 非整数）都必须落到同一条信息上。
for BAD in '"abc"' '0' '1.5' '-3'; do
  RESP=$("${CURL[@]}" -X POST "$BASE/v1/images/generations" -H 'Content-Type: application/json' \
    -H 'Authorization: Bearer '"$FAKE_TOKEN" \
    -d '{"prompt":"nbad-probe","n":'"$BAD"'}')
  if echo "$RESP" | grep -q "必须是 1-8 之间的整数"; then
    echo "  n=$BAD → PASS（同一条可读报错）"
  else
    echo "  n=$BAD → FAIL  实际: $(echo "$RESP" | head -c 160)"; RC=1
  fi
done

step "2.3 未知模型（V-7：必须明确报错，不得静默换成默认模型）"
RESP=$("${CURL[@]}" -X POST "$BASE/v1/images/generations" -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer '"$FAKE_TOKEN" \
  -d '{"prompt":"typo-model-probe","model":"jimeng-9.9-typo"}')
echo "$RESP"
echo "$RESP" | grep -q "不支持的模型\|国际版不支持模型" && echo "判定: PASS" || { echo "判定: FAIL"; RC=1; }

step "2.4 N-9 反例：out_dir 不可写 → 必须在生成前 0 积分报错"
echo "blocker" > "$TMP/_ro_probe"
RESP=$("${CURL[@]}" -X POST "$BASE/v1/agent/tasks" -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer '"$FAKE_TOKEN" \
  -d "{\"doc\":\"## 场景一\n一只猫\n\",\"out_dir\":\"$TMP/_ro_probe/sub\"}")
echo "$RESP"
if echo "$RESP" | grep -q "落盘目录不可用\|落盘目录不可写"; then
  echo "判定: PASS（含修复提示，0 积分）"
  grep -q "开始编排" "$TMP/svc.log" && { echo "⚠️ 异常：预检失败却仍进入了编排"; RC=1; } || echo "✓ 确认未进入编排"
else
  echo "判定: FAIL"; RC=1
fi

step "2.5 N-9 正例：out_dir 可写 → 预检通过并进入编排（假 token，上游必失败，0 积分）"
RESP=$("${CURL[@]}" -X POST "$BASE/v1/agent/tasks" -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer '"$FAKE_TOKEN" \
  -d "{\"doc\":\"## 场景二\n一只狗\n\",\"out_dir\":\"$TMP/_n9_ok\",\"max_items\":1}")
echo "$RESP" | head -c 300; echo
sleep 3
if grep -q "开始编排" "$TMP/svc.log"; then echo "判定: PASS（预检放过，进入编排）"; else echo "判定: FAIL"; RC=1; fi
echo "--- 编排层读取到的张数 ---"
grep -o "每个场景输出张数 n = [^—]*" "$TMP/svc.log" | head -1

kill $SVC 2>/dev/null

echo
echo "================================================================"
if [ "$RC" = "0" ]; then
  echo "✅ 本地验收全绿（第 1 段 + 第 2 段）"
else
  echo "❌ 本地验收存在失败项，请查看上方 FAIL 行"
fi
echo "报告与日志： $TMP/ （payload_assert.txt / report 相关输出 / svc.log）"
exit $RC
