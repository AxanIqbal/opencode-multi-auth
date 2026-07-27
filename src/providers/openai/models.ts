export const REASONING_VARIANTS = ["low", "medium", "high", "xhigh"] as const;
const REASONING_VARIANT_CONFIG = Object.fromEntries(
  REASONING_VARIANTS.map((effort) => [effort, { reasoningEffort: effort }]),
);

const CODEX_MODELS = [
  "gpt-5.6-terra-fast", "gpt-5.6-terra", "gpt-5.6-sol-fast", "gpt-5.6-sol", "gpt-5.6-luna-fast", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-mini", "codex-auto-review",
];

export function registerOpenAIModels(models: Record<string, unknown>): void {
  for (const id of CODEX_MODELS) {
    if (!models[id]) {
      models[id] = { name: id };
    }
    if (id.startsWith("gpt-")) {
      const model = models[id] as Record<string, unknown> & {
        variants?: Record<string, Record<string, unknown>>;
      };
      model.variants = {
        ...(model.variants ?? {}),
        ...REASONING_VARIANT_CONFIG,
      };
    }
  }
}
