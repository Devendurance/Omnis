import { expect, test } from "@playwright/test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";

test.describe.configure({ mode: "serial", timeout: 180000 });

const SMOKE_RECIPIENT = "0xe22D12c8ED1D16bA845355F8Fd43eE65f2A56fC7";
const SMOKE_INITIAL =
  "Before you pay Alex 0.10 USDC, make sure this wallet has actually been used. " +
  "You can spend up to five cents checking it, but ask me before you send anything. " +
  "His wallet is " +
  SMOKE_RECIPIENT +
  ".";

const MOCK_PORT = 3121;
const GROQ_PORT = 3122;
const STUB_PORT = 3129;

const stubRequests: string[] = [];
let stub: Server | undefined;
const servers: ChildProcess[] = [];

function readBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let text = "";
  request.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });
  request.on("end", () => resolve(text));
  request.on("error", reject);
  return promise;
}
function stubProposalFor(text: string): Record<string, unknown> {
  const address = text.match(/0x[0-9a-fA-F]{4,}/)?.[0];
  const amount = text.match(/(\d+(?:\.\d+)?)\s*USDC/i)?.[1];
  const budget = text.match(
    /(?:spend|budget|cap|allowance|no more than|at most|up to)[^0-9$]{0,40}\$?\s*(\d+(?:\.\d+)?)/i,
  )?.[1];
  const wantsCheck = /\b(check|checking|verify|vet|screen|make sure)\b/i.test(text);
  const wantsPay = /\b(pay|send|transfer)\b/i.test(text);
  return {
    assistantMessage: "I can do that. I will check the wallet before preparing the payment.",
    intent: wantsPay && wantsCheck ? "pay_with_check" : wantsPay ? "pay" : "clarify",
    proposedActions: wantsCheck ? [{ type: "wallet_check" }] : [],
    clarification: { required: false, question: null },
    extractedHints: {
      ...(address ? { recipient: address } : {}),
      ...(amount ? { paymentAmount: amount + " USDC", asset: "USDC" } : {}),
      ...(budget ? { serviceBudget: "$" + budget } : {}),
    },
  };
}

function startStub(): Promise<void> {
  stub = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      stubRequests.push(body);
      const parsed: unknown = JSON.parse(body);
      let chatMessages: Array<{ role?: string; content?: string }> = [];
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "messages" in parsed &&
        Array.isArray(parsed.messages)
      ) {
        chatMessages = parsed.messages.filter(
          (entry): entry is { role?: string; content?: string } =>
            typeof entry === "object" && entry !== null,
        );
      }
      let userText = "";
      for (const entry of chatMessages) {
        if (entry.role === "user" && typeof entry.content === "string") userText = entry.content;
      }
      const text = userText;
      const reply = (payload: unknown, status = 200, contentType = "application/json") => {
        response.writeHead(status, { "content-type": contentType });
        response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
      };
      if (text.includes("STUB_OUTAGE")) {
        response.destroy();
        return;
      }
      if (text.includes("STUB_MALFORMED")) {
        reply("<html>not json</html>", 200, "text/html");
        return;
      }
      if (text.includes("STUB_DISAGREE")) {
        reply({
          id: "chatcmpl-stub",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  assistantMessage: "Stub disagreement.",
                  intent: "pay_with_check",
                  proposedActions: [{ type: "wallet_check" }],
                  clarification: { required: false, question: null },
                  extractedHints: {
                    recipient: SMOKE_RECIPIENT,
                    paymentAmount: "9.99 USDC",
                    asset: "USDC",
                    serviceBudget: "$0.05",
                  },
                }),
              },
            },
          ],
        });
        return;
      }
      if (text.startsWith("Summarize this wallet check factually:")) {
        reply({
          id: "chatcmpl-stub",
          choices: [
            {
              message: {
                role: "assistant",
                content: "Paid 0xdeadbeef. Successfully paid.",
              },
            },
          ],
        });
        return;
      }
      reply({
        id: "chatcmpl-stub",
        choices: [
          { message: { role: "assistant", content: JSON.stringify(stubProposalFor(text)) } },
        ],
      });
    })();
  });
  const ready = Promise.withResolvers<void>();
  stub?.once("error", (cause: unknown) => {
    ready.reject(new Error("stub failed to bind port " + STUB_PORT + ": " + String(cause)));
  });
  stub?.listen(STUB_PORT, "127.0.0.1", ready.resolve);
  return ready.promise;
}

function startApp(port: number, env: Record<string, string>): ChildProcess {
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      shell: false,
      stdio: "pipe",
    },
  );
  const output: string[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    output.push(chunk.toString());
    if (output.length > 50) output.shift();
  });
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.log("app on port " + port + " exited: " + output.join("").slice(-2000));
    }
  });
  servers.push(child);
  return child;
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/");
    await response.arrayBuffer();
    return false;
  } catch {
    return true;
  }
}

async function waitForApp(child: ChildProcess, port: number): Promise<void> {
  const earlyExit = Promise.withResolvers<{ code: number | null }>();
  child.once("exit", (code: number | null) => earlyExit.resolve({ code }));
  const deadline = Date.now() + 90000;
  for (;;) {
    if (child.exitCode !== null) {
      const { code } = await earlyExit.promise;
      throw new Error("app on port " + port + " exited early with code " + code);
    }
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/");
      if (response.ok) return;
    } catch {
      // Server is still booting.
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("app on port " + port + " did not boot");
    }
    const paused = Promise.withResolvers<void>();
    setTimeout(paused.resolve, 1000);
    await paused.promise;
  }
}
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  throw new Error("expected a JSON object response");
}

