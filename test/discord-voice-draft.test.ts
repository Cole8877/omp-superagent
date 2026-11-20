import { expect, spyOn, test } from "bun:test";
import {
  ChannelType, MessageFlags, MessageReferenceType, MessageType,
  type Message, type MessageCreateOptions, type MessageReference, type TextChannel,
} from "discord.js";
import { VoiceDrafts, type DraftReaction } from "../src/discord-voice-draft.ts";

const botId = "200";
const ownerId = "300";
const guildId = "400";
const channelId = "500";
const cardId = "600";
const postedAt = 1_000;
const confirm = "/voice confirm";
const work = "/restart is the term to look up in the source tree";

type ReplyFixture = {
  id: string;
  content: string;
  type: MessageType;
  editedTimestamp: number | null;
  createdTimestamp: number;
  webhookId: string | null;
  author: { id: string; bot: boolean };
  client: { user: { id: string } };
  channelId: string;
  guildId: string | null;
  reference: MessageReference | null;
  attachments: ReadonlySet<string>;
  stickers: ReadonlySet<string>;
  messageSnapshots: ReadonlySet<string>;
};

const replyReference: MessageReference = { messageId: cardId, channelId, guildId, type: MessageReferenceType.Default };

function reply(patch: Partial<ReplyFixture> = {}): Message {
  const fields: ReplyFixture = {
    id: "700", content: confirm, type: MessageType.Reply, editedTimestamp: null, createdTimestamp: postedAt + 1,
    webhookId: null, author: { id: ownerId, bot: false }, client: { user: { id: botId } },
    channelId, guildId, reference: replyReference,
    attachments: new Set(), stickers: new Set(), messageSnapshots: new Set(), ...patch,
  };
  return fields as unknown as Message;
}

function fixture(delivery?: Promise<void>, receiptChannelId = channelId) {
  const sent: Array<MessageCreateOptions & { id: string }> = [];
  const channel = {
    id: channelId, guildId, type: ChannelType.GuildText, client: { user: { id: botId } },
    async send(payload: MessageCreateOptions) {
      const id = String(Number(cardId) + sent.length);
      sent.push({ ...payload, id });
      await delivery;
      return {
        id, author: { id: botId, bot: true },
        channelId: receiptChannelId, guildId, content: payload.content, createdTimestamp: postedAt,
      };
    },
  } as unknown as TextChannel;
  const drafts = new VoiceDrafts();
  const session = new AbortController();
  const propose = (text = work) => drafts.propose(channel, ownerId, text, session.signal);
  return { drafts, sent, session, propose };
}

test("uses the sent card identity and turns the owner's written reply into ordinary one-shot work", async () => {
  const { drafts, propose } = fixture();
  await propose();

  const input = drafts.consume(reply());

  expect(input).toMatch(/voice session.*confirmed by the owner in writing/);
  expect(input).toMatch(/not a slash command, native control, or approval/);
  expect(input?.endsWith(`\n\n${work}`)).toBe(true);
  expect(drafts.consume(reply())).toBeNull();
});

const invalidReplies: readonly (readonly [string, Partial<ReplyFixture>])[] = [
  ["other owner", { author: { id: "301", bot: false } }],
  ["bot author", { author: { id: ownerId, bot: true } }],
  ["webhook author", { webhookId: "800" }],
  ["other bot account", { client: { user: { id: "201" } } }],
  ["other guild", { guildId: "401" }],
  ["other channel", { channelId: "501" }],
  ["DM", { guildId: null }],
  ["non-reply", { type: MessageType.Default }],
  ["missing reference", { reference: null }],
  ["other referenced card", { reference: { ...replyReference, messageId: "601" } }],
  ["other referenced channel", { reference: { ...replyReference, channelId: "501" } }],
  ["other referenced guild", { reference: { ...replyReference, guildId: "401" } }],
  ["forward reference", { reference: { ...replyReference, type: MessageReferenceType.Forward } }],
  ["forwarded snapshot", { messageSnapshots: new Set(["800"]) }],
  ["edited reply", { editedTimestamp: postedAt + 2 }],
  ["reply predating the card", { createdTimestamp: postedAt - 1 }],
  ["confirmation with leading whitespace", { content: ` ${confirm}` }],
  ["confirmation with trailing newline", { content: `${confirm}\n` }],
  ["different case", { content: "/VOICE confirm" }],
  ["additional text", { content: `${confirm} and deploy` }],
  ["attachment", { attachments: new Set(["800"]) }],
  ["sticker", { stickers: new Set(["800"]) }],
];

for (const [violation, patch] of invalidReplies) {
  test(`does not consume a draft on ${violation}`, async () => {
    const { drafts, propose } = fixture();
    await propose();

    expect(drafts.consume(reply(patch))).toBeNull();
    expect(drafts.consume(reply())).not.toBeNull();
  });
}

test("rejects a replay of the old confirmation even after a new card is posted", async () => {
  const { drafts, propose, sent } = fixture();
  await propose();
  drafts.consume(reply());
  await propose("Inspect the build state");

  expect(drafts.consume(reply())).toBeNull();
  expect(sent).toHaveLength(2);
  expect(drafts.consume(reply({ id: "701", reference: { ...replyReference, messageId: sent[1].id } }))).toContain("Inspect the build state");
});

test("allows only one unconfirmed card both during send and after Discord returns", async () => {
  const delivery = Promise.withResolvers<void>();
  const { drafts, sent, propose } = fixture(delivery.promise);
  const first = propose();
  try {
    await expect(propose()).rejects.toThrow("already outstanding");
    expect(drafts.consume(reply())).toBeNull();
  } finally {
    delivery.resolve();
    await first;
  }

  await expect(propose("Try replacing the work")).rejects.toThrow("already outstanding");
  expect(sent).toHaveLength(1);
  expect(drafts.consume(reply())).toContain(work);
});

