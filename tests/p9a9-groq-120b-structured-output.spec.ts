import { expect, test } from "@playwright/test";

import { CONVERSATIONAL_PROPOSAL_JSON_SCHEMA } from "../src/lib/conversation/schema";
import {
  createGroqModel,
  GROQ_STRUCTURED_OUTPUT_MODELS,
  resolveGroqConfig,
  selectConversationalModel,
  usesGroqStructuredOutput,
} from "../src/lib/conversation/provider";

function chatCompletionResponse(proposal: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ message: { role: "assistant", content: JSON.stringify(proposal) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function validProposal(): Record<string, unknown> {
  return {
    assistantMessage: "ok",
    intent: "status",
    proposedActions: [],
    clarification: { required: false, question: null },
    extractedHints: {},
  };
}

async function captureBody(model: string) {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return chatCompletionResponse(validProposal());
  }) as typeof fetch;
  try {
    await createGroqModel({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "test-groq-key",
      model,
    }).generate({
      messages: [{ role: "user", content: "hello" }],
      taskContext: {},
      availableCapabilities: ["wallet_check"],
    });
    return body;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("P9A.9 strict output applies to groq 20b", () => {
  expect(usesGroqStructuredOutput("groq", "openai/gpt-oss-20b")).toBe(true);
});

test("P9A.9 strict output applies to groq 120b", () => {
  expect(usesGroqStructuredOutput("groq", "openai/gpt-oss-120b")).toBe(true);
});

test("P9A.9 non-supported groq model remains json_object", () => {
  expect(usesGroqStructuredOutput("groq", "llama-3.3-70b-versatile")).toBe(false);
  expect(usesGroqStructuredOutput("groq", "openai/gpt-oss-70b")).toBe(false);
  expect(usesGroqStructuredOutput("openai-compatible", "openai/gpt-oss-120b")).toBe(false);
});

test("P9A.9 both models send same schema with low reasoning budget", async () => {
  const body20 = await captureBody("openai/gpt-oss-20b");
  const body120 = await captureBody("openai/gpt-oss-120b");
  for (const body of [body20, body120]) {
    const format = body.response_format as Record<string, unknown>;
    expect(format.type).toBe("json_schema");
    const inner = format.json_schema as Record<string, unknown>;
    expect(inner.name).toBe("conversational_proposal");
    expect(inner.strict).toBe(true);
    expect(inner.schema).toEqual(CONVERSATIONAL_PROPOSAL_JSON_SCHEMA);
    // P9A.11: low reasoning plus 2048 completion ceiling; no reasoning exposure.
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.include_reasoning).toBe(false);
    expect("reasoning_format" in body).toBe(false);
    expect("max_tokens" in body).toBe(false);
    expect(body.model).toBeDefined();
  }
  const format20 = body20.response_format as Record<string, unknown>;
  const format120 = body120.response_format as Record<string, unknown>;
  expect(format120).toEqual(format20);
  expect(GROQ_STRUCTURED_OUTPUT_MODELS).toEqual(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
});
test("P9A.9 non-supported groq model keeps json_object without reasoning", async () => {
  const body = await captureBody("llama-3.3-70b-versatile");
  expect(body.response_format).toEqual({ type: "json_object" });
  expect("reasoning_format" in body).toBe(false);
  expect("reasoning_effort" in body).toBe(false);
  expect("include_reasoning" in body).toBe(false);
  expect("max_completion_tokens" in body).toBe(false);
});

test("P9A.9 provider selection remains env-driven with no financial writes", async () => {
  const resolved = resolveGroqConfig({
    OMNIS_LLM_PROVIDER: "groq",
    OMNIS_LLM_API_KEY: "test-key",
    OMNIS_LLM_MODEL: "openai/gpt-oss-120b",
  });
  expect(resolved?.model).toBe("openai/gpt-oss-120b");
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    urls.push(String(url));
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(String(body.model)).toBe("openai/gpt-oss-120b");
    return chatCompletionResponse(validProposal());
  }) as typeof fetch;
  try {
    const selected = selectConversationalModel({
      OMNIS_LLM_PROVIDER: "groq",
      OMNIS_LLM_API_KEY: "test-key",
      OMNIS_LLM_MODEL: "openai/gpt-oss-120b",
    });
    expect(selected.model).toBe("openai/gpt-oss-120b");
    await selected.generate({
      messages: [{ role: "user", content: "hello" }],
      taskContext: {},
      availableCapabilities: ["wallet_check"],
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/chat/completions");
    for (const url of urls) {
      expect(url).not.toContain("blocky402");
      expect(url).not.toContain("arc");
      expect(url).not.toContain("circle");
      expect(url).not.toContain("service-purchase");
      expect(url).not.toContain("settle");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("P9A.9 groq generation issues exactly one scoped request per model", async () => {
  const seen: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    seen.push(String(url));
    return chatCompletionResponse(validProposal());
  }) as typeof fetch;
  try {
    for (const model of ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]) {
      seen.length = 0;
      await createGroqModel({
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: "test-groq-key",
        model,
      }).generate({
        messages: [{ role: "user", content: "hello" }],
        taskContext: {},
        availableCapabilities: ["wallet_check"],
      });
      expect(seen).toEqual(["https://api.groq.com/openai/v1/chat/completions"]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
