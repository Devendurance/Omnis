import { isRecordObject } from "../conversation/guard";
import type { BoundedServiceCandidate } from "./dto";
import {
  SERVICE_RECOMMENDATION_JSON_SCHEMA,
  SERVICE_RECOMMENDATION_SCHEMA_NAME,
  validateServiceRecommendation,
  type ServiceRecommendation,
} from "./schema";

// P9B recommendation transport. Uses the frozen P9A.11.1 GPT-OSS contract
// (reasoning_effort low, max_completion_tokens 2048, include_reasoning
// false, strict json_schema) with a separate recommendation schema. The
// shared conversation transport in lib/conversation/provider.ts is untouched
// (P9A frozen); these constants deliberately mirror it by value. No shared
// provider refactor: if provider settings change later, update both modules
// together so recommendation behavior cannot drift silently.
export const RECOMMENDATION_MODEL_DEFAULT = "openai/gpt-oss-20b" as const;
export const RECOMMENDATION_MAX_COMPLETION_TOKENS = 2048 as const;
export const RECOMMENDATION_REASONING_EFFORT = "low" as const;
export const RECOMMENDATION_REQUEST_TIMEOUT_MS = 25000 as const;
// P9B.1 payload bounds. Descriptions are truncated at field boundaries and
// the candidate list is capped BEFORE stringify, so the request body is
// always syntactically valid JSON (never sliced mid-object).
export const RECOMMENDATION_MAX_CANDIDATES = 10 as const;
export const RECOMMENDATION_MAX_DESCRIPTION_CHARS = 500 as const;
const RECOMMENDATION_BASE_URL = "https://api.groq.com/openai/v1";

export type RecommendationModelInput = Readonly<{
  candidates: readonly BoundedServiceCandidate[];
  requiredCapability: string;
  serviceBudgetLabel: string;
}>;

export type RecommendationModelResult = Readonly<{
  recommendation: ServiceRecommendation;
  model: string;
  provider: string;
}>;

export type RecommendationModelError = Error;

export type RecommendationModel = Readonly<{
  name: string;
  model: string;
  generate: (input: RecommendationModelInput) => Promise<RecommendationModelResult>;
}>;

export class RecommendationOutputError extends Error {}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new RecommendationOutputError("model response had no JSON object");
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    throw new RecommendationOutputError("model response was not JSON");
  }
}

async function readRecommendationErrorCode(
  response: Response,
): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    if (!isRecordObject(payload)) return undefined;
    const error = payload.error;
    if (!isRecordObject(error)) return undefined;
    if (typeof error.code === "string") return error.code;
    return undefined;
  } catch {
    return undefined;
  }
}

function recommendationSystemPrompt(): string {
  return [
    "You compare bounded wallet service candidates for a financial task.",
    "Rules: recommend at most one candidate by its exact serviceId, or null when none is executable.",
    "Only reference candidates by their exact serviceId values.",
    "Never invent a service, price, budget, network, or capability.",
    "Use only the eligibility facts provided for each candidate.",
    "Catalog-only candidates may be discussed but must never be recommended as executable.",
    "Keep the rationale to two sentences using only the supplied facts.",
    "Do not repeat exact price, budget, network, or availability facts in the rationale; authoritative values are rendered separately from deterministic data.",
  ].join(" ");
}

export type RecommendationPayload = Readonly<{
  requiredCapability: string;
  serviceBudget: string;
  candidates: readonly BoundedServiceCandidate[];
}>;

// P9B.1 bounded payload. Caps and field-boundary truncation happen on the
// object graph so JSON.stringify always emits valid JSON.
export function buildRecommendationPayload(
  input: RecommendationModelInput,
): RecommendationPayload {
  return Object.freeze({
    requiredCapability: input.requiredCapability,
    serviceBudget: input.serviceBudgetLabel,
    candidates: Object.freeze(
      input.candidates.slice(0, RECOMMENDATION_MAX_CANDIDATES).map((candidate) =>
        candidate.description.length <= RECOMMENDATION_MAX_DESCRIPTION_CHARS
          ? candidate
          : Object.freeze({
              ...candidate,
              description: candidate.description.slice(
                0,
                RECOMMENDATION_MAX_DESCRIPTION_CHARS,
              ),
            }),
      ),
    ),
  });
}

export type GroqRecommendationConfig = Readonly<{
  baseUrl: string;
  apiKey: string;
  model: string;
}>;

