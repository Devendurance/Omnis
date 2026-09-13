import { expect, test } from "@playwright/test";

import {
  CONVERSATIONAL_PROPOSAL_JSON_SCHEMA,
  validateConversationalProposal,
} from "../src/lib/conversation/schema";
import {
  createGroqModel,
  createOpenAiCompatibleModel,
  ModelOutputError,
  usesGroqStructuredOutput,
} from "../src/lib/conversation/provider";

const GROQ_CONFIG = Object.freeze({
  baseUrl: "https://api.groq.com/openai/v1",
  apiKey: "test-groq-key",
  model: "openai/gpt-oss-20b",
});

function chatCompletionResponse(proposal: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ message: { role: "assistant", content: JSON.stringify(proposal) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function generateWithMockedProposal(proposal: unknown) {
  const originalFetch = globalThis.fetch;
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return chatCompletionResponse(proposal);
  }) as typeof fetch;
  try {
    const result = await createGroqModel({ ...GROQ_CONFIG }).generate({
      messages: [{ role: "user", content: "hello" }],
      taskContext: {},
      availableCapabilities: ["wallet_check"],
    });
    return { result, seen };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("P9A.5 request uses strict json_schema with low reasoning budget", async () => {
  const { seen } = await generateWithMockedProposal({
    assistantMessage: "ok",
    intent: "status",
    proposedActions: [],
    clarification: { required: false, question: null },
    extractedHints: { recipient: null, paymentAmount: null, asset: null, serviceBudget: null },
  });
  expect(seen).toHaveLength(1);
  const format = seen[0].body.response_format as Record<string, unknown>;
  expect(format.type).toBe("json_schema");
  const inner = format.json_schema as Record<string, unknown>;
  expect(inner.name).toBe("conversational_proposal");
  expect(inner.strict).toBe(true);
  expect(inner.schema).toEqual(CONVERSATIONAL_PROPOSAL_JSON_SCHEMA);
  // P9A.11: low reasoning plus 2048 completion ceiling; chain-of-thought
  // hidden via include_reasoning:false (mutually exclusive with reasoning_format).
  expect(seen[0].body.reasoning_effort).toBe("low");
  expect(seen[0].body.max_completion_tokens).toBe(2048);
  expect(seen[0].body.include_reasoning).toBe(false);
  expect("reasoning_format" in seen[0].body).toBe(false);
  expect("max_tokens" in seen[0].body).toBe(false);
});

test("P9A.5 openai-compatible transport keeps json_object", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return chatCompletionResponse({
      assistantMessage: "ok",
      intent: "status",
      proposedActions: [],
      clarification: { required: false, question: null },
      extractedHints: {},
    });
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
    expect(body.response_format).toEqual({ type: "json_object" });
    expect("reasoning_format" in body).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P9A.5 strict output applies only to the target groq model", () => {
  expect(usesGroqStructuredOutput("groq", "openai/gpt-oss-20b")).toBe(true);
  expect(usesGroqStructuredOutput("groq", "llama-3.3-70b-versatile")).toBe(false);
  expect(usesGroqStructuredOutput("openai-compatible", "openai/gpt-oss-20b")).toBe(false);
});

test("P9A.5 non-target groq model keeps json_object without reasoning", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return chatCompletionResponse({
      assistantMessage: "ok",
      intent: "status",
      proposedActions: [],
      clarification: { required: false, question: null },
      extractedHints: {},
    });
  }) as typeof fetch;
  try {
    await createGroqModel({
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: "test-groq-key",
      model: "llama-3.3-70b-versatile",
    }).generate({
      messages: [{ role: "user", content: "hello" }],
      taskContext: {},
      availableCapabilities: ["wallet_check"],
    });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect("reasoning_format" in body).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("P9A.5 schema requires extractedHints object with nullable text members", () => {
  const schema = CONVERSATIONAL_PROPOSAL_JSON_SCHEMA as unknown as {
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
  const hints = schema.properties.extractedHints as {
    type: string;
    required: string[];
    properties: Record<string, unknown>;
  };
  expect(hints.type).toBe("object");
  expect(hints.required).toEqual(["recipient", "paymentAmount", "asset", "serviceBudget"]);
  for (const key of ["recipient", "paymentAmount", "asset", "serviceBudget"]) {
    expect(hints.properties[key]).toEqual({ type: ["string", "null"] });
  }
});

test("P9A.5 A: full flagship instruction validates", async () => {
  const { result } = await generateWithMockedProposal({
    assistantMessage: "i can do that. i will check the wallet before preparing the payment.",
    intent: "pay_with_check",
    proposedActions: [{ type: "wallet_check" }],
    clarification: { required: false, question: null },
    extractedHints: {
      recipient: "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7",
      paymentAmount: "0.10 USDC",
      asset: "USDC",
      serviceBudget: "$0.05",
    },
  });
  expect(result.provider).toBe("groq");
  expect(result.proposal.intent).toBe("pay_with_check");
  expect(result.proposal.extractedHints).toEqual({
    recipient: "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7",
    paymentAmount: "0.10 USDC",
    asset: "USDC",
    serviceBudget: "$0.05",
  });
});

test("P9A.5 B: correction to 0.20 validates", async () => {
  const { result } = await generateWithMockedProposal({
    assistantMessage: "got it. i updated the plan to 0.20.",
    intent: "pay_with_check",
    proposedActions: [{ type: "wallet_check" }],
    clarification: { required: false, question: null },
    extractedHints: {
      recipient: "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7",
      paymentAmount: "0.20 USDC",
      asset: "USDC",
      serviceBudget: "$0.05",
    },
  });
  expect(result.proposal.extractedHints.paymentAmount).toBe("0.20 USDC");
});

test("P9A.5 C: send him 20 validates as text", async () => {
  const { result } = await generateWithMockedProposal({
    assistantMessage: "got it. i updated the plan to 20.",
    intent: "pay_with_check",
    proposedActions: [{ type: "wallet_check" }],
    clarification: { required: false, question: null },
    extractedHints: {
      recipient: "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7",
      paymentAmount: "20 USDC",
      asset: "USDC",
      serviceBudget: "$0.05",
    },
  });
  expect(typeof result.proposal.extractedHints.paymentAmount).toBe("string");
});

test("P9A.5 D: no hints available validates with nulls", async () => {
  const { result } = await generateWithMockedProposal({
    assistantMessage: "tell me what needs to get paid and i will prepare a plan.",
    intent: "clarify",
    proposedActions: [],
    clarification: { required: true, question: "what should i pay?" },
    extractedHints: { recipient: null, paymentAmount: null, asset: null, serviceBudget: null },
  });
  expect(result.proposal.intent).toBe("clarify");
  expect(result.proposal.extractedHints).toEqual({});
});

test("P9A.5 E: clarification required validates", async () => {
  const { result } = await generateWithMockedProposal({
    assistantMessage: "which wallet should i check?",
    intent: "clarify",
    proposedActions: [],
    clarification: { required: true, question: "which wallet should i check?" },
    extractedHints: { recipient: null, paymentAmount: null, asset: null, serviceBudget: null },
  });
  expect(result.proposal.clarification).toEqual({
    required: true,
    question: "which wallet should i check?",
  });
});

test("P9A.5 validator stays strict on nulls, adapter normalizes wire nulls", async () => {
  const direct = validateConversationalProposal({
    assistantMessage: "ok",
    intent: "status",
    proposedActions: [],
    clarification: { required: false, question: null },
    extractedHints: { recipient: null, paymentAmount: null, asset: null, serviceBudget: null },
  });
  expect(direct.ok).toBe(false);
  if (!direct.ok) expect(direct.error).toBe("extractedHints entries must be text");
  const { result } = await generateWithMockedProposal({
    assistantMessage: "ok",
    intent: "status",
    proposedActions: [],
    clarification: { required: false, question: null },
    extractedHints: { recipient: null, paymentAmount: null, asset: null, serviceBudget: null },
  });
  expect(result.proposal.extractedHints).toEqual({});
  const numeric = validateConversationalProposal({
    assistantMessage: "ok",
    intent: "status",
    proposedActions: [],
    clarification: { required: false, question: null },
    extractedHints: { recipient: null, paymentAmount: 0.2, asset: null, serviceBudget: null },
  });
  expect(numeric.ok).toBe(false);
  if (!numeric.ok) expect(numeric.error).toBe("extractedHints entries must be text");
  const arrayShape = validateConversationalProposal({
    assistantMessage: "ok",
    intent: "status",
    proposedActions: [],
    clarification: { required: false, question: null },
    extractedHints: [],
  });
  expect(arrayShape.ok).toBe(false);
  if (!arrayShape.ok) expect(arrayShape.error).toBe("extractedHints must be an object");
});
test("P9A.5 malformed extractedHints shapes fail closed", async () => {
  const malformed = [
    {
      assistantMessage: "ok",
      intent: "status",
      proposedActions: [],
      clarification: { required: false, question: null },
      extractedHints: ["0xabc"],
    },
    {
      assistantMessage: "ok",
      intent: "status",
      proposedActions: [],
      clarification: { required: false, question: null },
      extractedHints: null,
    },
    {
      assistantMessage: "ok",
      intent: "status",
      proposedActions: [],
      clarification: { required: false, question: null },
      extractedHints: { recipient: null, paymentAmount: 20, asset: null, serviceBudget: null },
    },
    {
      assistantMessage: "ok",
      intent: "status",
      proposedActions: [],
      clarification: { required: false, question: null },
      extractedHints: {
        recipient: null,
        paymentAmount: ["20 USDC"],
        asset: null,
        serviceBudget: null,
      },
    },
  ];
  for (const proposal of malformed) {
    await expect(generateWithMockedProposal(proposal)).rejects.toBeInstanceOf(ModelOutputError);
  }
});
