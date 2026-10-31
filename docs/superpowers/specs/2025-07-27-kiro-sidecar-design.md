# kiro-sidecar 设计文档

> 修订日期：2026-10-31。本文定义首版实现方案；传输指纹尚待 Phase 0 验证，不能将本文视为已完成的实现或指纹一致性证明。

## 概述

kiro-sidecar 是一个 Rust 实现的本地传输代理，专为 Kiro 渠道设计。Node.js 构造最终上游请求，Rust 负责 TLS、HTTP、上游代理和连接复用，并原样返回上游响应 body。

**首版目标**：提供可配置、可验证的 Rust 出站传输路径，评估它与目标客户端的 TLS / HTTP 行为差异，以及对现有请求链路的实际影响。

使用 Rust 或 rustls 不代表与某个版本的 AWS SDK、Q CLI 或 Kiro IDE 具有相同指纹，也不代表已经证明可以改善上游的风控或限流行为。目标客户端、依赖版本、加密后端、ClientHello 和 HTTP/2 参数必须通过前置实验确认。

**职责边界：**

| Node.js | Rust sidecar |
|---------|--------------|
| 凭证加载、token 刷新、账号状态 | 本地 HTTP 服务与目标地址校验 |
| 请求体构建、模型与端点路由 | TLS / HTTP 连接、上游代理拨号 |
| 请求头、UA 与调用身份策略 | 连接池与有界资源管理 |
| 严格解码 AWS Event Stream、事件语义处理 | 原样转发请求和响应 body |
| 工具调用组装、超时、重试与换账号 | 结构化报告本地传输错误、执行取消 |

首版不实现 Rust Event Stream 解码器，不引入 NDJSON，不提取第二条 `_streamViaSidecar` 事件处理路径。现有 `parseAwsEventStreamBuffer` 和严格的 `decodeKiroFrames` 继续负责校验和解码。

## Phase 0：先验证传输目标

进入正式开发前，完成一个最小传输实验，并保存可复核的对比结果：

1. 选定目标客户端及准确版本，明确参考 Q CLI 还是 Kiro IDE，不混用两者的 UA、端点和传输行为。
2. 固定 Rust 工具链、Cargo.lock、TLS 加密后端、TLS 配置及 HTTP 客户端配置，建立具名的 `transport_profile`。
3. 在受控环境中比较目标客户端、现有路径和实验路径的 ClientHello、ALPN、实际 HTTP 版本，以及使用 HTTP/2 时的 SETTINGS 和流控参数。比较协议字段与偏好，不要求随机数等随机字段相同。
4. 分别验证直连和项目实际使用的代理方式；同时检查证书校验、代理认证和 DNS 解析位置。
5. 验证相同请求的事件内容、工具参数、错误和取消行为没有回归，记录成功率与延迟。少量成功请求不能作为降低风控风险的证据。

验证记录包括客户端版本、测试环境、代理类型、工具链和依赖版本、配置、观察到的差异及尚未确认的事项。只有证据支持某一目标时，才能声称对应字段或行为一致。

若无法获取有效对照，或未观察到值得增加维护成本的收益，保持 `KIRO_SIDECAR_ENABLED=false`，暂缓后续开发。下面的依赖和构建版本是候选基线，最终以该阶段验证并提交的配置为准。

## 架构

### 请求流转

```text
Node.js (claude-kiro.js)
│  凭证准备、buildCodewhispererRequest
│  _buildRoutedRequest：生成最终 URL、body、headers
│    ├─ Builder ID → CodeWhisperer，移除不适用的 profileArn
│    └─ API Key → 配置的 runtime，调整 origin / Content-Type 等
│  合并 Axios 默认 headers 与本次 headers
│  选择传输：kiro-sidecar / 现有 tls-sidecar / 现有 Node.js 路径
│
▼ POST http://127.0.0.1:9091/stream（选中 kiro-sidecar 时）
  本地控制 headers + 最终上游 headers
  Body：最终上游请求序列化后的 JSON 字节
│
▼ Rust kiro-sidecar
│  校验本地协议、目标地址、代理配置及资源预算
│  通过选定的 transport_profile 发送一次上游请求
│  转发上游 status / 允许的响应 headers / 原始 body
│
▼ Node.js 收到普通 Axios stream 响应
  现有严格 Event Stream 解码
  现有事件分类、工具名还原、工具组装、超时与终止处理
```

首次发送前确定是否使用 kiro-sidecar，并在本次请求的串行传输重试中复用该选择；kiro-sidecar 的健康变化只影响后续新请求。未选中 kiro-sidecar 时继续原有 tls-sidecar / Node.js 选择逻辑。不能将 kiro-sidecar 的本地地址再交给 tls-sidecar 包装，也不能在已发送的请求中并行竞速或拼接两条路径的响应。

### 与 tls-sidecar 的关系

