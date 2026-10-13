import axios from 'axios';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { CopilotClient, RuntimeConnection } from '@github/copilot-sdk';
import logger from '../../utils/logger.js';
import { configureTLSSidecar, resolveProxyUrlForProvider } from '../../utils/proxy-utils.js';
import { buildSdkProxyEnv, createSdkProxyBridge } from '../../utils/sdk-proxy-bridge.js';
import { isRetryableNetworkError, MODEL_PROVIDER, getRetryAfterMs } from '../../utils/common.js';

const COPILOT_AUTO_TIERS = new Set(['efficiency', 'balance', 'intelligence']);
export const COPILOT_SDK_ROUTE_CAPACITY = 4;

function sdkRouteCapacityError() {
    const error = new Error('[GitHub Copilot] All SDK proxy route slots are busy. Retry shortly.');
    error.code = 'COPILOT_SDK_ROUTE_CAPACITY';
    error.status = error.statusCode = 503;
    error.retryAfterMs = 1000;
    error.skipErrorCount = true;
    return error;
}

export function normalizeCopilotAutoTier(value, fallback = 'balance') {
    const tier = String(value || fallback).toLowerCase();
    if (!COPILOT_AUTO_TIERS.has(tier)) {
        throw new Error(`[GitHub Copilot] Invalid Auto tier '${tier}'. Use efficiency, balance, or intelligence.`);
    }
    return tier;
}

function messageContentToText(content, attachments) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);

    return content.map((part, index) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;

        const imageUrl = part.image_url?.url || part.url;
        if (typeof imageUrl !== 'string') return '';
        const dataUrl = imageUrl.match(/^data:([^;,]+);base64,(.+)$/s);
        if (dataUrl) {
            attachments.push({
                type: 'blob',
                data: dataUrl[2],
                mimeType: dataUrl[1],
                displayName: `chat-image-${index + 1}`
            });
            return `[Image attachment ${index + 1}]`;
        }
        return `[Image URL: ${imageUrl}]`;
    }).filter(Boolean).join('\n');
}

function buildCopilotPrompt(requestBody) {
    const messages = Array.isArray(requestBody.messages) ? requestBody.messages : [];
    const systemMessages = [];
    const conversation = [];
    const attachments = [];

    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const content = messageContentToText(message.content, attachments);
        if (message.role === 'system' || message.role === 'developer') {
            if (content) systemMessages.push(content);
            continue;
        }

        const role = String(message.role || 'user').toUpperCase();
        const toolName = message.name ? ` (${message.name})` : '';
        conversation.push(`${role}${toolName}:\n${content}`);
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            conversation.push(`ASSISTANT TOOL CALLS:\n${JSON.stringify(message.tool_calls)}`);
        }
    }

    return {
        systemPrompt: systemMessages.join('\n\n') || 'You are a helpful assistant. Answer the user directly.',
        prompt: conversation.join('\n\n') || 'Respond to the user.',
        attachments
    };
}

function createChatCompletion(content, outputTokens) {
    const response = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'auto',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
    };
    if (Number.isFinite(outputTokens)) {
        response.usage = { prompt_tokens: 0, completion_tokens: outputTokens, total_tokens: outputTokens };
    }
    return response;
}

function createChatCompletionChunk(id, created, delta, finishReason = null) {
    return {
        id,
        object: 'chat.completion.chunk',
        created,
        model: 'auto',
        choices: [{ index: 0, delta, finish_reason: finishReason }]
    };
}

