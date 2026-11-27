# 从网页抓包到纯 Node.js 无浏览器破解：AI Studio WAA / BotGuard 逆向全流程文档

> **声明**：本文档完整复盘从最初打开浏览器开发者工具抓包，到定位 `!proof` 生成链路、搭建无损 V8 Inspector 追踪器、破解字节码 VM 动态流密码与 `0x99` CFB 遥测加密、直至实现纯 Node.js（`node:vm`）毫秒级签名的完整逆向思路与工程落地流程。所有示例均已脱敏，不包含任何真实凭据。

---

## 全流程总览图

```text
[阶段 1: 网页抓包]
  抓包 MakerSuiteService/GenerateContent 与 Waa/Create
  拆解 JSPB 二进制数组协议、认证头、Cookie 续期与 wire[4] 的 "!proof"
        │
        ▼
[阶段 2: 静态逆向定位源头]
  在 b0.patched.js (2.17MB) 中定位 _.SB(req) 摘要算法与 WaaService.snapshot
  理清 Waa/Create -> iframe-eval.js (62KB VM) -> bscframe 沙箱执行链路
        │
        ▼
[阶段 3: 外层二进制结构拆解 & 误区证伪]
  解析 "!proof" Base64URL 结构：Prelude 偏移 S (90=F失败 / 100=V成功)
  分离 0x68 / 0x0F (nd异常段) / 0x7E (75B控制流轨迹) / 0x99 (加密遥测) / 288B 签名
        │
        ▼
[阶段 4: 绕过源码自校验的无损动态追踪]
  发现 pc=25797..25997 对 Ld/k5/ul/XX/S.toString() 做哈希并更新流密码密钥
  用 node:inspector 条件恒假断点 (condition: "log(...), false") 实现零改动指令级追踪
        │
        ▼
[阶段 5: 攻克第一道关卡 F -> V (pc=10776 动态密钥派生)]
  定位 pc=8522 二阶段 eval 与 pc=10193..10759 的前 3 路 typeof 环境探针
  修复 createEvent('MouseEvents').screenX 等缺失属性，消除 pc=10790 乱码崩溃与 0x0F 段
        │
        ▼
[阶段 6: 攻克第二道关卡 V 模式 403 (分段替换 Oracle + 0x99 CFB 解密)]
  真机 Proof 与本地 Proof 交叉替换，证明本地 0x7E 与 288B 签名 100% 合法，锁定 0x99 段
  逆向 ul 函数中的 8 字节分组 CFB 模式与 14 轮 ARX 函数 Oj，完整解密 0x99 明文 TLV
        │
        ▼
[阶段 7: 逐一击破 0x99 遥测段四大校验点]
  1. Tag 3 & Tag 103 (6 路动态 typeof 探针) -> 导出 Chrome 151 全量 chrome-schema.json
  2. Tag 232 & Tag 233 (childWindow 9 路构造器原型抽样) -> 补齐内建类与精确属性顺序
  3. Tag [250, 18] (WebIDL 反篡改位图) -> [16,45,76,84] 归零为 [0,4,0,0]
  4. Tag 235 (32 桶 DOM 交互事件直方图) -> simulateUserInteraction() 派发合成事件 -> HTTP 200 OK!
        │
        ▼
[阶段 8: 多账号池化与性能优化]
  进程级 Schema 原型缓存 + vm.Script 字节码缓存 + 1h 热态内存池
  单账号冷启动 576~860ms，热态签名 ~30ms，单账号堆内存增量仅 1.5~3MB
```

---

## 阶段一：从网页抓包入手——拆解 `GenerateContent` 协议与认证体系

逆向的第一步是在真实 Chrome 浏览器中登录 `https://aistudio.google.com`，打开 DevTools Network 面板，点击发送一条对话，观察核心 RPC 请求。

### 1.1 核心推理接口：`MakerSuiteService/GenerateContent`
- **请求地址**：
  `POST https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent`
- **Content-Type**：`application/json+protobuf`（Google 内部 JSPB 数组格式，字段号为 N 的 Protobuf 字段对应 JSON 数组的下标 `N - 1`）。

通过对比普通对话、带思考（Thinking）、带工具调用（Function Calling）和带图片的抓包，完整还原出请求体顶层数组 `wire` 的结构：