| 维度 | tls-sidecar | kiro-sidecar 首版 |
|------|-------------|------------------|
| 语言 | Go | Rust |
| 用途 | 现有通用 TLS 代理 | Kiro 专用传输路径 |
| 响应 body | 原样透传 | 原样透传 AWS Event Stream |
| 默认端口 | 9090 | 9091，仅监听 loopback |
| TLS 配置 | 现有 uTLS 配置 | Phase 0 验证的 rustls 配置 |
| 事件解码 | Node.js | 同一个 Node.js 严格解码器 |

kiro-sidecar 不可用时，尚未发起的请求使用原有传输选择逻辑。现有代理配置仍然生效；不能将“sidecar 降级”解释为忽略用户指定的上游代理而直连。

首版接入 `streamApiReal` 使用的传输，包括通过现有流式链路汇总结果的非流式生成接口。token 刷新、模型发现、用量查询以及其他调用保留现有传输，后续扩展需要单独验证。

## Node.js 集成

### 先完成业务路由，再选择传输

将当前 `_requestWithBuilderEndpointRouting` 拆成“生成最终请求”和“发送请求”两部分：

- 新增 `_buildRoutedRequest(axiosConfig, requestData)`，保留原有 Builder ID、API Key runtime 路由和全部请求改写，避免修改调用方的原始对象。
- 合并 Axios 实例默认 headers、方法级 headers 与请求 headers，保留默认的 Content-Type、`amz-sdk-request` 等；不能仅转发 `streamApiReal` 局部变量中的 headers。
- 路由改写后，对最终上游 body 再应用请求大小限制，序列化一次；工具名映射等内部状态留在 Node.js，不加入线上的 JSON。
- `_requestWithBuilderEndpointRouting` 默认保持现有行为，仅在调用方明确启用 Kiro sidecar、响应类型为 stream 且 sidecar ready 时首次选择新路径。请求级传输上下文保存该选择，并传入递归重试，不能在每次重试时重新按 ready 状态降级。

示意代码只表达执行顺序，header 合并和错误适配必须按 Axios 的实际行为实现：

```js
async _requestWithBuilderEndpointRouting(config, requestData, options = {}) {
    const routed = this._buildRoutedRequest(config, requestData);
    const outbound = mergeAxiosDefaults(this.axiosInstance, routed);

    // 首次检查配置、响应类型及 ready；重试复用请求级传输选择。
    const transport = selectOrReuseTransport(outbound, options);
    if (transport.kind === 'kiro-sidecar') {
        return await this._requestViaKiroSidecar(outbound, transport);
    }

    this._applySidecar(outbound); // 原有 tls-sidecar / 代理选择
    return await this.axiosInstance.request(outbound);
}
```

`streamApiReal` 在现有请求位置传入 `allowKiroSidecar: true` 和请求级传输上下文，继续使用同一份循环、catch 和 finally，不新增独立的事件生成器。以下行为由原有公共流程统一管理：

- 并发 / 速率控制和客户端取消；
- 首个有效事件、空闲、总时长超时；
- 严格帧校验、尾部半帧检查、upstream exception 处理；
- 工具名还原、工具参数验证、usage 和 stop reason；
- `hasYieldedContent` 及已有输出后的重试限制；
- 错误 body 的有界读取、凭证状态更新与资源释放。

### 本地请求适配

`_requestViaKiroSidecar(outbound, transport)` 只负责协议适配，返回与原有请求相同的 Axios response 或标准化错误：

1. 使用原有 `resolveProxyUrlForProvider(..., { forSidecar: true })` 规则解析本次账号的代理，保留节点配置、动态绑定及原有 fallback 的优先级。解析失败应报错，不能静默直连。
2. 把最终目标 URL 和已解析的代理传给 Rust；上游 Authorization 与允许的业务 headers 按下面的协议传递。
3. 本地连接使用独立的 keep-alive `http.Agent`，设置 `proxy: false`，清除继承的代理 agents 和远端 `baseURL`。保留本次传输的 AbortSignal。
4. 本地跳转禁止自动跟随重定向；响应的压缩处理与现有上游路径保持一致。
5. 在上游 HTTP 错误处理之前识别 sidecar 自身错误；上游错误则保留原始 status、headers 和 body，不改成包装 JSON。本地控制 headers 在适配层消费，不冒充 AWS 响应信息。

## 本地接口协议 v1

### 信任与版本约定

sidecar 仅监听 `127.0.0.1`，不暴露容器端口。Node.js 每次启动子进程时生成独立的本地随机密钥和实例 ID；本地密钥通过子进程环境或受控管道传入，不复用 AWS token，不进入日志。

`/stream` 和 `/health` 都要求 `X-Kiro-Sidecar-Token`。`X-Kiro-Protocol-Version: 1` 用于协议协商；不支持的版本必须失败，不能尝试解析未知协议。健康检查同时核对实例 ID、协议版本和 transport profile，不能只检查 HTTP 200 或接管占用同一端口的其他进程。

