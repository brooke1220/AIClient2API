# kiro-sidecar 设计文档

## 概述

kiro-sidecar 是一个 Rust 实现的本地代理程序，专为 Kiro 渠道设计。它用真实的 Rust TLS/HTTP2 指纹发送请求到 AWS，并将 AWS Event Stream 二进制帧解码为 NDJSON 流式输出供 Node.js 消费。

**核心价值**：解决当前请求链路中 UA 声称 `aws-sdk-rust` 但实际 TLS 指纹为 Node.js/Go 的不一致问题。

**定位**：纯传输代理 + 帧解码器。不涉及路由选择、认证管理、请求体构建、业务逻辑。

## 架构

### 请求流转

```
Node.js (claude-kiro.js)
│  路由选择 (_requestWithBuilderEndpointRouting)
│  请求体构建 (buildCodewhispererRequest)
│  Token 管理 & 刷新
│
▼ POST http://127.0.0.1:9091/stream
  Headers: X-Auth-Token, X-Target-Url, X-Amz-Target, ...
  Body: JSON (已构建好的 request body)
│
▼ Rust kiro-sidecar
│  hyper + rustls HTTP/2 请求到 AWS
│  读取 AWS Event Stream 二进制流
│  帧解码 (prelude → CRC32 → headers → payload)
│  转为 NDJSON 逐行输出
│
▼ Node.js 读 NDJSON stream
  每行 JSON.parse → _classifyFrame → 现有事件处理逻辑
```

### 与 tls-sidecar 的关系

| 维度 | tls-sidecar | kiro-sidecar |
|------|-------------|--------------|
| 语言 | Go | Rust |
| 用途 | 通用 TLS 指纹代理（多渠道共用） | Kiro 渠道专用传输代理 |
| 输出 | 原样透传 response body | NDJSON（已解码的 Event Stream 帧） |
| 端口 | 9090 | 9091 |
| TLS | uTLS Chrome 指纹 | rustls（真实 aws-sdk-rust 指纹） |

kiro-sidecar 启用时，Kiro 渠道的流式请求走 kiro-sidecar，不再经过 tls-sidecar。其他渠道不受影响。

## 接口协议

### POST /stream — 核心代理端点

**入站 Headers（Node.js → Rust）：**

| Header | 必填 | 说明 |
|--------|------|------|
| X-Target-Url | 是 | 上游 AWS endpoint URL |
| X-Auth-Token | 是 | `Bearer <access_token>` |
| X-Token-Type | 否 | `API_KEY`（ksk_ token 时传） |
| X-Amz-Target | 是 | AWS service target |
| X-Amz-Invocation-Id | 是 | 请求唯一 ID |
| X-Proxy-Url | 否 | 上游代理 URL（socks5/http/https） |
| Content-Type | 是 | `application/x-amz-json-1.0` |

**入站 Body：** JSON（buildCodewhispererRequest 的输出，原样透传到 AWS）

**Rust 构建的出站 Headers（Rust → AWS）：**

| Header | 来源 |
|--------|------|
| Authorization | 从 X-Auth-Token 映射 |
| x-amz-target | 从 X-Amz-Target 映射 |
| amz-sdk-invocation-id | 从 X-Amz-Invocation-Id 映射 |
| TokenType | 从 X-Token-Type 映射（如有） |
| Content-Type | 直接透传 |
| user-agent | Rust 硬编码：aws-sdk-rust/... |
| x-amz-user-agent | Rust 硬编码：aws-sdk-rust/... |

不透传的：所有 `X-` 内部 headers、hop-by-hop headers。

**出站响应 — 成功（HTTP 200）：**

```
HTTP 200
Content-Type: application/x-ndjson
Transfer-Encoding: chunked

{"headers":{":message-type":"event",":event-type":"AssistantResponseEvent"},"data":{"content":"Hello"}}\n
{"headers":{":message-type":"event",":event-type":"AssistantResponseEvent"},"data":{"reasoningContent":{"text":"..."}}}\n
```

**出站响应 — 上游 HTTP 错误（4xx/5xx）：**

```
HTTP <upstream_status>
Content-Type: application/json

{"error":"upstream responded with 429","upstream_status":429,"body":"<response body>"}
```