```json
[
  "models/gemini-4-argon",                     // wire[0] (Field 1): 模型全名
  [                                            // wire[1] (Field 2): repeated Content (对话历史)
    [
      [
        [null, "你好"],                        // Part Field 2 (part[1]): 文本内容
        [null, null, ["image/png", "iVBOR.."]] // Part Field 3 (part[2]): 本地 Base64 多模态 inlineData
      ],
      "user"                                   // Content Field 2: role ("user" | "model")
    ]
  ],
  [[null,null,7,5], [null,null,8,5], ...],     // wire[2] (Field 3): SafetySettings
  [                                            // wire[3] (Field 4): GenerationConfig
    null, null, null, 32768, 1, 0.95, 64, null,
    null, null, null, null, null, 1, null, null,
    [1, null, null, 2]                         // wire[3][16] (Field 17): ThinkingConfig ([includeThoughts=1, budget, null, level])
  ],
  "!O1BQUF...（约 1550 字符）",                 // wire[4] (Field 5): WAA / BotGuard 反滥用证明 (!proof)
  null,                                        // wire[5] (Field 6): SystemInstruction（可统一折入 wire[1] 开头 user）
  [[null, [["getWeather", "描述", [...]]]]]    // wire[6] (Field 7): repeated Tool (Function Declarations)
]
```

### 1.2 响应帧与流式细节
虽然请求没有单独的 HTTP 流式 URL，但只要使用 `fetch` 按字节流读取响应体，Google 服务端就会以分块（Chunked）方式增量推送嵌套 JSON 数组：
`[[ frame1, frame2, frame3, ... ]]`
其中每个 `frame` 的 `cand[0][0]` 包含增量 `Part`：
- **明文思考总结**：`part[12] === 1`（Field 13 `thought = true`），文本在 `part[1]`。
- **正文回答**：`part[12]` 为空，文本在 `part[1]`。
- **工具调用（FunctionCall）**：在 `part[10]`（Field 11 `_.ct`），结构为 `[name, Struct(args), callId]`。
- **思考签名（`thoughtSignature`）**：在 `part[14]`（Field 15），是一段加密 Base64 字符串（如 `"EtIGCs8GA..."`），在多轮对话或工具结果回传时必须原样带回。

### 1.3 认证头与隐藏的四个实战大坑
抓包对比发现，要让 `GenerateContent` 稳定返回 `200 OK`，除了 `!proof` 外还有 4 个关键认证条件：
1. **共享 `x-goog-api-key`**：网页 `WIZ_global_data` 中的 `AIzaSy...` Key 是所有用户共享的公开前端 Key，但**必须使用网页 HTML 里的这把 Key**；如果误用 `b0.patched.js` 源码里硬编码的另一把 `AIza` Key（那把仅用于 `Waa/Create`），调 `GenerateContent` 会直接 `403`。
2. **`Authorization: SAPISIDHASH`**：由 Cookie 中的 `SAPISID`（或 `__Secure-3PAPISID`）、当前秒级时间戳和 `https://aistudio.google.com` 拼接后计算 SHA-1 得到：
   `SAPISIDHASH <timestamp>_<sha1(timestamp + " " + SAPISID + " " + origin)>`
3. **高阶模型权限头 `X-AIStudio-G1-Tier`**：
   测试发现，Pro 账号在网页能调通 `models/gemini-4-argon` 和 `models/gemini-3.6-flash`，但脚本直接发包却报 `403 The caller does not have permission`。
   逆向 `b0.patched.js` 发现：前端启动时会请求 `MakerSuiteService/GetAiStudioBenefitTier`，Pro 账号返回 `[1]`（对应 `TIER1`），Ultra 返回 `[2]`（对应 `TIER2`），免费号返回 `[3]` 或空（`TIER0`）。调用高阶模型（模型定义中 `field 78 = 2`）时，请求头必须附带 `X-AIStudio-G1-Tier: TIER1`（以及 `X-Goog-Ext-519733851-bin`）。
4. **Cookie 续期与 `LSID` 陷阱**：
   Google 的 `__Secure-1PSIDTS` 等短效 Cookie 约 10~20 分钟过期，后台通过 `POST https://accounts.google.com/RotateCookies` 自动续期。
   但 `RotateCookies` 位于 `accounts.google.com` 域下，**强依赖该域独有的 `LSID` / `__Host-1PLSID` / `__Host-3PLSID`（均为 `HttpOnly`）**。如果只抓了 `.google.com` 域下的 15 个 Cookie 而漏掉 `accounts.google.com` 的 `LSID`，一旦盲目调用 `RotateCookies`，Google 会判定会话异常并直接下发 `Set-Cookie: SID=deleted` 吊销整号登录态！因此油猴脚本必须同时匹配 `aistudio.google.com` 和 `accounts.google.com` 抓取全部 20 个核心 Cookie。

