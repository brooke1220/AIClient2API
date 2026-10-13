/**
 * 代理工具模块
 * 支持 HTTP、HTTPS 和 SOCKS5 代理
 */

import { HttpsProxyAgent } from 'https-proxy-agent';
import logger from './logger.js';
import requestContext from './context.js';
import { HttpProxyAgent } from 'http-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { getTLSSidecar } from './tls-sidecar.js';
import { NETWORK } from './constants.js';
import { normalizeNodeProxyUrl, redactProxyUrl } from './node-proxy-config.js';

// 代理 Agent 缓存，避免重复创建 Agent 导致连接池失效和内存泄漏
// Map 的插入顺序即 LRU 顺序：命中时移到末尾，超出上限时淘汰最久未用的条目
export const PROXY_AGENT_CACHE_LIMIT = 128;
const agentCache = new Map();

// Evicted agents may still be held by cached clients (e.g. OAuth2Client) or
// in-flight requests. Only close idle keep-alive sockets: active requests finish
// normally, and an agent that is used again simply opens a new connection.
function closeIdleAgentSockets(proxyConfig) {
    for (const agent of new Set([proxyConfig.httpAgent, proxyConfig.httpsAgent])) {
        for (const sockets of Object.values(agent?.freeSockets || {})) {
            for (const socket of sockets) socket.destroy();
        }
    }
}

function cacheProxyAgents(key, proxyConfig) {
    agentCache.set(key, proxyConfig);
    while (agentCache.size > PROXY_AGENT_CACHE_LIMIT) {
        const [oldestKey, oldest] = agentCache.entries().next().value;
        agentCache.delete(oldestKey);
        closeIdleAgentSockets(oldest);
    }
}

/** Test helper: drop all cached agents and close their idle sockets. */
export function clearProxyAgentCache() {
    for (const proxyConfig of agentCache.values()) closeIdleAgentSockets(proxyConfig);
    agentCache.clear();
}

// 用于存储全局通配符代理获取器，解决启动初始化时无请求上下文的问题
let wildcardProxyResolver = null;

/**
 * 注册全局通配符代理获取器
 * @param {Function} resolver 
 */
export function registerWildcardProxyResolver(resolver) {
    wildcardProxyResolver = resolver;
}

/**
 * 从插件或上下文中解析当前节点的代理 URL。
 * 检查 context 或 config 中是否由插件注入了 ipNodeProxy.getProxyUrl 方法。
 *
 * @param {Object} config - 已合并节点配置的请求配置
 * @param {string} providerType - 提供商类型
 * @returns {string|null} 绑定的代理 URL
 */
export function getNodeProxyUrlFromBinding(config = {}, providerType) {
    // 优先从线程级上下文获取（解决提供商实例缓存 config 导致获取不到最新插件方法的问题）
    const contextIpNodeProxy = requestContext.get('ipNodeProxy');
    if (typeof contextIpNodeProxy?.getProxyUrl === 'function') {
        try {
            return contextIpNodeProxy.getProxyUrl(providerType, config?.uuid);
        } catch (error) {
            const nodeName = config?.customName || config?.uuid || 'unknown';
            logger.error(`[Proxy] Error resolving IP proxy binding for ${providerType}/${nodeName}`);
        }
    }

    // 兜底：从 config 获取
    if (typeof config?.ipNodeProxy?.getProxyUrl === 'function') {
        try {
            return config.ipNodeProxy.getProxyUrl(providerType, config.uuid);
        } catch (error) {
            const nodeName = config?.customName || config?.uuid || 'unknown';
            logger.error(`[Proxy] Error resolving configured IP proxy binding for ${providerType}/${nodeName}`);
        }
    }

    // 最后的兜底：如果没有上下文（如项目启动初始化），使用全局通配符 '*'
    if (typeof wildcardProxyResolver === 'function') {
        return wildcardProxyResolver(providerType, config?.uuid);
    }

    return null;
}


