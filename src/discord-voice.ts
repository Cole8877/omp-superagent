import { ChannelType, MessageType, type Message, type TextChannel } from "discord.js";
import type { DiscordVoiceConfig } from "./config";
import { routeKey, type Inbound, type Lane, type OutputRecord } from "./contracts";
import { CONTEXT_MESSAGES, headReplyContext, startContext, type ContextMessage } from "./discord-voice-context";
import { VOICE_DRAFT_HEADER, VoiceDrafts, type DraftReaction } from "./discord-voice-draft";
import type { openVoiceLink } from "./discord-voice-link";
import type { openLive } from "./openai-live";
import type { openCodexLive } from "./codex-live";

// Keep codecs and the provider out of setup, login, and ordinary text traffic.
const connectDiscord: typeof openVoiceLink = async (...args) =>
  (await import("./discord-voice-link")).openVoiceLink(...args);
const connectProvider: typeof openLive = async (...args) =>
  (await import("./openai-live")).openLive(...args);
const connectSubscription: typeof openCodexLive = async (...args) =>
  (await import("./codex-live")).openCodexLive(...args);

/** Read-only HEAD state a headContext voice session may share; credentials are redacted from it. */
export type VoiceHeadSource = { readonly lanes: () => readonly Lane[]; readonly secrets: readonly string[] };

/** Gateway-authored notices are not HEAD output; keep them out of the shared conversation. */
const NOTICE = /^(?:Voice (?:ready|is off|stopped|session ended)|A voice session|Start subscription voice|For one minute|Use \/voice|No matching active voice draft|Join the configured voice|A separate voice provider key|Could not open)/;

/** One explicitly started session on the existing Gateway client. No background rejoin or paid retries. */
export class DiscordVoice {
  private session?: AbortController;
  private readonly drafts: VoiceDrafts;
  private readonly awaitingText = new Map<string, string>();
  private notifyReply?: (text?: string) => void;
  private lastCommand = 0n;
  private readonly startedAt = Date.now();

  constructor(private readonly config: DiscordVoiceConfig, private readonly owner: string,
    private readonly apiKey: string | undefined, private readonly report: (error: unknown) => void, private readonly link = connectDiscord,
    private readonly live = connectProvider, private readonly subscription = connectSubscription,
    private readonly head?: VoiceHeadSource) {
    this.drafts = new VoiceDrafts(config.headContext === true);
  }

  static isControl(text: string): boolean { return /^\/voice(?:\s|$)/i.test(text.trim()); }

  /** Only called for authorized, original MessageCreate events, never catchup or edits. */
  command(message: Message, input: Inbound): string | null {
    if (message.author.bot || message.author.id !== this.owner || message.webhookId || message.editedTimestamp !== null ||
      (message.type !== MessageType.Default && message.type !== MessageType.Reply) || message.channel.type !== ChannelType.GuildText ||
      message.channelId !== this.config.textChannelId || message.createdTimestamp < this.startedAt ||
      !/^\d{1,20}$/.test(message.id)) return null;
    const sequence = BigInt(message.id);
    if (sequence <= this.lastCommand) return null;
    this.lastCommand = sequence;
    const channel = message.channel;
    const control = message.content.trim();
    if (control === "/voice confirm") {
      const work = this.drafts.consume(message);
      if (work) this.awaitingText.set(input.id, routeKey(input.route));
      if (!work) this.notice(channel, "No matching active voice draft. Reply to the current draft, or write the request directly.");
      return work;
    }
    if (message.type !== MessageType.Default || message.reference || message.attachments.size) return null;
    if (control === "/voice stop") {
      this.close();
      this.notice(channel, "Voice is off.");
    } else if (control === "/voice start") {
      if (this.session) this.notice(channel, "A voice session is already starting or active.");
      else void this.start(channel).catch(() => this.report(new Error("Discord voice startup failed")));
    } else this.notice(channel, this.config.auth === "subscription"
      ? "Use /voice start or /voice stop. A work request you speak is posted here as a draft; react \u2705 to it or reply /voice confirm to submit it."
      : "Use /voice start or /voice stop. Voice uses paid OpenAI Live audio.");
    return null;
  }

  /**
   * Only called for a fresh reaction-add by the configured text channel's allowlisted guild. Returns the confirmed
   * work for head intake, or null when the reaction is not the owner's \u2705 on the one active, unexpired draft.
   */
  reaction(reaction: DraftReaction, input: Inbound): string | null {
    if (reaction.channelId !== this.config.textChannelId || reaction.userId !== this.owner) return null;
    const work = this.drafts.consumeReaction(reaction);
    if (work) this.awaitingText.set(input.id, routeKey(input.route));
    return work;
  }