---

## 阶段二：顺藤摸瓜——在 `b0.patched.js` 中定位 `!proof` 生成链路

既然请求体唯一动态变化的加密字段是 `wire[4]`（以 `!` 开头的 ~1550 字符字符串），接下来我们在 AI Studio 的核心前端包 `b0.patched.js`（2.17 MB）中搜索是谁填充了 GenerateContent 请求的第 5 个字段。

### 2.1 请求内容摘要算法 `_.SB(req)`
在 `b0.patched.js` 中顺着 `GenerateContent` 的调用栈向上回溯，找到了给请求签名计算内容摘要的函数 `_.SB` 与 `_.Wm`：

```javascript
_.SB = function(a) {
  return _.y(function*() {
    // 遍历 wire[1] (contents) 中每个回合的所有 Part，映射为字符串后用空格连接，再算 SHA-256
    var b = _.rk(a, _.tt, 2).flatMap(c => c.tg()).map(_.Wm);
    return _.GB(b.join(" ")); // _.GB 为 SHA-256 hex
  });
};

_.Wm = function(a) {
  switch (_.Um(a)) {
    case 2: return a.getText();                       // 文本 Part: 取 part[1]
    case 3: return _.Vm(a)?.getData()?.Le();          // 本地 Base64 多模态 Part (inlineData): 取 part[2][1]
    case 6: return _.eCa(a)?.getId();                 // Drive 文件 Part: 取 part[5][0]
    default: return "";                               // 工具调用(11) / 工具响应(12) / 思考签名: 返回空串 ""
  }
};
```
**关键逆向结论**：
- `!proof` **与请求内容强绑定**！Google 服务端收到 `GenerateContent` 请求后，会用完全相同的逻辑对 `wire[1]` 计算 SHA-256，并校验 `!proof` 末尾的 288 字节签名块是否签在该 SHA-256 摘要上。
- 注意 `b.join(" ")`：即使某个 Part 是 `functionCall`、`functionResponse` 或末尾的 `thoughtSignature`（`_.Wm` 返回 `""`），它依然在数组中占据一个元素位置，多一个 Part 就会多拼接一个空格 `" "`！因此中转网关构造的 `wireContents` 必须原封不动传给签名服务计算摘要。

### 2.2 WAA / BotGuard 挑战与执行的三步握手
继续追踪 `_.Cn(waaService, digest)`，还原出浏览器生成 `!proof` 的完整生命周期：
1. **第一步（拉取动态挑战 `Waa/Create`）**：
   向 `POST https://waa-pa.clients6.google.com/$rpc/google.internal.waa.v1.Waa/Create` 发送初始化请求。
   - **异地/跨号绑定实验结论**：如果 `Waa/Create` 不带 Cookie（匿名拉取），产出的 `!proof` 虽然也是合法的 `V` 模式，但在携带账号 Cookie 调用 `GenerateContent` 时会 100% 返回 `403`。**`Waa/Create` 必须携带同一个 Google 账号的 Cookie 与 `SAPISIDHASH`**，这样挑战本身就与该 Google 账号完成绑定。
   - `Waa/Create` 响应包含两部分：一段高熵字节码挑战（Challenge Program，如 `cIZw7Fa...` 或 `C7AoLbL...`）以及解释器脚本路径 `/_/_/http/botguard/...`（即 `iframe-eval.js`，约 62 KB）。
2. **第二步（在隐藏 Iframe `bscframe` 中启动 VM）**：
   前端创建一个同源隐藏 `<iframe src="/app/_/bscframe">`，将 `iframe-eval.js` 和挑战字节码注入 `iframe.contentWindow` 中运行。字节码 VM 完成环境探测后，在全局暴露出一个含 `snapshot` 方法的实例。
3. **第三步（热态毫秒级铸造 `snapshot`）**：
   每当需要发送对话时，调用 `instance.snapshot({ Krc: { content: sha256Digest }, fFc: { content: sha256Digest } })`，VM 将当前环境遥测与 `sha256Digest` 打包签名，返回以 `!` 开头的 `!proof` 字符串。一张挑战（Challenge）初始化后可以在热态下连续铸造数百次不同 `digest` 的 `!proof`！

