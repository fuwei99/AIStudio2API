# 3. WAA Proof Server (`3-waa-proof-server`)

纯 Node.js（`node:vm`）无浏览器 WAA `!proof` 签名服务端（默认监听 `http://127.0.0.1:18801`）：
- **纯计算无浏览器依赖**：基于内置 Chrome 151 WebIDL 环境沙箱与预编译 `vm.Script` 字节码缓存，直接生成通过 Google 校验的 `V` 模式 `!xxx` 签名（热态单次签名耗时 `~30 ms`）。
- **单层内存池（零落盘）**：保留 VM 实例（每账号约 `1.5~3 MB` 堆内存），毫秒级签名；VM 空闲超过 1 小时自动销毁并删除该账号条目，进程重启即清空。
- **并发与订阅等级**：同账号并发初始化 Singleflight 合并、全局并发信号量限流、自动检测账号订阅等级（`TIER0` / `TIER1` Pro / `TIER2` Ultra）。
- **职责纯粹**：仅处理 `!xxx` 签名与内存池管理，不包含浏览器登录、Cookie 抓取，也不轮换/回写 Cookie（Cookie 完全由调用方持有）。

---

## 快速启动

```bash
cd 3-waa-proof-server
node bin/start-proof-server.js
```

---

## 接口说明

- `POST /v1/proof/mint`：传入 `{ cookies, authUser, model, wireContents, messages }`，返回 `{ ok: true, proof: "!xxx", poolState: "hot" }`（签名服务不回传 Cookie/Authorization，调用方用自己的 Cookie 本地计算 SAPISIDHASH；字段说明与 curl / Node / Python 调用示例见 **[`API.md`](./API.md)**，原始报文示例见 `request.example.json`）。
- `GET /v1/pool/stats`（或 `GET /health`）：必须传入 Cookie（`X-Google-Cookies` 头或 `?cookies=`），查询该账号在内存池中的状态（`hot`/`initializing`、VM 回收时间、累计签名次数、`hotTtlMs`）。

---

## 逆向工程全流程文档

从网页抓包、`b0.patched.js` 静态定位、V8 Inspector 无损追踪、攻克 `pc=10776` 动态密钥派生、破解 `0x99` CFB 流密码与四大遥测校验点，到最终纯 Node.js 无浏览器破局的完整思路与步骤，详见：
- **[`REVERSE-ENGINEERING.md`](./REVERSE-ENGINEERING.md)**