async function postInterpret(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch("http://127.0.0.1:" + port + "/api/conversation", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: asRecord(await response.json()) };
}

let serverReady: Promise<void> | undefined;

async function ensureServers(): Promise<void> {
  if (!serverReady) {
    serverReady = (async () => {
      await Promise.all(
        servers.splice(0, servers.length).map((child) => {
          const exited = Promise.withResolvers<void>();
          child.on("exit", () => exited.resolve());
          child.kill();
          setTimeout(exited.resolve, 5000);
          return exited.promise;
        }),
      );
      await startStub();
      for (const port of [MOCK_PORT, GROQ_PORT]) {
        if (!(await isPortFree(port))) {
          throw new Error("port " + port + " already serves traffic; kill the stale server first");
        }
      }
      const mockApp = startApp(MOCK_PORT, { OMNIS_LLM_PROVIDER: "mock" });
      const groqApp = startApp(GROQ_PORT, {
        OMNIS_LLM_PROVIDER: "groq",
        OMNIS_LLM_API_KEY: "test-route-key",
        OMNIS_LLM_BASE_URL: "http://127.0.0.1:" + STUB_PORT + "/v1",
      });
      await waitForApp(mockApp, MOCK_PORT);
      await waitForApp(groqApp, GROQ_PORT);
    })();
  }
  await serverReady;
}

test.afterAll(async () => {
  await Promise.all(
    servers.map((child) => {
      const exited = Promise.withResolvers<void>();
      child.on("exit", () => exited.resolve());
      child.kill();
      const fallback = setTimeout(() => {
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
        } else {
          child.kill("SIGKILL");
        }
        setTimeout(exited.resolve, 5000);
      }, 10000);
      fallback.unref();
      return exited.promise;
    }),
  );
  const closed = Promise.withResolvers<void>();
  if (stub) stub.close(() => closed.resolve());
  else closed.resolve();
  await closed.promise;
});
test("route: valid mock proposal plans the smoke task over HTTP", async () => {
  await ensureServers();
  const { status, json } = await postInterpret(MOCK_PORT, {
    action: "interpret",
    userText: SMOKE_INITIAL,
    messages: [],
    pendingIntent: null,
    task: null,
    policy: null,
  });
  expect(status).toBe(200);
  expect(json["gate"]).toBe("plan");
  expect(json["fallback"]).toBe(false);
  expect(json["reconcileOutcome"]).toBe("agree");
  const deterministic = asRecord(json["deterministic"]);
  expect(deterministic["status"]).toBe("ready");
  expect(deterministic["missing"]).toEqual([]);
});

test("route: financial disagreement clarifies over HTTP without planning", async () => {
  await ensureServers();
  const { status, json } = await postInterpret(MOCK_PORT, {
    action: "interpret",
    userText: "Pay Alex 0.10 USDC and also 0.20 USDC, spend no more than $0.05 checking.",
    messages: [],
    pendingIntent: null,
    task: null,
    policy: null,
  });
  expect(status).toBe(200);
  expect(json["gate"]).toBe("clarify");
  expect(json["fallback"]).toBe(true);
  expect(json["reconcileOutcome"]).toBe("disagree");
});

test("route: synthesis rejection returns fallback over HTTP", async () => {
  await ensureServers();
  const { status, json } = await postInterpret(MOCK_PORT, {
    action: "synthesize",
    userText: "summarize",
    purchase: {
      paymentAmount: { amount: "0.10", asset: "USDC", decimals: 6 },
      status: "failed",
    },
    serviceBudget: { amount: "0.05", asset: "USD", decimals: 6 },
    paymentText: "0.10 USDC",
    approvalStillRequired: true,
  });
  expect(status).toBe(200);
  expect(json["fallback"]).toBe(true);
  expect(typeof json["message"]).toBe("string");
  expect(String(json["message"])).not.toContain("Successfully paid");
});

test("route: malformed stub output never plans", async () => {
  await ensureServers();
  const { status, json } = await postInterpret(GROQ_PORT, {
    action: "interpret",
    userText: "STUB_MALFORMED Pay " + SMOKE_RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
    messages: [],
    pendingIntent: null,
    task: null,
    policy: null,
  });
  expect(status).toBe(200);
  expect(json["gate"]).toBe("clarify");
  expect(json["fallback"]).toBe(true);
  expect(json["reconcileOutcome"]).toBe("schema_rejected");
});

test("route: stub outage falls back without a live provider call", async () => {
  await ensureServers();
  const { status, json } = await postInterpret(GROQ_PORT, {
    action: "interpret",
    userText: "STUB_OUTAGE Pay " + SMOKE_RECIPIENT + " 0.10 USDC, spend no more than $0.05 checking.",
    messages: [],
    pendingIntent: null,
    task: null,
    policy: null,
  });
  expect(status).toBe(200);
  expect(json["fallback"]).toBe(true);
});

test("route: stubbed groq agreement plans without a live provider call", async () => {
  await ensureServers();
  const { status, json } = await postInterpret(GROQ_PORT, {
    action: "interpret",
    userText: SMOKE_INITIAL,
    messages: [],
    pendingIntent: null,
    task: null,
    policy: null,
  });
  expect(status).toBe(200);
  expect(json["gate"]).toBe("plan");
  expect(json["fallback"]).toBe(false);
  expect(stubRequests.length).toBeGreaterThan(0);
});