`X-Target-Url` 仅接受允许的 HTTPS 目标。内置允许项覆盖现有 Kiro / CodeWhisperer / runtime 端点；自定义 base URL 通过 Node.js 启动配置显式加入精确 origin 允许列表。禁止 URL userinfo、fragment 和自动重定向，不使用宽泛的 `*.amazonaws.com` 代替目标约束。

### POST /stream

**本地控制 headers：**

| Header | 必填 | 说明 |
|--------|------|------|
| X-Kiro-Sidecar-Token | 是 | 本地调用认证，不转发到上游 |
| X-Kiro-Protocol-Version | 是 | 首版固定为 `1` |
| X-Target-Url | 是 | 业务路由完成后的最终 HTTPS URL |
| X-Proxy-Url | 否 | 本次请求使用的 http / https / socks5 / socks5h 代理，包含需要的认证信息 |

**上游 headers：** Node.js 传入，Rust 按明确允许列表转发，不自行硬编码另一套 UA。

| Header | 处理 |
|--------|------|
| Authorization | 保留最终 Bearer token |
| TokenType | 存在时保留，例如 `API_KEY` |
| Content-Type、Accept | 保留最终请求值；不能将所有端点统一写成同一种 Content-Type |
| user-agent、x-amz-user-agent | 保留 Node.js 按目标客户端策略生成的值 |
| x-amz-target | 存在时保留 |
| amz-sdk-invocation-id、amz-sdk-request | 保留本次调用身份和尝试信息 |
| x-amzn-codewhisperer-optout | 保留最终值，包括 API Key 路由的改写 |
| x-amzn-kiro-agent-mode、x-amzn-kiro-profile-arn | 存在时保留 |

Rust 按最终 URL 生成 Host / HTTP authority，按实际 body 生成 Content-Length 或对应的传输 framing。移除本地控制 headers、hop-by-hop headers 及 Connection 指定的 headers。不能笼统删除所有 `X-` headers，否则会误删 AWS 的业务 headers。

**Body：** Node.js 完成路由后序列化的 JSON 字节。Rust 按配置的上限读取，不使用 `Json` extractor 重新解释请求体，不添加、删除或重排字段。

### 上游响应：保留 status、body 和必要 headers

所有已收到的上游 HTTP 响应均携带 sidecar 生成的标识：

```http
X-Kiro-Protocol-Version: 1
X-Kiro-Response-Source: upstream
```

保留上游 Content-Type、Content-Encoding、Retry-After、请求追踪 ID 和 AWS 错误类型等允许的响应 headers。移除 hop-by-hop headers，并重新生成本地 HTTP framing；上游不得覆盖 `X-Kiro-*` 控制标识。

- HTTP 200：原样转发二进制 Event Stream，不解码、不拼接、不丢弃帧，不插入心跳或 JSON 错误。
- 上游 4xx / 5xx 等其他状态：保留原始状态和 body 字节，不包成 `{ error, body }`。Node.js 原有的 401 / 402 / 403 / 429 / 5xx 处理继续读取真实上游信息。
- Rust 不为了格式化错误而预先无限读取错误 body。Node.js 继续应用已有的错误 body 大小和读取超时限制。

### sidecar 自身错误：只在本地响应头提交前返回 JSON

示例：

```http
HTTP/1.1 502 Bad Gateway
Content-Type: application/json
X-Kiro-Protocol-Version: 1
X-Kiro-Response-Source: sidecar

{"source":"sidecar","code":"CONNECT_TIMEOUT","phase":"connect","message":"upstream connect timeout","retryable":true}
```

| code | 示例触发条件 | 本地 HTTP 状态 | 是否可重试 |
|------|--------------|---------------|------------|
| LOCAL_AUTH_FAILED | 本地密钥无效 | 401 | 否，属于本地配置错误 |
| PROTOCOL_UNSUPPORTED | 本地协议不兼容 | 400 | 否 |
| INVALID_TARGET / INVALID_PROXY | 目标或代理配置无效 | 400 | 否 |
| REQUEST_TOO_LARGE | 本地请求 body 超限 | 413 | 否 |
| SIDECAR_BUSY | 并发或内存预算已满 | 503 | 仅在未输出且仍有公共重试预算时 |
| DNS_ERROR / CONNECT_TIMEOUT / CONNECT_ERROR | DNS 或连接失败 | 502 | 按具体原因和公共重试预算判断 |
| TLS_ERROR / PROXY_AUTH_FAILED | 证书、握手配置或代理认证失败 | 502 | 默认否，需要配置或环境恢复 |
| PROXY_CONNECT_ERROR / UPSTREAM_HEADERS_ERROR | 代理连接或读取上游响应头失败 | 502 | 按具体原因和公共重试预算判断 |

