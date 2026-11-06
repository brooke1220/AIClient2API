# Kiro 生产保护与兼容性开关

本次调整保留现有多协议出口和账号配置。流式与非流式生成共用 AWS 帧解码、工具参数组装和结束原因判断；实现为本项目独立代码。图片解码与缩放使用锁定版本的 `sharp`，不需要参考项目的 Rust 运行环境。

## 默认生效的保护

- `/cc/v1/messages` 与普通消息端点默认实时输出。`message_start.usage` 先提供估算值（开启缓存 `estimate` 模式时输入与缓存改为零占位），最终用量在 `message_delta.usage` 更新；要求起始事件携带最终输入用量的旧客户端可以显式开启缓冲。本地输入估算只在收到上游响应头后、等待首个事件期间计算，不再推迟上游请求的发出；`[Kiro Stream] Upstream headers` 日志的 `input estimate` 记录其耗时。
- thinking 兼容标签只保留可能构成未完成标签的尾部及相邻引号，不再固定积压末尾 10–11 个字符；短正文和短思考片段无需等待下一段或 EOF。跨片段的标签、引用标签和 CRLF 分隔符仍保留语义；片段末尾的反斜杠留到下一段，跨片段的 `\n` 转义仍解码为换行。
- 原生 `metadataEvent.tokenUsage` 的非缓存输入、输出、缓存读取和缓存写入分别映射到 Claude 用量字段。同一调用的重复快照取最新有效值，不累加；缺失或非法字段保留已知值或原有估算。OpenAI/Responses 输入总数包含缓存读取和写入，缓存读取仍单独列出。
- `CONTENT_FILTERED` 输出明确的拒答与 `stop_reason=refusal`，不会作为损坏流重试。原生思考签名和隐藏思考内容在 Claude 流式与非流式响应中保留；OpenAI Chat 使用 `finish_reason=content_filter`，Responses 使用 `incomplete_details.reason=content_filter`。
- `meteringEvent` 的 `usage` 是本次调用的 credit 用量快照，不是 token。Claude、OpenAI Chat 和 Responses 的最终 `usage` 通过 `credit_usage`、`credit_unit` 和可选 `credit_unit_plural` 扩展字段返回最近一次有效值，不累加重复快照。
- 显式模型不可用返回 503；上游错误地以 5xx 返回的明确请求格式错误转为 400；明确网关超时转为 504；请求体超过上游阈值转为 413。这些情况不会处罚账号或触发凭证切换。未知 5xx 保留原有恢复策略。
- 明确账号限流（`USER_REQUEST_RATE_EXCEEDED`、`CREDIT_CONSUMPTION_RATE_EXCEEDED`、`SERVICE_REQUEST_RATE_EXCEEDED` 等）触发账号短冷却和切换，即使通用冷却开关关闭。明确账号限流、402（含额度耗尽）与 403 换号前只等待 0–500ms 随机抖动，这类账号限流也不再先等 `REQUEST_BASE_DELAY`；`SERVICE_REQUEST_RATE_EXCEEDED` 可能覆盖所有账号，保留原有等待。凭证刷新仍不等待，未分类错误保留原有 0–10 秒抖动；但按重试本身的选号规则（含 fallback 链和模型映射）会回到同一个账号时，例如其他账号都停用、不健康、冷却、暂停、不支持该模型、该模型被 402 跳过，或者并发已满且没有队列空位，此时非 429 错误只等 0–500ms，其余 429（未分类与 `SERVICE_REQUEST_RATE_EXCEEDED`）仍保留 0–10 秒作为退避。明确模型容量不足的 429 直接返回，不处罚账号。非流式保留 `Retry-After` 响应头；SSE 已发出响应头时，在错误事件的 `error.retry_after` 返回原值（Responses 错误事件使用顶层 `retry_after`），同时带 `status`。模型暂不可用且上游未给重试时间时默认 5 秒。
- 402 时先查询 `getUsageLimits`，把基础额度、未过期的免费试用和奖励额度的剩余量相加。查询失败、响应没有用量明细或剩余不足 0.01 时按额度耗尽处理，账号锁到下月 1 日 00:00 UTC。仍有剩余时（例如剩余的试用额度不覆盖所请求的模型），本次请求换号，账号不标记为不健康；号池在内存中对该账号的同一上游模型跳过 10 分钟，指向同一上游模型的客户端别名一并跳过，其他模型照常可用，重启后清空。冷却记录绑定凭证来源及上游配置，更换凭证、API Key 或相关上游配置后立即失效；旧配置下请求迟到的 402 也不会写入新账号。单纯 UUID 或 access token 轮换保留同账号冷却，并发请求通过插槽租约追踪轮换后的账号。全部账号不健康时的自愈也不会重置这类账号。已经在该账号并发队列里排队的请求不受这条规则影响。
- HTTP 请求按客户端 API Key 的哈希隔离会话，优先读取 `metadata.session_id`、JSON `metadata.user_id.session_id`、Claude Code 的 `user_…_session_UUID`、`session_id` 或 `conversation_id`；缺失时从 system 与首条 user 消息生成稳定 ID。会话 ID 使用带客户端作用域的哈希派生 UUID，不在日志或上游载荷中暴露客户端 Key。
- 会话账号绑定仅在上游返回成功响应头后建立，保存于内存，最多 8192 条，1 小时过期。优先使用仍健康、支持模型且有空闲并发的绑定账号；冷却、停用、刷新、排除和并发满时按现有选择规则继续恢复。绑定跟随账号状态，能够跨 UUID 轮换保留。共享同一个 API Key 的客户端属于同一作用域；应提供明确 session ID 以区分独立对话。
- 换号重试优先选择本次请求尚未离开过的账号。5xx、403 等错误不会把账号标记为不健康，若不这样处理，会话绑定会把请求送回刚失败的账号。已离开的账号通过插槽租约持续追踪，在实际选号时读取当前 UUID；重试抖动、等待选号和后续重试期间的 UUID 轮换不会丢失历史，同请求体重试也保留这份历史。其它账号都不健康、被排除或不存在时回到原账号。其它账号并发已满时，配置了 `queueLimit` 且队列未满的账号会让请求排队等待；都没有队列空位（默认 `queueLimit=0`）时回到原账号，不会因为抢不到槽位而失败。
- 空响应等同请求体重试的第一次保留会话绑定，绑定账号可用时继续使用它及其提示词缓存，但不回到本次请求已经离开过的账号。本次请求已经用过一次同请求体重试后再失败时（重试次数按整个请求计，换号后不重新计算），下一次重试优先选择其它账号。上游尝试超时（首事件、流空闲、总时长）例外：会话绑定在收到响应头时建立，卡住的正是绑定账号，因此这类重试优先选择其它账号。
- 图片按实际字节识别 PNG/JPEG/GIF/WebP，并验证可解码性；声明 MIME 不一致时纠正格式。默认将大图限制在长边 1568 像素、base64 400000 字节内；转换为 JPEG 时保持比例、透明区域铺白底。需要重编码的动画只保留首帧。源字节与解码像素都有预算，损坏图片在请求上游前返回 400，源体积超限或无法满足输出预算返回 413。
- 工具缺少描述时使用工具名，保留参数 schema 的必填、枚举、组合与长度等约束。

