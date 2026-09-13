// P9A.2 hermetic guard. Preloaded into the Playwright test Next server via
// NODE_OPTIONS=--require. Any server-side fetch to an external LLM host
// throws immediately, so a provider regression fails loudly instead of
// silently calling api.groq.com or api.openai.com. Loopback stays allowed
// so localhost stubs keep working. The only LLM transport in the provider
// layer is fetch, which is what this wraps.
const BLOCKED_HOSTS = ["api.groq.com", "api.openai.com"];

function hostOf(input) {
  try {
    if (typeof input === "string") return new URL(input).hostname.toLowerCase();
    if (input instanceof URL) return input.hostname.toLowerCase();
    if (input && typeof input.url === "string") {
      return new URL(input.url).hostname.toLowerCase();
    }
  } catch {
    return "";
  }
  return "";
}

function isBlockedLlmHost(host) {
  if (typeof host !== "string") return false;
  const lower = host.toLowerCase();
  return BLOCKED_HOSTS.some(
    (blocked) => lower === blocked || lower.endsWith("." + blocked),
  );
}

function installLlmFetchGuard() {
  const scope = globalThis;
  if (scope.__OMNIS_BLOCK_EXTERNAL_LLM_INSTALLED) return;
  scope.__OMNIS_BLOCK_EXTERNAL_LLM_INSTALLED = true;
  const originalFetch = scope.fetch;
  if (typeof originalFetch !== "function") return;
  const guarded = function (input, init) {
    const host = hostOf(input);
    if (host && isBlockedLlmHost(host)) {
      throw new Error(
        "blocked external LLM call in automated tests: " + host,
      );
    }
    return originalFetch.call(this, input, init);
  };
  scope.fetch = guarded;
}

installLlmFetchGuard();

module.exports = { installLlmFetchGuard, isBlockedLlmHost };