---

## 阶段三：剖析 `!proof` 二进制结构与推翻早期三大误区

把 `b0.patched.js` 和 `iframe-eval.js` 放进 Node.js 的 `node:vm` 跑起来并不难，但最初跑出来的 `!proof` 发给 `GenerateContent` 却 **100% 返回 `HTTP 403`**。为了弄清楚原因，我们先拆解 `!proof` 的外层二进制格式。

### 3.1 `!proof` 外层二进制布局
去掉开头的 `!` 后，做 Base64URL 解码得到字节数组 `P`（正常长度约 `1,150 ~ 1,190` 字节）：
- **前置区结束偏移 $S$**：由前 5 个字节异或解码得出：
  $$S = ((P[3] \oplus P[1]) \ll 8) \mid (P[4] \oplus P[1])$$
  - 当 **$S = 90$（`0x5A`）** 时：代表 **`F` 模式（Failure / Fallback）**，说明字节码 VM 在中途因为密钥算错或未捕获异常提前崩溃退出。
  - 当 **$S = 100$（`0x64`）** 时：代表 **`V` 模式（Valid / Full）**，说明字节码 VM 走完了完整流程。
- **偏移 $S$ 之后的分段 TLV 区 + 末尾 288 字节签名块**：
  - `0x68`（固定 2 字节）：版本与模式标志。
  - `0x0F`（2 字节大端长度 + 数据，对应 VM 寄存器 `reg 371`）：**`nd` 异常上报段**。
  - `0x7E`（2 字节大端长度 + 数据，对应 `reg 330` / `reg 49`）：**75 字节控制流基本块轨迹（Control-Flow Trace）**。
  - `0x99`（2 字节大端长度 + 数据，对应 `reg 291` / `reg 179`）：**约 940~980 字节的加密环境遥测段**。
  - **末尾 288 字节**：与请求 SHA-256 `digest` 绑定的非对称/椭圆曲线签名块。

### 3.2 早期三大误区的实验证伪
在逆向初期，很容易掉进以下三个误区，我们通过对照真浏览器抓包逐一将其推翻：
1. **误区一：“在外层 `env.js` 给 `document.createElement` 打 log 显示调用次数为 0，说明 VM 根本没检查 DOM”**
   - **真相**：VM 在执行到 `pc = 8522` 时，解密内部字符串表 `tU[13]` 并调用 `eval(Q)` 完成了**二阶段自举**，而且所有 DOM 探针都在 `iframe.contentWindow`（`childWindow`）内部通过动态解密的属性名调用，外层粗糙的静态钩子根本没挂在 `childWindow` 上。
2. **误区二：“本地产出的 Proof 里有一段 `0x0F` 段（比如 `[30, 42, 38, 126]`），以为是正常字段”**
   - **真相**：对比真浏览器 `200 OK` 的 Proof 发现，**真浏览器的 Proof 中从来没有 `0x0F` 段**！逆向 `iframe-eval.js` 的 `nd` 函数发现：`0x0F` 是专门用来向 Google 服务端打小报告的**异常捕获段**！只要字节码执行过程中抛出任何异常，`nd` 就会把 `[错误码, pc_hi, pc_lo]` 写进 `0x0F`，还会把 Node.js 的 `Error.stack` 塞进 `0x99` 加密上报！
3. **误区三：“是不是因为 Node.js 的 TLS 指纹或 IP 被 `Waa/Create` 标记了，所以 Node 拉的挑战一定 403？”**
   - **真相**：完全不是 TLS 指纹问题。之所以缓存的某份旧挑战能跑过，而实时拉取的新挑战会挂，是因为每次 `Waa/Create` 生成的字节码都会从 Chrome 的 1,200+ 个 WebIDL 类和属性中**随机抽取 6 个属性 + 9 个原型**进行探测！

---

## 阶段四：打造无损透视镜——绕过 `pc = 25797..25997` 源码自校验

要想知道字节码 VM 到底读了哪些浏览器属性、在哪条指令抛了异常，我们需要追踪 VM 的执行。

