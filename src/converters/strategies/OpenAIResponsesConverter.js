/**
 * OpenAI Responses API 转换器
 * 处理 OpenAI Responses API 格式与其他协议之间的转换
 */

import { v4 as uuidv4 } from 'uuid';
import { BaseConverter } from '../BaseConverter.js';
import { CodexConverter } from './CodexConverter.js';
import { MODEL_PROTOCOL_PREFIX } from '../../utils/common.js';
import {
    extractAndProcessSystemMessages as extractSystemMessages,
    extractTextFromMessageContent as extractText,
    cleanJsonSchemaForOpenAI,
    CLAUDE_DEFAULT_MAX_TOKENS,
    GEMINI_DEFAULT_INPUT_TOKEN_LIMIT,
    GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT,
    safeParseJSON
} from '../utils.js';
import {
    generateResponseCreated,
    generateResponseInProgress,
    generateOutputItemAdded,
    generateContentPartAdded,
    generateOutputTextDone,
    generateContentPartDone,
    generateOutputItemDone,
    generateResponseCompleted
} from '../../providers/openai/openai-responses-core.mjs';

const RESPONSES_TOOL_OUTPUT_CONTENT_TYPES = new Set([
    'input_text', 'output_text', 'text', 'input_image', 'image_url', 'input_file'
]);

/**
 * OpenAI Responses API 转换器类
 * 支持 OpenAI Responses 格式与 OpenAI、Claude、Gemini 之间的转换
 */
export class OpenAIResponsesConverter extends BaseConverter {
    constructor() {
        super(MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES);
        this.codexConverter = new CodexConverter();
        this.claudeStreamStates = new Map();
    }

    // =============================================================================
    // 请求转换
    // =============================================================================

    /**
     * 转换请求到目标协议
     */
    convertRequest(data, toProtocol) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIRequest(data);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeRequest(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiRequest(data);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexRequest(data);
            case MODEL_PROTOCOL_PREFIX.GROK:
                return this.toGrokRequest(data);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换响应到目标协议
     */
    convertResponse(data, toProtocol, model) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiResponse(data, model);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexResponse(data, model);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换流式响应块到目标协议
     */
    convertStreamChunk(chunk, toProtocol, model, requestId) {
        switch (toProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeStreamChunk(chunk, model, requestId);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiStreamChunk(chunk, model);
            case MODEL_PROTOCOL_PREFIX.CODEX:
                return this.toCodexStreamChunk(chunk, model);
            default:
                throw new Error(`Unsupported target protocol: ${toProtocol}`);
        }
    }

    /**
     * 转换模型列表到目标协议
     */
    convertModelList(data, targetProtocol) {
        switch (targetProtocol) {
            case MODEL_PROTOCOL_PREFIX.OPENAI:
                return this.toOpenAIModelList(data);
            case MODEL_PROTOCOL_PREFIX.CLAUDE:
                return this.toClaudeModelList(data);
            case MODEL_PROTOCOL_PREFIX.GEMINI:
                return this.toGeminiModelList(data);
            default:
                return data;
        }
    }

    // =============================================================================
    // 转换到 OpenAI 格式
    // =============================================================================

    /**
     * 将 OpenAI Responses 请求转换为标准 OpenAI 请求
     */
    toOpenAIRequest(responsesRequest) {
        const openaiRequest = {
            model: responsesRequest.model,
            messages: [],
            stream: responsesRequest.stream || false
        };

        // 复制其他参数
        if (responsesRequest.temperature !== undefined) {
            openaiRequest.temperature = responsesRequest.temperature;
        }
        if (responsesRequest.max_output_tokens !== undefined) {
            openaiRequest.max_tokens = responsesRequest.max_output_tokens;
        } else if (responsesRequest.max_tokens !== undefined) {
            openaiRequest.max_tokens = responsesRequest.max_tokens;
        }
        if (responsesRequest.top_p !== undefined) {
            openaiRequest.top_p = responsesRequest.top_p;
        }
        if (responsesRequest.parallel_tool_calls !== undefined) {
            openaiRequest.parallel_tool_calls = responsesRequest.parallel_tool_calls;
        }

        // OpenAI Responses API 使用 instructions 和 input 字段
        // 需要转换为标准的 messages 格式
        if (responsesRequest.instructions) {
            // instructions 作为系统消息
            openaiRequest.messages.push({
                role: 'system',
                content: responsesRequest.instructions
            });
        }

        // input 包含用户消息和历史对话
        let input = responsesRequest.input;
        if (typeof input === 'string') {
            input = [{
                type: 'message',
                role: 'user',
                content: input
            }];
        }

        if (input && Array.isArray(input)) {
            input.forEach(item => {
                const itemType = item.type || (item.role ? 'message' : '');
                
                switch (itemType) {
                    case 'message':
                        // 提取消息内容
                        let content = '';
                        if (Array.isArray(item.content)) {
                            content = item.content
                                .filter(c => c.type === 'input_text' || c.type === 'output_text')
                                .map(c => c.text)
                                .join('\n');
                        } else if (typeof item.content === 'string') {
                            content = item.content;
                        }
                        
                        if (content || (item.role === 'assistant' || item.role === 'developer')) {
                            openaiRequest.messages.push({
                                role: item.role === 'developer' ? 'system' : item.role,
                                content: content
                            });
                        }
                        break;
                    
                    case 'function_call':
                        openaiRequest.messages.push({
                            role: 'assistant',
                            tool_calls: [{
                                id: item.call_id,
                                type: 'function',
                                function: {
                                    name: item.name,
                                    arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments)
                                }
                            }]
                        });
                        break;
                    
                    case 'function_call_output':
                        openaiRequest.messages.push({
                            role: 'tool',
                            tool_call_id: item.call_id,
                            content: item.output
                        });
                        break;
                }
            });
        }

        // 如果有标准的 messages 字段，也支持
        if (responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
            responsesRequest.messages.forEach(msg => {
                openaiRequest.messages.push({
                    role: msg.role === 'developer' ? 'system' : msg.role,
                    content: msg.content
                });
            });
        }

        // 处理工具
        if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
            openaiRequest.tools = responsesRequest.tools
                .map(tool => {
                    if (tool.type && tool.type !== 'function') {
                        return null;
                    }
                    
                    const name = tool.name || (tool.function && tool.function.name);
                    const description = tool.description || (tool.function && tool.function.description);
                    const parameters = tool.parameters || (tool.function && tool.function.parameters) || tool.parametersJsonSchema || { type: 'object', properties: {} };

                    // 如果没有名称，则该工具无效，稍后过滤掉
                    if (!name) {
                        return null;
                    }

                    return {
                        type: 'function',
                        function: {
                            name: name,
                            description: description,
                            parameters: parameters
                        }
                    };
                })
                .filter(tool => tool !== null);
        }

