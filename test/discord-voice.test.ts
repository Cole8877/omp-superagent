import { expect, test } from "bun:test";
import { ChannelType, Collection, MessageType, type Message } from "discord.js";
import { DiscordVoice } from "../src/discord-voice";
import type { Inbound, OutputRecord, Route } from "../src/contracts";
import type { openLive } from "../src/openai-live";
import type { openVoiceLink } from "../src/discord-voice-link";

test.each(["api", "subscription", "subscription rejected"] as const)("%s: explicit voice start uses only the selected provider and keeps work bound to written confirmation", async mode => {
  const route: Route = { platform: "discord", accountId: "11", authorityId: "22", guildId: "33", channelId: "44", threadId: null };
  const client = { user: { id: route.accountId } };
  const ready = Promise.withResolvers<void>();
  const rejected = Promise.withResolvers<void>();
  const text = {
    id: route.channelId, type: ChannelType.GuildText, client, guildId: route.guildId,
    guild: {
      channels: { fetch: async () => ({ id: "55", guildId: route.guildId, type: ChannelType.GuildVoice }) },
      voiceStates: { cache: new Map([[route.authorityId, { channelId: "55" }]]) },
    },
    send: async ({ content }: { content: string }) => {
      if (content.startsWith("Voice ready.")) ready.resolve();
      if (content.includes("No API fallback")) rejected.resolve();
      return { id: "300", author: { id: route.accountId, bot: true }, content, channelId: route.channelId,
        guildId: route.guildId, createdTimestamp: Date.now() };
    },
  };
  function message(content: string, id: string, reply = false): [Message, Inbound] {
    const now = Date.now();
    return [{ content, id, type: reply ? MessageType.Reply : MessageType.Default, channel: text, channelId: text.id,
      author: { id: route.authorityId, bot: false }, guildId: text.guildId, client, attachments: new Collection(),
      messageSnapshots: new Collection(), stickers: new Collection(), editedTimestamp: null, webhookId: null, createdTimestamp: now,
      reference: reply ? { messageId: "300", channelId: text.id, guildId: route.guildId } : null } as unknown as Message,
    { id: `discord:11:${id}:original`, messageId: id, route, text: content, receivedAt: now, attachments: [] }];
  }
  let discord!: Parameters<typeof openVoiceLink>[2];
  let live!: Parameters<typeof openLive>[1];
  let signal!: AbortSignal;
  let opened = 0;
  let notified = 0;
  const fromOwner: Buffer[] = [];
  const toOwner: Buffer[] = [];
  const bind = (handlers: Parameters<typeof openLive>[1], active: AbortSignal): Awaited<ReturnType<typeof openLive>> => {
    live = handlers;
    signal = active;
    return { input: pcm => { fromOwner.push(pcm); }, close() {}, notifyHeadReply: () => { ++notified; } };
  };
  let apiCalls = 0;
  const billing = mode === "api" ? { apiKeyEnv: "UNUSED", model: "speech", backendModel: "delegate" }
    : { auth: "subscription" as const };
  const voice = new DiscordVoice({ ...billing, voice: "selected", channelId: "55", textChannelId: text.id,
    maxSessionSeconds: 60 }, route.authorityId, mode === "subscription" ? undefined : "unused-api-key",
  error => { throw error; },
  async (_channel, _owner, handlers) => {
    discord = handlers;
    return { play: pcm => { toOwner.push(pcm); }, clear() {}, close() {} };
  },
  async (_options, handlers, active) => {
    ++apiCalls;
    ++opened;
    return bind(handlers, active);
  }, async (_options, handlers, active) => {
    ++opened;
    if (mode === "subscription rejected") throw new Error("No subscription entitlement");
    return bind(handlers, active);
  });
  try {
    voice.command(...message("/voice start", "101"));
    voice.command(...message("/voice start", "102"));
    if (mode === "subscription rejected") {
      await rejected.promise;
      expect(apiCalls).toBe(0);
      expect(opened).toBe(1);
      return;
    }
    await ready.promise;
    expect(opened).toBe(1);
    expect(apiCalls).toBe(mode === "api" ? 1 : 0);
    const pcm = Buffer.from([5, 0]);
    discord.audio(pcm);
    live.audio(pcm);
    expect(fromOwner).toEqual([pcm]);
    expect(toOwner).toEqual([pcm]);
    expect(await live.forward("Inspect the failed check")).toContain("Not yet submitted");
    const confirmation = message("/voice confirm", "301", true);
    expect(voice.command(...confirmation)).toContain("Inspect the failed check");
    expect(voice.command(...confirmation)).toBeNull();
    const output: OutputRecord = { id: "out", sourceId: confirmation[1].id, route, text: "Private result",
      remoteId: null, error: null, state: "sending" };
    voice.textDelivered({ ...output, route: { ...route, threadId: "77" } });
    voice.textDelivered({ ...output, sourceId: "unrelated" });
    expect(notified).toBe(0);
    voice.textDelivered(output);
    voice.textDelivered(output);
    expect(notified).toBe(1);
    expect(await live.forward("Check the deploy queue")).toContain("Not yet submitted");
    const reaction = { messageId: "300", channelId: text.id, guildId: route.guildId, userId: route.authorityId, userIsBot: false, emoji: "\u2705" };
    const [, reacted] = message("\u2705", "303", true);
    expect(voice.reaction({ ...reaction, userId: "other" }, reacted)).toBeNull();
    expect(voice.reaction({ ...reaction, channelId: "elsewhere" }, reacted)).toBeNull();
    expect(voice.reaction(reaction, reacted)).toContain("Check the deploy queue");
    expect(voice.reaction(reaction, reacted)).toBeNull();
    voice.command(...message("/voice stop", "302"));
    expect(signal.aborted).toBe(true);
    discord.audio(pcm);
    live.audio(pcm);
    await expect(live.forward("Too late")).rejects.toThrow();
    expect(fromOwner).toHaveLength(1);
    expect(toOwner).toHaveLength(1);
  } finally {
    voice.close();
  }
});
