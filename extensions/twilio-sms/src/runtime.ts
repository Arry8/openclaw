// Authored by: cc (Claude Code) | 2026-03-18
import http from "node:http";
import { normalizePhoneNumber } from "./allowlist.js";
import type { SmsConfig } from "./config.js";
import { handleSmsRequest, type SmsMessage } from "./webhook.js";

const INBOX_MAX = 50;

type SubagentDispatcher = {
  run: (params: { sessionKey: string; message: string }) => Promise<unknown>;
};

type RuntimeLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export type SmsRuntime = {
  stop: () => Promise<void>;
  getInbox: () => SmsMessage[];
};

export async function createSmsRuntime(
  config: SmsConfig,
  subagent: SubagentDispatcher,
  logger: RuntimeLogger,
): Promise<SmsRuntime> {
  const inbox: SmsMessage[] = [];

  const onMessage = (msg: SmsMessage): void => {
    // Ring-buffer: keep only the most recent INBOX_MAX messages.
    inbox.push(msg);
    if (inbox.length > INBOX_MAX) {
      inbox.shift();
    }

    // Session key is stable per sender so conversation history accumulates correctly.
    const sessionKey = `sms:${normalizePhoneNumber(msg.from)}`;
    const message = `SMS from ${msg.from}: ${msg.body}`;

    logger.info(`[twilio-sms] dispatching message to agent (session=${sessionKey})`);

    // Fire-and-forget — the TwiML response is already sent; agent errors are logged only.
    subagent
      .run({ sessionKey, message })
      .catch((err: unknown) => logger.error(`[twilio-sms] agent dispatch failed: ${String(err)}`));
  };

  const server = http.createServer((req, res) => {
    // Only route requests that match the configured webhook path.
    const urlPath = req.url?.split("?")[0] ?? "";
    if (urlPath !== config.serve.path) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    handleSmsRequest(req, res, { config, onMessage }).catch((err: unknown) => {
      logger.error(`[twilio-sms] webhook handler error: ${String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(config.serve.port, config.serve.bind, resolve);
    server.on("error", reject);
  });

  logger.info(
    `[twilio-sms] webhook server listening on ${config.serve.bind}:${config.serve.port}${config.serve.path}`,
  );

  return {
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
    // Return a snapshot so callers can't mutate the internal buffer.
    getInbox: () => [...inbox],
  };
}
