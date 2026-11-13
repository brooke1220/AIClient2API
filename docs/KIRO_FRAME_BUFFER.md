# Kiro 事件帧分片累积

`kiro-frame-buffer.js` 只保存跨传输 chunk 的未完成 AWS Event Stream 帧。完整连续帧直接交给原有 `decodeKiroFrames`，不复制原始帧；分片帧采用几何扩容，不再对每个新 chunk 重复 `Buffer.concat` 整个已有前缀。

## 校验与内存边界

- 不足 12 字节时最多保存一个 prelude；凑齐后立即通过原严格解码器校验 prelude CRC、帧长及 header 长度，再采用声明的帧长。
- 仅按已到达的数据扩容，容量不超过经过校验的单帧长度；默认 32 MiB 上限及 `KIRO_MAX_FRAME_BYTES` 的原有解释不变。多个合法帧组成的大 chunk 不受“整个 chunk 不得超过单帧上限”的误限制。
- 完整帧仍由原解码器验证 message CRC、header、UTF-8、JSON 与上游异常；不重同步、不跳过损坏帧。
- 同一次 `push` 内所有帧完成严格解码后才进入事件映射。后面的损坏帧或异常仍会使本批次失败，不提前发出本批次前面的正文或工具事件；之前批次已发出的内容保持原有语义。
- EOF 如有残留，继续抛出 `truncated trailing event frame`，不将残帧当作成功结束。

## 分片复制量

本地内存验证采用合法、无 header、JSON 正文为 `{ "content": "x…" }` 的 AWS 帧，含两个 CRC。以下“旧累积复制量”按旧逻辑中每次 `Buffer.concat` 的结果长度求和；第一片无需 concat。新累积复制量统计 helper 实际执行的 `Buffer.copy` 返回值，包含扩容时复制旧前缀的开销。

| 正文字符串大小 | 每片大小 | 帧字节数 | 分片数 | 旧累积复制量 | 新累积复制量 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 64 KiB | 1 B | 65,566 B | 65,566 | 2,149,482,960 B | 163,858 B |
| 1 MiB | 97 B | 1,048,606 B | 10,811 | 5,669,093,644 B | 2,620,394 B |

完整帧直接到达时，helper 的帧缓冲区复制和分配均为 0。分片时，累积复制量不超过帧长度的 3 倍，扩容次数为对数级。上述数值用于验证局部累积算法的复制成本，不代表真实上游 token/s 或首字延迟的改善比例。

## 回归验证

`tests/kiro-frame-buffer.test.js` 覆盖单字节至多帧分片、每个两片切分边界、分片 UTF-8、CRC/帧长/header/JSON/异常顺序、截断 EOF、恶意声明长度、完整帧零复制，以及 64 KiB 单字节和 1 MiB 小分片的复制/分配预算。还通过公共 Kiro 流验证事件映射、用量与最终完成事件。

运行当前工作区的测试文件，避免同仓库内其他 worktree 被路径模式匹配：

```sh
npm test -- --runInBand --runTestsByPath "$PWD/tests/kiro-frame-buffer.test.js" "$PWD/tests/kiro-production-safety.test.js"
```