- 校验 prelude CRC 与 message CRC、帧头边界及 JSON；异常帧和 EOF 残帧不会被正常收尾。
- 流内异常帧没有 HTTP 状态码，按 `:exception-type` 对应到 HTTP 处理：`ValidationException` 返回 400，不重放、不换号、不处罚账号，其中上下文超过上游阈值（`CONTENT_LENGTH_EXCEEDS_THRESHOLD`）的与 HTTP 路径一样返回 413；`ThrottlingException` 不用同一请求体原样重放，载荷中的 `reason` 按 HTTP 429 的同一规则分类：容量不足直接返回 429，不处罚账号也不换号；明确账号限流按账号限流冷却并换号；没有可识别的 `reason` 时按未分类的 429 换号，等待 0–10 秒抖动，开启 `RATE_LIMIT_COOLDOWN_ENABLED` 时账号进入通用冷却。流内异常没有 HTTP 响应，因此不会先等 `REQUEST_BASE_DELAY`，也没有 `Retry-After`。其它异常类型（如 `InternalServerException`）保留原有的同请求体重试。已向客户端输出内容后，任何异常都不重试。
- 相同文本增量仍逐段保留，不以字符串相等判定重发。
- 按工具调用 ID 缓冲并验证参数，按到达顺序输出合法、无重叠的 Claude 内容块。文本保持实时；工具参数在完整校验后输出，避免下游执行截断参数。
- 工具参数按新增片段累计字节数，避免反复扫描完整参数；跨片段的 UTF-16 代理对按拼接后的实际 UTF-8 字节计数。工具边界先输出此前缓存的文本/思考。
- 流式与非流式共用文本形式 `[Called ... with args: {...}]` 的增量解码，只识别请求中声明的工具；引用、代码块、思考内的标记仍是文本。进入内联思考前先输出暂存的标记文本及其空白，已识别但尚未完成的工具调用在该边界报完整性错误，不跨思考块拼接。参数必须是完整合法的 JSON 对象，不修复损坏参数；复用工具参数/调用数预算并过滤 no-op 占位调用。
- 原生与文本形式的同一调用不会重复输出，独立原生调用 ID 不因参数相同而合并。Claude Message 保留必需的可空 `stop_reason` / `stop_sequence` 字段。
- 先解析业务端点，再配置代理或 TLS Sidecar。
- 同时开启 `KIRO_SIDECAR_ENABLED`、`TLS_SIDECAR_ENABLED`，且 `TLS_SIDECAR_ENABLED_PROVIDERS` 匹配 Kiro 时，已就绪的 Sidecar 使用 `Node.js → Rust → Go uTLS → 上游代理（如有）→ AWS`。仅开启 Rust 时仍由 Rust 直接出站；仅开启 TLS Sidecar 时保留原有 Go 路径。令牌刷新、模型发现和额度查询保留原有路径。
- 串联时仍由 Node.js 按节点代理、插件绑定、`KIRO_SIDECAR_PROXY_URL`、`PROXY_URL` 的优先级解析上游代理，并经 Rust 交给 Go；不会改用 `TLS_SIDECAR_PROXY_URL`。本机两跳都绕过系统代理。
- Rust 通过父进程配置的 `KIRO_TLS_SIDECAR_URL` 连接 Go 的 `/kiro/stream`；该地址只允许 `http://127.0.0.1:<port>`。请求仅传递串联模式标记，不接受任意中继地址；真实 HTTPS 目标仍由 Rust 先校验。
- 每次生成开始时固定 Rust 实例和出站方式，重试不改变路径。Go 返回来源与协议标记，Rust 将 Go 故障标准化为本地错误；真实 AWS 状态码和错误正文保留。流中断向下游传播，已输出内容不重放。Go 不在一次调用中自动重发失败的 H2 请求。
- 不经 Sidecar 和代理的直连生成请求，所有账号共用一个 keep-alive 连接池，空闲连接保留 30 秒（Node 全局 agent 为 5 秒，短于两轮对话之间的工具执行时间）。该超时只回收空闲连接，不会中断正在进行的长流。
- Go 的 H2/H1 与 Rust 的本机 HTTP 连接均复用，响应字节流不做二次事件解析。显式 `SSL_CERT_FILE` 也用于 Go 的 CA 信任，证书及主机名校验仍开启。
- Go 每个上游代理配置最多缓存 128 个目标地址，H2/H1 共用该容量；按最近使用时间淘汰。淘汰只回收空闲连接或等待活跃流结束，拨号锁在初始化请求及所有等待者退出后删除，不按历史目标地址永久保留。
- 升级串联功能时须重新编译两个 Sidecar，或重建 Docker 镜像，再重启服务；启动时通过 Go 健康检查确认串联协议版本，旧版 Go 仅保持原有功能，新生成请求继续使用 Rust 出站并记录升级提示。已选定串联的请求遇到 Go 故障时仍明确返回本地错误。
- 并发插槽在交接时预留，以独立租约幂等释放；排队可取消，失败重试先释放上一尝试的插槽。UUID 变化不影响已获取插槽的释放。
- SSE 写入遇到背压时等待 `drain`；断开或取消可以中止等待。心跳是 SSE 注释，不算模型输出，不会关闭空响应重试窗口。
- 原有错误响应体的 10 秒/64 KiB 读取保护继续保留。
- Kiro 凭证只读取指定账号文件；IdC 注册信息按 `clientIdHash` 定位，仅补充客户端注册字段。同目录其它账号的 token、区域、过期时间不参与合并。Base64 按原始配置内容的指纹使用独立缓存，重启或 UUID 变化仍读取自身轮换后的令牌；写入失败时优先保留内存中的新令牌。
- Kiro 暂停状态贯穿选点、并发排队、发送前检查和健康检查。明确 suspended 状态不会被并发成功请求或后台刷新自动清除；人工恢复入口仍可用。
- 有效 Token 提前续期只安排后台刷新，不设置阻断请求的 `needsRefresh`。已过期（含现有 30 秒安全余量）、401 或可刷新 403 才暂停该凭据。并发请求共用账号状态上的刷新任务，UUID 变化和配置热重载不会另起刷新。
- 生成请求记录实际发送时的凭据版本和 Token 指纹；已被成功刷新替代的旧 Token 迟到 401 不会再次暂停账号、轮换 UUID 或重复刷新。新 Token 自身被拒绝时仍可触发刷新，判定不依赖最近成功请求的时间戳。
- 需要刷新时优先使用其他可用账号和兼容 fallback；全部不可用且存在刷新任务时，最多等待 `KIRO_REFRESH_WAIT_TIMEOUT_MS`（覆盖刷新排队时间）。客户端取消只结束自己的等待，不取消共享刷新。刷新失败和等待超时返回 503；失效凭据刷新失败后冷却 30 秒，保留禁用、暂停和更长的既有冷却。
- 当前账号等待凭据刷新不消耗跨账号切换预算；`CREDENTIAL_SWITCH_MAX_RETRIES=0` 或预算用尽时仍可等待当前账号的共享刷新，保留等待期限、取消和发送前的账号状态检查。
- 动态模型发现沿用生成调用的健康检查、人工恢复选项；获准执行的恢复检测不会被内部模型发现再次作为普通请求拒绝。
- Kiro 的完整工具调用优先于正常 `end_turn`；明确的 `max_tokens`、上下文超限等终止原因保持原样。
- 无法识别的终止原因仍按完整性失败处理，不改写为 `end_turn`；警告日志 `[Kiro Stream] Unsupported upstream stop reason` 记录截断后的原始值，用于依据真实流量补充映射。同一请求体会得到同样的终止原因，因此不再用同一请求体重试；否则非流式和整段缓冲请求会把完整回答再生成两遍后仍然失败。

