import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import {
  col,
  type Component,
  type KeybindingsManager,
  type KeyId,
  matchesKey,
  type NativeNode,
  type NativeUiEvent,
  span,
  text,
  type Theme,
  type TUI,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import { actionBar, actionButton } from "@oh-my-pi/pi-tui/native/overlay";
import {
  changeCount,
  type DiffPart,
  extractRewrite,
  firstPassPrompt,
  type Intensity,
  nextPassPrompt,
  type PolishConfig,
  readConfig,
  sameText,
  wordDiff,
} from "./polish";

const PLUGIN = "prompt-polish";
const PASS_TIMEOUT_MS = 120_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Terminal control characters from model output must never reach the screen; keep newlines and tabs.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

async function loadConfig(cwd: string): Promise<{ config: PolishConfig; warnings: string[] }> {
  try {
    return readConfig(await getPluginSettings(PLUGIN, cwd));
  } catch (error) {
    const { config } = readConfig({});
    return { config, warnings: [`cannot read settings (${error instanceof Error ? error.message : String(error)})`] };
  }
}

interface Candidate {
  text: string;
  edited: boolean;
}

/** One polishing run: the draft, every candidate so far, and the side-turn lineage for follow-up passes. */
class PolishRun {
  readonly candidates: Candidate[] = [];
  index = -1;
  #history: Message[] = [];
  #conversationKey = crypto.randomUUID();

  constructor(
    private readonly ctx: ExtensionContext,
    readonly draft: string,
    readonly intensity: Intensity,
    private readonly lifetime: AbortSignal,
  ) {}

  get current(): Candidate | undefined {
    return this.candidates[this.index];
  }

  add(textValue: string, edited: boolean): void {
    this.candidates.push({ text: textValue, edited });
    this.index = this.candidates.length - 1;
  }

  async pass(notes: string, signal: AbortSignal): Promise<void> {
    const current = this.current;
    const promptText = current ? nextPassPrompt(current.text, notes, this.intensity) : firstPassPrompt(this.draft, this.intensity);
    const timeout = AbortSignal.timeout(PASS_TIMEOUT_MS);
    try {
      const { replyText, assistantMessage } = await this.ctx.runEphemeralTurn!({
        promptText,
        history: this.#history,
        conversationKey: this.#conversationKey,
        // Tool definitions stay so the side turn reuses the conversation's prompt cache; calls are discarded.
        minimizeEffort: true,
        dedupeReply: false,
        replyMaxBytes: Infinity,
        signal: AbortSignal.any([signal, this.lifetime, timeout]),
      });
      if (assistantMessage.stopReason === "error" || assistantMessage.stopReason === "aborted") {
        throw new Error(assistantMessage.errorMessage ?? `The request ${assistantMessage.stopReason === "error" ? "failed" : "was aborted"}.`);
      }
      const extracted = extractRewrite(replyText);
      if (!extracted.ok) throw new Error(failureReason(extracted.reason, assistantMessage));
      this.#history.push({ role: "user", content: promptText, timestamp: Date.now() }, assistantMessage);
      this.add(extracted.text, false);
    } catch (error) {
      // A failed or cancelled request must not anchor the next attempt to its provider lineage.
      this.#conversationKey = crypto.randomUUID();
      if (timeout.aborted && !signal.aborted) throw new Error(`No rewrite within ${PASS_TIMEOUT_MS / 1000} s.`);
      throw error;
    }
  }
}

function failureReason(reason: string, message: AssistantMessage): string {
  if (message.content.some(part => part.type === "toolCall")) return `${reason} The model tried to call a tool instead.`;
  if (message.stopReason === "length") return `${reason} The output limit was reached.`;
  return reason;
}

type Outcome = "accept" | "edit" | "refine" | "cancel";
type ViewName = "rewrite" | "changes" | "original";
const VIEWS: readonly ViewName[] = ["rewrite", "changes", "original"];
const VIEW_LABELS: Record<ViewName, string> = { rewrite: "Rewrite", changes: "Changes", original: "Original" };

class PolishView implements Component {
  readonly nativeOverlay = { role: "omp.overlay.prompt-polish", head: "Polish prompt", size: "lg" } as const;
  #view: ViewName = "rewrite";
  #scroll = 0;
  #working: AbortController | undefined;
  #startedAt = 0;
  #timer: Timer | undefined;
  #notice: string | undefined;
  #diff: { candidate: Candidate; parts: DiffPart[] } | undefined;
  #closed = false;

  constructor(
    private readonly run: PolishRun,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (outcome: Outcome) => void,
    notes: string | undefined,
  ) {
    if (notes !== undefined) this.#start(notes);
  }

  #start(notes: string): void {
    const controller = new AbortController();
    this.#working = controller;
    this.#notice = undefined;
    this.#startedAt = Date.now();
    this.#timer = setInterval(() => this.tui.requestRender(), 100);
    this.run.pass(notes, controller.signal).then(
      () => {
        this.#view = "rewrite";
        this.#scroll = 0;
      },
      (error: unknown) => {
        if (controller.signal.aborted) this.#notice = "Cancelled; nothing changed.";
        else this.#notice = error instanceof Error ? error.message : String(error);
      },
    ).finally(() => {
      clearInterval(this.#timer);
      this.#working = undefined;
      if (this.#closed) return;
      // Cancelling the very first pass leaves nothing to review.
      if (controller.signal.aborted && !this.run.current) this.#close("cancel");
      else this.tui.requestRender();
    });
  }

  #close(outcome: Outcome): void {
    if (this.#closed) return;
    this.#closed = true;
    this.done(outcome);
  }

  dispose(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#working?.abort();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || this.keybindings.matches(data, "app.interrupt") || matchesKey(data, "q")) this.#act("cancel");
    else if (matchesKey(data, "enter") || matchesKey(data, "a")) this.#act("accept");
    else if (matchesKey(data, "e")) this.#act("edit");
    else if (matchesKey(data, "r")) this.#act("refine");
    else if (matchesKey(data, "b")) this.#act("previous");
    else if (matchesKey(data, "f")) this.#act("next");
    else if (matchesKey(data, "tab") || matchesKey(data, "v")) this.#act("cycle");
    else if (matchesKey(data, "d")) this.#act("view:changes");
    else if (matchesKey(data, "o")) this.#act("view:original");
    else if (matchesKey(data, "up") || matchesKey(data, "k")) this.#scroll = Math.max(0, this.#scroll - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.#scroll++;
    else if (matchesKey(data, "pageUp")) this.#scroll = Math.max(0, this.#scroll - this.#bodyRows());
    else if (matchesKey(data, "pageDown")) this.#scroll += this.#bodyRows();
    else if (matchesKey(data, "home")) this.#scroll = 0;
    else if (matchesKey(data, "end")) this.#scroll = Number.MAX_SAFE_INTEGER;
    this.tui.requestRender();
  }

  handleNativeEvent(event: NativeUiEvent): void {
    if (event.type === "action") this.#act(event.act);
    this.tui.requestRender();
  }

  #act(action: string): void {
    if (this.#working) {
      if (action === "cancel") this.#working.abort();
      return;
    }
    const current = this.run.current;
    if (action === "cancel") this.#close("cancel");
    else if (!current) {
      // Only the first pass failed: retry it in place.
      if (action === "refine" || action === "retry") this.#start("");
    } else if (action === "accept") this.#close("accept");
    else if (action === "edit") this.#close("edit");
    else if (action === "refine") this.#close("refine");
    else if (action === "previous" && this.run.index > 0) this.#select(this.run.index - 1);
    else if (action === "next" && this.run.index < this.run.candidates.length - 1) this.#select(this.run.index + 1);
    else if (action === "cycle") this.#show(VIEWS[(VIEWS.indexOf(this.#view) + 1) % VIEWS.length]!);
    else if (action.startsWith("view:")) this.#show(action.slice(5) as ViewName);
  }

  #select(index: number): void {
    this.run.index = index;
    this.#scroll = 0;
    this.#notice = undefined;
  }

  #show(view: ViewName): void {
    this.#view = view;
    this.#scroll = 0;
  }

  #diffParts(candidate: Candidate): DiffPart[] {
    if (this.#diff?.candidate !== candidate) this.#diff = { candidate, parts: wordDiff(this.run.draft, candidate.text) };
    return this.#diff.parts;
  }

  #meta(candidate: Candidate | undefined): string {
    const parts: string[] = [this.run.intensity];
    if (candidate && this.run.candidates.length > 1) parts.push(`${this.run.index + 1}/${this.run.candidates.length}`);
    if (candidate?.edited) parts.push("edited");
    if (candidate && sameText(candidate.text, this.run.draft)) parts.push("already good");
    return parts.join(" · ");
  }

  #bodyRows(): number {
    return Math.max(4, Math.floor(this.tui.terminal.rows * 0.9) - 8);
  }

  /** Styled physical lines of the active view, wrapped to `width`. */
  #bodyLines(candidate: Candidate, width: number): string[] {
    const { theme } = this;
    const logical: string[] = [""];
    const append = (value: string, style: (segment: string) => string) => {
      const pieces = value.replace(CONTROL, "").split("\n");
      pieces.forEach((piece, index) => {
        if (index > 0) logical.push("");
        if (piece) logical[logical.length - 1] += style(piece);
      });
    };
    if (this.#view === "changes") {
      for (const part of this.#diffParts(candidate)) {
        if (part.kind === "same") append(part.text, segment => segment);
        else if (part.kind === "add") append(part.text, segment => theme.fg("success", segment));
        else append(part.text, segment => theme.fg("error", theme.strikethrough(segment)));
      }
    } else {
      append(this.#view === "rewrite" ? candidate.text : this.run.draft, segment => segment);
    }
    return logical.flatMap(line => (line ? wrapTextWithAnsi(line, width) : [""]));
  }

  render(width: number): readonly string[] {
    const { theme } = this;
    const candidate = this.run.current;
    const lines = [
      truncateToWidth(`${theme.bold(theme.fg("accent", "Polish prompt"))}${theme.fg("dim", `  ${this.#meta(candidate)}`)}`, width),
    ];
    if (this.#working) {
      const elapsed = Date.now() - this.#startedAt;
      const frame = SPINNER[Math.floor(elapsed / 100) % SPINNER.length]!;
      lines.push(
        "",
        truncateToWidth(`${theme.fg("accent", frame)} Rewriting… ${theme.fg("dim", `${Math.floor(elapsed / 1000)} s`)}`, width),
        "",
        theme.fg("dim", "esc cancel"),
      );
      return lines;
    }
    if (!candidate) {
      lines.push(
        "",
        ...wrapTextWithAnsi(theme.fg("error", (this.#notice ?? "No rewrite.").replace(CONTROL, "")), width),
        "",
        theme.fg("dim", "r retry · esc close"),
      );
      return lines;
    }
    const changes = changeCount(this.#diffParts(candidate));
    lines.push(
      truncateToWidth(
        VIEWS.map(view => {
          const label = view === "changes" ? `${VIEW_LABELS[view]} (${changes})` : VIEW_LABELS[view];
          return view === this.#view ? theme.bold(theme.fg("accent", `[${label}]`)) : theme.fg("dim", ` ${label} `);
        }).join(" "),
        width,
      ),
      "",
    );
    const body = this.#bodyLines(candidate, Math.max(10, width));
    const rows = this.#bodyRows();
    this.#scroll = Math.min(this.#scroll, Math.max(0, body.length - rows));
    lines.push(...body.slice(this.#scroll, this.#scroll + rows));
    const position = body.length > rows ? `${this.#scroll + 1}–${Math.min(body.length, this.#scroll + rows)}/${body.length} · ` : "";
    const history = this.run.candidates.length > 1 ? " · b/f previous/next" : "";
    lines.push(
      "",
      truncateToWidth(
        this.#notice
          ? theme.fg("warning", this.#notice.replace(CONTROL, ""))
          : theme.fg("dim", `${position}enter use · e edit · r another pass · tab view${history} · esc keep original`),
        width,
      ),
    );
    return lines;
  }

  describe(): NativeNode {
    const candidate = this.run.current;
    const head = text([span("Polish prompt", "strong"), span(`  ${this.#meta(candidate)}`, "dim")]);
    if (this.#working) {
      return col([head, text([span("Rewriting…", "accent")]), actionBar([null, actionButton("Cancel", "cancel", { keys: "escape" })])], { gap: "md" });
    }
    if (!candidate) {
      return col(
        [
          head,
          text([span((this.#notice ?? "No rewrite.").replace(CONTROL, ""), "error")]),
          actionBar([actionButton("Retry", "retry", { keys: "r", tone: "accent" }), null, actionButton("Close", "cancel", { keys: "escape" })]),
        ],
        { gap: "md" },
      );
    }
    const changes = changeCount(this.#diffParts(candidate));
    const views = actionBar(
      VIEWS.map(view =>
        actionButton(view === "changes" ? `${VIEW_LABELS[view]} (${changes})` : VIEW_LABELS[view], `view:${view}`, {
          key: `view-${view}`,
          tone: view === this.#view ? "accent" : undefined,
        }),
      ),
      "views",
    );
    const body =
      this.#view === "changes"
        ? text(
            this.#diffParts(candidate).map(part =>
              span(part.text.replace(CONTROL, ""), part.kind === "add" ? "success" : part.kind === "del" ? "error del" : undefined),
            ),
          )
        : text((this.#view === "rewrite" ? candidate.text : this.run.draft).replace(CONTROL, ""));
    const buttons: (NativeNode | null)[] = [];
    if (this.run.candidates.length > 1) {
      buttons.push(
        actionButton("Previous", "previous", { keys: "b", disabled: this.run.index > 0 ? undefined : "First candidate" }),
        actionButton("Next", "next", { keys: "f", disabled: this.run.index < this.run.candidates.length - 1 ? undefined : "Latest candidate" }),
      );
    }
    buttons.push(
      actionButton("Edit", "edit", { keys: "e" }),
      actionButton("Another pass", "refine", { keys: "r" }),
      null,
      actionButton("Keep original", "cancel", { keys: "escape" }),
      actionButton("Use rewrite", "accept", { keys: "enter", tone: "accent" }),
    );
    return col(
      [head, views, body, ...(this.#notice ? [text([span(this.#notice.replace(CONTROL, ""), "warning")])] : []), actionBar(buttons)],
      { gap: "md" },
    );
  }
}

export default async function promptPolish(pi: ExtensionAPI) {
  const startup = await loadConfig(process.cwd());
  const shortcut = startup.config.shortcut;
  let lifetime = new AbortController();
  let busy = false;
  let lastReplacement: { previous: string; inserted: string } | undefined;

  async function polish(ctx: ExtensionContext, draft: string): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify("prompt-polish needs the interactive TUI.", "warning");
      return;
    }
    if (!ctx.runEphemeralTurn) {
      ctx.ui.notify("This OMP session cannot run side turns, so prompt-polish is unavailable.", "error");
      return;
    }
    if (!draft.trim()) {
      ctx.ui.notify(`Type a draft first, then press ${shortcut} (or run /polish <draft>).`, "info");
      return;
    }
    if (busy) {
      ctx.ui.notify("A polish is already open.", "warning");
      return;
    }
    busy = true;
    try {
      const { config, warnings } = await loadConfig(ctx.cwd);
      if (warnings.length) ctx.ui.notify(`prompt-polish settings: ${warnings.join("; ")}; using defaults.`, "warning");
      // What the editor holds now; accepting replaces it only if it is still unchanged.
      const expectedEditor = ctx.ui.getEditorText();
      const run = new PolishRun(ctx, draft, config.intensity, lifetime.signal);
      let notes: string | undefined = "";
      for (;;) {
        if (lifetime.signal.aborted) return;
        const pending = notes;
        notes = undefined;
        const outcome = await ctx.ui.custom<Outcome>(
          (tui, theme, keybindings, done) => new PolishView(run, tui, theme, keybindings, done, pending),
          { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%" } },
        );
        const candidate = run.current;
        if (outcome === "cancel" || !candidate) return;
        if (outcome === "edit") {
          const edited = await ctx.ui.editor("Edit rewrite", candidate.text);
          if (edited !== undefined && edited.trim() && edited !== candidate.text) run.add(edited, true);
          continue;
        }
        if (outcome === "refine") {
          notes = await ctx.ui.input("Another pass", "What should change? Leave empty for a different take.");
          continue;
        }
        const current = ctx.ui.getEditorText();
        if (current === candidate.text) {
          ctx.ui.notify("The editor already holds this text; nothing changed.", "info");
          return;
        }
        if (
          current !== expectedEditor &&
          !(await ctx.ui.confirm("Replace editor text?", "The editor changed since polishing started. Replace it with the rewrite?"))
        ) {
          continue;
        }
        ctx.ui.setEditorText(candidate.text);
        lastReplacement = { previous: current, inserted: candidate.text };
        ctx.ui.notify("Rewrite placed in the editor, not sent. /polish-undo restores the previous text.", "info");
        return;
      }
    } finally {
      busy = false;
    }
  }

  pi.registerShortcut(shortcut as KeyId, {
    description: "Polish the draft in the editor into a clearer prompt",
    handler: ctx => polish(ctx, ctx.ui.getEditorText()),
  });

  pi.registerCommand("polish", {
    description: "Rewrite a draft into a clearer prompt and review it before use",
    handler: (args, ctx) => polish(ctx, args),
  });

  pi.registerCommand("polish-undo", {
    description: "Put back the editor text the last accepted rewrite replaced",
    handler: async (_args, ctx) => {
      const replacement = lastReplacement;
      if (!replacement) {
        ctx.ui.notify("No rewrite to undo in this session.", "info");
        return;
      }
      const current = ctx.ui.getEditorText();
      // Typing the command usually empties the editor; anything else is newer work worth confirming.
      if (
        current.trim() &&
        current !== replacement.inserted &&
        !(await ctx.ui.confirm("Restore previous draft?", "The editor holds other text. Replace it with the draft from before the rewrite?"))
      ) {
        return;
      }
      ctx.ui.setEditorText(replacement.previous);
      lastReplacement = undefined;
    },
  });

  pi.on("session_start", (_event, ctx) => {
    lifetime = new AbortController();
    if (ctx.agent.kind !== "main" || !ctx.hasUI) return;
    if (startup.warnings.length) ctx.ui.notify(`prompt-polish settings: ${startup.warnings.join("; ")}; using defaults.`, "warning");
    const conflict = pi.getShortcutConflict(shortcut as KeyId);
    if (conflict) {
      ctx.ui.notify(`prompt-polish shortcut ${shortcut} is taken (${conflict.kind}); use /polish or set another shortcut.`, "warning");
    }
  });

  pi.on("session_shutdown", () => {
    lifetime.abort();
    lastReplacement = undefined;
  });
}
