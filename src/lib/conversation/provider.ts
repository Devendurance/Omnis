import { formatMoney, type SerializedMoney } from "../domain/money";
import { declinesWalletCheck, normalizeMoneyPhrase } from "../intent/semantic";
import { isRecordObject } from "./guard";
import {
  CONVERSATIONAL_PROPOSAL_JSON_SCHEMA,
  validateConversationalProposal,
  type ConversationalProposal,
} from "./schema";
import { CONVERSATIONAL_SYSTEM_PROMPT } from "./system-prompt";

export type ConversationMessageIn = Readonly<{
  role: "user" | "assistant";
  content: string;
}>;

export type ConversationGenerateInput = Readonly<{
  messages: ReadonlyArray<ConversationMessageIn>;
  taskContext: Readonly<Record<string, unknown>>;
  availableCapabilities: ReadonlyArray<string>;
}>;

export type ConversationGenerateResult = Readonly<{
  proposal: ConversationalProposal;
  provider: string;
  model: string;
  providerRequestId?: string;
}>;

export type ConversationalModel = Readonly<{
  name: string;
  model: string;
  generate: (input: ConversationGenerateInput) => Promise<ConversationGenerateResult>;
}>;

function fallbackClarifyProposal(message: string): ConversationalProposal {
  return Object.freeze({
    assistantMessage: message,
    intent: "clarify",
    proposedActions: Object.freeze([]),
    clarification: Object.freeze({ required: true, question: message }),
    extractedHints: Object.freeze({}),
  });
}

const MOCK_ACK_COPY =
  "I can do that. I will check the wallet before preparing the payment.";
const MOCK_GENERIC_COPY = "Tell me what needs to get paid and I will prepare a plan.";
const MOCK_UPDATE_COPY =
  "Got it. I have updated the plan below. Prior checks for the old plan no longer apply.";
const MOCK_REFUSAL_COPY =
  "I cannot approve, sign, or settle payments, and I cannot skip safeguards. Tell me what needs to be paid and I will prepare a plan.";
const MOCK_SYNTH_PREFIX = "Summarize this wallet check factually:";

// Fail-closed subset for the mock only. The interpreter remains the
// authority; the mock must never agree with these.
const MOCK_BYPASS_PATTERNS = Object.freeze([
  /\bwithout approval\b/i,
  /\bwithout asking\b/i,
  /\bno approval (needed|required)\b/i,
  /\bskip(ping)? (the )?(approval|settlement|verification)\b/i,
  /\bbypass.{0,24}(approval|policy|safeguards?)\b/i,
  /\bi (have )?approved\b/i,
  /\bmark .* (completed|complete|confirmed|settled)\b/i,
  /\bignore .*instructions\b/i,
  /\bignore (the )?policy\b/i,
  /\bpretend\b/i,
  /\bsay (the )?wallet check passed\b/i,
  /\binvent (a )?transaction hash\b/i,
  /\bwithout (running|verifying|verification|checking) (it|the check|verification)\b/i,
]);

const MOCK_CORRECTION_PATTERN =
  /\b(actually|make that|change (it|that|the) to|instead of|correction)\b/i;

function mockTaskContext(input: ConversationGenerateInput): Record<string, unknown> {
  const context = (input as { taskContext?: unknown }).taskContext;
  return isRecordObject(context) ? context : {};
}