`phase` 表示 `local`、`dns`、`connect`、`proxy`、`tls` 或 `headers`。错误不包含凭证、代理密码或请求 body。

Node.js 必须在现有 AWS HTTP 状态分支前完成 source 分类：

- `source=sidecar` 设置独立的传输错误标识、`skipErrorCount=true`、`shouldSwitchCredential=false`，交给传输重试策略，不进入 AWS 401 / 403 / 5xx 或账号恢复逻辑。
- 上层通用错误处理同样识别该标识，不能再次把本地 HTTP 502 / 503 当作 AWS 失败或换账号理由。
- 本地接口失联、版本错误、非法响应或无法确认来源的本地错误也归入传输错误；不能因为缺少 marker 就猜成 AWS 的认证失败。
- 流式响应中途发生、无法确认来自 sidecar 还是 AWS 连接的中断，同样按传输错误处理，保留已有输出边界，不推断为账号认证或配额问题。
- sidecar 的 `retryable` 是必要输入，Node.js 还必须检查客户端取消、实际错误原因、是否已经输出和剩余预算。Rust 本身不重试。

### HTTP 200 提交后的中断与 EOF

一旦提交上游响应头，sidecar 不再尝试改变状态码或插入错误 JSON。上游读取失败、body 未完整结束或本地转发失败，必须以响应 body 错误终止本地连接；不能捕获错误后返回正常 EOF，也不能发送表示成功完成的最终 HTTP chunk。

Node.js 通过两层检查判断结果：

1. 本地响应是否正常完成；body 错误、连接重置、sidecar 崩溃都导致请求失败。
2. 现有严格解码器是否成功消费全部字节；CRC 错误、非法 UTF-8 / JSON、非法 header、upstream exception 和 EOF 时残留半帧均导致失败。

保留现有业务结束策略：有明确 stop reason 时按其处理；`KIRO_REQUIRE_STOP_REASON=true` 时，缺失 stop reason 必须失败。对允许无 stop reason 的旧端点，正常 HTTP EOF 和完整帧只能说明已接收的字节完整，不能证明模型语义上绝无截断。sidecar 不伪造 stop reason 来消除这个限制。

首版没有 NDJSON，因此不引入自定义 `end` 消息；结束状态由 HTTP body 完整性、严格解码和现有业务策略共同判断。

### GET /health

```json
{
  "status": "ok",
  "service": "kiro-sidecar",
  "protocol_version": 1,
  "instance_id": "<Node.js 为本次子进程生成的实例 ID>",
  "transport_profile": "<Phase 0 验证的配置名>",
  "inflight": 0,
  "buffer_bytes": 0
}
```

健康检查只报告本地进程及其配置是否可用，不通过实际 AWS 请求检查账号，也不表示上游连接必定成功。

## 错误处理、重试与降级

| 场景 | 行为 |
|------|------|
| 配置未启用、二进制不存在、实例未 ready | 新请求按原有 tls-sidecar / Node.js 逻辑发送，保留配置的上游代理 |
| 健康检查失败或进程退出 | 立即 ready=false；后续新请求降级，已有请求按各自结果完成或失败 |
| sidecar 自身连接失败 | 标准化成本地传输错误；仅在未输出、未取消、原因允许且有预算时串行重试 |
| 已发请求的 sidecar 不可用 | 不在该请求中自动切换其他传输；保留失败并允许后续新请求重新选择路径 |
| AWS HTTP 错误 | 保留原始状态、headers、body，进入现有业务处理 |
| CRC 错误、非法帧、upstream exception、尾部半帧 | 严格失败，不扫描恢复，不跳帧，不把部分结果当成功 |
| 已经输出内容、思考或工具参数后中断 | 终止并向调用方报告错误，不从头重发，不自动重放工具调用 |
| 客户端取消 | 取消当前尝试，不重试，不换账号，不改变凭证健康状态 |

所有可重试路径共享既有请求预算，不为 Rust、sidecar 适配层和业务层分别增加重试次数。未向客户端输出并不表示 AWS 一定没有执行；重试生成 POST 仍可能产生额外计算和计费，不能将 invocation ID 当成未验证的幂等保证。

## 超时、取消与资源边界

### 超时责任

| 预算 | 所有者 | 首版约定 |
|------|--------|----------|
| 连接建立 | Rust | 连接阶段总预算默认 10 秒，覆盖 DNS、代理、TCP 和 TLS；始终受 Node.js 更早取消约束 |
| 首个有效模型事件 | Node.js | 保留 `KIRO_FIRST_EVENT_TIMEOUT_MS`，默认 30 秒 |
| 流空闲 | Node.js | 保留 `KIRO_STREAM_IDLE_TIMEOUT_MS`，默认 120 秒，并保留下游反压期间的现有计时行为 |
| 整次尝试 | Node.js | 保留 `KIRO_STREAM_TOTAL_TIMEOUT_MS`，默认 0 表示不设额外总时限 |
| 错误 body 读取 | Node.js | 保留现有有界读取策略 |