## 配置

可在全局配置 JSON 中设置；生成相关字段也可以通过节点配置覆盖。示例默认值见 `configs/config.json.example`。

管理后台的“配置管理 → Kiro 模型与凭证”支持修改 `KIRO_DYNAMIC_MODELS`、`KIRO_MODEL_CACHE_TTL_MS`、`KIRO_REFRESH_AHEAD_MINUTES`、`KIRO_REFRESH_JITTER_MS` 和 `KIRO_REFRESH_WAIT_TIMEOUT_MS`。保存后自动重载；节点同名配置优先。后台保存会保留原配置文件中未编辑的字段，运行时账号池等内部状态不会写入配置文件。原文件无法读取或不是有效 JSON 对象时，保存失败并保留原文件。

| 配置 | 默认值 | 说明 |
| --- | ---: | --- |
| `KIRO_CC_BUFFERED` | false | CC 端点显式开启整段缓冲，起始事件使用最终输入与缓存计数；代价是首字要等上游完成。节点配置优先。 |
| `KIRO_MAX_BUFFERED_RESPONSE_BYTES` | 33554432 | 缓冲事件序列化后的 UTF-8 字节上限，超限关闭上游、返回错误并且不切号；不是 Node.js 堆内存的精确上限。 |
| `KIRO_SESSION_AFFINITY` | true | 账号池按客户端作用域与会话进行软绑定；绑定账号需要等待速率预算时，优先切到额度和并发均可用的账号。没有可立即使用的账号时保留原有排队和评分选择。全局关闭后仍保留稳定的上游会话 ID。 |
| `KIRO_ACCOUNT_MIN_INTERVAL_MS` | 0 | 每账号发起请求的最小间隔；0 关闭，节点可独立覆盖。不会在整个响应期间持有启动队列。 |
| `KIRO_ACCOUNT_REQUESTS_PER_MINUTE` | 0 | 每账号滚动 60 秒的请求启动次数预算；0 关闭。重试也占次数，取消的等待不占次数。原有 `KIRO_REQUEST_MIN_INTERVAL_MS` 全局间隔仍可组合使用。 |
| `KIRO_IMAGE_MAX_SOURCE_BYTES` | 10485760 | 单图解码前字节预算；先限制 base64 长度再解码。 |
| `KIRO_IMAGE_MAX_PIXELS` | 40000000 | 单图解码像素预算，防止压缩图展开后过大。 |
| `KIRO_IMAGE_MAX_EDGE` | 1568 | 自动缩放后的长边上限，不放大小图。 |
| `KIRO_IMAGE_MAX_BASE64_BYTES` | 400000 | 单图发送给上游的 base64 字节预算，仍受最终 JSON 总体预算限制。 |
| `KIRO_REQUEST_TRACE` | false | 每次生成上游尝试输出一条 `[Kiro Trace]` JSON 日志；同一请求重试共享 requestId，并递增 attempt。记录账号摘要、模型、路径类型、`attemptStartMs`（尝试相对请求起点的偏移）、耗时、状态、首事件、原生用量与 credit。最终 `[Kiro Usage]` 记录实际返回用量、来源与可用的缓存计量详情，不记录提示词、工具参数、图片或凭证。`[Kiro Trace]` 另记 `headersMs`、`firstReasoningMs`、`firstContentMs`、`firstToolMs`（工具开始）和 `firstToolArgsMs`（首段非空参数；空白或 `{}` 不计），以请求起点计时，占位工具不计入；旧 XML 思考模型的 `<thinking>` 文本仍计为正文。`[Kiro Tool Trace]` 每次生成（含账号切换后的新生成）在有工具调用或参数快照时输出一条，`attempt` 为该次生成内最后一次上游尝试的序号；按本地序号 `callKey` 记录每个工具调用的首段参数、身份就绪、完整校验、生成与首次写入时间，以及前序工具阻塞、身份未就绪、此前已输出文本形式工具（`priorLegacyEmitted`）和背压标记（其他写入等待 drain 的区间与工具参数到达至该调用首次参数写入之间重叠时为 true，包含参数到达前已开始、到达后才结束的等待；该调用自身超过 socket highWaterMark 的写入不算），并统计字符串片段之后收到非空完整对象的次数、前缀一致次数与空对象占位次数，不记录工具 ID 或参数。整段缓冲与非流式模式不记录 `firstWriteMs`。`[Kiro Downstream]` 每个请求一条，记录模式、客户端协议、结果（`completed`、`error`、`client_closed`、`write_timeout`）、下游首段思考、正文、非空工具参数的写入时间（写入被接受，不代表客户端已收到；空白或 `{}` 不计），模型事件数与字节数（不含心跳、错误和结束标记），以及所有 Kiro 写入（含心跳和结束标记）等待 drain 的次数。 |
| `KIRO_PROMPT_CACHE_MODE` | off | `observe` 只记录本地缓存估算日志，`estimate` 补全缺失的缓存字段；明确的上游值和零值优先。 |
| `KIRO_PROMPT_CACHE_POLICY` | auto | 有缓存声明时使用 `explicit`，否则使用 `history`；可显式固定其中一种策略。 |
| `KIRO_PROMPT_CACHE_DEFAULT_TTL_MS` | 300000 | 未声明 TTL 时的本地默认有效期，从上游请求发起时计算，最多 1 小时。 |
| `KIRO_PROMPT_CACHE_MAX_ENTRIES` | 65536 | 进程内前缀账本上限，最多 1048576；重启后冷启动，多实例不共享。 |
| `KIRO_PROMPT_CACHE_MIN_TOKENS_BY_MODEL` | `{}` | 按最终上游模型 ID 覆盖本地门槛，须为正整数；默认 Sonnet 1024，其它 4096，不代表已验证的 Kiro 门槛。 |
| `SSE_HEARTBEAT_INTERVAL_MS` | 15000 | SSE 心跳间隔；0 关闭。不会在背压期间继续堆积心跳。 |
| `KIRO_FIRST_EVENT_TIMEOUT_MS` | 30000 | 从实际发起上游请求开始，等待有意义的文本、思考或工具事件；元数据字节不算首事件。0 关闭。 |
| `KIRO_REFRESH_AHEAD_MINUTES` | 10 | 请求侧与定时检查共用的提前续期窗口；独立于 `CRON_NEAR_MINUTES` 检查频率。必须是正数，无效值回退默认。 |
| `KIRO_REFRESH_JITTER_MS` | 30000 | 按凭据身份确定性地增加 0 到该值的提前量，错开批量续期；0 关闭。 |
| `KIRO_REFRESH_WAIT_TIMEOUT_MS` | 15000 | 无可用账号时等待共享刷新，及独立服务等待强制刷新的上限；必须是正数，无效值回退默认。 |
| `KIRO_STREAM_IDLE_TIMEOUT_MS` | 120000 | 开始产出后等待更多上游数据；消费者应用背压期间暂停该计时。0 关闭。 |
| `KIRO_STREAM_TOTAL_TIMEOUT_MS` | 0 | 单次上游尝试总期限；默认关闭，长任务可自行设置。不会取消共享的客户端信号。 |
| `KIRO_DOWNSTREAM_WRITE_TIMEOUT_MS` | 30000 | 仅 Kiro 调用链启用的单次下游写入期限，覆盖正文、心跳、错误和结束记录。有效值为 1–2147483647 的整数毫秒；无效值（含 0）回退默认值。节点配置优先。客户端持续不读取时取消生成、关闭响应并释放并发名额，不处罚账号。 |
| `KIRO_MAX_FRAME_BYTES` | 33554432 | 解码器的单帧资源预算，不是对上游服务允许大小的承诺。 |
| `KIRO_MAX_TOOL_ARGUMENT_BYTES` | 4194304 | 单次响应累计工具参数的存储预算。 |
| `KIRO_MAX_TOOL_CALLS` | 1024 | 单次响应最大工具调用数量。 |
| `KIRO_REQUIRE_STOP_REASON` | false | 严格检查终止 metadata。旧端点可能没有该字段，先观察真实流再开启；明确异常/残帧在关闭时也会失败。 |
| `KIRO_MAX_PAYLOAD_BYTES` | 10485760 | 最终上游 JSON 的应用层字节预算；需按实际端点验证后调整。超限返回 413，不标记凭证不健康。 |
| `KIRO_TRIM_HISTORY` | false | 显式开启后才能裁剪较旧的完整对话轮次；保留开头的 priming 对话和最近轮次，修复孤立工具结果，并添加省略提示。不会截短当前输入或工具参数，仍超限则返回 413。 |
| `KIRO_HISTORY_IMAGE_MESSAGE_WINDOW` | 5 | 保留图片的历史消息距末尾最大距离，按过滤空消息、合并同角色消息后的序列计算，含 assistant 消息，不等于用户轮次数。`0` 只省略历史图片，当前消息图片仍保留；无效值回退默认。超窗口的图片留省略说明，不静默丢弃。 |
| `KIRO_ENABLE_INFERENCE_CONFIG` | true | 将 `max_tokens`、`temperature`、`top_p` 映射到上游 `inferenceConfig`；保留 `temperature=0`。不支持该字段的自定义端点可关闭。参数仍需合法。 |
| `KIRO_DYNAMIC_MODELS` | false | 开启账号隔离的动态模型列表和能力读取；成功发现且缓存未过期时，账号池据此过滤不支持模型的账号（包括已知别名）。发现失败或过期不把静态回退列表当成账号能力。 |
| `KIRO_MODEL_CACHE_TTL_MS` | 300000 | 动态元数据缓存 TTL；失败回退最多缓存 30 秒。0 禁用结果缓存，仍合并同时发起的相同读取。 |
| `KIRO_MODELS_URL` | 未设置 | 覆盖模型发现 URL；API Key 的模型列表契约需单独验证，API Key 模式未提供该 URL 时保持静态列表。 |
| `KIRO_API_KEY_RUNTIME_ENABLED` | false | 显式开启 API Key CLI runtime 路由；不会默认迁移现有 API Key 流量。 |
| `KIRO_API_KEY_BASE_URL` | 未设置 | 显式配置 API Key runtime URL，也会启用该路径。开启时使用 CLI origin、对应内容类型，并去除 profileArn。 |

