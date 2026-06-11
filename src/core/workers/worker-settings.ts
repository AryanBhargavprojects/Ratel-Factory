export function createWorkerSessionSettings() {
  return {
    compaction: {
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    },
    retry: {
      enabled: true,
      maxRetries: 2,
    },
  };
}
