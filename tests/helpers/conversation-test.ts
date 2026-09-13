import type { Page } from "@playwright/test";

// P9A.2 shared browser-test contract. Conversation stays ON in production
// and in tests. POST /api/conversation performs interpretation only and is
// never a financial write.

export const CONVERSATION_PATH = "/api/conversation";

// Every client route that can move or authorize money. Any POST to one of
// these paths counts as a financial write. Keep in sync with
// src/components/composer.tsx fetch calls and src/app/api POST handlers.
export const FINANCIAL_WRITE_PATHS = Object.freeze([
  "/api/tasks/service-purchase",
  "/api/tasks/final-settlement",
  "/api/services/wallet-activity",
  "/api/dev/x402-wallet-activity",
  "/api/dev/circle-settlement/preflight",
  "/api/dev/circle-settlement/reconcile",
]);

// External LLM hosts that automated tests must never contact.
export const FORBIDDEN_LLM_HOSTS = Object.freeze([
  "api.groq.com",
  "api.openai.com",
]);

export function isFinancialWrite(url: string): boolean {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0] ?? url;
  }
  return FINANCIAL_WRITE_PATHS.some(
    (route) => path === route || path.startsWith(route + "/"),
  );
}

export function isConversationRequest(url: string): boolean {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0] ?? url;
  }
  return path === CONVERSATION_PATH;
}

export function isForbiddenLlmRequest(url: string): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return FORBIDDEN_LLM_HOSTS.some(
    (blocked) => host === blocked || host.endsWith("." + blocked),
  );
}

export type RequestLog = {
  conversation: string[];
  financialWrites: string[];
  forbiddenLlm: string[];
  mutations: string[];
};

// Records every request the page issues, classified into conversation
// (interpretation only), financial writes (must stay zero in no-payment
// tests), and forbidden external LLM calls (must always stay zero).
export async function trackTestRequests(page: Page): Promise<RequestLog> {
  const log: RequestLog = {
    conversation: [],
    financialWrites: [],
    forbiddenLlm: [],
    mutations: [],
  };
  page.on("request", (request) => {
    const url = request.url();
    if (isForbiddenLlmRequest(url)) log.forbiddenLlm.push(url);
    if (isConversationRequest(url)) log.conversation.push(url);
    if (isFinancialWrite(url)) log.financialWrites.push(url);
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      log.mutations.push(`${request.method()} ${url}`);
    }
  });
  return log;
}