// GitHub Copilot API Service
// GitHub Copilot uses OpenAI-compatible API endpoints but with GitHub-specific authentication
export class GitHubCopilotApiService {
    constructor(config) {
        this.config = config;
        this.baseUrl = config.GITHUB_COPILOT_BASE_URL || 'https://api.githubcopilot.com';
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_GITHUB ?? false;
        logger.info(`[GitHub Copilot] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);

        this.apiKey = config.GITHUB_COPILOT_API_KEY;
        this.sdkClientPromise = null;
        this.sdkClient = null;
        this.sdkProxyBridge = null;
        this.sdkActiveOperations = 0;
        this.retired = false;
        this.sdkForceDisposed = false;
        this.sdkDisposePromise = null;
        this.sdkCleanupPromise = null;
        this.sdkStopPromises = new WeakMap();
        this.sdkRoutes = new Map();
        this.sdkRouteSlots = new Set();
        this.sdkRouteReservations = new Set();
        this.sdkRouteSequence = 0;
        this.sdkRouteProxyUrl = undefined;
        this.isSdkRoute = false;
        this.sdkRoutesDisposePromise = null;
        this.quotaCache = null;
        if (!this.apiKey) {
            logger.warn('[GitHub Copilot] No fine-grained personal access token found.');
        }

        const axiosConfig = {
            baseURL: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'AIClient2API'
            },
        };

        this.axiosInstance = axios.create(axiosConfig);
    }

    createSdkClient(env) {
        const safeId = String(this.config.uuid || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
        return new CopilotClient({
            gitHubToken: this.apiKey,
            useLoggedInUser: false,
            mode: 'empty',
            baseDirectory: path.join(os.tmpdir(), 'aiclient2api-copilot-sdk', safeId),
            logLevel: 'error',
            ...(env ? { env, connection: RuntimeConnection.forStdio() } : {})
        });
    }

    assertUsable() {
        if (this.retired) throw new Error('[GitHub Copilot] This provider instance has been retired. Retry with the current provider configuration.');
    }

    createSdkRoute(proxyUrl) {
        const route = new GitHubCopilotApiService({ ...this.config });
        route.sdkRouteProxyUrl = proxyUrl;
        route.isSdkRoute = true;
        route.createSdkClient = env => this.createSdkClient(env);
        this.sdkRoutes.set(proxyUrl, route);
        this.sdkRouteSlots.add(route);
        return route;
    }

    leaseSdkRoute(route) {
        const finish = route.beginSdkOperation();
        route.sdkLastUsed = ++this.sdkRouteSequence;
        let released = false;
        return {
            route,
            finish: () => {
                if (released) return;
                released = true;
                route.sdkLastUsed = ++this.sdkRouteSequence;
                finish();
            }
        };
    }

    async acquireSdkRoute() {
        this.assertUsable();
        const proxyUrl = resolveProxyUrlForProvider(this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.GITHUB_COPILOT);
        const existing = this.sdkRoutes.get(proxyUrl);
        if (existing) return this.leaseSdkRoute(existing);
        if (this.sdkRouteReservations.has(proxyUrl)) throw sdkRouteCapacityError();

        if (this.sdkRouteSlots.size >= COPILOT_SDK_ROUTE_CAPACITY) {
            const idle = [...this.sdkRoutes.values()]
                .filter(route => route.sdkActiveOperations === 0)
                .sort((first, second) => first.sdkLastUsed - second.sdkLastUsed)[0];
            if (!idle) throw sdkRouteCapacityError();

            // Keep the retiring process in the capacity count until both SDK
            // and bridge have closed. Reserve the replacement URL before await.
            this.sdkRouteReservations.add(proxyUrl);
            this.sdkRoutes.delete(idle.sdkRouteProxyUrl);
            try {
                await idle.dispose();
                this.sdkRouteSlots.delete(idle);
                this.assertUsable();
                return this.leaseSdkRoute(this.createSdkRoute(proxyUrl));
            } finally {
                this.sdkRouteReservations.delete(proxyUrl);
            }
        }
        return this.leaseSdkRoute(this.createSdkRoute(proxyUrl));
    }

    async withSdkRoute(operation) {
        const lease = await this.acquireSdkRoute();
        try {
            return await operation(lease.route);
        } finally {
            lease.finish();
        }
    }

    beginSdkOperation() {
        this.assertUsable();
        this.sdkActiveOperations += 1;
        return () => {
            this.sdkActiveOperations -= 1;
            this.maybeCleanupSdk();
        };
    }

    stopSdkClient(client, force = false, startupSettled = false) {
        if (!client) return Promise.resolve();
        let pending = this.sdkStopPromises.get(client);
        if (!pending) {
            pending = {};
            this.sdkStopPromises.set(client, pending);
        }
        // A startup may spawn its child after an earlier forceStop. Stop again
        // once startup settles so that asynchronous spawn cannot leak a process.
        const mode = force ? (startupSettled ? 'forceAfterStartup' : 'force') : 'graceful';
        if (!pending[mode]) {
            pending[mode] = Promise.resolve().then(async () => {
                if (force || typeof client.stop !== 'function') await client.forceStop?.();
                else {
                    try {
                        const errors = await client.stop();
                        if (Array.isArray(errors) && errors.length) await this.stopSdkClient(client, true);
                    } catch {
                        await this.stopSdkClient(client, true);
                    }
                }
            }).catch(() => {});
        }
        return pending[mode];
    }

    /** Retire immediately, then release the SDK and proxy when active operations drain. */
    dispose({ force = false } = {}) {
        this.retired = true;
        this.sdkForceDisposed ||= force;
        if (!this.isSdkRoute) {
            const disposals = [...this.sdkRouteSlots].map(route => route.dispose({ force }));
            if (!this.sdkRoutesDisposePromise) {
                this.sdkRoutesDisposePromise = Promise.all(disposals).then(() => {
                    this.sdkRoutes.clear();
                    this.sdkRouteSlots.clear();
                });
            }
            return this.sdkRoutesDisposePromise;
        }
        if (!this.sdkDisposePromise) {
            this.sdkDisposePromise = new Promise(resolve => { this.resolveSdkDispose = resolve; });
        }
        if (force) {
            void this.stopSdkClient(this.sdkClient, true);
            void this.sdkProxyBridge?.close().catch(() => {});
        }
        this.maybeCleanupSdk();
        return this.sdkDisposePromise;
    }

    maybeCleanupSdk() {
        if (!this.retired || (!this.sdkForceDisposed && this.sdkActiveOperations > 0) || this.sdkCleanupPromise) return;
        this.sdkCleanupPromise = (async () => {
            try {
                await this.sdkClientPromise;
            } catch {}
            await this.stopSdkClient(this.sdkClient, this.sdkForceDisposed);
            await this.sdkProxyBridge?.close().catch(() => {});
            this.sdkClient = null;
            this.sdkProxyBridge = null;
            this.quotaCache = null;
        })().finally(() => this.resolveSdkDispose());
    }

    async getSdkClient(operationActive = false) {
        if (!this.isSdkRoute) return this.withSdkRoute(route => route.getSdkClient(true));
        if (!operationActive) this.assertUsable();
        if (this.sdkForceDisposed) throw new Error('[GitHub Copilot] Provider has been shut down.');
        if (!this.apiKey) {
            throw new Error('[GitHub Copilot] No fine-grained personal access token configured. Add one as GITHUB_COPILOT_API_KEY with the Copilot Requests permission.');
        }
        if (!this.sdkClientPromise) {
            this.sdkClientPromise = Promise.resolve().then(async () => {
                let client;
                let bridge;
                try {
                    const proxyUrl = this.sdkRouteProxyUrl;
                    if (proxyUrl) bridge = await createSdkProxyBridge(proxyUrl);
                    this.sdkProxyBridge = bridge;
                    if (this.sdkForceDisposed || (this.retired && this.sdkActiveOperations === 0)) this.assertUsable();
                    client = this.createSdkClient(bridge ? buildSdkProxyEnv(bridge.url) : undefined);
                    this.sdkClient = client;
                    await client.start();
                    if (this.sdkForceDisposed || (this.retired && this.sdkActiveOperations === 0)) this.assertUsable();
                    return client;
                } catch (error) {
                    await this.stopSdkClient(client, true, true);
                    await bridge?.close().catch(() => {});
                    this.sdkClient = null;
                    this.sdkProxyBridge = null;
                    this.sdkClientPromise = null;
                    throw error;
                }
            });
        }
        return this.sdkClientPromise;
    }

    async getQuota(operationActive = false) {
        if (!this.isSdkRoute) return this.withSdkRoute(route => route.getQuota(true));
        const finish = operationActive ? () => {} : this.beginSdkOperation();
        try {
            const now = Date.now();
            if (this.quotaCache && now - this.quotaCache.fetchedAt < 60000) {
                return { ...this.quotaCache.data };
            }

            const client = await this.getSdkClient(true);
            const result = await client.rpc.account.getQuota({ gitHubToken: this.apiKey });
            const quotaSnapshots = result?.quotaSnapshots || {};
            const quotaTypes = ['premium_interactions', 'chat', 'completions'];
            const quotaType = quotaTypes.find((type) => {
                const snapshot = quotaSnapshots[type];
                return snapshot && (snapshot.isUnlimitedEntitlement === true || Number(snapshot.entitlementRequests) > 0);
            }) || quotaTypes.find(type => quotaSnapshots[type]) || null;
            if (!quotaType) {
                const unavailable = {
                    available: false,
                    message: 'Copilot did not report a supported quota snapshot.'
                };
                this.quotaCache = { fetchedAt: now, data: unavailable };
                return { ...unavailable };
            }

            const snapshot = quotaSnapshots[quotaType];
            const isUnlimited = snapshot.isUnlimitedEntitlement === true || snapshot.entitlementRequests === -1;
            const remainingPercentage = Number(snapshot.remainingPercentage);
            const quota = {
                available: true,
                quotaType,
                usedRequests: Number(snapshot.usedRequests) || 0,
                entitlementRequests: Number(snapshot.entitlementRequests),
                remainingPercentage: isUnlimited || !Number.isFinite(remainingPercentage)
                    ? null
                    : Math.max(0, Math.min(100, remainingPercentage)),
                usedPercentage: isUnlimited || !Number.isFinite(remainingPercentage)
                    ? null
                    : Math.max(0, Math.min(100, 100 - remainingPercentage)),
                resetDate: snapshot.resetDate || null,
                isUnlimited
            };
            this.quotaCache = { fetchedAt: now, data: quota };
            return { ...quota };
        } finally {
            finish();
        }
    }

    async createAutoSession(requestBody, autoTier, streaming = false, operationActive = false) {
        if (Array.isArray(requestBody.tools) && requestBody.tools.length > 0) {
            throw new Error('[GitHub Copilot] Auto mode via the Copilot SDK does not support OpenAI tool-call requests yet.');
        }

        const client = await this.getSdkClient(operationActive);
        const { systemPrompt, prompt, attachments } = buildCopilotPrompt(requestBody);
        const session = await client.createSession({
            model: 'auto',
            capi: { autoTier },
            availableTools: [],
            streaming,
            systemMessage: { mode: 'append', content: systemPrompt }
        });
        return { client, session, prompt, attachments };
    }

    getAutoRequestContext(requestId, autoTier) {
        const safeRequestId = typeof requestId === 'string'
            ? requestId.replace(/[\r\n]/g, '').slice(0, 128)
            : 'unknown';
        const providerUuid = String(this.config.uuid || 'unknown').replace(/[\r\n]/g, '').slice(0, 128);
        return `provider=${providerUuid}, requestId=${safeRequestId}, model=auto, tier=${autoTier}`;
    }

    async cleanupSdkSession(client, session) {
        try {
            await session.disconnect();
        } catch (error) {
            logger.warn(`[GitHub Copilot SDK] Session disconnect failed: ${error.message}`);
        }
        try {
            await client.deleteSession(session.sessionId);
        } catch (error) {
            logger.warn(`[GitHub Copilot SDK] Session cleanup failed: ${error.message}`);
        }
    }

    async generateAutoContent(requestBody, requestId = null, operationActive = false) {
        if (!this.isSdkRoute) return this.withSdkRoute(route => route.generateAutoContent(requestBody, requestId, true));
        const finish = operationActive ? () => {} : this.beginSdkOperation();
        const startedAt = Date.now();
        let autoTier = 'invalid';
        let client;
        let session;
        let prompt;
        let attachments;
        try {
            autoTier = normalizeCopilotAutoTier(
                requestBody.auto_tier,
                this.config.GITHUB_COPILOT_AUTO_TIER || 'balance'
            );
            const context = this.getAutoRequestContext(requestId, autoTier);
            logger.info(`[GitHub Copilot SDK] Auto request started (${context})`);
            ({ client, session, prompt, attachments } = await this.createAutoSession(requestBody, autoTier, false, true));
            const response = await session.sendAndWait({ prompt, attachments });
            const outputTokens = response?.data?.outputTokens;
            logger.info(`[GitHub Copilot SDK] Auto request succeeded (${context}, durationMs=${Date.now() - startedAt}, outputTokens=${Number.isFinite(outputTokens) ? outputTokens : 'unknown'})`);
            return createChatCompletion(response?.data?.content || '', outputTokens);
        } catch (error) {
            const context = this.getAutoRequestContext(requestId, autoTier);
            logger.error(`[GitHub Copilot SDK] Auto request failed (${context}, durationMs=${Date.now() - startedAt}): ${error.message}`);
            throw error;
        } finally {
            try {
                if (client && session) await this.cleanupSdkSession(client, session);
            } finally {
                finish();
            }
        }
    }

    async *generateAutoContentStream(requestBody, requestId = null, operationActive = false) {
        if (!this.isSdkRoute) {
            const lease = await this.acquireSdkRoute();
            try {
                yield* lease.route.generateAutoContentStream(requestBody, requestId, true);
            } finally {
                lease.finish();
            }
            return;
        }
        const finish = operationActive ? () => {} : this.beginSdkOperation();
        const startedAt = Date.now();
        let autoTier = 'invalid';
        let client;
        let session;
        let prompt;
        let attachments;
        let unsubscribe;
        let deltaStream;
        let hasDelta = false;
        let finalContent = '';

        try {
            autoTier = normalizeCopilotAutoTier(
                requestBody.auto_tier,
                this.config.GITHUB_COPILOT_AUTO_TIER || 'balance'
            );
            const context = this.getAutoRequestContext(requestId, autoTier);
            logger.info(`[GitHub Copilot SDK] Auto stream started (${context})`);
            ({ client, session, prompt, attachments } = await this.createAutoSession(requestBody, autoTier, true, true));
            const id = `chatcmpl-${randomUUID()}`;
            const created = Math.floor(Date.now() / 1000);
            deltaStream = new Readable({ objectMode: true, read() {} });
            unsubscribe = session.on((event) => {
                if (event.agentId) return;
                if (event.type === 'assistant.message_delta') {
                    hasDelta = true;
                    deltaStream.push(event.data.deltaContent);
                } else if (event.type === 'assistant.message') {
                    finalContent = event.data.content || '';
                } else if (event.type === 'session.idle') {
                    if (!hasDelta && finalContent) deltaStream.push(finalContent);
                    deltaStream.push(null);
                } else if (event.type === 'session.error') {
                    deltaStream.destroy(new Error(event.data.message));
                }
            });

            yield createChatCompletionChunk(id, created, { role: 'assistant' });
            const sendPromise = session.send({ prompt, attachments });
            sendPromise.catch(error => deltaStream.destroy(error));
            for await (const content of deltaStream) {
                if (content) {
                    yield createChatCompletionChunk(id, created, { content });
                }
            }
            await sendPromise;
            yield createChatCompletionChunk(id, created, {}, 'stop');
            logger.info(`[GitHub Copilot SDK] Auto stream succeeded (${context}, durationMs=${Date.now() - startedAt})`);
        } catch (error) {
            const context = this.getAutoRequestContext(requestId, autoTier);
            logger.error(`[GitHub Copilot SDK] Auto stream failed (${context}, durationMs=${Date.now() - startedAt}): ${error.message}`);
            throw error;
        } finally {
            try {
                unsubscribe?.();
                deltaStream?.destroy();
                if (client && session) await this.cleanupSdkSession(client, session);
            } finally {
                finish();
            }
        }
    }

    getAuthHeader() {
        return this.apiKey ? `Bearer ${this.apiKey}` : null;
    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.GITHUB_COPILOT, this.baseUrl);
    }

    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        try {
            const authHeader = this.getAuthHeader();
            if (!authHeader) {
                throw new Error('[GitHub Copilot] No fine-grained personal access token configured. Add one as GITHUB_COPILOT_API_KEY with the Copilot Requests permission.');
            }

            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: body,
                headers: {
                    'Authorization': authHeader
                }
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';
            const responseMessage = typeof data === 'string'
                ? data.trim()
                : data?.error?.message || data?.message;
            if (status && responseMessage) {
                error.message = `[GitHub Copilot API] HTTP ${status}: ${responseMessage}`;
            }

            // Check for retryable network errors
            const isNetworkError = isRetryableNetworkError(error);

            if (status === 401 || status === 403) {
                logger.error(`[GitHub Copilot API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[GitHub Copilot API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[GitHub Copilot API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[GitHub Copilot API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            // Handle network errors with exponential backoff
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[GitHub Copilot API] Network error (${errorIdentifier}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`[GitHub Copilot API] Error calling API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        const authHeader = this.getAuthHeader();
        if (!authHeader) {
            throw new Error('[GitHub Copilot] No fine-grained personal access token configured. Add one as GITHUB_COPILOT_API_KEY with the Copilot Requests permission.');
        }

        // GitHub Copilot streaming requires stream to be set to true
        const streamRequestBody = { ...body, stream: true };
        let hasYieldedChunk = false;

        try {
            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: streamRequestBody,
                responseType: 'stream',
                headers: {
                    'Authorization': authHeader
                }
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);

            const stream = response.data;
            let buffer = '';
            const decoder = new StringDecoder('utf8');

            for await (const chunk of stream) {
                buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const jsonData = line.substring(6).trim();
                        if (jsonData === '[DONE]') {
                            return; // Stream finished
                        }
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            hasYieldedChunk = true;
                            yield parsedChunk;
                        } catch (e) {
                            logger.warn("[GitHubCopilotApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
                        }
                    } else if (line === '') {
                        // Empty line, end of an event
                    }
                }
            }
            buffer += decoder.end();
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            const errorCode = error.code;
            const errorMessage = error.message || '';

            // Check for retryable network errors
            const isNetworkError = isRetryableNetworkError(error);

            if (status === 401 || status === 403) {
                logger.error(`[GitHub Copilot API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[GitHub Copilot API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (!hasYieldedChunk && retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[GitHub Copilot API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (!hasYieldedChunk && status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[GitHub Copilot API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            // Handle network errors with exponential backoff
            if (!hasYieldedChunk && isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                const errorIdentifier = errorCode || errorMessage.substring(0, 50);
                logger.info(`[GitHub Copilot API] Network error (${errorIdentifier}) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`[GitHub Copilot API] Error calling streaming API (Status: ${status}, Code: ${errorCode}):`, errorMessage);
            throw error;
        }
    }

    async generateContent(model, requestBody) {
        this.assertUsable();
        const requestId = requestBody._monitorRequestId || this.config._monitorRequestId || null;
        // Temporary storage for monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        if (String(model).toLowerCase() === 'auto') {
            return this.generateAutoContent(requestBody, requestId);
        }

        return this.callApi('/chat/completions', requestBody);
    }

    async *generateContentStream(model, requestBody) {
        this.assertUsable();
        const requestId = requestBody._monitorRequestId || this.config._monitorRequestId || null;
        // Temporary storage for monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        if (String(model).toLowerCase() === 'auto') {
            yield* this.generateAutoContentStream(requestBody, requestId);
            return;
        }

        yield* this.streamApi('/chat/completions', requestBody);
    }

    async listModels() {
        this.assertUsable();
        return { data: [{ id: 'auto', name: 'Auto', object: 'model', owned_by: 'github-copilot' }] };
    }
}