**出站响应 — sidecar 自身错误：**

```
HTTP 502
Content-Type: application/json

{"error":"connect timeout","code":"CONNECT_TIMEOUT"}
{"error":"tls handshake failed","code":"TLS_ERROR"}
{"error":"socks5 proxy refused","code":"PROXY_ERROR"}
```

### GET /health — 健康检查

```
HTTP 200
{"status":"ok","transport":"hyper-rustls-h2"}
```

## Rust 项目结构

```
kiro-sidecar/
├── Cargo.toml
├── Cargo.lock
├── .gitignore
├── src/
│   ├── main.rs                 # axum server, CLI/env 配置, signal handling
│   ├── config.rs               # 端口、超时、UA 字符串等常量
│   ├── health.rs               # GET /health handler
│   ├── proxy.rs                # POST /stream: 提取 headers → 发请求 → 流式 NDJSON
│   ├── client.rs               # hyper + rustls HTTP/2 client, 连接池
│   ├── upstream_proxy.rs       # SOCKS5 / HTTP CONNECT 代理拨号
│   ├── event_stream/
│   │   ├── mod.rs
│   │   ├── decoder.rs          # 增量帧解码器 + 错误恢复
│   │   ├── crc.rs              # CRC32 校验（IEEE 多项式，与 JS 侧一致）
│   │   ├── headers.rs          # AWS Event Stream header 二进制解析
│   │   └── types.rs            # Frame, Header, DecodeError
│   └── ndjson.rs               # Frame → JSON + '\n' 序列化
├── tests/
│   ├── integration.rs          # 端到端测试（mock AWS server）
│   └── fixtures/               # 测试用 Event Stream 二进制样本
```

### 依赖

```toml
[dependencies]
axum = "0.8"
tokio = { version = "1", features = ["full"] }
hyper = { version = "1", features = ["client", "http2"] }
hyper-util = { version = "0.1", features = ["client-legacy", "http2", "tokio"] }
hyper-rustls = { version = "0.27", features = ["http2", "ring", "logging"] }
rustls = "0.23"
http-body-util = "0.1"
bytes = "1"
crc32fast = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio-socks = "0.5"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
uuid = { version = "1", features = ["v4"] }
```

### 核心模块设计

**event_stream/decoder.rs — 增量解码器：**

```rust
pub struct Decoder {
    buffer: BytesMut,
    max_frame_bytes: u32,
    consecutive_errors: u32,
}

impl Decoder {
    /// 喂入网络 chunk，返回解码结果
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<DecodeResult>;
}

pub enum DecodeResult {
    Frame(DecodedFrame),
    Fatal(DecodeError),      // upstream exception — 透传给 Node.js
    Recovered { skipped: usize },  // 恢复性跳过，记日志
}
```

错误恢复策略：
- prelude CRC 不匹配：byte-scan 找下一个有效帧（最多 256KB）
- message CRC 不匹配：跳过整帧
- 连续 5 次错误：停止解码

**proxy.rs — 流式处理伪代码：**

```rust
async fn handle_stream(req: Request) -> Response {
    // 1. 提取 X- headers
    // 2. 构建出站 request
    // 3. 可选：通过代理建立连接
    // 4. hyper HTTP/2 POST 到 AWS
    // 5. 非 200 → 透传错误
    // 6. 200 → 逐 chunk 解码 + NDJSON 输出
    let mut decoder = Decoder::new(max_frame_bytes);
    let body_stream = response.into_body();
    let ndjson_stream = body_stream.map(|chunk| {
        let results = decoder.feed(&chunk);
        results.into_iter()
            .filter_map(|r| match r {
                DecodeResult::Frame(f) => Some(to_ndjson_line(&f)),
                DecodeResult::Fatal(e) => Some(to_error_line(&e)),
                DecodeResult::Recovered(_) => None,
            })
            .collect::<String>()
    });
    Response::new(StreamBody::new(ndjson_stream))
}
```

## Node.js 侧改动

### 新增文件

**src/utils/kiro-sidecar.js** — 进程管理类

复制 `tls-sidecar.js` 的管理模式：

