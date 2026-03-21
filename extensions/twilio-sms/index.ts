// Authored by: cc (Claude Code) | 2026-03-20
import { Type } from "@sinclair/typebox";
import { resolveSecretInputString } from "openclaw/plugin-sdk";
import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { SmsConfigSchema, resolveSmsConfig, type SmsConfigInput } from "./src/config.js";
import { createSmsRuntime, type SmsRuntime } from "./src/runtime.js";

const smsPlugin = {
  id: "twilio-sms",
  name: "Twilio SMS",
  description:
    "Receive inbound SMS via Twilio and route messages to the OC agent (Phase 1: inbound only)",

  async register(api: OpenClawPluginApi) {
    // Resolve Twilio credentials — may be plain strings or secret refs (e.g. AKV exec refs).
    const rawPluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const rawTwilio = rawPluginConfig.twilio as Record<string, unknown> | undefined;
    let resolvedPluginConfig: SmsConfigInput = rawPluginConfig as SmsConfigInput;
    if (rawTwilio) {
      resolvedPluginConfig = {
        ...rawPluginConfig,
        twilio: {
          accountSid: await resolveSecretInputString({
            config: api.config,
            value: rawTwilio.accountSid,
            env: process.env,
          }),
          authToken: await resolveSecretInputString({
            config: api.config,
            value: rawTwilio.authToken,
            env: process.env,
          }),
        },
      } as SmsConfigInput;
    }
    const config = SmsConfigSchema.parse(resolveSmsConfig(resolvedPluginConfig));
    let runtime: SmsRuntime | null = null;

    api.registerService({
      id: "twilio-sms",
      start: async () => {
        runtime = await createSmsRuntime(config, api.runtime.subagent, api.logger);
      },
      stop: async () => {
        await runtime?.stop();
        runtime = null;
      },
    });

    api.registerGatewayMethod("sms.status", ({ respond }: GatewayRequestHandlerOptions) => {
      respond(true, { running: !!runtime, port: config.serve.port });
    });

    api.registerTool({
      name: "sms_inbox",
      label: "SMS Inbox",
      description:
        "View recent inbound SMS messages received at the configured Twilio number. Returns up to 50 messages.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string) {
        const messages = runtime?.getInbox() ?? [];
        return {
          content: [{ type: "text" as const, text: JSON.stringify(messages, null, 2) }],
          details: { messages },
        };
      },
    });
  },
};

export default smsPlugin;
