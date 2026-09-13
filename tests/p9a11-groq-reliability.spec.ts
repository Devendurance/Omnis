import { expect, test } from "@playwright/test";

import { CONVERSATIONAL_PROPOSAL_JSON_SCHEMA } from "../src/lib/conversation/schema";
import { interpretConversation } from "../src/lib/conversation/interpreter";
import {
  createGroqModel,
  createOpenAiCompatibleModel,
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

async function captureGroqBody(model: string): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
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

function expectReliableTransport(body: Record<string, unknown>): void {
  const format = body.response_format as Record<string, unknown>;
  expect(format.type).toBe("json_schema");
  const inner = format.json_schema as Record<string, unknown>;
  expect(inner.strict).toBe(true);
  expect(inner.schema).toEqual(CONVERSATIONAL_PROPOSAL_JSON_SCHEMA);
  expect(body.reasoning_effort).toBe("low");
  expect(body.max_completion_tokens).toBe(2048);
  expect(body.include_reasoning).toBe(false);
  expect("reasoning_format" in body).toBe(false);
  expect("max_tokens" in body).toBe(false);
}

test("P9A.11 groq 20B uses low reasoning with 2048 completion ceiling", async () => {
  expectReliableTransport(await captureGroqBody("openai/gpt-oss-20b"));
});

test("P9A.11 groq 120B uses the same reliable transport settings", async () => {
  const body120 = await captureGroqBody("openai/gpt-oss-120b");
  const body20 = await captureGroqBody("openai/gpt-oss-20b");
  expectReliableTransport(body120);
  expect(body120.reasoning_effort).toBe(body20.reasoning_effort);
  expect(body120.max_completion_tokens).toBe(body20.max_completion_tokens);
  expect(body120.include_reasoning).toBe(body20.include_reasoning);
});

test("P9A.11 groq transport never exposes reasoning", async () => {
  for (const model of ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]) {
    const body = await captureGroqBody(model);
    expect(body.include_reasoning).toBe(false);
    expect("reasoning_format" in body).toBe(false);
  }
});

test("P9A.11 unrelated providers keep legacy transport", async () => {
  const originalFetch = globalThis.fetch;
  let compatBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    compatBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return chatCompletionResponse(validProposal());
  }) as typeof fetch;
  try {
    await createOpenAiCompatibleModel({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "test-key",
      model: "gpt-4o-mini",
    }).generate({
      messages: [{ role: "user", content: "hello" }],
      taskContext: {},
      availableCapabilities: ["wallet_check"],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(compatBody.response_format).toEqual({ type: "json_object" });
  expect(compatBody.max_tokens).toBe(800);
  expect("reasoning_effort" in compatBody).toBe(false);
  expect("include_reasoning" in compatBody).toBe(false);
  expect("max_completion_tokens" in compatBody).toBe(false);

  const otherGroq = await captureGroqBody("llama-3.3-70b-versatile");
  expect(otherGroq.response_format).toEqual({ type: "json_object" });
  expect(otherGroq.max_tokens).toBe(800);
  expect("reasoning_effort" in otherGroq).toBe(false);
  expect("include_reasoning" in otherGroq).toBe(false);
  expect("max_completion_tokens" in otherGroq).toBe(false);
});

test("P9A.11 generation failure falls back safely without promotion", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    seenUrls.push(String(url));
    return new Response(
      JSON.stringify({
        error: { message: "json validation failed", type: "invalid_request_error", code: "json_validate_failed" },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const model = createGroqModel({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "test-groq-key",
      model: "openai/gpt-oss-20b",
    });
    const { payload, log } = await interpretConversation(
      { userText: "Pay 0.2 USDC to mark.", messages: [] },
      model,
    );
    expect(payload.fallback).toBe(true);
    expect(payload.proposal).toBeUndefined();
    expect(payload.promotedIntent).toBeUndefined();
    expect(log.schemaOk).toBe(false);
    expect(log.reconcileOutcome).toBe("fallback");
    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain("api.groq.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