```js
class KiroSidecar {
    constructor() {
        this.port = 9091;
        this.baseUrl = null;
        // spawn, healthCheck, autoRestart, gracefulShutdown
        // 完全同 TLSSidecar 的生命周期管理
    }
}

export function getKiroSidecar() { /* 单例 */ }
```

- 默认端口 9091
- 环境变量 `KIRO_SIDECAR_PORT`
- 二进制查找路径：`<projectRoot>/kiro-sidecar/kiro-sidecar`、`/app/kiro-sidecar/kiro-sidecar` 等
- 日志前缀 `[Kiro-Sidecar]`

### 修改文件

**src/providers/claude/claude-kiro.js：**

1. **提取 `_classifyFrame(headers, data)` 方法**
   - 从 `parseAwsEventStreamBuffer` 中提取 frames → events 的映射逻辑
   - 原方法改为调用 `_classifyFrame`
   - sidecar 路径也调用 `_classifyFrame`
   - 一份代码两条路径共用

2. **新增 `_streamViaSidecar(sidecar, targetUrl, requestData, headers, options)` 方法**
   - 构建发给 sidecar 的 HTTP 请求（映射 X- headers）
   - 读 NDJSON stream，逐行 JSON.parse
   - 每行调用 `_classifyFrame` 分类事件
   - yield 事件，与现有 `streamApiReal` 的输出格式一致

3. **`streamApiReal` 加分支**
   - 在 axiosConfig 构建之后、发送之前检查 kiro-sidecar 是否可用
   - 可用则 `yield* this._streamViaSidecar(...)`
   - 不可用则走现有 axios + tls-sidecar 路径

**src/core/config-manager.js** — 新增配置项：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| KIRO_SIDECAR_ENABLED | boolean | false | 启用 kiro-sidecar |
| KIRO_SIDECAR_PORT | number | 9091 | 监听端口 |
| KIRO_SIDECAR_PATH | string | auto | 自定义二进制路径 |

**src/services/api-server.js** — 启动集成：

```js
if (CONFIG.KIRO_SIDECAR_ENABLED) {
    await getKiroSidecar().start({
        port: CONFIG.KIRO_SIDECAR_PORT,
        binaryPath: CONFIG.KIRO_SIDECAR_PATH,
    });
}
```

**Dockerfile** — 新增 Rust 构建 stage：

```dockerfile
# ── Stage 1b: 编译 Rust kiro-sidecar ──
FROM rust:1.82-alpine AS kiro-builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY kiro-sidecar/Cargo.toml kiro-sidecar/Cargo.lock ./
# 依赖预编译层（利用 Docker cache）
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release && rm -rf src
COPY kiro-sidecar/src ./src
RUN cargo build --release

# Stage 2 中新增:
COPY --from=kiro-builder /build/target/release/kiro-sidecar /app/kiro-sidecar/kiro-sidecar
RUN chmod +x /app/kiro-sidecar/kiro-sidecar
```

musl 静态链接，单个二进制无外部依赖，与 Go sidecar 的 `CGO_ENABLED=0` 策略一致。

## 错误处理与 Fallback

### 三层错误分类

| Layer | 触发条件 | Rust 行为 | Node.js 处理 |
|-------|----------|-----------|-------------|
| sidecar 不可用 | 进程未启动/崩溃/health check 失败 | — | `isReady()=false`，走现有 axios 路径 |
| 连接失败 | DNS/TCP/TLS/代理失败 | HTTP 502 + error JSON | 映射到可重试错误，进入 retry 循环 |
| 上游 HTTP 错误 | AWS 返回 4xx/5xx | 透传状态码 + body | 跟现有 axios 路径完全一致 |

### Fallback 降级矩阵

| 场景 | 行为 |
|------|------|
| `KIRO_SIDECAR_ENABLED = false` | 不启动 sidecar，走现有路径 |
| 二进制不存在 | 启动失败，日志警告，走现有路径 |
| 进程崩溃 | auto-restart（最多 5 次），期间走现有路径 |
| health check 失败 | 标记 ready=false，走现有路径 |
| 请求超时/连接失败 | Rust 返回 502，Node.js 重试（仍走 sidecar） |
| NDJSON parse 失败 | 跳过该行记日志，不中断流 |

**原则：sidecar 是增强层，不是必要层。不可用时不阻断请求。**