### 4.1 为什么不能直接修改 `iframe-eval.js` 插入 `console.log`？
当我们尝试在 `iframe-eval.js` 的核心函数（如寄存器写函数 `ul`、加密函数 `XX`、主循环 `S`）里插入 `console.log` 时，原本能跑通的字节码突然全部崩溃！
逆向末尾字节码（`pc = 25797..25997`）揭开了原因——**VM 对自身解释器源码做了 `.toString()` 完整性自校验**：

```javascript
// VM 在字节码末尾依次读取自身 5 个核心函数的源码字符串并计算 JU 哈希：
Ld.toString() -> JU(...)
k5.toString() -> JU(...)
ul.toString() -> JU(...)
XX.toString() -> JU(...)
S.toString()  -> JU(...)
// 随后在 pc = 25997 调用 GX.call(this, 26, 6, 208030)，用这 5 个哈希值更新流密码密钥寄存器 reg 169！
```
只要改动函数体内任意一个字符（哪怕多加一个空格或一行 `console.log`），`.toString()` 返回的源码长度和内容就会改变，导致 `pc = 25997` 派生出错误的流密码密钥，后续指令全部解成乱码！

### 4.2 破局方案：V8 `node:inspector` 条件恒假断点（Non-Intrusive Tracing）
既然不能改源码，我们就站到 V8 引擎层面上观察它：
1. 在 Node.js 脚本中通过 `const inspector = require('node:inspector')` 连接当前进程自身的 V8 调试器。
2. 开启 `Debugger.setInstrumentationBreakpoint({ instrumentation: 'beforeScriptExecution' })`，在 `iframe-eval.js` 及二阶段 `eval` 脚本刚编译、尚未执行第一行代码时精准拦截。
3. 在关键位置（如 `ul` 写入 `0x99` 遥测段、属性读取 `f[q]`、方法调用 `q.apply(B, m.N)`、异常捕获 `nd`）下断点，并将断点条件（`condition`）设为**把数据推入全局数组并返回 `false`**：
   ```javascript
   condition: 'window.__writes.push({ pc: H(I,153)>>3, reg: v, tag: V, bytes: Array.from(S||[]) }), false'
   ```
4. V8 每次执行到该行时都会先求值 `condition`（自动完成日志记录），而因为表达式最终结果恒为 `false`，V8 不会暂停执行，且被测函数的 `.toString()` 保持 100% 原汁原味！

---

## 阶段五：第一道关卡——攻克 `F -> V` 分水岭（`pc = 10776` 动态密钥派生）

借助无损追踪器，我们立刻抓到了本地沙箱落入 `F` 模式（或产生 `0x0F` 异常段）的第一案发现场：

1. **二阶段自举（`pc = 8522`）**：VM 解密出 `tU[13]` 并执行 `eval(Q)`，切换到二阶段解释器闭包。
2. **前 3 路 `typeof` 探针采集（`pc = 10193..10759`）**：
   字节码解密出一个 6 字节随机盐（例如 `"6qlsvA"`），随后依次探测 3 个 DOM 对象的属性类型并拼接到盐值后面：
   - `typeof document.createElement('img').removeChild` $\rightarrow$ `"function"`
   - `typeof document.createEvent('MouseEvents').screenX` $\rightarrow$ `"number"`
   - `typeof document.createElement('img').scrollTop` $\rightarrow$ `"number"`
   在真实 Chrome 151 中，拼接结果为 `"6qlsvAfunctionnumbernumber"`。
   而在简陋的本地沙箱中，`document.createEvent('MouseEvents')` 返回的空对象没有 `screenX` 属性，`typeof` 返回了 `"undefined"`，拼接结果变成了 `"6qlsvAfunctionundefinednumber"`！
3. **流密码动态 Re-key（`pc = 10776`）**：
   字节码将这个拼接字符串算完 `JU` 哈希后，在 `pc = 10776` 调用：
   `GX.call(this, 26, 6, 86264)`
   **直接用探针哈希值覆盖了字节码流密码密钥寄存器 `reg 169`**，并跳转到 `bitPc = 86264`（`pc = 10783`）继续取指执行！
   - 这是一个极其精妙的防沙箱设计：**VM 不写 `if (typeof x === 'undefined') throw Error`，而是直接把环境探针的返回结果当作解密下一段字节码的密钥**！
   - 沙箱只要有一个属性类型不对，密钥就会错；7 个字节后的 `pc = 10790` 解出乱码指令去读未初始化的 `reg 126`，立刻抛出 `[bl, 30, 126]` 异常，被 `nd` 捕获写入 `0x0F` 段并提前终止于 `F` 模式！