生成流请求显式关闭继承的 Axios socket 超时，由以上三个 Kiro 请求级期限管理连接。因此关闭或延长某项期限不会再受原有 120 秒实例超时限制，消费者背压也不会触发该隐藏超时。Go 将入站请求的取消上下文传给出站请求，串联链路随 Node.js 取消而释放资源；Go 不额外施加覆盖整个响应正文的固定总超时。独立调用 Go relay，或关闭 Node.js 对应期限时，调用方需要自行提供取消或期限。认证刷新、模型发现、用量查询和错误响应体仍保留各自的期限。

Kiro 的上游尝试期限与下游写入期限分别管理；上游结束不意味着客户端已经接收完数据。Kiro 明确账号限流与启用 `RATE_LIMIT_COOLDOWN_ENABLED` 的通用限流，其显式 `Retry-After` 不受 `RATE_LIMIT_COOLDOWN_MAX_MS` 截短，恢复时间不会早于上游要求；模型容量限流不进入账号冷却，其它渠道保留原有策略。`REQUEST_MAX_RETRIES=0` 关闭 Kiro 网络重试，`CREDENTIAL_SWITCH_MAX_RETRIES=0` 关闭 Kiro 凭证切换重试；空响应预算仍由原有 `EMPTY_RESPONSE_MAX_RETRIES` 独立控制。

