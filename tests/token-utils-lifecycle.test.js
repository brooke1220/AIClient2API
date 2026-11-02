import { jest } from '@jest/globals';
jest.mock('@anthropic-ai/tokenizer', () => ({ getTokenizer: jest.fn() }));
jest.mock('../src/utils/logger.js', () => ({ __esModule: true, default: { warn: jest.fn() } }));
import { getTokenizer } from '@anthropic-ai/tokenizer';
import { countTextTokens, warmupTokenizer, disposeTokenizer } from '../src/utils/token-utils.js';

beforeEach(() => { disposeTokenizer(); jest.clearAllMocks(); });
afterAll(disposeTokenizer);
const encoder = () => ({ encode: jest.fn(() => [1, 2]), free: jest.fn() });

test('warmup and repeated counts share one encoder until disposal', () => {
    const first = encoder(), second = encoder();
    getTokenizer.mockReturnValueOnce(first).mockReturnValueOnce(second);
    warmupTokenizer();
    expect(countTextTokens('ﬃ')).toBe(2);
    expect(countTextTokens('中文')).toBe(2);
    expect(first.encode).toHaveBeenNthCalledWith(1, 'ffi', 'all');
    expect(first.encode).toHaveBeenNthCalledWith(2, '中文', 'all');
    expect(getTokenizer).toHaveBeenCalledTimes(1);
    expect(first.free).not.toHaveBeenCalled();
    disposeTokenizer(); disposeTokenizer();
    expect(first.free).toHaveBeenCalledTimes(1);
    expect(countTextTokens('again')).toBe(2);
    expect(getTokenizer).toHaveBeenCalledTimes(2);
});

test('a failed encoder keeps the old estimate and is recreated on next use', () => {
    const failed = encoder(), healthy = encoder();
    failed.encode.mockImplementation(() => { throw new Error('encoding failed'); });
    failed.free.mockImplementation(() => { throw new Error('free failed'); });
    getTokenizer.mockReturnValueOnce(failed).mockReturnValueOnce(healthy);
    expect(countTextTokens('123456789')).toBe(3);
    expect(failed.free).toHaveBeenCalledTimes(1);
    expect(countTextTokens('recovered')).toBe(2);
});

test('failed startup warmup allows lazy retry and empty text allocates nothing', () => {
    getTokenizer.mockImplementationOnce(() => { throw new Error('startup failure'); }).mockReturnValueOnce(encoder());
    expect(countTextTokens('')).toBe(0);
    expect(getTokenizer).not.toHaveBeenCalled();
    expect(() => warmupTokenizer()).not.toThrow();
    expect(countTextTokens('later')).toBe(2);
    expect(getTokenizer).toHaveBeenCalledTimes(2);
});
