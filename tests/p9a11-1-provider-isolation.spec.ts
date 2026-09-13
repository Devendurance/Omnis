import { expect, test } from "@playwright/test";

import { CONVERSATIONAL_PROPOSAL_JSON_SCHEMA } from "../src/lib/conversation/schema";
import {
  createGroqModel,
  createOpenAiCompatibleModel,
} from "../src/lib/conversation/provider";

// P9A.11.1: provider parameter isolation. GPT-OSS wire fields must not leak
// into unrelated providers, and legacy fields must not leak into GPT-OSS.
// All bodies are captured from a mocked fetch: no real external calls.

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

type Captured = { url: string; body: Record<string, unknown> };

async function captureBody(
  makeModel: () => { generate: (input: never) => Promise<unknown> },
): Promise<Captured> {
  const originalFetch = globalThis.fetch;
  let captured: Captured = { url: "", body: {} };
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    captured = {
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return chatCompletionResponse(validProposal());
  }) as typeof fetch;
  try {
    await makeModel().generate({
      messages: [{ role: "user", content: "hello" }],
      taskContext: {},
      availableCapabilities: ["wallet_check"],
    } as never);
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function messageRoles(body: Record<string, unknown>): unknown {
  return (body.messages as Array<Record<string, unknown>>).map((m) => m.role);
}

const GPT_OSS_KEYS = [
  "include_reasoning",
  "max_completion_tokens",
  "messages",
  "model",
  "reasoning_effort",
  "response_format",
  "temperature",
];

const LEGACY_KEYS = ["max_tokens", "messages", "model", "response_format", "temperature"];

function expectGptOssBody(body: Record<string, unknown>, model: string): void {
  expect(Object.keys(body).sort()).toEqual(GPT_OSS_KEYS);
  expect(body.model).toBe(model);
  expect(body.temperature).toBe(0.2);
  expect(body.max_completion_tokens).toBe(2048);
  expect(body.reasoning_effort).toBe("low");
  expect(body.include_reasoning).toBe(false);
  expect(body.response_format).toEqual({
    type: "json_schema",
    json_schema: {
      name: "conversational_proposal",
      strict: true,
      schema: CONVERSATIONAL_PROPOSAL_JSON_SCHEMA,
    },
  });
  expect(messageRoles(body)).toEqual(["system", "system", "user"]);
}

function expectLegacyBody(body: Record<string, unknown>, model: string): void {
  expect(Object.keys(body).sort()).toEqual(LEGACY_KEYS);
  expect(body.model).toBe(model);
  expect(body.temperature).toBe(0.2);
  expect(body.max_tokens).toBe(800);
  expect(body.response_format).toEqual({ type: "json_object" });
  expect(messageRoles(body)).toEqual(["system", "system", "user"]);
}

test("P9A.11.1 groq 20B sends the exact GPT-OSS body", async () => {
  const { url, body } = await captureBody(() =>
    createGroqModel({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "test-groq-key",
      model: "openai/gpt-oss-20b",
    }),
  );
  expect(url).toContain("api.groq.com");
  expectGptOssBody(body, "openai/gpt-oss-20b");
});

test("P9A.11.1 groq 120B sends the identical GPT-OSS body", async () => {
  const first = await captureBody(() =>
    createGroqModel({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "test-groq-key",
      model: "openai/gpt-oss-120b",
    }),
  );
  const second = await captureBody(() =>
    createGroqModel({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "test-groq-key",
      model: "openai/gpt-oss-20b",
    }),
  );
  expect(first.url).toContain("api.groq.com");
  expectGptOssBody(first.body, "openai/gpt-oss-120b");
  expect(first.body).toEqual({ ...second.body, model: "openai/gpt-oss-120b" });
});

test("P9A.11.1 non-target groq model keeps the exact legacy body", async () => {
  const { url, body } = await captureBody(() =>
    createGroqModel({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "test-groq-key",
      model: "llama-3.3-70b-versatile",
    }),
  );
  expect(url).toContain("api.groq.com");
  expectLegacyBody(body, "llama-3.3-70b-versatile");
});

test("P9A.11.1 openai-compatible provider keeps the exact legacy body", async () => {
  const { url, body } = await captureBody(() =>
    createOpenAiCompatibleModel({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o-mini",
    }),
  );
  expect(url).toContain("api.openai.com");
  expectLegacyBody(body, "gpt-4o-mini");
});

test("P9A.11.1 gpt-oss model name on the compat provider stays legacy", async () => {
  const { body } = await captureBody(() =>
    createOpenAiCompatibleModel({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "openai/gpt-oss-20b",
    }),
  );
  expectLegacyBody(body, "openai/gpt-oss-20b");
});