补齐 `createEvent('MouseEvents')` 与 `DOMElement` 的基础属性后，VM 顺利跨过 `pc = 10776`，`0x0F` 异常段彻底消失，稳定产出 $S = 100$ 的 `V` 模式证明！

---

## 阶段六：第二道关卡——分段替换 Oracle 与破解 `0x99` CFB 流密码

跨过 `pc = 10776` 拿到无异常的 `V` 模式证明后，发给 `GenerateContent` 依然返回 `HTTP 403`。
此时本地 Proof 与真浏览器 Proof 外观一模一样：都是 `S = 100`，都有 `0x68`（2B）、`0x7E`（75B）、`0x99`（~975B）和末尾 288B 签名。到底差在哪里？

### 6.1 分段交叉嫁接实验（Section Swap Oracle）
我们在同一份 Challenge、同一个 Prompt（相同 SHA-256 `digest`）下，用真浏览器生成一条 `200 OK` 的 Proof（记为 **Browser**），用本地 Node VM 生成一条 `403` 的 Proof（记为 **Local**），做三组外科手术式替换实验：

| 实验 | 组合方式 | `GenerateContent` 结果 | 关键推论 |
|---|---|---|---|
| **实验 1** | Browser 的其他全部 + **Local 的 `0x7E`（75B 控制流轨迹）** | **`HTTP 200 OK`** | 本地 Node VM 的字节码执行路径 `0x7E` 与真浏览器 **100% 一致**！ |
| **实验 2** | Browser 的其他全部 + **Local 的 `0x99`（加密遥测段）** | **`HTTP 403`** | 问题出在本地的 `0x99` 加密遥测段！ |
| **实验 3** | **Local 的 Prelude + Local 的 `0x68` + Local 的 `0x7E` + Local 的 288B 签名块**，仅把 `0x99` 换成 Browser 的 `0x99` | **`HTTP 200 OK`** | **决定性突破**：各段之间没有跨段 MAC 耦合，且本地生成的 288B 内容签名块 **100% 合法**！唯一导致 403 的原因就在 `0x99` 段内部的遥测明文里！ |

### 6.2 逆向 `0x99` 段的 8 字节分组 CFB 密码与 14 轮 ARX 函数 `Oj`
为了看清 `0x99` 段里到底装了什么，我们逆向了 `iframe-eval.js` 中向 `reg 291` / `reg 179` 写入加密数据的 `ul` 与 `XX` 函数：
- `0x99` 段采用的是 **8 字节分组的密文反馈模式（CFB，Cipher Feedback Mode）**：
  - 前 8 字节 `C[0..7]` 是由伪随机数生成器 `k5` 产生的随机 IV。
  - 第 $N$ 个 8 字节块（$N \ge 1$，字节偏移 $8N$）的 8 字节密钥流，是由**前一个 8 字节密文块** `C[8N-8 .. 8N-1]`（拆成两个 32 位大端整数 $W_{\text{lo}}, W_{\text{hi}}$）加上存储在 `reg 155` 中的两个固定 32 位常数密钥：
    $$T_1 = -1290220787 \quad (\text{0xB31868AD}), \qquad T_2 = -923460489 \quad (\text{0xC8F5C277})$$
    送入 **14 轮 ARX 块密码函数 `Oj`** 计算得出：
    $$\text{Keystream}_N = \text{Oj}\big(29,\ \text{u32}(C, 8N-4),\ 1770,\ [0, 0, T_1, T_2],\ \text{u32}(C, 8N-8)\big)$$
    $$\text{Plaintext}_N = C[8N .. 8N+7] \oplus \text{Keystream}_N$$
- **为什么破解这个 CFB 密码至关重要？**
  1. 我们可以把真浏览器（200）和本地 Node VM（403）的 `0x99` 密文**彻底解密成明文 TLV 记录流**，逐个 Tag 对比差异！
  2. 我们还可以把真浏览器的某几个明文 Tag 嫁接到本地明文中，再重新用 CFB 加密打包发给 Google 服务端（二分法查找），从而以**单条 Tag 精度**验证服务端到底校验了哪些字段！

---

## 阶段七：逐一击破 `0x99` 遥测段的四大校验点