Node.js 的应用级预算覆盖本地转发和上游等待。Rust 不复制参考项目的固定整次请求 timeout，不另加等待响应头和整流读取的默认时限，也不增加独立的重试或静默断流逻辑。

### 取消与反压

```text
客户端 disconnect / Node.js deadline / 调用方结束迭代
  → 取消本次传输 signal，销毁本地 stream
  → Rust 取消尚未完成的拨号、代理握手或上游响应等待
  → 停止读取上游 body，释放本次流及资源预算
```

drop 是资源回收手段，不能代替取消行为的验证。请求 future、上游 response body 和本地响应 body 必须有清晰的所有权；若启动后台任务，应绑定同一个取消上下文，并在下游断开时取消和回收。分别验证收到上游响应头之前及之后的取消，不能只覆盖正在转发数据时的情况。

响应转发按下游消费速度读取上游，不使用无限 channel 或将整个响应收集进内存。HTTP/2 取消针对当前 stream，不能无条件关闭被其他请求共用的连接。

### 资源限制

- 请求 body 上限与 Node.js 的 `KIRO_MAX_PAYLOAD_BYTES` 一致，默认 10 MiB，由启动配置传入 Rust；路由后的字节数必须再次校验。
- 本地 handler 明确执行 body 上限，不依赖框架 extractor 的隐式默认值。Rust 首版允许有界缓冲请求，但响应必须流式转发。
- 首版 sidecar 默认最多接纳 128 个在途请求，请求 body 总缓冲预算默认 64 MiB。读取前申请预算；预算不足返回 `SIDECAR_BUSY`，不能先分配后排队。
- 客户端缓存默认最多 128 个代理 / TLS 配置组合，使用有界淘汰策略。key 必须包含完整代理身份、认证信息和 transport profile；实际目标连接按 scheme / host / port 隔离，不能跨代理复用连接。
- 淘汰缓存不能中断仍在使用的请求；账号 token 放在本次请求 headers 中，不作为共享 client 的可变默认值。
- 日志只记录脱敏后的目标、错误阶段、耗时、profile 和资源计数；不记录 AWS token、本地密钥、代理 userinfo 或完整请求 body。

这些边界属于核心实现与验收要求，不能推迟到 Docker 收尾阶段。

## 进程生命周期

新增 `src/utils/kiro-sidecar.js`，复用现有管理方式的接口习惯，但单独实现以下状态规则：

```text
stopped → starting → ready
              │        └─ 健康失败 → unhealthy ── 健康恢复 → ready
              │                       │
              └──→ backoff ←── 进程退出 / 连续健康检查失败
                       ├─ 预算内 → starting
                       └─ 预算耗尽 → unavailable
任意状态 → stopping → stopped
```

- 并发 `start()` 共享同一个启动 promise；starting、unhealthy 和 backoff 都不对请求报告 ready。
- 等待启动就绪默认最多 10 秒，健康检查间隔 30 秒、单次超时 3 秒；启动超时必须先回收旧进程，再按预算处理后续重启。
- 任一次健康检查失败即撤销 ready；连续 3 次失败时，先终止并回收旧进程，再按同一预算重启。恢复健康可回到 ready，但必须仍是同一实例。
- 自动重启预算为滚动 10 分钟内最多 5 次，采用有上限的退避。健康检查成功不清零滚动预算；预算耗尽保持 unavailable，直到显式重新启动。重新加载配置也必须停止旧进程后再启动。
- 保存并取消启动、健康检查、退避和停止定时器。`stop()` 幂等，在 stopping 期间禁止启动新子进程，不能由排队的重启回调复活进程。
- `spawn` 错误和 `exit` 都进入统一清理路径，并保证同一子进程只触发一次重启调度。端口占用或健康身份不符时，不复用未知进程。
- Node.js 托管模式保留父子控制管道；父进程退出、管道 EOF 时，Rust 停止服务并回收资源，避免 worker 异常退出后留下孤儿进程。
- 正常停止时，Rust 先停止接纳新请求，在最多 5 秒内排空；到期取消剩余请求并退出。Node.js 保留最终强制结束能力，整个流程受现有服务器关闭总时限约束。
- 关闭本地 keep-alive agent，清理健康状态、实例身份和子进程句柄。

### 配置与服务集成

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| KIRO_SIDECAR_ENABLED | boolean | false | 启用经过验证的首版传输 |
| KIRO_SIDECAR_PORT | number | 9091 | loopback 监听端口 |
| KIRO_SIDECAR_PATH | string | auto | 自定义二进制路径 |

Node.js 根据有效业务端点生成目标允许列表，并把本地密钥、实例 ID、请求上限和 transport profile 传入子进程。首版 profile 与构建版本绑定，不能在请求中随意覆盖 TLS 配置。