/**
 * 解析代理URL并返回相应的代理配置
 * @param {string} proxyUrl - 代理URL，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080
 * @returns {Object|null} 代理配置对象，包含 httpAgent 和 httpsAgent
 */
export function parseProxyUrl(proxyUrl) {
    if (!proxyUrl || typeof proxyUrl !== 'string') {
        return null;
    }

    const trimmedUrl = proxyUrl.trim();
    if (!trimmedUrl) {
        return null;
    }

    // 检查缓存（命中时刷新 LRU 位置）
    const cached = agentCache.get(trimmedUrl);
    if (cached) {
        agentCache.delete(trimmedUrl);
        agentCache.set(trimmedUrl, cached);
        return cached;
    }

    try {
        const url = new URL(trimmedUrl);
        const protocol = url.protocol.toLowerCase();

        // 默认 Agent 配置
        const agentOptions = {
            keepAlive: true,
            maxSockets: 64,        // 每个主机最多 64 个连接（稍微下调，平衡性能与资源）
            maxFreeSockets: 8,     // 最多保留 8 个空闲连接
            timeout: NETWORK.DEFAULT_TIMEOUT
        };

        let result = null;
        if (protocol === 'socks5:' || protocol === 'socks4:' || protocol === 'socks:') {
            // SOCKS 代理
            const socksAgent = new SocksProxyAgent(trimmedUrl, agentOptions);
            result = {
                httpAgent: socksAgent,
                httpsAgent: socksAgent,
                proxyType: 'socks'
            };
        } else if (protocol === 'http:' || protocol === 'https:') {
            // HTTP/HTTPS 代理
            result = {
                httpAgent: new HttpProxyAgent(trimmedUrl, agentOptions),
                httpsAgent: new HttpsProxyAgent(trimmedUrl, agentOptions),
                proxyType: 'http'
            };
        } else {
            logger.warn(`[Proxy] Unsupported proxy protocol: ${protocol}`);
            return null;
        }

        // 存入缓存
        if (result) {
            cacheProxyAgents(trimmedUrl, result);
        }
        return result;
    } catch (error) {
        logger.error('[Proxy] Failed to parse proxy URL');
        return null;
    }
}

/**
 * 检查指定的提供商是否启用了代理（支持前缀匹配）
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用代理
 */
export function isProxyEnabledForProvider(config, providerType) {
    return Boolean(resolveProxyUrlForProvider(config, providerType));
}

/** Resolve one account's proxy without changing the shared global config. */
export function resolveProxyUrlForProvider(config = {}, providerType, options = {}) {
    const nodeProxyUrl = normalizeNodeProxyUrl(config?.NODE_PROXY_URL);
    if (nodeProxyUrl) return nodeProxyUrl;

    const boundProxyUrl = getNodeProxyUrlFromBinding(config, providerType);
    if (boundProxyUrl) return boundProxyUrl;

    // Preserve the existing Sidecar-specific upstream fallback.
    if (options.forSidecar) {
        return config?.TLS_SIDECAR_PROXY_URL || config?.PROXY_URL || null;
    }

    const enabledProviders = config?.PROXY_ENABLED_PROVIDERS;
    if (!config?.PROXY_URL || !Array.isArray(enabledProviders)) return null;
    const enabled = enabledProviders.some(p => typeof p === 'string' &&
        (p === providerType || providerType?.startsWith(p + '-')));
    return enabled ? config.PROXY_URL : null;
}

/**
 * 获取指定提供商的代理配置
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} 代理配置对象或 null
 */