        if (responsesRequest.tool_choice) {
            openaiRequest.tool_choice = responsesRequest.tool_choice;
        }

        return openaiRequest;
    }

    /**
     * 将 OpenAI Responses 响应转换为标准 OpenAI 响应
     */
    toOpenAIResponse(responsesResponse, model) {
        const contentParts = [];
        const toolCalls = [];
        let usage = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 }
        };

        if (responsesResponse.output && Array.isArray(responsesResponse.output)) {
            responsesResponse.output.forEach((item) => {
                if (item.type === 'message') {
                    const content = item.content
                        ?.filter(c => c.type === 'output_text')
                        .map(c => c.text)
                        .join('') || '';
                    if (content) {
                        contentParts.push(content);
                    }
                } else if (item.type === 'function_call') {
                    toolCalls.push({
                        id: item.call_id || item.id,
                        type: 'function',
                        function: {
                            name: item.name,
                            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
                        }
                    });
                }
            });
        }

        if (responsesResponse.usage) {
            usage = {
                prompt_tokens: responsesResponse.usage.input_tokens || 0,
                completion_tokens: responsesResponse.usage.output_tokens || 0,
                total_tokens: responsesResponse.usage.total_tokens || 0,
                prompt_tokens_details: {
                    cached_tokens: responsesResponse.usage.input_tokens_details?.cached_tokens || 0
                },
                completion_tokens_details: {
                    reasoning_tokens: responsesResponse.usage.output_tokens_details?.reasoning_tokens || 0
                }
            };
        }

        const message = {
            role: 'assistant',
            content: contentParts.length > 0 ? contentParts.join('') : (toolCalls.length > 0 ? null : '')
        };
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }

        let finishReason = null;
        if (toolCalls.length > 0) {
            finishReason = 'tool_calls';
        } else if (!responsesResponse.status || responsesResponse.status === 'completed') {
            finishReason = 'stop';
        } else if (responsesResponse.status === 'incomplete') {
            finishReason = 'length';
        }

        return {
            id: responsesResponse.id || `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: responsesResponse.created_at || Math.floor(Date.now() / 1000),
            model: model || responsesResponse.model,
            choices: [{
                index: 0,
                message,
                finish_reason: finishReason
            }],
            usage: usage
        };
    }

    /**
     * 将 OpenAI Responses 流式块转换为标准 OpenAI 流式块
     */
    toOpenAIStreamChunk(responsesChunk, model) {
        const resId = responsesChunk.response?.id || responsesChunk.id || `chatcmpl-${Date.now()}`;
        const created = responsesChunk.response?.created_at || responsesChunk.created || Math.floor(Date.now() / 1000);
        
        const delta = {};
        let finish_reason = null;

        if (responsesChunk.type === 'response.output_text.delta') {
            delta.content = responsesChunk.delta;
        } else if (responsesChunk.type === 'response.function_call_arguments.delta') {
            delta.tool_calls = [{
                index: responsesChunk.output_index || 0,
                function: {
                    arguments: responsesChunk.delta
                }
            }];
        } else if (responsesChunk.type === 'response.output_item.added' && responsesChunk.item?.type === 'function_call') {
            delta.tool_calls = [{
                index: responsesChunk.output_index || 0,
                id: responsesChunk.item.call_id,
                type: 'function',
                function: {
                    name: responsesChunk.item.name,
                    arguments: ''
                }
            }];
        } else if (responsesChunk.type === 'response.completed') {
            finish_reason = 'stop';
        }

        return {
            id: resId,
            object: 'chat.completion.chunk',
            created: created,
            model: model || responsesChunk.response?.model || responsesChunk.model,
            choices: [{
                index: 0,
                delta: delta,
                finish_reason: finish_reason
            }]
        };
    }

    // =============================================================================
    // 转换到 Claude 格式
    // =============================================================================

    _stringifyContentValue(value) {
        if (value === null || value === undefined) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        return JSON.stringify(value);
    }

    _normalizeInstructions(instructions) {
        if (instructions === null || instructions === undefined) {
            return '';
        }
        if (typeof instructions === 'string') {
            return instructions;
        }
        if (Array.isArray(instructions)) {
            return instructions.map(item => this._stringifyContentValue(item?.text ?? item)).filter(Boolean).join('\n');
        }
        return this._stringifyContentValue(instructions);
    }

    _extractResponsesImageUrl(part) {
        if (!part) {
            return '';
        }
        const image = part.image_url ?? part.url;
        if (typeof image === 'string') {
            return image;
        }
        return image?.url || '';
    }

    _dataUrlToClaudeImage(url) {
        if (typeof url !== 'string' || !/^data:/i.test(url)) {
            return null;
        }
        const match = url.match(/^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/is);
        if (!match) {
            return null;
        }
        return {
            type: 'image',
            source: {
                type: 'base64',
                media_type: match[1],
                data: match[2]
            }
        };
    }

    _responsesContentToClaudeBlocks(content, role = 'user') {
        if (content === null || content === undefined) {
            return [];
        }

        if (typeof content === 'string') {
            return content ? [{ type: 'text', text: content }] : [];
        }

        if (!Array.isArray(content)) {
            const text = this._stringifyContentValue(content);
            return text ? [{ type: 'text', text }] : [];
        }

        const blocks = [];
        for (const part of content) {
            if (!part) continue;
            const partType = part.type;
            if (partType === 'input_text' || partType === 'output_text' || partType === 'text') {
                if (part.text !== undefined && part.text !== null) {
                    blocks.push({ type: 'text', text: String(part.text) });
                }
                continue;
            }
            if (partType === 'refusal') {
                const refusal = part.refusal ?? part.text;
                if (refusal) {
                    blocks.push({ type: 'text', text: String(refusal) });
                }
                continue;
            }
            if (partType === 'input_image' || partType === 'image_url') {
                const url = this._extractResponsesImageUrl(part);
                const imageBlock = this._dataUrlToClaudeImage(url);
                if (imageBlock) {
                    blocks.push(imageBlock);
                } else if (url) {
                    blocks.push({ type: 'text', text: `[Image: ${url}]` });
                }
                continue;
            }
            if (partType === 'input_file') {
                const fileLabel = part.filename || part.file_id || part.file_url || 'file';
                blocks.push({ type: 'text', text: `[File: ${fileLabel}]` });
                continue;
            }

            const fallbackText = part.text ?? part.content;
            if (fallbackText !== undefined && fallbackText !== null) {
                blocks.push({ type: 'text', text: this._stringifyContentValue(fallbackText) });
            }
        }

        return blocks;
    }

    _normalizeToolInput(argumentsValue) {
        if (argumentsValue === null || argumentsValue === undefined || argumentsValue === '') {
            return {};
        }
        const parsed = typeof argumentsValue === 'string' ? safeParseJSON(argumentsValue) : argumentsValue;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
        return { _raw_arguments: parsed };
    }

    _normalizeToolOutput(output) {
        if (output === null || output === undefined) {
            return '';
        }
        if (typeof output === 'string') {
            return output;
        }
        // Only typed Responses content arrays are multimodal. Preserve legacy
        // JSON objects/arrays and never parse a caller's text as image content.
        if (Array.isArray(output) && output.some(part => RESPONSES_TOOL_OUTPUT_CONTENT_TYPES.has(part?.type))) {
            return output.flatMap(part => {
                if (part?.type === 'input_image' || part?.type === 'image_url') {
                    const url = this._extractResponsesImageUrl(part);
                    const image = this._dataUrlToClaudeImage(url);
                    if (image) return [image];
                    // Retain URL sources for providers that support them; Kiro's
                    // content converter reports them as unsupported without fetching.
                    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
                        return [{ type: 'image', source: { type: 'url', url } }];
                    }
                    return [{ type: 'text', text: '[Tool output image was not forwarded: provide a base64 data URL or an HTTP(S) image URL; file_id images are not supported.]' }];
                }
                if (part?.type === 'input_file') {
                    return [{ type: 'text', text: '[Tool output file was not forwarded: file inputs are not supported in tool results.]' }];
                }
                if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text' || typeof part === 'string') {
                    return this._responsesContentToClaudeBlocks(typeof part === 'string' ? part : [part]);
                }
                // Do not serialize an unknown/binary block alongside valid images
                // into text: acknowledge the unsupported part without its data.
                const kind = typeof part?.type === 'string' ? part.type.slice(0, 64) : 'unknown';
                return [{ type: 'text', text: `[Unsupported tool output content block "${kind}" was not forwarded.]` }];
            });
        }
        return JSON.stringify(output);
    }

    _pushClaudeMessage(messages, role, blocks) {
        if (!blocks || blocks.length === 0) {
            return;
        }
        const normalizedRole = role === 'assistant' ? 'assistant' : 'user';
        const last = messages[messages.length - 1];
        if (last && last.role === normalizedRole && Array.isArray(last.content)) {
            last.content.push(...blocks);
            return;
        }
        messages.push({
            role: normalizedRole,
            content: blocks
        });
    }

    _mapResponsesToolToClaude(tool) {
        if (!tool || typeof tool !== 'object') {
            return null;
        }
        if (tool.type && tool.type !== 'function') {
            if (tool.type === 'web_search_preview' || tool.type === 'web_search') {
                return {
                    type: 'web_search_20250305',
                    name: tool.name || 'web_search'
                };
            }
            return null;
        }

        const fn = tool.function || {};
        const name = tool.name || fn.name;
        if (!name) {
            return null;
        }

        return {
            name,
            description: tool.description || fn.description || '',
            input_schema: cleanJsonSchemaForOpenAI(
                tool.parameters || fn.parameters || tool.parametersJsonSchema || { type: 'object', properties: {} }
            )
        };
    }

    _mapResponsesToolChoiceToClaude(toolChoice) {
        if (!toolChoice) {
            return undefined;
        }
        if (typeof toolChoice === 'string') {
            if (toolChoice === 'auto') return { type: 'auto' };
            if (toolChoice === 'required') return { type: 'any' };
            if (toolChoice === 'none') return { type: 'none' };
            return undefined;
        }
        if (toolChoice.type === 'function') {
            const name = toolChoice.name || toolChoice.function?.name;
            return name ? { type: 'tool', name } : undefined;
        }
        return undefined;
    }

    _mapReasoningToClaudeThinking(reasoning) {
        const effort = String(reasoning?.effort || '').toLowerCase().trim();
        if (!effort) {
            return undefined;
        }
        if (effort === 'none') {
            return { type: 'disabled' };
        }
        const budgetByEffort = {
            minimal: 1024,
            low: 2048,
            medium: 8192,
            high: 20000,
            xhigh: 32000,
            max: 32000
        };
        return {
            type: 'enabled',
            budget_tokens: budgetByEffort[effort] || 20000
        };
    }

    /**
     * 将 OpenAI Responses 请求转换为 Claude 请求
     */
    toClaudeRequest(responsesRequest) {
        const claudeRequest = {
            model: responsesRequest.model,
            messages: [],
            max_tokens: responsesRequest.max_output_tokens || responsesRequest.max_tokens || CLAUDE_DEFAULT_MAX_TOKENS,
            stream: responsesRequest.stream || false
        };

        const systemParts = [];
        const normalizedInstructions = this._normalizeInstructions(responsesRequest.instructions);
        if (normalizedInstructions) {
            systemParts.push(normalizedInstructions);
        }

        const thinking = this._mapReasoningToClaudeThinking(responsesRequest.reasoning);
        if (thinking) {
            claudeRequest.thinking = thinking;
        }

        // 处理 input 数组中的消息
        let input = responsesRequest.input;
        if (typeof input === 'string') {
            input = [{
                type: 'message',
                role: 'user',
                content: input
            }];
        }

        const appendResponsesItems = (items) => {
            items.forEach(item => {
                if (!item) return;
                const itemType = item.type || (item.role ? 'message' : '');

                switch (itemType) {
                    case 'message':
                        if (item.role === 'system' || item.role === 'developer') {
                            const systemText = this._responsesContentToClaudeBlocks(item.content)
                                .filter(block => block.type === 'text')
                                .map(block => block.text)
                                .join('\n');
                            if (systemText) systemParts.push(systemText);
                            break;
                        }
                        this._pushClaudeMessage(
                            claudeRequest.messages,
                            item.role,
                            this._responsesContentToClaudeBlocks(item.content, item.role)
                        );
                        break;

                    case 'function_call':
                        this._pushClaudeMessage(claudeRequest.messages, 'assistant', [{
                                type: 'tool_use',
                                id: item.call_id || item.id || `toolu_${uuidv4().replace(/-/g, '')}`,
                                name: item.name,
                                input: this._normalizeToolInput(item.arguments)
                            }]);
                        break;

                    case 'function_call_output':
                        this._pushClaudeMessage(claudeRequest.messages, 'user', [{
                                type: 'tool_result',
                                tool_use_id: item.call_id,
                                content: this._normalizeToolOutput(item.output)
                            }]);
                        break;

                    case 'reasoning':
                        {
                            const summary = Array.isArray(item.summary) ? item.summary : [];
                            const thinkingText = summary
                                .map(part => part?.text ?? part?.summary_text ?? '')
                                .filter(Boolean)
                                .join('\n');
                            if (thinkingText) {
                                this._pushClaudeMessage(claudeRequest.messages, 'assistant', [{
                                    type: 'thinking',
                                    thinking: thinkingText
                                }]);
                            }
                        }
                        break;
                }
            });
        };

        if (input && Array.isArray(input)) {
            appendResponsesItems(input);
        }

        if (responsesRequest.messages && Array.isArray(responsesRequest.messages)) {
            appendResponsesItems(responsesRequest.messages.map(message => ({
                type: 'message',
                role: message.role,
                content: message.content
            })));
        }

        if (systemParts.length > 0) {
            claudeRequest.system = systemParts.join('\n');
        }

        // 处理工具
        if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
            const tools = responsesRequest.tools.map(tool => this._mapResponsesToolToClaude(tool)).filter(Boolean);
            if (tools.length > 0) {
                claudeRequest.tools = tools;
            }
        }

        const toolChoice = this._mapResponsesToolChoiceToClaude(responsesRequest.tool_choice);
        if (toolChoice) {
            claudeRequest.tool_choice = toolChoice;
        }

        return claudeRequest;
    }

    /**
     * 将 OpenAI Responses 响应转换为 Claude 响应
     */
    toClaudeResponse(responsesResponse, model) {
        const content = [];
        let stop_reason = 'end_turn';
        let messageId = null;

        if (responsesResponse.output && Array.isArray(responsesResponse.output)) {
            responsesResponse.output.forEach(item => {
                if (item.type === 'message') {
                    if (!messageId && item.id) {
                        messageId = item.id;
                    }
                    for (const block of this._responsesContentToClaudeBlocks(item.content, 'assistant')) {
                        if (block.type === 'text') {
                            content.push(block);
                        }
                    }
                } else if (item.type === 'function_call') {
                    content.push({
                        type: 'tool_use',
                        id: item.call_id || item.id || `toolu_${uuidv4().replace(/-/g, '')}`,
                        name: item.name,
                        input: this._normalizeToolInput(item.arguments)
                    });
                    stop_reason = 'tool_use';
                } else if (item.type === 'reasoning') {
                    const summary = Array.isArray(item.summary) ? item.summary : [];
                    const thinking = summary
                        .map(part => part?.text ?? part?.summary_text ?? '')
                        .filter(Boolean)
                        .join('\n');
                    if (thinking) {
                        content.push({ type: 'thinking', thinking });
                    }
                }
            });
        }

        if (responsesResponse.status === 'incomplete') {
            stop_reason = 'max_tokens';
        }

        return {
            id: messageId || responsesResponse.id || `msg_${uuidv4().replace(/-/g, '')}`,
            type: 'message',
            role: 'assistant',
            content: content,
            model: model || responsesResponse.model,
            stop_reason: stop_reason,
            usage: {
                input_tokens: responsesResponse.usage?.input_tokens || 0,
                output_tokens: responsesResponse.usage?.output_tokens || 0,
                cache_read_input_tokens: responsesResponse.usage?.input_tokens_details?.cached_tokens || 0
            }
        };
    }

    _getClaudeStreamState(requestId) {
        const key = requestId || 'default';
        if (!this.claudeStreamStates.has(key)) {
            this.claudeStreamStates.set(key, {
                textBlocks: new Set(),
                toolBlocks: new Set(),
                reasoningBlocks: new Set(),
                stoppedBlocks: new Set(),
                stopReason: 'end_turn',
                usage: null
            });
        }
        return this.claudeStreamStates.get(key);
    }

    _mapResponsesUsageToClaude(usage = {}) {
        return {
            input_tokens: usage.input_tokens || 0,
            output_tokens: usage.output_tokens || 0,
            cache_read_input_tokens: usage.input_tokens_details?.cached_tokens || 0
        };
    }

    _normalizeClaudeStreamIndex(chunk) {
        return chunk.output_index ?? chunk.content_index ?? 0;
    }

    /**
     * 将 OpenAI Responses 流式块转换为 Claude 流式块
     */
    toClaudeStreamChunk(responsesChunk, model, requestId = null) {
        if (!responsesChunk) {
            return null;
        }
        const state = this._getClaudeStreamState(requestId);

        if (responsesChunk.type === 'response.created') {
            return {
                type: 'message_start',
                message: {
                    id: responsesChunk.response.id,
                    type: 'message',
                    role: 'assistant',
                    content: [],
                    model: model || responsesChunk.response.model,
                    usage: {
                        input_tokens: 0,
                        output_tokens: 0
                    }
                }
            };
        }

        if (responsesChunk.type === 'response.content_part.added') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
            if (responsesChunk.part?.type === 'output_text' && !state.textBlocks.has(index)) {
                state.textBlocks.add(index);
                return {
                    type: 'content_block_start',
                    index,
                    content_block: {
                        type: 'text',
                        text: ''
                    }
                };
            }
        }

        if (responsesChunk.type === 'response.output_text.delta') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
            const events = [];
            if (!state.textBlocks.has(index)) {
                state.textBlocks.add(index);
                events.push({
                    type: 'content_block_start',
                    index,
                    content_block: {
                        type: 'text',
                        text: ''
                    }
                });
            }
            events.push({
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'text_delta',
                    text: responsesChunk.delta || ''
                }
            });
            return events;
        }

        if (responsesChunk.type === 'response.output_text.done' || responsesChunk.type === 'response.content_part.done') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
            if (!state.stoppedBlocks.has(`text:${index}`)) {
                state.stoppedBlocks.add(`text:${index}`);
                return {
                    type: 'content_block_stop',
                    index
                };
            }
            return null;
        }

        if (responsesChunk.type === 'response.reasoning_summary_text.delta') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
            const events = [];
            if (!state.reasoningBlocks.has(index)) {
                state.reasoningBlocks.add(index);
                events.push({
                    type: 'content_block_start',
                    index,
                    content_block: {
                        type: 'thinking',
                        thinking: ''
                    }
                });
            }
            events.push({
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'thinking_delta',
                    thinking: responsesChunk.delta || ''
                }
            });
            return events;
        }

        if (responsesChunk.type === 'response.reasoning_summary_text.done') {
            const index = this._normalizeClaudeStreamIndex(responsesChunk);
            if (!state.stoppedBlocks.has(`reasoning:${index}`)) {
                state.stoppedBlocks.add(`reasoning:${index}`);
                return {
                    type: 'content_block_stop',
                    index
                };
            }
            return null;
        }

        if (responsesChunk.type === 'response.function_call_arguments.delta') {
            return {
                type: 'content_block_delta',
                index: responsesChunk.output_index || 0,
                delta: {
                    type: 'input_json_delta',
                    partial_json: responsesChunk.delta
                }
            };
        }

        if (responsesChunk.type === 'response.function_call_arguments.done') {
            const index = responsesChunk.output_index || 0;
            if (!state.stoppedBlocks.has(`tool:${index}`)) {
                state.stoppedBlocks.add(`tool:${index}`);
                return {
                    type: 'content_block_stop',
                    index
                };
            }
            return null;
        }

        if (responsesChunk.type === 'response.output_item.added' && responsesChunk.item?.type === 'function_call') {
            state.stopReason = 'tool_use';
            state.toolBlocks.add(responsesChunk.output_index || 0);
            return {
                type: 'content_block_start',
                index: responsesChunk.output_index || 0,
                content_block: {
                    type: 'tool_use',
                    id: responsesChunk.item.call_id || responsesChunk.item.id,
                    name: responsesChunk.item.name,
                    input: {}
                }
            };
        }

        if (responsesChunk.type === 'response.output_item.done' && responsesChunk.item?.type === 'function_call') {
            const index = responsesChunk.output_index || 0;
            state.stopReason = 'tool_use';
            if (!state.toolBlocks.has(index)) {
                state.toolBlocks.add(index);
                state.stoppedBlocks.add(`tool:${index}`);
                const args = this._stringifyContentValue(this._normalizeToolInput(responsesChunk.item.arguments));
                return [
                    {
                        type: 'content_block_start',
                        index,
                        content_block: {
                            type: 'tool_use',
                            id: responsesChunk.item.call_id || responsesChunk.item.id,
                            name: responsesChunk.item.name,
                            input: {}
                        }
                    },
                    {
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'input_json_delta',
                            partial_json: args
                        }
                    },
                    {
                        type: 'content_block_stop',
                        index
                    }
                ];
            }
            if (!state.stoppedBlocks.has(`tool:${index}`)) {
                state.stoppedBlocks.add(`tool:${index}`);
                return {
                    type: 'content_block_stop',
                    index
                };
            }
            return null;
        }

        if (responsesChunk.type === 'response.output_item.done' && responsesChunk.item?.type === 'message') {
            return null;
        }

        if (responsesChunk.type === 'response.completed' && responsesChunk.response?.usage) {
            state.usage = this._mapResponsesUsageToClaude(responsesChunk.response.usage);
        }

        if (responsesChunk.type === 'response.completed' && Array.isArray(responsesChunk.response?.output)) {
            if (responsesChunk.response.output.some(item => item.type === 'function_call')) {
                state.stopReason = 'tool_use';
            }
        }

        if (responsesChunk.type === 'response.completed') {
            const usage = state.usage || this._mapResponsesUsageToClaude(responsesChunk.response?.usage || {});
            this.claudeStreamStates.delete(requestId || 'default');
            return [
                {
                    type: 'message_delta',
                    delta: {
                        stop_reason: state.stopReason
                    },
                    usage
                },
                {
                    type: 'message_stop'
                }
            ];
        }

        return null;
    }

    // =============================================================================
    // 转换到 Gemini 格式
    // =============================================================================

    /**
     * 将 OpenAI Responses 请求转换为 Gemini 请求
     */
    toGeminiRequest(responsesRequest) {
        const geminiRequest = {
            contents: [],
            generationConfig: {}
        };

        // 处理 instructions 作为系统指令
        if (responsesRequest.instructions) {
            geminiRequest.systemInstruction = {
                parts: [{
                    text: responsesRequest.instructions
                }]
            };
        }

        // 处理 input 数组中的消息
        let input = responsesRequest.input;
        if (typeof input === 'string') {
            input = [{
                type: 'message',
                role: 'user',
                content: input
            }];
        }

        if (input && Array.isArray(input)) {
            input.forEach(item => {
                const itemType = item.type || (item.role ? 'message' : '');
                
                switch (itemType) {
                    case 'message':
                        const parts = [];
                        if (Array.isArray(item.content)) {
                            item.content.forEach(c => {
                                if (c.type === 'input_text' || c.type === 'output_text') {
                                    parts.push({ text: c.text });
                                } else if (c.type === 'input_image') {
                                    const url = c.image_url?.url || c.url;
                                    if (url && url.startsWith('data:')) {
                                        const [mediaInfo, data] = url.split(';base64,');
                                        const mimeType = mediaInfo.replace('data:', '');
                                        parts.push({
                                            inlineData: {
                                                mimeType: mimeType,
                                                data: data
                                            }
                                        });
                                    }
                                }
                            });
                        } else if (typeof item.content === 'string') {
                            parts.push({ text: item.content });
                        }
                        
                        if (parts.length > 0) {
                            geminiRequest.contents.push({
                                role: item.role === 'assistant' ? 'model' : 'user',
                                parts: parts
                            });
                        }
                        break;
                    
                    case 'function_call':
                        geminiRequest.contents.push({
                            role: 'model',
                            parts: [{
                                functionCall: {
                                    name: item.name,
                                    args: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments
                                }
                            }]
                        });
                        break;
                    
                    case 'function_call_output':
                        geminiRequest.contents.push({
                            role: 'user', // Gemini function response role is user or tool? usually user/model
                            parts: [{
                                functionResponse: {
                                    name: item.name,
                                    response: { content: item.output }
                                }
                            }]
                        });
                        break;
                }
            });
        }

        // 设置生成配置
        if (responsesRequest.temperature !== undefined) {
            geminiRequest.generationConfig.temperature = responsesRequest.temperature;
        }
        if (responsesRequest.max_output_tokens !== undefined) {
            geminiRequest.generationConfig.maxOutputTokens = responsesRequest.max_output_tokens;
        } else if (responsesRequest.max_tokens !== undefined) {
            geminiRequest.generationConfig.maxOutputTokens = responsesRequest.max_tokens;
        }
        if (responsesRequest.top_p !== undefined) {
            geminiRequest.generationConfig.topP = responsesRequest.top_p;
        }

        // 处理工具
        if (responsesRequest.tools && Array.isArray(responsesRequest.tools)) {
            geminiRequest.tools = [{
                functionDeclarations: responsesRequest.tools
                    .filter(tool => !tool.type || tool.type === 'function')
                    .map(tool => ({
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.parameters || tool.parametersJsonSchema || { type: 'object', properties: {} }
                    }))
            }];
        }

        return geminiRequest;
    }

    /**
     * 将 OpenAI Responses 响应转换为 Gemini 响应
     */
    toGeminiResponse(responsesResponse, model) {
        const parts = [];
        let finishReason = 'STOP';

        if (responsesResponse.output && Array.isArray(responsesResponse.output)) {
            responsesResponse.output.forEach(item => {
                if (item.type === 'message') {
                    const text = item.content
                        ?.filter(c => c.type === 'output_text')
                        .map(c => c.text)
                        .join('') || '';
                    if (text) {
                        parts.push({ text: text });
                    }
                } else if (item.type === 'function_call') {
                    parts.push({
                        functionCall: {
                            name: item.name,
                            args: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments
                        }
                    });
                }
            });
        }

        return {
            candidates: [{
                content: {
                    parts: parts,
                    role: 'model'
                },
                finishReason: finishReason,
                index: 0
            }],
            usageMetadata: {
                promptTokenCount: responsesResponse.usage?.input_tokens || 0,
                candidatesTokenCount: responsesResponse.usage?.output_tokens || 0,
                totalTokenCount: responsesResponse.usage?.total_tokens || 0,
                cachedContentTokenCount: responsesResponse.usage?.input_tokens_details?.cached_tokens || 0
            }
        };
    }

    /**
     * 将 OpenAI Responses 流式块转换为 Gemini 流式块
     */
    toGeminiStreamChunk(responsesChunk, model) {
        if (responsesChunk.type === 'response.output_text.delta') {
            return {
                candidates: [{
                    content: {
                        parts: [{ text: responsesChunk.delta }],
                        role: 'model'
                    },
                    index: 0
                }]
            };
        }

        if (responsesChunk.type === 'response.function_call_arguments.delta') {
            // Gemini 不太支持流式 functionCall 参数，这里只能简单映射
            return {
                candidates: [{
                    content: {
                        parts: [{ 
                            functionCall: { 
                                name: '', // 无法在 delta 中获取名称
                                args: responsesChunk.delta 
                            } 
                        }],
                        role: 'model'
                    },
                    index: 0
                }]
            };
        }

        return null;
    }

    /**
     * OpenAI Responses → Codex 请求转换
     */
    toCodexRequest(responsesRequest) {
        return this.codexConverter.toOpenAIResponsesToCodexRequest(responsesRequest);
    }

    /**
     * OpenAI Responses → Grok 请求转换
     */
    toGrokRequest(responsesRequest) {
        // 先转换为 OpenAI 格式
        const openaiRequest = this.toOpenAIRequest(responsesRequest);
        return {
            ...openaiRequest,
            _isConverted: true
        };
    }

    // =============================================================================
    // 辅助方法
    // =============================================================================

    /**
     * 映射完成原因
     */
    mapFinishReason(reason) {
        const reasonMap = {
            'stop': 'STOP',
            'length': 'MAX_TOKENS',
            'content_filter': 'SAFETY',
            'end_turn': 'STOP'
        };
        return reasonMap[reason] || 'STOP';
    }

    /**
     * 将 OpenAI Responses 模型列表转换为标准 OpenAI 模型列表
     */
    toOpenAIModelList(responsesModels) {
        // OpenAI Responses 格式的模型列表已经是标准 OpenAI 格式
        // 如果输入已经是标准格式,直接返回
        if (responsesModels.object === 'list' && responsesModels.data) {
            return responsesModels;
        }

        // 如果是其他格式,转换为标准格式
        return {
            object: "list",
            data: (responsesModels.models || responsesModels.data || []).map(m => ({
                id: m.id || m.name,
                object: "model",
                created: m.created || Math.floor(Date.now() / 1000),
                owned_by: m.owned_by || "openai",
            })),
        };
    }

    /**
     * 将 OpenAI Responses 模型列表转换为 Claude 模型列表
     */
    toClaudeModelList(responsesModels) {
        const models = responsesModels.data || responsesModels.models || [];
        return {
            models: models.map(m => ({
                name: m.id || m.name,
                description: m.description || "",
            })),
        };
    }

    /**
     * 将 OpenAI Responses 模型列表转换为 Gemini 模型列表
     */
    toGeminiModelList(responsesModels) {
        const models = responsesModels.data || responsesModels.models || [];
        return {
            models: models.map(m => ({
                name: `models/${m.id || m.name}`,
                version: m.version || "1.0.0",
                displayName: m.displayName || m.id || m.name,
                description: m.description || `A generative model for text and chat generation. ID: ${m.id || m.name}`,
                inputTokenLimit: m.inputTokenLimit || GEMINI_DEFAULT_INPUT_TOKEN_LIMIT,
                outputTokenLimit: m.outputTokenLimit || GEMINI_DEFAULT_OUTPUT_TOKEN_LIMIT,
                supportedGenerationMethods: m.supportedGenerationMethods || ["generateContent", "streamGenerateContent"]
            }))
        };
    }


    /**
     * OpenAI Responses → Codex 响应转换 (实际上是 Codex 转 OpenAI Responses)
     */
    toCodexResponse(codexResponse, model) {
        const output = [];
        const responseData = codexResponse.response || codexResponse;

        if (responseData.output && Array.isArray(responseData.output)) {
            responseData.output.forEach(item => {
                if (item.type === 'message' && item.content) {
                    const content = item.content.map(c => ({
                        type: c.type === 'output_text' ? 'output_text' : 'input_text',
                        text: c.text,
                        annotations: []
                    }));
                    output.push({
                        id: item.id || `msg_${uuidv4().replace(/-/g, '')}`,
                        type: "message",
                        role: item.role || "assistant",
                        status: item.status || "completed",
                        content: content
                    });
                } else if (item.type === 'reasoning') {
                    output.push({
                        id: item.id || `rs_${uuidv4().replace(/-/g, '')}`,
                        type: "reasoning",
                        status: item.status || "completed",
                        summary: item.summary || []
                    });
                } else if (item.type === 'function_call') {
                    output.push({
                        id: item.id || `fc_${uuidv4().replace(/-/g, '')}`,
                        call_id: item.call_id,
                        type: "function_call",
                        name: item.name,
                        arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
                        status: item.status || "completed"
                    });
                }
            });
        }

        return {
            id: responseData.id || `resp_${uuidv4().replace(/-/g, '')}`,
            object: "response",
            created_at: responseData.created_at || Math.floor(Date.now() / 1000),
            model: model || responseData.model,
            status: responseData.status || "completed",
            output: output,
            usage: {
                input_tokens: responseData.usage?.input_tokens || 0,
                output_tokens: responseData.usage?.output_tokens || 0,
                total_tokens: responseData.usage?.total_tokens || 0,
                input_tokens_details: {
                    cached_tokens: responseData.usage?.input_tokens_details?.cached_tokens || 0
                },
                output_tokens_details: {
                    reasoning_tokens: responseData.usage?.output_tokens_details?.reasoning_tokens || 0
                }
            }
        };
    }

    /**
     * OpenAI Responses → Codex 流式响应转换 (实际上是 Codex 转 OpenAI Responses)
     */
    toCodexStreamChunk(codexChunk, model) {
        const type = codexChunk.type;
        const resId = codexChunk.response?.id || 'default';
        const events = [];

        if (type === 'response.created') {
            events.push(
                generateResponseCreated(resId, model || codexChunk.response?.model),
                generateResponseInProgress(resId)
            );
            return events;
        }

        if (type === 'response.reasoning_summary_text.delta') {
            events.push({
                type: "response.reasoning_summary_text.delta",
                response_id: resId,
                item_id: codexChunk.item_id,
                output_index: codexChunk.output_index,
                summary_index: codexChunk.summary_index,
                delta: codexChunk.delta
            });
            return events;
        }

        if (type === 'response.output_text.delta') {
            events.push({
                type: "response.output_text.delta",
                response_id: resId,
                item_id: codexChunk.item_id,
                output_index: codexChunk.output_index,
                content_index: codexChunk.content_index,
                delta: codexChunk.delta
            });
            return events;
        }

        if (type === 'response.function_call_arguments.delta') {
            events.push({
                type: "response.function_call_arguments.delta",
                response_id: resId,
                item_id: codexChunk.item_id,
                output_index: codexChunk.output_index,
                delta: codexChunk.delta
            });
            return events;
        }

        if (type === 'response.output_item.added') {
            events.push({
                type: "response.output_item.added",
                response_id: resId,
                output_index: codexChunk.output_index,
                item: codexChunk.item
            });
            return events;
        }

        if (type === 'response.completed') {
            const completedEvent = generateResponseCompleted(resId);
            completedEvent.response = {
                ...completedEvent.response,
                ...codexChunk.response
            };
            events.push(completedEvent);
            return events;
        }

        // 透传其他 response.* 事件
        if (type && type.startsWith('response.')) {
            return [codexChunk];
        }

        return null;
    }

}