### 流式中断处理

```
客户端 disconnect → Node.js abort signal → 取消对 sidecar 的请求
  → Rust 检测到客户端断开 → 取消对 AWS 的请求 → 释放连接
```

axum 和 hyper 的 drop 机制自动处理级联取消，无需额外信号传递。

## 测试策略

### Rust 侧

**单元测试：**
- `event_stream/decoder.rs`：正常解码、CRC 校验、跨 chunk 帧、错误恢复、连续错误停止、超大帧拒绝、空 payload
- `event_stream/headers.rs`：各 header 类型编解码、畸形 header
- `ndjson.rs`：格式正确性、特殊字符转义、边界值
- `upstream_proxy.rs`：URL 解析、无效 URL 错误

**集成测试：**
- mock AWS server 返回预构造的 Event Stream 二进制
- 端到端验证 NDJSON 输出

### Node.js 侧

**新增 `tests/kiro-sidecar-integration.test.js`：**
- KiroSidecar 进程管理生命周期
- NDJSON → 内部事件映射
- X- headers 传递正确性
- NDJSON 行 parse 失败容错
- fallback 路径验证

**回归要求：**
- `kiro-streaming.test.js`（42 tests）全部通过
- `kiro-production-safety.test.js`（57 tests）全部通过
- `kiro-truncation-recovery.test.js` 全部通过
- `_classifyFrame` 提取后原有测试不受影响

## 开发阶段

### Phase 1：Rust 骨架 + HTTP 代理（2 天）

- Cargo.toml + 依赖
- axum server + health endpoint
- proxy handler（透传模式，不解码帧）
- hyper + rustls HTTP/2 client
- SOCKS5 + HTTP CONNECT 代理支持
- 手动验证

### Phase 2：AWS Event Stream 解码器（2-3 天）

- 增量帧解码器 + CRC32 校验
- 二进制 header 解析
- NDJSON 序列化输出
- proxy handler 集成解码器
- Rust 单元测试 + 集成测试

### Phase 3：Node.js 集成（1-2 天）

- `kiro-sidecar.js` 进程管理类
- `claude-kiro.js` 改动：提取 `_classifyFrame`、新增 `_streamViaSidecar`、分支逻辑
- 配置项 + 启动集成
- Node.js 测试 + 回归验证

### Phase 4：Docker 构建 + 加固（1 天）

- Dockerfile 新增 Rust 构建 stage
- 边界加固：启动失败降级、并发连接池、内存控制
- 文档更新

### 依赖关系

```
Phase 1 → Phase 2 → Phase 3 → Phase 4
```

Phase 1-2 纯 Rust，不影响现有代码。Phase 3 开始改 Node.js，有完整 fallback。

**总估时：6-8 天**

## 风险与注意事项

### CRC 多项式确认

现有 JS 代码 `kiro-event-stream.js` 的 `crc32()` 使用多项式 `0xEDB88320`，这是标准 CRC32（IEEE），不是 CRC32C（Castagnoli，多项式 `0x82F63B78`）。AWS Event Stream 规范用的是 CRC32，不是 CRC32C。Rust 侧应使用标准 CRC32 与 JS 侧保持一致。依赖选择用 `crc32fast` crate 而非 `crc32c`。

### hyper HTTP/2 指纹

rustls 的 TLS 指纹与真实 aws-sdk-rust 一致。HTTP/2 SETTINGS frame 的参数（如 INITIAL_WINDOW_SIZE、MAX_CONCURRENT_STREAMS）可能有差异，需要对比真实 Q CLI 的行为。可通过 hyper Builder 调整。

### Alpine + musl + ring

`hyper-rustls` 依赖的 `ring` crate 需要 C 编译器。`apk add musl-dev` 应该够。如果编译有问题，可切到 `aws-lc-rs` 后端。

### 不做的事

- 不在 Rust 侧做 token 刷新
- 不在 Rust 侧做请求体构建（buildCodewhispererRequest）
- 不在 Rust 侧做事件语义处理（content/reasoning/toolUse 分类）
- 不在 Rust 侧做重试（涉及换凭证，跟 Node.js 状态耦合）
- 不做 Windows/macOS 构建（仅 Linux x86_64）