  private async start(text: TextChannel): Promise<void> {
    const session = new AbortController();
    this.session = session;
    const { signal } = session;
    const finish = (reason: string) => {
      if (this.session !== session) return;
      this.close();
      this.notice(text, reason);
    };
    const timer = setTimeout(() => finish("Voice stopped at the configured session time limit."),
      this.config.maxSessionSeconds * 1000);
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    try {
      const config = this.config;
      let connect: (handlers: Parameters<typeof openLive>[1], headContext?: string) => ReturnType<typeof openLive>;
      if (config.auth === "subscription") {
        connect = (handlers, headContext) => this.subscription({ voice: config.voice, headContext }, handlers, signal);
      } else {
        const apiKey = this.apiKey;
        if (!apiKey) { finish("A separate voice provider key is required. No Live session was opened."); return; }
        connect = (handlers, headContext) => this.live(
          { model: config.model, backendModel: config.backendModel, voice: config.voice, apiKey, headContext }, handlers, signal);
      }
      const channel = await text.guild.channels.fetch(this.config.channelId);
      if (signal.aborted) return;
      if (channel?.type !== ChannelType.GuildVoice || channel.guildId !== text.guildId ||
        text.guild.voiceStates.cache.get(this.owner)?.channelId !== channel.id) {
        finish("Join the configured voice channel in this server before starting voice."); return;
      }
      let provider: Awaited<ReturnType<typeof openLive>> | undefined;
      const ended = () => finish("Voice session ended. Use /voice start to open a new session.");
      const activeLink = await this.link(channel, this.owner, {
        audio: pcm => { if (!signal.aborted) provider?.input(pcm); },
        ended,
      }, signal);
      if (signal.aborted) { activeLink.close(); return; }
      const headContext = config.headContext && this.head ? await this.snapshot(text, this.head) : undefined;
      if (signal.aborted) { activeLink.close(); return; }
      provider = await connect({
        audio: pcm => { if (!signal.aborted) activeLink.play(pcm); },
        interrupt: () => activeLink.clear(), ended,
        forward: async request => {
          signal.throwIfAborted();
          await this.drafts.propose(text, this.owner, request, signal);
          return "Draft posted for written confirmation. Not yet submitted to HEAD or executed.";
        },
      }, headContext);
      if (signal.aborted) { provider.close(); return; }
      this.notifyReply = reply => provider?.notifyHeadReply(reply);
      const shared = headContext === undefined ? ""
        : " Recent text in this channel and open lane titles/states were also sent to OpenAI, and HEAD's replies here will be while voice is on.";
      this.notice(text, (config.auth === "subscription"
        ? "Voice ready. Audio goes to OpenAI using your Codex subscription."
        : "Voice ready. Your audio goes to OpenAI Live.") +
        " A work request you speak is posted here as a draft; react \u2705 to it or reply /voice confirm to submit it. Use /voice stop to disconnect." + shared);
    } catch {
      // Never send SDK errors, bearer headers, owner audio, or transcripts to Discord/logs.
      finish(this.config.auth === "subscription"
        ? "Could not open Codex subscription voice. Check the voice bridge, subscription login, voice access and Discord channel. No API fallback."
        : "Could not open voice. Check channel membership, permissions, voice dependencies and provider settings. No automatic retry.");
    }
  }

  /** Bounded recent owner/HEAD text plus open lane status; a failed read degrades to what is available. */
  private async snapshot(text: TextChannel, head: VoiceHeadSource): Promise<string> {
    const messages: ContextMessage[] = [];
    try {
      const botId = text.client.user?.id;
      for (const message of [...(await text.messages.fetch({ limit: CONTEXT_MESSAGES })).values()].reverse()) {
        if (message.webhookId || !message.content ||
          (message.type !== MessageType.Default && message.type !== MessageType.Reply)) continue;
        if (message.author.id === this.owner && !message.author.bot) {
          if (!DiscordVoice.isControl(message.content)) messages.push({ from: "owner", text: message.content });
        } else if (botId && message.author.id === botId && !message.content.startsWith(VOICE_DRAFT_HEADER) &&
          !NOTICE.test(message.content)) messages.push({ from: "HEAD", text: message.content });
      }
    } catch {
      this.report(new Error("Voice HEAD context could not read recent channel messages"));
    }
    let lanes: readonly Lane[] = [];
    try {
      lanes = head.lanes();
    } catch {
      this.report(new Error("Voice HEAD context could not read lane status"));
    }
    return startContext(messages, lanes, head.secrets);
  }

  private notice(channel: TextChannel, content: string): void {
    void channel.send({ content, allowedMentions: { parse: [] } }).catch(() => this.report(new Error("Discord voice notice delivery failed")));
  }

  textDelivered(output: OutputRecord): void {
    const confirmed = this.awaitingText.get(output.sourceId) === routeKey(output.route);
    if (confirmed) this.awaitingText.delete(output.sourceId);
    let reply: string | undefined;
    if (this.config.headContext && this.head) {
      const { route } = output;
      if (route.platform !== "discord" || route.channelId !== this.config.textChannelId || route.threadId !== null) return;
      reply = headReplyContext(output.text, this.head.secrets) ?? undefined;
    } else if (!confirmed) return;
    // Discord delivery succeeded; a best-effort spoken notice cannot change that outcome.
    try { this.notifyReply?.(reply); } catch { this.report(new Error("Voice reply notification failed")); }
  }

  close(): void {
    const session = this.session;
    this.session = undefined;
    this.notifyReply = undefined;
    this.awaitingText.clear();
    session?.abort();
    this.drafts.clear();
  }
}