export function resolveGroqRecommendationConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GroqRecommendationConfig | undefined {
  // Same env names as the frozen conversation transport (read-only reuse;
  // provider.ts is untouched). Missing key yields undefined and the caller
  // falls back to the mock model.
  const apiKey = env.OMNIS_LLM_API_KEY ?? "";
  if (!apiKey) return undefined;
  const baseUrl = env.OMNIS_LLM_BASE_URL ?? RECOMMENDATION_BASE_URL;
  const model = env.OMNIS_LLM_MODEL ?? RECOMMENDATION_MODEL_DEFAULT;
  return Object.freeze({ baseUrl, apiKey, model });
}

export function createGroqRecommendationModel(
  config: GroqRecommendationConfig,
): RecommendationModel {
  return Object.freeze({
    name: "groq-recommendation",
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
          signal: AbortSignal.timeout(RECOMMENDATION_REQUEST_TIMEOUT_MS),
          body: JSON.stringify({
            model: config.model,
            temperature: 0.2,
            max_completion_tokens: RECOMMENDATION_MAX_COMPLETION_TOKENS,
            reasoning_effort: RECOMMENDATION_REASONING_EFFORT,
            include_reasoning: false,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: SERVICE_RECOMMENDATION_SCHEMA_NAME,
                strict: true,
                schema: SERVICE_RECOMMENDATION_JSON_SCHEMA,
              },
            },
            messages: [
              { role: "system", content: recommendationSystemPrompt() },
              {
                role: "user",
                content: JSON.stringify(buildRecommendationPayload(input)),
              },
            ],
          }),
        });
      } catch (error) {
        if (error instanceof RecommendationOutputError) throw error;
        if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new Error("recommendation_timeout: model request timed out");
        }
        throw new Error(
          "recommendation_request_failed: model request failed: " +
            (error instanceof Error ? error.message : "unknown"),
        );
      }
      if (!response.ok) {
        if (response.status === 400) {
          const code = await readRecommendationErrorCode(response);
          if (code === "json_validate_failed") {
            throw new Error(
              "recommendation400_json_generation_failed: model failed to generate schema-conforming JSON",
            );
          }
          throw new Error(
            "recommendation400_schema_request: model request failed with status 400" +
              (code ? " (" + code + ")" : ""),
          );
        }
        if (response.status === 429) {
          throw new Error("recommendation429_rate_limit: model request failed with status 429");
        }
        throw new Error(
          "recommendation_request_failed: model request failed with status " + response.status,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new RecommendationOutputError("model response was not JSON");
      }
      if (!isRecordObject(payload) || !Array.isArray(payload.choices)) {
        throw new RecommendationOutputError("model response had no choices");
      }
      const first = payload.choices[0];
      if (!isRecordObject(first) || !isRecordObject(first.message)) {
        throw new RecommendationOutputError("model response choice had no message");
      }
      const content = first.message.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new RecommendationOutputError("model response had no content");
      }
      const validated = validateServiceRecommendation(extractJsonObject(content));
      if (!validated.ok) {
        throw new RecommendationOutputError(
          "model output failed schema validation: " + validated.error,
        );
      }
      return Object.freeze({
        recommendation: validated.recommendation,
        model: config.model,
        provider: "groq-recommendation",
      });
    },
  });
}

// Deterministic mock for automated tests and hermetic environments. It
// recommends the first executable candidate, or null when none qualifies.
export function createMockRecommendationModel(): RecommendationModel {
  return Object.freeze({
    name: "mock-recommendation",
    model: "mock",
    generate: async (input) => {
      const executable = input.candidates.find((candidate) => candidate.executable);
      const comparisons = input.candidates.map((candidate) => ({
        serviceId: candidate.serviceId,
        assessment: candidate.executable
          ? "executable now within budget"
          : "not executable in this demo",
      }));
      return Object.freeze({
        recommendation: Object.freeze({
          recommendedServiceId: executable ? executable.serviceId : null,
          rationale: executable
            ? "The executable candidate fits the task within budget."
            : "No candidate is executable in this demo.",
          comparisons: Object.freeze(comparisons),
          clarificationRequired: false,
          clarificationQuestion: null,
        }),
        model: "mock",
        provider: "mock-recommendation",
      });
    },
  });
}

export function selectRecommendationModel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RecommendationModel {
  if ((env.OMNIS_LLM_PROVIDER ?? "mock") === "mock") {
    return createMockRecommendationModel();
  }
  const config = resolveGroqRecommendationConfig(env);
  if (!config) return createMockRecommendationModel();
  return createGroqRecommendationModel(config);
}