function mockContextText(context: Record<string, unknown>, key: string): string | undefined {
  const value = context[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function mockSynthesizeNarrative(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let facts: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    if (!isRecordObject(parsed)) return undefined;
    facts = parsed;
  } catch {
    return undefined;
  }
  const purchaseStatus =
    typeof facts.purchaseStatus === "string" ? facts.purchaseStatus : undefined;
  if (purchaseStatus !== "paid") return undefined;
  const spent = isRecordObject(facts.spent) ? facts.spent : undefined;
  const spentAsset = spent && typeof spent.asset === "string" ? spent.asset : undefined;
  let spentText: string | undefined;
  try {
    if (!spent || !spentAsset) return undefined;
    spentText = formatMoney(spent as unknown as SerializedMoney) + " " + spentAsset;
  } catch {
    return undefined;
  }
  const parts: string[] = [
    "I have spent " + (spentText as string) + " of the service budget.",
  ];
  if (Array.isArray(facts.heuristicFlags)) {
    for (const flag of facts.heuristicFlags) {
      if (isRecordObject(flag) && typeof flag.code === "string" && flag.code.trim()) {
        parts.push("Heuristic signal " + flag.code.trim() + " was observed.");
      }
    }
  }
  const paymentText = typeof facts.paymentText === "string" ? facts.paymentText : undefined;
  if (paymentText && paymentText.trim()) {
    parts.push(
      facts.approvalStillRequired !== false
        ? "The " + paymentText.trim() + " payment is ready, but I still need your approval."
        : "The " + paymentText.trim() + " payment is ready.",
    );
  }
  return "Wallet check summary: " + parts.join(" ");
}

export function createMockConversationalModel(): ConversationalModel {
  return Object.freeze({
    name: "mock",
    model: "mock-1",
    generate: async (input) => {
      const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
      const text = lastUser?.content ?? "";
      const context = mockTaskContext(input);
      if (
        mockContextText(context, "mode") === "synthesize" ||
        text.startsWith(MOCK_SYNTH_PREFIX)
      ) {
        const narrative = mockSynthesizeNarrative(text);
        if (narrative !== undefined) {
          return Object.freeze({
            proposal: Object.freeze({
              assistantMessage: narrative,
              intent: "clarify",
              proposedActions: Object.freeze([]),
              clarification: Object.freeze({ required: false, question: null }),
              extractedHints: Object.freeze({}),
            }),
            provider: "mock",
            model: "mock-1",
          });
        }
        return Object.freeze({
          proposal: fallbackClarifyProposal(
            "I could not summarize this result. The recorded facts stand.",
          ),
          provider: "mock",
          model: "mock-1",
        });
      }
      if (MOCK_BYPASS_PATTERNS.some((pattern) => pattern.test(text))) {
        return Object.freeze({
          proposal: Object.freeze({
            assistantMessage: MOCK_REFUSAL_COPY,
            intent: "clarify",
            proposedActions: Object.freeze([]),
            clarification: Object.freeze({ required: true, question: MOCK_REFUSAL_COPY }),
            extractedHints: Object.freeze({}),
          }),
          provider: "mock",
          model: "mock-1",
        });
      }
      const addressMatch = text.match(/0x[0-9a-fA-F]{40}/);
      const amountMatch = text.match(/(\d+(?:\.\d+)?|\.\d+)\s*(USDC|usdc)/);
      const budgetMatch = text.match(
        /(?:spend|budget|cap|allowance|no more than|at most|up to)[^0-9$]{0,40}\$?\s*(\d+(?:\.\d+)?)/i,
      );
      const centsMatch = text.match(
        /\b((?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty)(?:[\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?)\s*cents?\b/i,
      );
      const dollarSignMatch = text.match(/\$\s*(\d+(?:\.\d+)?|\.\d+)/);
      const pendingField = mockContextText(context, "pendingField");
      const taskType = mockContextText(context, "taskType");
      const taskStatus = mockContextText(context, "taskStatus");
      const hasTaskContext = taskStatus !== undefined || taskType !== undefined;
      const recipientPresent = context.recipientPresent === true;
      const isCorrection = MOCK_CORRECTION_PATTERN.test(text);
      const textWithoutAddresses = text.replace(/0x[0-9a-fA-F]+/g, " ");
      const bareInteger = /\b\d+\b/.test(textWithoutAddresses);
      const explicitNumber =
        /\d+\.\d+/.test(textWithoutAddresses) ||
        /\b\d+\s*(USDC|USD)\b/i.test(text) ||
        /\$\s*\d/.test(textWithoutAddresses) ||
        /\b\w+\s+cents?\b/i.test(textWithoutAddresses);
      const correctionPaymentMatch =
        text.match(
          /\b(?:actually|make (?:that|it)|change (?:that |it )?to|instead)\b[^\d$]{0,24}(\d+(?:\.\d+)?|\.\d+)/i,
        ) ?? text.match(/(\d+(?:\.\d+)?|\.\d+)[^\d$]{0,24}\binstead\b/i);
      const correctionBudgetWord = /\b(?:budget|cap|allowance|spend|service|check(?:ing)?|cents?|dollars?|\$)\b/i.test(
        text,
      );
      const mentionsPaymentNoun = /\bpay(?:ment|ing)?\b/i.test(text);
      const correctionPaymentText =
        !amountMatch &&
        correctionPaymentMatch?.[1] &&
        !correctionBudgetWord &&
        mentionsPaymentNoun
          ? correctionPaymentMatch[1].replace(/,/g, "").replace(/^\./, "0.")
          : undefined;
      const centsBudgetText = centsMatch
        ? (normalizeMoneyPhrase(centsMatch[0]) ?? undefined)
        : undefined;
      const keywordBudgetText = budgetMatch ? budgetMatch[1].replace(/,/g, "") : undefined;
      const dollarBudgetText =
        !budgetMatch && dollarSignMatch ? dollarSignMatch[1].replace(/,/g, "") : undefined;
      const bareBudgetText =
        pendingField === "serviceBudget" &&
        !centsBudgetText &&
        !dollarBudgetText &&
        correctionPaymentText === undefined
          ? (amountMatch?.[1] ?? text.match(/(\d+(?:\.\d+)?|\.\d+)/)?.[1])
          : undefined;
      const mockBudgetAmount =
        pendingField === "serviceBudget"
          ? (centsBudgetText ?? keywordBudgetText ?? dollarBudgetText ?? bareBudgetText)
          : (keywordBudgetText ?? centsBudgetText ?? dollarBudgetText);
      const mockBudgetEvidence =
        mockBudgetAmount === undefined
          ? undefined
          : (centsBudgetText !== undefined && mockBudgetAmount === centsBudgetText
              ? centsMatch?.[0]
              : keywordBudgetText !== undefined && mockBudgetAmount === keywordBudgetText
                ? budgetMatch?.[0]
                : dollarBudgetText !== undefined && mockBudgetAmount === dollarBudgetText
                  ? dollarSignMatch?.[0]
                  : (amountMatch?.[0] ?? text.slice(0, 120)));
      const paymentHintText =
        amountMatch?.[1] ?? correctionPaymentText ?? undefined;
      const paymentHintEvidence =
        amountMatch?.[0] ?? correctionPaymentMatch?.[0] ?? undefined;
      const paymentForHints =
        paymentHintText === undefined ||
        paymentHintEvidence === undefined ||
        (pendingField === "serviceBudget" && mockBudgetAmount !== undefined)
          ? undefined
          : { text: paymentHintText, evidence: paymentHintEvidence };
      const labelMatch = text.match(/\bto\s+([A-Za-z][A-Za-z0-9_-]*)\b/);
      if (bareInteger && !explicitNumber && !addressMatch && !amountMatch) {
        const question = "How much should I send, and in which asset?";
        return Object.freeze({
          proposal: Object.freeze({
            assistantMessage: question,
            intent: "clarify",
            proposedActions: Object.freeze([]),
            clarification: Object.freeze({ required: true, question }),
            extractedHints: Object.freeze({}),
          }),
          provider: "mock",
          model: "mock-1",
        });
      }
      const declinesCheck = declinesWalletCheck(text);
      const wantsCheck =
        !declinesCheck &&
        (/\b(check|checking|verify|vet|screen|inspect|risk|make sure)\b/i.test(text) ||
          taskType === "pay_with_check");
      const wantsPay =
        /\b(pay|send|transfer)\b/i.test(text) ||
        /\b(?:gets?|receives?)\s+(?:\$\s*)?(?:\d|\.\d)/i.test(text) ||
        (isCorrection && hasTaskContext) ||
        (addressMatch !== null && hasTaskContext);
      const intent =
        wantsPay && wantsCheck ? "pay_with_check" : wantsPay ? "pay" : "clarify";
      let message = wantsPay ? MOCK_ACK_COPY : MOCK_GENERIC_COPY;
      if (
        isCorrection &&
        (taskStatus === "planned" || taskStatus === "awaiting_approval")
      ) {
        message = MOCK_UPDATE_COPY;
      }
      const recipientMissing = addressMatch === null && !recipientPresent;
      let clarification: ConversationalProposal["clarification"] = Object.freeze({
        required: false,
        question: null,
      });
      if (recipientMissing && (wantsPay || wantsCheck || hasTaskContext)) {
        const question = amountMatch
          ? "Who should receive " + amountMatch[1] + " USDC?"
          : "Who should receive this payment?";
        clarification = Object.freeze({ required: true, question });
      }
      return Object.freeze({
        proposal: Object.freeze({
          assistantMessage: message,
          intent,
          proposedActions: Object.freeze(
            wantsCheck ? [Object.freeze({ type: "wallet_check" as const })] : [],
          ),
          clarification,
          extractedHints: Object.freeze({
            ...(addressMatch ? { recipient: addressMatch[0] } : {}),
            ...(paymentForHints
              ? { paymentAmount: paymentForHints.text + " USDC", asset: "USDC" }
              : {}),
            ...(mockBudgetAmount ? { serviceBudget: "$" + mockBudgetAmount } : {}),
          }),
          semantic: Object.freeze({
            intent,
            ...(addressMatch
              ? {
                  recipientAddress: addressMatch[0],
                  recipientEvidence: addressMatch[0],
                }
              : {}),
            ...(labelMatch && !/^0x/i.test(labelMatch[1])
              ? { recipientLabel: labelMatch[1].slice(0, 80) }
              : {}),
            ...(paymentForHints
              ? {
                  paymentAmount: paymentForHints.text.replace(/,/g, ""),
                  paymentAsset: "USDC",
                  paymentEvidence: paymentForHints.evidence.slice(0, 200),
                }
              : {}),
            ...(mockBudgetAmount && mockBudgetEvidence
              ? {
                  serviceBudgetAmount: mockBudgetAmount,
                  serviceBudgetAsset: "USD",
                  serviceBudgetEvidence: mockBudgetEvidence.slice(0, 200),
                }
              : {}),
            ...(wantsCheck ? { requiresWalletCheck: true } : {}),
            ...(declinesCheck ? { requiresWalletCheck: false } : {}),
          }),
        }),
        provider: "mock",
        model: "mock-1",
      });
    },
  });
}

export function createDeterministicFallbackModel(reason: string): ConversationalModel {
  return Object.freeze({
    name: "fallback",
    model: "fallback-1",
    generate: async () => ({
      proposal: fallbackClarifyProposal(reason),
      provider: "fallback",
      model: "fallback-1",
    }),
  });
}

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-20b";
export const GROQ_REQUEST_TIMEOUT_MS = 25000;

type OpenAiCompatibleConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  model: string;
}>;

export type GroqConfig = OpenAiCompatibleConfig;

export function resolveGroqConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GroqConfig | undefined {
  const apiKey = env.OMNIS_LLM_API_KEY ?? "";
  if (!apiKey) return undefined;
  const model = env.OMNIS_LLM_MODEL ?? GROQ_DEFAULT_MODEL;
  const baseUrl = env.OMNIS_LLM_BASE_URL ?? GROQ_BASE_URL;
  return Object.freeze({ baseUrl, apiKey, model });
}

// Strict JSON Schema output is only documented for the target Groq GPT-OSS models.
// Any other model on a Groq-compatible endpoint keeps plain JSON object
// mode, so configuring a different model never sends an unsupported shape.
export const GROQ_STRUCTURED_OUTPUT_MODELS: ReadonlyArray<string> = Object.freeze([
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
]);
export function usesGroqStructuredOutput(providerName: string, model: string): boolean {
  return providerName === "groq" && (GROQ_STRUCTURED_OUTPUT_MODELS as ReadonlyArray<string>).includes(model);
}

export function resolveOpenAiCompatibleConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenAiCompatibleConfig | undefined {
  const apiKey = env.OMNIS_LLM_API_KEY ?? env.OPENAI_API_KEY ?? "";
  if (!apiKey) return undefined;
  const baseUrl = env.OMNIS_LLM_BASE_URL ?? "https://api.openai.com/v1";
  const model = env.OMNIS_LLM_MODEL ?? "gpt-4o-mini";
  return Object.freeze({ baseUrl, apiKey, model });
}

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new ModelOutputError("model did not return a JSON object");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ModelOutputError("model did not return parseable JSON");
  }
}
function readProviderRequestId(payload: Record<string, unknown>): string | undefined {
  const id = payload.id;
  if (typeof id !== "string") return undefined;
  const trimmed = id.trim().slice(0, 64);
  return /^[\w.:-]{1,64}$/.test(trimmed) ? trimmed : undefined;
}