二进制查找包含 `<projectRoot>/kiro-sidecar/kiro-sidecar` 和 `/app/kiro-sidecar/kiro-sidecar`。首版交付 Linux x86_64；平台不匹配或不可执行时明确记录启动失败，再按降级规则处理。宿主机其他平台可通过指定平台的 Docker 验证，不宣称提供原生二进制。

`src/services/api-server.js` 同时集成启动和关闭；启动失败记录具体原因并继续原有路径。健康恢复只影响后续请求，不迁移已有请求。

## Rust 项目与构建

### 项目结构

```text
kiro-sidecar/
├── Cargo.toml
├── Cargo.lock
├── rust-toolchain.toml
├── .gitignore
├── src/
│   ├── main.rs             # loopback server、父进程管道、signal 与退出
│   ├── config.rs           # 经过验证的传输配置与资源预算
│   ├── health.rs           # 本地认证、版本和实例健康信息
│   ├── proxy.rs            # 有界请求读取、原始响应 body 转发
│   ├── client.rs           # reqwest TLS / HTTP / 代理配置、连接复用和缓存
│   ├── protocol.rs         # 本地控制 headers、目标限制、错误格式
│   └── lifecycle.rs        # 取消、在途计数、排空和资源释放
└── tests/
    ├── integration.rs      # mock 上游和代理、错误、取消与反压
    └── fixtures/           # 原始样本，Rust 不解析其事件语义
```

### 依赖与 TLS 后端

沿用当前设计中的 reqwest 客户端选型，借鉴参考项目的代理配置和 client 缓存方式；底层仍是 hyper / rustls，但不直接复制参考项目的端点身份、默认 timeout 或损坏帧恢复策略。只有 Phase 0 证实 reqwest 无法表达所需传输参数时，才评估直接使用 hyper 的额外成本。

候选依赖如下；首版只选择 `aws-lc-rs` 后端。若 Phase 0 证据要求更换，必须同步修改所有相关 features、构建依赖和验证记录，不能同时开启两个后端后依赖自动选择：

```toml
[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["rt"] }
reqwest = { version = "0.12.24", default-features = false, features = ["stream", "http2", "socks", "rustls-tls-native-roots-no-provider"] }
rustls = { version = "0.23", default-features = false, features = ["aws_lc_rs", "std", "tls12"] }
http = "1"
bytes = "1"
futures-util = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
url = "2"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

使用 reqwest 的 `no-provider` TLS feature，再由 rustls 显式选择唯一的 crypto provider；不能额外启用会引入 ring 的普通 `rustls-tls` / `rustls-tls-native-roots` feature。用依赖树核对实际 features，不能依靠特性推断。HTTP/1.1 与 HTTP/2 的启用方式、ALPN 和协商规则由 profile 固定，不能因只添加了 `http2` feature 就声称已经复现目标客户端。

reqwest Client 必须显式禁用自动重定向及库级重试，并用 mock 计数证明一次调用只发送一次上游请求。代理只使用 Node.js 为本次请求解析的配置，不读取系统代理形成第二套优先级。禁用自动压缩 / 解压，保留 Rust 转发的原始 body 字节和 Content-Encoding，让 Node.js 继续按原有规则处理。连接超时、代理认证、证书信任和 profile 参数在 client 构建时固定，禁止把账号 Authorization 存为共享默认 header。

证书链和目标主机名校验保持启用。使用系统根证书时，最终运行镜像必须安装 CA bundle；企业代理需要的 CA 通过显式配置提供，不能通过关闭校验解决连接问题。

### Docker

当前交付基线为 Rust 1.88.0，与 `rust-toolchain.toml` 及 `rust:1.88-alpine` 构建镜像一致，已通过 Linux amd64 完整镜像构建和最终运行环境验证。构建使用提交的 Cargo.lock，不在构建时重新解析依赖版本。参考项目的 Rust 1.92 不作为未经验证的强制升级要求。

```dockerfile
FROM rust:1.88-alpine AS kiro-builder
RUN apk add --no-cache build-base cmake perl
WORKDIR /build
COPY kiro-sidecar/Cargo.toml kiro-sidecar/Cargo.lock kiro-sidecar/rust-toolchain.toml ./
COPY kiro-sidecar/src ./src
RUN cargo build --release --locked

