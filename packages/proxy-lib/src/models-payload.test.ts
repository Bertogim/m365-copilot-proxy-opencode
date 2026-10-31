import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildModelsPayload } from "./index.js";

const example = JSON.parse(
  readFileSync(new URL("../../../examples/opencode.jsonc", import.meta.url), "utf8"),
);

describe("examples/opencode.jsonc", () => {
  const advertised = new Map(buildModelsPayload().data.map(model => [model.id, model]));
  const models = example.provider.m365.models as Record<string, {
    limit: { context: number; output: number };
  }>;

  it("includes exactly the models the proxy serves", () => {
    expect(new Set(Object.keys(models))).toEqual(new Set(advertised.keys()));
  });

  it("keeps limit in step with /v1/models (meter and auto-compaction accuracy)", () => {
    for (const [id, model] of Object.entries(models)) {
      const served = advertised.get(id)!;
      expect(model.limit.context, id).toBe(served.context_window);
      expect(model.limit.output, id).toBe(served.max_output_tokens);
    }
  });

  it("points at the local OpenAI-compatible endpoint", () => {
    expect(example.provider.m365.npm).toBe("@ai-sdk/openai-compatible");
    expect(example.provider.m365.options.baseURL).toBe("http://127.0.0.1:4141/v1");
  });
});
