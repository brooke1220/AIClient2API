// getUsageLimits 返回的额度分三类：每月重置的基础额度、免费试用、奖励。
// 基础额度用完后试用和奖励仍可用，判断"额度耗尽"必须把三者合起来算。

// 额度带两位小数精度，低于此值视为已用完。
export const KIRO_CREDIT_EPSILON = 0.01;

// Kiro 时间戳是秒级浮点数，兼容毫秒和 ISO 字符串。
function toMs(ts) {
    if (ts === null || ts === undefined || ts === '') return null;
    if (typeof ts === 'number') return ts < 10000000000 ? ts * 1000 : ts;
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? null : parsed;
}

// Preserve the precision actually supplied by the API, including sub-cent
// amounts, while removing binary subtraction/addition noise at that precision.
function decimalPlaces(value) {
    const [coefficient, exponent = '0'] = String(value).split('e');
    return Math.min(100, Math.max(0, (coefficient.split('.')[1]?.length ?? 0) - Number(exponent)));
}

function remainingOf(grant) {
    const used = Number(grant.currentUsageWithPrecision ?? grant.currentUsage ?? 0);
    const limit = Number(grant.usageLimitWithPrecision ?? grant.usageLimit ?? 0);
    if (!Number.isFinite(used) || !Number.isFinite(limit)) return 0;
    const precision = Math.max(decimalPlaces(used), decimalPlaces(limit));
    return Math.max(0, Number((limit - used).toFixed(precision)));
}

function isActiveGrant(status, expiresAt, now) {
    if (status === 'EXPIRED') return false;
    const expiresMs = toMs(expiresAt);
    return expiresMs === null || expiresMs > now;
}

/**
 * 汇总当前仍可用的剩余额度（基础 + 未过期的试用 + 未过期的奖励）。
 * @returns {number|null} 剩余额度；响应里没有 usageBreakdownList 时返回 null（无法判断）。
 */
export function getKiroRemainingCredits(usageLimits, now = Date.now()) {
    const breakdownList = usageLimits?.usageBreakdownList;
    if (!Array.isArray(breakdownList) || breakdownList.length === 0) return null;

    let remaining = 0;
    let precision = 0;
    const addRemaining = grant => {
        const amount = remainingOf(grant);
        remaining += amount;
        precision = Math.max(precision, decimalPlaces(amount));
    };
    for (const breakdown of breakdownList) {
        if (!breakdown) continue;
        addRemaining(breakdown);
        const ft = breakdown.freeTrialInfo;
        if (ft && isActiveGrant(ft.freeTrialStatus, ft.freeTrialExpiry, now)) {
            addRemaining(ft);
        }
        if (Array.isArray(breakdown.bonuses)) {
            for (const bonus of breakdown.bonuses) {
                if (bonus && isActiveGrant(bonus.status, bonus.expiresAt, now)) {
                    addRemaining(bonus);
                }
            }
        }
    }
    return Number(remaining.toFixed(precision));
}
