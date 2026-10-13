jest.mock('../src/providers/openai/openai-responses-core.js', () => ({ OpenAIResponsesApiService: jest.fn() }));
jest.mock('../src/providers/gemini/gemini-core.js', () => ({ GeminiApiService: jest.fn() }));
jest.mock('../src/providers/gemini/antigravity-core.js', () => ({ AntigravityApiService: jest.fn() }));
jest.mock('../src/providers/openai/openai-core.js', () => ({ OpenAIApiService: jest.fn() }));
jest.mock('../src/providers/claude/claude-core.js', () => ({ ClaudeApiService: jest.fn() }));
jest.mock('../src/providers/claude/claude-kiro.js', () => ({ KiroApiService: jest.fn() }));
jest.mock('../src/providers/openai/qwen-core.js', () => ({ QwenApiService: jest.fn() }));
jest.mock('../src/providers/openai/iflow-core.js', () => ({ IFlowApiService: jest.fn() }));
jest.mock('../src/providers/openai/codex-core.js', () => ({ CodexApiService: jest.fn() }));
jest.mock('../src/providers/forward/forward-core.js', () => ({ ForwardApiService: jest.fn() }));
jest.mock('../src/providers/grok/grok-core.js', () => ({ GrokApiService: jest.fn() }));
jest.mock('../src/providers/grok/grok-cli-core.js', () => ({ GrokCliApiService: jest.fn() }));
jest.mock('../src/providers/github/github-copilot-core.js', () => ({ GitHubCopilotApiService: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

import {
    disposeServiceAdapters,
    getServiceAdapter,
    getServiceInstanceKey,
    GitHubCopilotApiServiceAdapter,
    invalidateAllServiceAdapters,
    invalidateServiceAdapter,
    registerAdapter,
    serviceInstances
} from '../src/providers/adapter.js';
import { GitHubCopilotApiService } from '../src/providers/github/github-copilot-core.js';

const providerType = 'test-node-proxy';

describe('provider instance retirement', () => {
    afterEach(async () => {
        await disposeServiceAdapters({ force: true });
        jest.clearAllMocks();
    });

    test('a saved proxy change creates a new instance while the previous one drains', async () => {
        let complete;
        const drained = new Promise(resolve => { complete = resolve; });
        const dispose = jest.fn(() => drained);
        registerAdapter(providerType, class {
            constructor(config) { this.config = config; this.dispose = dispose; }
        });
        const previous = getServiceAdapter({ MODEL_PROVIDER: providerType, uuid: 'account-a', NODE_PROXY_URL: 'http://proxy-a:8080' });
        expect(invalidateServiceAdapter(providerType, 'account-a')).toBe(true);
        expect(dispose).toHaveBeenCalledWith({});

        const replacement = getServiceAdapter({ MODEL_PROVIDER: providerType, uuid: 'account-a', NODE_PROXY_URL: null });
        expect(replacement).not.toBe(previous);
        expect(replacement.config.NODE_PROXY_URL).toBeNull();
        expect(previous.config.NODE_PROXY_URL).toBe('http://proxy-a:8080');
        complete();
        await drained;
    });

    test('shutdown forces cleanup of an instance already retired by reload', async () => {
        let complete;
        const pending = new Promise(resolve => { complete = resolve; });
        const adapter = {
            dispose: jest.fn(({ force } = {}) => {
                if (force) complete();
                return pending;
            })
        };
        serviceInstances[getServiceInstanceKey(providerType, 'old')] = adapter;
        invalidateAllServiceAdapters();
        expect(Object.keys(serviceInstances)).toHaveLength(0);
        expect(adapter.dispose).toHaveBeenCalledTimes(1);

        await disposeServiceAdapters({ force: true });
        expect(adapter.dispose).toHaveBeenLastCalledWith({ force: true });
    });

    test('reload retires every account and tolerates providers without external resources', async () => {
        const first = { dispose: jest.fn().mockResolvedValue(undefined) };
        const second = { dispose: jest.fn().mockResolvedValue(undefined) };
        serviceInstances.a = first;
        serviceInstances.b = second;
        serviceInstances.legacy = {};
        invalidateAllServiceAdapters();
        expect(Object.keys(serviceInstances)).toHaveLength(0);
        expect(first.dispose).toHaveBeenCalledTimes(1);
        expect(second.dispose).toHaveBeenCalledTimes(1);
        await disposeServiceAdapters();
    });

    test('cleanup failure does not prevent removing an old proxy instance', async () => {
        serviceInstances[getServiceInstanceKey(providerType, 'broken')] = {
            dispose() { throw new Error('cleanup failed'); }
        };
        expect(invalidateServiceAdapter(providerType, 'broken')).toBe(true);
        expect(invalidateServiceAdapter(providerType, 'broken')).toBe(false);
        await expect(disposeServiceAdapters()).resolves.toBeUndefined();
    });

    test('Copilot adapter forwards disposal options to its service', async () => {
        const dispose = jest.fn().mockResolvedValue(undefined);
        GitHubCopilotApiService.mockImplementation(() => ({ dispose }));
        const adapter = new GitHubCopilotApiServiceAdapter({ uuid: 'copilot' });
        await adapter.dispose({ force: true });
        expect(dispose).toHaveBeenCalledWith({ force: true });
    });

    test('terminal shutdown prevents late request handlers from starting another client', async () => {
        await jest.isolateModulesAsync(async () => {
            const isolated = await import('../src/providers/adapter.js');
            const constructor = jest.fn();
            isolated.registerAdapter(providerType, constructor);
            await isolated.disposeServiceAdapters({ force: true, shutdown: true });
            expect(() => isolated.getServiceAdapter({ MODEL_PROVIDER: providerType, uuid: 'late-request' }))
                .toThrow('Provider services are shutting down');
            expect(constructor).not.toHaveBeenCalled();
            expect(Object.keys(isolated.serviceInstances)).toHaveLength(0);
        });
    });
});