`REQUEST_MAX_RETRIES` 默认 3，表示首次尝试之外的重试次数。Kiro 接受非负安全整数及转换后满足该条件的数字字符串（包括科学计数法）；负数、小数、空值或非法值回退为 3。既有配置没有约定额外的业务上限，本次不静默截短显式配置。重试采用指数退避，配置很大的次数会显著延长失败等待；应优先使用默认值或较小预算，并通过调用方取消控制整个请求生命周期。

本轮修复参考固定源码快照：`kiro-gateway@a5292ca` 的指定凭证/匹配注册文件与截断优先工具映射，`Kiro-Go@f8f6071` 的明确暂停处理，`sub2api@9c2cca9` 的权威可调度状态复查，以及 `new-api@7de10f2` 的逐次下游写入期限。参考设计只用于对应的 Kiro 修复，没有迁移其它平台的配额规则或改变其它渠道默认行为。UUID 代理绑定与 API Key runtime origin 的待验证问题不在本轮修复范围内。

可复核源码：[kiro-gateway 凭证读取](https://github.com/jwadow/kiro-gateway/blob/a5292ca04c7c6231e0b47673ac3f981f5a706e1e/kiro/auth.py#L413)、[Kiro-Go 暂停处理](https://github.com/Quorinex/Kiro-Go/blob/f8f6071c9298a4266ad3e0c7e483d4a2510cbcaf/pool/account.go#L344)、[sub2api 可调度状态](https://github.com/Wei-Shaw/sub2api/blob/9c2cca9e627291bc719bada3d57de23b625a4180/backend/internal/service/account.go#L191)、[new-api 写入期限](https://github.com/QuantumNous/new-api/blob/7de10f2c602b50122017556e8a09cb7c488c273c/relay/helper/stream_scanner.go#L29)。

Base64 独立缓存保存在凭证目录的 `.kiro-base64/<原始配置指纹>.json`，不会自动迁入旧默认共享文件中的令牌，以免迁入其它账号。若旧 Base64 配置中的 refresh token 已轮换失效，应重新导入该账号的当前凭证。文件路径方式保持原路径；同时提供 Base64 和文件路径时仍按原有 Base64 优先规则处理。Kiro 热重载不会通过旧磁盘快照解除当前暂停或禁用，重新启用应使用现有人工启用、重置或成功的人工健康检测入口。

动态缓存按服务实例、认证、区域、profile、端点和代理身份隔离，最多缓存 16 个条目，并限制共享读取数量。发现请求总期限为 10 秒、响应体最多 1 MiB、分页最多 20 页；失败保留静态模型列表，不因为发现失败处罚生成账号。共享只读发现不会被一个调用方的取消打断。缓存不作为全局账号权限注册表，也不自动把新模型加入所有账号池。

账号池的模型能力快照另行绑定凭证来源及端点、代理配置的身份指纹。更换凭证来源或相关配置后，旧快照立即失效；旧配置下尚未完成的发现也不能回写新快照。配置重载仍保留活跃请求和等待队列，单纯 UUID 或 access token 轮换不清除同一来源的有效能力。选择账号时只读取速率预算，不提前占用启动次数；相同 API Key 或相同凭证文件共用预算，Base64 账号按各自稳定凭证文件隔离。

开启动态发现后，已发现模型的输出上限用于校验 `max_tokens`，输入容量用于上下文占用百分比的估算；显式配置的自定义上下文容量优先。真实上游 token 计数优先于估算。缓存本地估算需显式启用，不代表上游实际缓存命中或收费数据；具体口径、来源与历史迁移见 [Kiro 缓存计量](KIRO_PROMPT_CACHE.md)。

## Sidecar 本机信任与证书更新

Node.js → Rust 使用每次启动生成的独立本地 token。Rust → Go 的 `/kiro/stream` 当前信任同一主机、同一网络命名空间内的调用方：Go 仅监听 `127.0.0.1`，该跳没有独立 token 鉴权。Rust 的本地 token 不会转发到 Go 或业务上游。协议版本及响应来源标记用于识别响应格式，不构成调用方身份认证；不能将 Go 监听地址改为公开地址或通过额外转发向不受信任的调用方开放。

Go 首次使用时读取显式 `SSL_CERT_FILE`，并缓存信任池及加载错误。更新该 CA 文件，或修复首次加载失败后，需要重启 Go sidecar；重启应用也会重新启动其管理的 sidecar。正常的上游服务器证书轮换只要仍受已加载的 CA 信任，就不需要因此重启。已有 TLS 连接的证书验证发生在握手时。

Go 的 `UPSTREAM_HEADERS_ERROR` 保留为未分类 `RoundTrip` 失败的历史兜底码，不保证故障一定发生在响应头阶段。排查时结合连接、代理、TLS 等已识别错误及脱敏日志判断，不仅凭该兜底码推断连接已建立。

## 上线验证

1. API Key runtime、动态发现、历史裁剪等兼容性开关保持默认关闭，先验证现有认证与代理链路；`inferenceConfig` 默认开启，尚未完成真实端点验收时建议先设置 `KIRO_ENABLE_INFERENCE_CONFIG=false`。
2. 验证流式/非流式文本、中文分片、工具调用、取消和 401/402/403/429/5xx。
3. 观察终止 metadata 覆盖率，再考虑开启严格终止检查。
4. 分别验证 Q、CodeWhisperer、自定义端点对 `inferenceConfig` 的实际支持；不支持时关闭该开关。
5. API Key runtime 和动态发现单独小流量启用，确认账号权限、模型 ID、区域和端点契约。
6. 观察首事件延迟、排队长度、活跃插槽、取消耗时、完整性错误、背压等待与请求体拒绝率。

7. 分别通过 Claude `/v1/messages` 和 Responses `/v1/responses` 验收截图工具返回的图片。Responses 的 `function_call_output.output` 应使用包含 `input_text` / `input_image` 的结构化数组，而不是含图片 JSON 的字符串；确认单图、文本混合、并行工具图片编号、历史图片窗口和流式/非流式发送。超限请求应返回 413，Kiro 的远程 URL 图片、文件 ID 图片和 `input_file` 工具输出应有明确的未转发说明，且二进制数据不能出现在工具结果文本中。

自动测试使用本地模拟流和临时 HTTP 服务，不代表已完成真实上游或生产代理验收。