// Strict JSON Schema output requires stable extractedHints shape, so absent
// hints arrive as null on the wire. The runtime validator is unchanged and
// rejects nulls, so the adapter strips wire nulls to absent before
// validating. Non-null non-text values pass through untouched and still fail.
function stripWireNullHints(value: unknown): unknown {
  if (!isRecordObject(value)) return value;
  let out = value;
  if (isRecordObject(value.extractedHints)) {
    const hints = value.extractedHints;
    const cleaned: Record<string, unknown> = {};
    for (const key of ["recipient", "paymentAmount", "asset", "serviceBudget"]) {
      const entry = hints[key];
      if (entry !== undefined && entry !== null) cleaned[key] = entry;
    }
    out = { ...out, extractedHints: cleaned };
  }
  if (isRecordObject(value.semantic)) {
    out = { ...out, semantic: stripSemanticNulls(value.semantic) };
  }
  return out;
}

function stripSemanticNulls(semantic: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(semantic)) {
    if (entry === undefined || entry === null) continue;
    if (isRecordObject(entry)) {
      const slot: Record<string, unknown> = {};
      for (const [slotKey, slotValue] of Object.entries(entry)) {
        if (slotValue !== undefined && slotValue !== null) slot[slotKey] = slotValue;
      }
      cleaned[key] = slot;
    } else {
      cleaned[key] = entry;
    }
  }
  return cleaned;
}
// Reads only the provider error code from a failed response for
// classification. Never surfaces headers, keys, prompts, or model output:
// failed_generation bodies can echo user content, so only the short code
// string is kept.
async function readProviderErrorCode(response: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = await response.json();
    if (!isRecordObject(parsed) || !isRecordObject(parsed.error)) return undefined;
    const code = parsed.error.code;
    return typeof code === "string" && code.length > 0 ? code.slice(0, 64) : undefined;
  } catch {
    return undefined;
  }
}