test("does not retry or infer a card ID after an ambiguous Discord send", async () => {
  const delivery = Promise.withResolvers<void>();
  const { drafts, sent, propose } = fixture(delivery.promise);
  const pending = propose();
  delivery.reject(new Error("request timed out"));

  await expect(pending).rejects.toThrow("delivery is uncertain");
  await expect(propose()).rejects.toThrow("already outstanding");
  expect(sent).toHaveLength(1);
  expect(drafts.consume(reply())).toBeNull();
});

test("does not bind a Discord receipt from outside the original channel", async () => {
  const { drafts, propose } = fixture(undefined, "501");

  await expect(propose()).rejects.toThrow("did not verify");
  expect(drafts.consume(reply())).toBeNull();
});

test("a card cannot be confirmed at its expiry even though the session remains active", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(500);
  try {
    const { drafts, session, propose, sent } = fixture();
    await propose();
    clock.mockReturnValue(500 + 5 * 60 * 1000);

    expect(drafts.consume(reply())).toBeNull();
    expect(session.signal.aborted).toBe(false);
    await propose();
    expect(sent).toHaveLength(2);
  } finally {
    clock.mockRestore();
  }
});

test("aborting the live session invalidates its card and prevents new sends", async () => {
  const { drafts, sent, session, propose } = fixture();
  await propose();
  session.abort();

  expect(drafts.consume(reply())).toBeNull();
  await expect(propose()).rejects.toThrow();
  expect(sent).toHaveLength(1);
});

test("clearing a session while Discord is sending cannot activate its late card", async () => {
  const delivery = Promise.withResolvers<void>();
  const { drafts, propose } = fixture(delivery.promise);
  const pending = propose();
  drafts.clear();
  delivery.resolve();

  await expect(pending).rejects.toThrow("no longer active");
  expect(drafts.consume(reply())).toBeNull();
});

test("renders proposal content literally and disables Discord mentions and embeds", async () => {
  const { drafts, sent, propose } = fixture();
  const injection = "```\n@everyone <@300> <#500> [fake control](https://example.test)\n\u202E\u{E0061}\u{E0100}";

  await propose(injection);

  expect(sent[0]).toMatchObject({ allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds });
  const content = sent[0]?.content;
  expect(content?.match(/^```$/gm)).toHaveLength(2);
  expect(content).not.toContain("\u202E");
  expect(content).toContain("\\u{202e}\\u{e0061}\\u{e0100}");
  expect(content).toContain(`\n\`\`\`\nTo submit`);
  expect(content).toContain(`\`${confirm}\``);
  expect(drafts.consume(reply())?.endsWith(injection)).toBe(true);
});

test("rejects empty, raw oversize, and rendered oversize proposals without posting a partial draft", async () => {
  const { sent, propose } = fixture();

  await expect(propose(" \n")).rejects.toThrow("empty");
  await expect(propose("a".repeat(2_001))).rejects.toThrow("too long");
  await expect(propose("`".repeat(400))).rejects.toThrow("too long");
  expect(sent).toHaveLength(0);
});

const check: DraftReaction = { messageId: cardId, channelId, guildId, userId: ownerId, userIsBot: false, emoji: "\u2705" };

test("the owner's check-mark reaction on the exact card submits the same one-shot work as a written reply", async () => {
  const { drafts, propose, sent } = fixture();
  await propose();

  expect(sent[0]?.content).toContain("react to this message with \u2705");
  const input = drafts.consumeReaction(check);
  expect(input).toMatch(/voice session.*confirmed by the owner in writing/);
  expect(input?.endsWith(`\n\n${work}`)).toBe(true);
  expect(drafts.consumeReaction(check)).toBeNull();
  expect(drafts.consume(reply())).toBeNull();
});

const invalidReactions: readonly (readonly [string, Partial<DraftReaction>])[] = [
  ["other user", { userId: "301" }],
  ["bot user", { userIsBot: true }],
  ["other emoji", { emoji: "\u{1F44D}" }],
  ["custom emoji", { emoji: null }],
  ["other message", { messageId: "601" }],
  ["other channel", { channelId: "501" }],
  ["other guild", { guildId: "401" }],
  ["DM", { guildId: null }],
];

for (const [violation, patch] of invalidReactions) {
  test(`does not consume a draft on a reaction from ${violation}`, async () => {
    const { drafts, propose } = fixture();
    await propose();

    expect(drafts.consumeReaction({ ...check, ...patch })).toBeNull();
    expect(drafts.consumeReaction(check)).not.toBeNull();
  });
}

test("a reaction cannot confirm an expired, consumed or cleared card, or one that is still being sent", async () => {
  const delivery = Promise.withResolvers<void>();
  const sending = fixture(delivery.promise);
  const pending = sending.propose();
  expect(sending.drafts.consumeReaction(check)).toBeNull();
  delivery.resolve();
  await pending;
  expect(sending.drafts.consumeReaction(check)).not.toBeNull();

  const clock = spyOn(Date, "now").mockReturnValue(500);
  try {
    const { drafts, propose } = fixture();
    await propose();
    clock.mockReturnValue(500 + 5 * 60 * 1000);
    expect(drafts.consumeReaction(check)).toBeNull();
  } finally {
    clock.mockRestore();
  }

  const replied = fixture();
  await replied.propose();
  replied.drafts.consume(reply());
  expect(replied.drafts.consumeReaction(check)).toBeNull();

  const closed = fixture();
  await closed.propose();
  closed.session.abort();
  expect(closed.drafts.consumeReaction(check)).toBeNull();
});
