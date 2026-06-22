export const DEFAULT_CONFIG = {
    accountSelectionStrategy: "sticky",
    debug: false,
    quietMode: false,
    pidOffsetEnabled: false,
    proactiveRefreshThresholdMs: 5 * 60 * 1000, // 5 min
    removeOnInvalidGrant: true,
    perModelRateLimits: true,
    rateLimitCooldownMs: 60_000,
};
/** Merge partial config with defaults */
export function resolveConfig(partial) {
    return { ...DEFAULT_CONFIG, ...partial };
}
//# sourceMappingURL=types.js.map