# 在现有 Node.js 最终 stage 中，COPY . . 之后增加：
RUN apk add --no-cache ca-certificates
COPY --from=kiro-builder /build/target/release/kiro-sidecar /app/kiro-sidecar/kiro-sidecar
RUN chmod +x /app/kiro-sidecar/kiro-sidecar
```

首版用 Linux amd64 构建并在最终运行镜像内执行健康检查和 TLS 连通性测试。核对产物架构、动态依赖及根证书来源；即使二进制为静态链接，证书信任库仍是运行环境的一部分。不使用空 `main.rs` 预编译再覆盖的方式优化首版缓存，后续可单独引入经过验证的依赖缓存方案。

## 测试与验收

### 两条传输路径的同样例验证

同一组 mock 上游样本分别通过原有路径和真实 Rust sidecar，最终都进入现有 JS 严格解码器。正常情况比较事件、文本、工具参数、usage 与 stop reason；失败情况比较错误类别、是否误报成功、是否重试及凭证状态变化。

| 场景 | 必须验证的结果 |
|------|----------------|
| 正常帧、跨 chunk、UTF-8 分片、相邻重复 delta | 内容及顺序一致，不丢失、不去重、不重排 |
| Builder ID 无 profileArn | 最终 URL 和 body 与原有业务路由一致 |
| API Key runtime | URL、origin、Content-Type、TokenType 和 optout 值均一致 |
| Axios 默认 headers、UA、invocation ID | 经 sidecar 后完整保留允许的最终值 |
| 两账号使用不同代理 / 代理密码变化 | 不跨代理复用连接，不串请求头；无效代理不直连 |
| HTTP 401 / 402 / 403 / 429 / 5xx | 状态、必要 headers 和原始错误 body 可被公共处理读取 |
| 本地认证失败、TLS 失败、代理失败、sidecar busy | 被识别为本地传输错误，不刷新或惩罚 AWS 凭证 |
| 错误 body 超限、迟迟不结束、读取时客户端取消 | 保留有界读取和取消，释放请求槽位 |
| Prelude / message CRC 错误、非法 UTF-8 / JSON / header | 失败，不跳帧，不将部分结果完成为成功响应 |
| 工具参数中间帧损坏 | 不把剩余片段拼成另一份合法工具调用；不执行或完成错误参数 |
| 文本后收到 upstream exception | 两条路径均报告失败 |
| 文本后 EOF 留有半帧、sidecar 中途崩溃 | 两条路径均失败；HTTP body 错误不能转换成正常 EOF |
| 在完整帧边界发生传输错误 | 仍报告传输失败，不能只依据解码 buffer 为空就成功 |
| 明确 stop reason、严格模式缺少 stop reason | 保持既有业务终止策略 |
| 首事件、空闲、总时长超时 | 公共预算生效，反压不引入额外空闲误判 |
| 拨号、代理握手、等待上游响应头或转发 body 时取消 | 上游操作结束，后台任务、槽位和预算各释放一次 |
| 已输出内容 / 思考 / 工具参数后断流 | 不重发、不重放工具调用 |
| 慢下游、超大 body、高并发和缓存淘汰 | 内存和任务数有界，活跃请求不因缓存淘汰被关闭 |
| 并发启动、连续崩溃、spawn 失败、健康身份不符 | 无重复进程、重启预算正确、不接管未知服务 |
| 停止时已有重启排队、父进程异常退出 | 不复活进程，无孤儿 sidecar |
| 未启用、二进制缺失、启动失败 | 新请求按原有路径和原有代理规则运行 |

测试需包含真实本地 HTTP 服务、代理和 Rust 进程；只 mock `_requestWithBuilderEndpointRouting` 的既有 JS 测试不能替代这组验收。

### 回归基线与新增测试

- 新增 Rust 集成测试，验证字节透传、协议、代理、连接隔离、取消、反压和资源预算。
- 新增 `tests/kiro-sidecar-integration.test.js`，验证真实 sidecar 与 Node.js 的协议、source 分类、路由和生命周期。
- 将 `kiro-streaming.test.js`、`kiro-production-safety.test.js`、`kiro-truncation-recovery.test.js`、`kiro-buffered-stream.test.js` 纳入回归，并覆盖新增行为涉及的账号状态和代理测试。
- 验收以当前工作树重新运行的结果为准，不能沿用文档早期的 146 项通过记录。当前验证结果及已有失败见下节。
- Rust 构建、测试和最终 Docker 镜像验证使用同一份锁定依赖与目标架构。

### 2026-10-31 实现修复验证记录

本次修复覆盖本地错误与 AWS 错误隔离、串行重试预算和实例固定、读取前内存申请、流结束前并发占用、代理校验、Axios headers 合并、库级重试与重定向关闭、HTTP 协商，以及子进程的启动、健康、重启、管道 EOF 与有界排空。

| 验证 | 结果与边界 |
|------|------------|
| Rust 单元测试 | 本机 `cargo test --locked --offline` 与 Linux amd64 构建容器内 `cargo test --release --locked --offline` 均为 30 项通过，包含资源释放、溢出与协议校验 |
| 真实 sidecar 集成 | `tests/kiro-sidecar-integration.test.js`：42 项通过，使用真实 Rust 子进程、本地 CA / HTTPS 上游与 CONNECT 代理 |
| 其他相关 Node.js 回归 | 12 组、316 项通过，覆盖流完整性、生产安全、截断恢复、账号状态、公共 handler、代理、配额和槽位 |
| Linux amd64 完整镜像 | 项目 Dockerfile 构建通过；最终 Node Alpine 镜像内认证健康检查、原始字节透传、HTTP/2、HTTP/1.1 回退、证书主机名校验、本地 / 上游 401 分类及正常停止通过 |
| 运行依赖 | Rust 1.88.0；锁定 reqwest 0.12.28、rustls 0.23.46；依赖树只启用 aws-lc-rs provider；最终镜像存在 CA bundle，未包含宿主机 `kiro-sidecar/target` |

新增集成测试需要 Rust / Cargo、OpenSSL 及本机监听权限；默认使用 `cargo build --locked --offline` 构建测试二进制，因此首次运行前须先在 `kiro-sidecar` 目录执行 `cargo build --locked` 下载锁定依赖。也可通过 `KIRO_SIDECAR_TEST_BINARY` 指定已构建的同平台二进制。

扩展回归仍有 26 项已有失败：`kiro-core-review-fixes.test.js` 的 19 项涉及凭证隔离、发送前账号检查、重试配置校验和工具终止原因；`kiro-buffered-stream.test.js` 的 7 项调用了当前不存在的 `generateContentStreamBuffered`。在临时副本中使用修改前的已提交 Kiro 实现运行相同测试，失败名称及数量完全一致；本轮 sidecar 修复未新增这些失败，也未据此宣称全仓测试通过。

以上结果证明受控环境中的传输与生命周期行为；尚未完成 Phase 0 的目标客户端 ClientHello / HTTP/2 SETTINGS 对照，也未进行真实 AWS 账号成功率或风控实验。

## 开发阶段

| 阶段 | 交付与退出条件 | 初步估时 |
|------|----------------|----------|
| Phase 0：传输实验 | 目标客户端、profile、对比记录和继续实施依据；未通过则暂缓 | 1–2 天，取决于对照环境 |
| Phase 1：Rust 传输核心 | 本地协议、原始透传、代理、错误分类、取消、反压和预算；mock 集成通过 | 2–3 天 |
| Phase 2：Node.js 接入 | 路由与发送分离、共用流处理、进程管理、source 错误适配、降级验证 | 1–2 天 |
| Phase 3：交付验收 | 两路径同样例、既有回归、Linux amd64 Docker、故障与退出验证 | 1–2 天 |

Phase 0 通过后，再按验证结果修订估时；当前预计总计约 5–9 个工作日。若验证要求超出 reqwest 能力的传输配置，单独评估，不通过删减完整性和生命周期验收来满足工期。

## 后续扩展：Event Stream 解码迁移的门槛

只有在测量证实 JS 解码存在值得优化的开销，或有明确复用需求时，才重新设计 Rust 解码。该扩展不属于首版，需独立评审并满足：

- 与严格 JS 解码器使用同一批正确和错误样本，保持 CRC32（IEEE / ISO-HDLC）、保留 header 类型校验和错误语义；不采用扫描恢复或静默跳帧。
- 明确 `frame / error / end` 消息、协议版本和边界，不把“能够 JSON.parse”当作协议完整性校验。
- 解码器必须有 `finish()`，只有上游 body 正常结束且无残留时才输出 `end`。缺少 `end`、未知消息、非法 NDJSON、CRC 错误和 upstream exception 都必须失败。
- 错误和 EOF 必须保持工具调用安全性，不能修补、重放或拼接已经丢失的工具参数。
- 继续共用 Node.js 的业务事件处理、请求预算及凭证逻辑。

## 参考依据

- 本地 `kiro.rs/src/http_client.rs`：TLS 后端、代理认证和 HTTP client 构建。
- 本地 `kiro.rs/src/kiro/provider.rs`：按有效代理配置缓存 client 的方式。
- 本地 `kiro.rs/src/kiro/endpoint/ide.rs`：其 IDE 端点和 UA 是独立的客户端身份，不能作为 Q CLI 一致性的证明。
- 本项目 `src/providers/claude/claude-kiro.js`、`kiro-event-stream.js` 及对应测试：业务路由、严格完整性校验和流生命周期基线。
- [Amazon Event Stream Specification](https://smithy.io/2.0/aws/amazon-eventstream.html)：CRC 校验失败必须终止流。
- [AWS SDK for Rust HTTP 配置](https://docs.aws.amazon.com/sdk-for-rust/latest/dg/http.html)：HTTP / TLS 后端及配置选项。
- [reqwest features](https://docs.rs/crate/reqwest/0.12.24/features)、[rustls CryptoProvider](https://docs.rs/rustls/0.23.35/rustls/crypto/struct.CryptoProvider.html)：使用 no-provider feature，显式选择加密后端，避免特性叠加。