通过明文 TLV 逐条对比与二分替换，我们找出了 Google 服务端在 `0x99` 段中校验的全部 **4 个核心检测点**，并在 `waa-runtime/src/browser/env.js` 与 `service.js` 中完成了 100% 拟真：

### 7.1 校验点一：6 路随机 `typeof` 探针（Tag `3` + Tag `103`）
每次 `Waa/Create` 下发的字节码不仅在 `pc = 10776` 用**前 3 路** `typeof` 探针做流密码 Re-key（并写入 Tag `3`），还会额外抽取 **后 3 路** `typeof` 探针，带 6 字节随机盐拼接后算 4 字节 `JU` 哈希写入 **Tag `103`**！
- **阴险之处**：后 3 路探针**不参与流密码密钥派生**！也就是说，哪怕后 3 路探针里有属性在沙箱中是 `"undefined"`，VM 也**不会报错崩溃**，依然能顺利跑完产出 `S = 100` 的 `V` 模式证明，但因为 Tag `103` 的 4 字节哈希不对，服务端直接判 `403`！
- **随机抽样范围**：跨不同 Challenge 实测抽到的属性包括：
  `window.RTCStatsReport`、`window.XRProjectionLayer`、`window.CloseWatcher`、`window.CSSPositionValue`、`window.WindowControlsOverlayGeometryChangeEvent`、`window.crashReport`、`window.when`（继承自 `EventTarget.prototype`）、`navigator.leaveAdInterestGroup`、`div.style.marginRight`、`div.style.timelineTriggerActiveRange`、`div.style.interpolateSize`、`img.removeChild`、`img.offsetWidth`、`MouseEvents.screenX`、`MouseEvents.pageX` 等。
- **彻底解决**：通过 CDP 从真实 Chrome 151 一次性导出完整属性类型与原型表 `src/browser/chrome-schema.json`（含 `winProps` 1,231 项、`styleTypes` 754 项、`imgTypes` 375 项、`divTypes` 346 项、`docTypes` 302 项、`navTypes` 79 项、`mouseEvTypes` 53 项），在沙箱创建时全量挂载。

### 7.2 校验点二：`iframe.contentWindow` 构造器 `.prototype` 抽样（Tag `232` & Tag `233`）
VM 会在 `bscframe` 的 `iframe.contentWindow`（即沙箱中的 `childWindow`）里随机抽查 9 个类构造器的原型属性顺序：
$$\text{propName} = \text{Object.getOwnPropertyNames}(\text{childWindow}[\text{Ctor}].\text{prototype})[\text{idx}]$$
并将 `[CtorHash(4B), idx(2B), JU(propName)(4B)]` 写入 Tag `232` 与 Tag `233`。
- **踩坑细节**：
  1. 不仅会抽 DOM 类（如 `HTMLAnchorElement`、`Navigator`），还会抽 JS 内建类（如 `childWindow.WeakMap`、`Map`、`Set`、`ArrayBuffer`）。
  2. 不仅检查属性存不存在，还通过固定下标 `idx` **检查 `Object.getOwnPropertyNames(Ctor.prototype)` 的精确排列顺序**！
- **彻底解决**：在 `env.js` 中补齐 `JS_CORE_BUILTINS`，并基于 `chrome-schema.json` 中导出的每个类的 `proto` 数组实现 `makeElementSubProto()`，严格按 Chrome 151 的属性声明顺序构建所有类的 `.prototype`。

### 7.3 校验点三：WebIDL 原型链与 Iframe 生命周期反篡改位图（Tag `[250, 18]`）
在 `0x99` 明文靠后位置，有一条 6 字节记录 `[250, 18, b0, b1, b2, b3]`（32 位反篡改位图）：
- 真浏览器恒为 **`[250, 18, 0, 4, 0, 0]`**；而早期沙箱为 **`[250, 18, 16, 45, 76, 84]`**。
- 逆向 `pc = 16000..17628` 还原出它的全部检测项：
  1. 检查 `Navigator.prototype`（`plugins`/`mimeTypes`/`webdriver`）、`HTMLIFrameElement.prototype`（`srcdoc`/`contentWindow`）、`HTMLAnchorElement.prototype`（`hrefTranslate`）、`HTMLMediaElement.prototype`（`canPlayType`）的属性描述符。
  2. 实例自身 `hasOwnProperty` 必须为 `false`（属性必须在 `.prototype` 上）。
  3. Getter 的 `.name` 必须为 `'get <prop>'`，`.toString()` 必须包含 `[native code]`。
  4. **非法 `this` 调用检测（Illegal Invocation）**：直接调用 `Navigator.prototype.webdriver` 或 `desc.get.call({})` **必须抛出 `TypeError: Illegal invocation`**！
  5. **Iframe DOM 挂载生命周期**：新创建的 `document.createElement('iframe')` 在未 `appendChild` 前 `contentWindow` 必须为 `null`；`appendChild` 后必须返回非空同一引用；`removeChild` 后必须变回 `null`。