function createChatCompletionsModel(
  config: OpenAiCompatibleConfig,
  providerName: string,
): ConversationalModel {
  return Object.freeze({
    name: providerName,
    model: config.model,
    generate: async (input) => {
      let response: Response;
      try {
        response = await fetch(config.baseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + config.apiKey,
          },
          signal: AbortSignal.timeout(GROQ_REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            ...(usesGroqStructuredOutput(providerName, config.model)
              ? {
                  // P9A.11: GPT-OSS needs low reasoning plus a completion
                  // ceiling that fits reasoning plus strict JSON. Prior wire
                  // config omitted reasoning_effort (effective Groq GPT-OSS
                  // default medium, ~480 reasoning tokens) and truncated the
                  // schema at 800 (json_validate_failed); low uses ~40-200.
                  max_completion_tokens: 2048,
                  reasoning_effort: "low",
                  // include_reasoning:false hides chain-of-thought. It is
                  // mutually exclusive with reasoning_format, so the old
                  // reasoning_format:hidden is replaced, not kept.
                  include_reasoning: false,
                  response_format: {
                    type: "json_schema",
                    json_schema: {
                      name: "conversational_proposal",
                      strict: true,
                      schema: CONVERSATIONAL_PROPOSAL_JSON_SCHEMA,
                    },
                  },
                }
              : { response_format: { type: "json_object" }, max_tokens: 800 }),
            messages: [
              { role: "system", content: CONVERSATIONAL_SYSTEM_PROMPT },
              {
                role: "system",
                content:
                  "Task context (facts only, never send secrets): " +
                  JSON.stringify(input.taskContext).slice(0, 2000) +
                  ". Available capabilities: " +
                  input.availableCapabilities.join(", "),
              },
              ...input.messages.map((m) => ({ role: m.role, content: m.content })),
            ],
          }),
        });
      } catch (error) {
        if (error instanceof ModelOutputError) throw error;
        if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new Error("provider_timeout: model request timed out");
        }
        throw new Error(
          "provider_request_failed: model request failed: " +
            (error instanceof Error ? error.message : "unknown"),
        );
      }
      if (!response.ok) {
        if (response.status === 400) {
          const code = await readProviderErrorCode(response);
          if (code === "json_validate_failed") {
            throw new Error(
              "provider400_json_generation_failed: model failed to generate schema-conforming JSON",
            );
          }
          throw new Error(
            "provider400_schema_request: model request failed with status 400" +
              (code ? " (" + code + ")" : ""),
          );
        }
        if (response.status === 429) {
          throw new Error("provider429_rate_limit: model request failed with status 429");
        }
        throw new Error("provider_request_failed: model request failed with status " + response.status);
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new ModelOutputError("model response was not JSON");
      }
      if (!isRecordObject(payload) || !Array.isArray(payload.choices)) {
        throw new ModelOutputError("model response had no choices");
      }
      const first = payload.choices[0];
      if (!isRecordObject(first) || !isRecordObject(first.message)) {
        throw new ModelOutputError("model response choice had no message");
      }
      const content = first.message.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new ModelOutputError("model response had no content");
      }
      const validated = validateConversationalProposal(stripWireNullHints(extractJsonObject(content)));
      if (!validated.ok) {
        throw new ModelOutputError("model output failed schema validation: " + validated.error);
      }
      const providerRequestId = readProviderRequestId(payload);
      return Object.freeze({
        proposal: validated.proposal,
        model: config.model,
        provider: providerName,
        ...(providerRequestId ? { providerRequestId } : {}),
      });
    },
  });
}