export function getProxyConfigForProvider(config, providerType) {
    const proxyUrl = resolveProxyUrlForProvider(config, providerType);
    if (!proxyUrl) return null;
    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig && normalizeNodeProxyUrl(config?.NODE_PROXY_URL)) {
        throw new Error('Unable to configure the node proxy');
    }
    if (proxyConfig) {
        const nodeName = config?.customName || config?.uuid;
        const nodeDisplay = nodeName ? `${providerType}/${nodeName}` : providerType;
        
        logger.info(`[Proxy] Using ${proxyConfig.proxyType} proxy for ${nodeDisplay}: ${redactProxyUrl(proxyUrl)}`);
    }

    return proxyConfig;
}

/**
 * 为 axios 配置代理
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object} 更新后的 axios 配置
 */
export function configureAxiosProxy(axiosConfig, config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        // 使用代理 agent
        axiosConfig.httpAgent = proxyConfig.httpAgent;
        axiosConfig.httpsAgent = proxyConfig.httpsAgent;
        // 禁用 axios 内置的代理配置，使用我们的 agent
        axiosConfig.proxy = false;
    }

    return axiosConfig;
}

/**
 * 检查指定的提供商是否启用了 TLS Sidecar（支持前缀匹配）
 * @param {Object} config - 配置对象
 * @param {string} providerType - 提供商类型
 * @returns {boolean} 是否启用 TLS Sidecar
 */
export function isTLSSidecarEnabledForProvider(config, providerType) {
    // if (getNodeProxyUrlFromBinding(config, providerType)) {
    //     return true;
    // }

    if (!config || !config.TLS_SIDECAR_ENABLED || !config.TLS_SIDECAR_ENABLED_PROVIDERS) {
        return false;
    }

    const enabledProviders = config.TLS_SIDECAR_ENABLED_PROVIDERS;
    if (!Array.isArray(enabledProviders)) {
        return false;
    }

    // 1. 尝试精确匹配
    if (enabledProviders.includes(providerType)) {
        return true;
    }

    // 2. 尝试前缀匹配
    return enabledProviders.some(p => providerType.startsWith(p + '-'));
}

/**
 * 为 axios 配置 TLS Sidecar
 * @param {Object} axiosConfig - axios 配置对象
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @param {string} [defaultBaseUrl] - 默认基础 URL（用于处理相对路径）
 * @returns {Object} 更新后的 axios 配置
 */
export function configureTLSSidecar(axiosConfig, config, providerType, defaultBaseUrl = null) {
    const sidecar = getTLSSidecar();
    if (sidecar.isReady() && isTLSSidecarEnabledForProvider(config, providerType)) {
        const proxyUrl = resolveProxyUrlForProvider(config, providerType, { forSidecar: true });
        
        // 处理相对路径
        if (axiosConfig.url && !axiosConfig.url.startsWith('http')) {
            const baseUrl = (axiosConfig.baseURL || defaultBaseUrl || '').replace(/\/$/, '');
            if (baseUrl) {
                const path = axiosConfig.url.startsWith('/') ? axiosConfig.url : '/' + axiosConfig.url;
                axiosConfig.url = baseUrl + path;
            }
        }
        
        const nodeName = config?.customName || config?.uuid;
        const nodeDisplay = nodeName ? `${providerType}/${nodeName}` : providerType;
        
        logger.info(`[TLS Sidecar] Using sidecar for ${nodeDisplay}${proxyUrl ? ` (proxy: ${redactProxyUrl(proxyUrl)})` : ''}`);
        
        sidecar.wrapAxiosConfig(axiosConfig, proxyUrl);
    }else{
        // 未启用 TLS Sidecar，直接使用全局代理
        configureAxiosProxy(axiosConfig, config, providerType);
    }
    return axiosConfig;
}

/**
 * 为 google-auth-library 配置代理
 * @param {Object} config - 应用配置对象
 * @param {string} providerType - 提供商类型
 * @returns {Object|null} transporter 配置对象或 null
 */
export function getGoogleAuthProxyConfig(config, providerType) {
    const proxyConfig = getProxyConfigForProvider(config, providerType);

    if (proxyConfig) {
        return {
            agent: proxyConfig.httpsAgent
        };
    }

    return null;
}