- 按上述规则实现 `makeNativeGetter/Setter/Method` 与 Iframe 挂载状态机后，本地位图精准归零为 **`[250, 18, 0, 4, 0, 0]`**。

### 7.4 校验点四：32 桶 DOM 用户交互事件直方图（Tag `235`）——临门一脚！
当前三项全部对齐后，通过二分替换发现最后唯一阻拦 `200 OK` 的是 `0x99` 末尾的 **Tag `235`**（16 字节）：
- 在纯 Node.js 沙箱里，因为没有任何鼠标移动或按键事件，Tag `235` 全是 `0`：`[235, 0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0]`。
- 逆向 `pc = 23485` 发现：VM 在初始化时向 `document` 和 `document.body` 注册了多个事件监听器，用 32 个哈希桶（`reg 191`）统计交互事件计数与时间戳差值，最后汇总写入 Tag `235`。全零代表“无任何人类交互的纯脚本环境”，服务端直接判 `403`！
- **彻底解决（`simulateUserInteraction()`）**：在 `WaaService.init()` 回调完成后以及每次 `snapshot()` 前，向 `document` 和 `document.body` 自动派发一组带递增 `timeStamp` 和坐标的合成事件（`mousemove` $\rightarrow$ `mousedown` $\rightarrow$ `mouseup` $\rightarrow$ `click` $\rightarrow$ `keydown` $\rightarrow$ `keyup` $\rightarrow$ `focus`）。
- 加上这组事件派发后，Tag `235` 立即变为非零直方图，`GenerateContent` **当场返回 `HTTP 200 OK`**！

---

## 阶段八：高并发冷启动优化与两级零落盘内存池

打通单次纯 Node.js 签名后，为了支撑多账号高并发轮询，我们在 `waa-runtime` 与 `3-waa-proof-server` 中实施了 5 项工程优化：

1. **进程级 Schema 原型树缓存（`CACHED_SCHEMA_GLOBALS`）**：
   首次启动时构建一次 Chrome 151 的 1,231 个 WebIDL 类与原型树，后续每个新账号沙箱直接复用描述符，使 `createBrowserEnv()` 从 `~800 ms` 降至 **`5 ms`**。
2. **预编译 `vm.Script` 字节码缓存（`BUNDLE_SCRIPT_CACHE` & `MEMORY_PROGRAM_CACHE`）**：
   对 2.17 MB 的 `b0.patched.js` 和 62 KB 的 `iframe-eval.js` 缓存编译后的 `vm.Script` 对象，跳过重复语法解析，脚本加载耗时从 `~450 ms` 降至 **`118 ms`**。
3. **裁剪无关网络请求 & 缩短就绪轮询**：
   在虚拟 XHR 层短路跳过与签名无关的 `feedback/js/help/*` 和 `lazy.min.js`，并将 `waitForService` 轮询间隔从 `100 ms` 缩短为 `5 ms`。
4. **冷启动时延对比**：
   - 优化前单账号冷启动：`1,550 ~ 2,100 ms`
   - 优化后单账号冷启动：**`576 ~ 860 ms`**
   - 热态单次 `!proof` 铸造：**`27 ~ 45 ms`**
   - 每增加一个热态账号的堆内存增量：仅 **`+1.1 ~ 3.1 MB`**（单机 4GB 内存可常驻数百个热态账号）。
5. **1h 热态单层纯内存池（`src/account-pool.js`）**：
   - 全程**零磁盘写入**（不落盘任何 Cookie 或挑战文件）。
   - 闲置满 1 小时自动销毁 `node:vm` 上下文并删除账号条目；再次请求按冷启动处理（`~600 ms` 重新初始化 VM）。Cookie 完全由调用方持有，池内副本每次请求按传入值覆盖。