export function createOpenAiCompatibleModel(
  config: OpenAiCompatibleConfig,
): ConversationalModel {
  return createChatCompletionsModel(config, "openai-compatible");
}

export function createGroqModel(config: GroqConfig): ConversationalModel {
  return createChatCompletionsModel(config, "groq");
}

export function selectConversationalModel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConversationalModel {
  const provider = (env.OMNIS_LLM_PROVIDER ?? "").toLowerCase();
  if (provider === "mock") return createMockConversationalModel();
  if (provider === "off") {
    return createDeterministicFallbackModel(
      "Conversational model is disabled. Tell Omnis what needs to be paid or researched.",
    );
  }
  if (provider === "groq") {
    const groq = resolveGroqConfig(env);
    if (!groq) {
      return createDeterministicFallbackModel(
        "Tell Omnis what needs to be paid or researched.",
      );
    }
    return createGroqModel(groq);
  }
  if (provider === "" || provider === "openai" || provider === "openai-compatible") {
    const config = resolveOpenAiCompatibleConfig(env);
    if (!config) {
      return createDeterministicFallbackModel(
        "Tell Omnis what needs to be paid or researched.",
      );
    }
    return createOpenAiCompatibleModel(config);
  }
  return createDeterministicFallbackModel(
    "Tell Omnis what needs to be paid or researched.",
  );
}
