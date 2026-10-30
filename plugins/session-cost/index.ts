import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
  type Component,
  type KeybindingsManager,
  matchesKey,
  type Theme,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import { buildReport, type CostReport } from "./report";
import { loadTranscripts } from "./transcripts";
import { formatCost, type Page, rootPage, textSummary } from "./view";

const COST_COLUMN = 11;
const FOOTER = "↑↓ move · enter open · ← back · r refresh · esc close";

async function collectReport(ctx: ExtensionCommandContext): Promise<CostReport> {
  const sessions = ctx.sessionManager;
  const mainFile = sessions.getSessionFile() ?? undefined;
  const artifacts = sessions.getArtifactsDir() ?? (mainFile?.endsWith(".jsonl") ? mainFile.slice(0, -".jsonl".length) : undefined);
  const transcripts = artifacts ? await loadTranscripts(artifacts) : [];
  // Same-process registry: the only live signal that a transcript is still being written.
  const running = new Set<string>();
  for (const ref of AgentRegistry.global().list()) {
    if (ref.status === "running" && ref.sessionFile) running.add(path.resolve(ref.sessionFile));
  }
  return buildReport({
    mainEntries: sessions.getEntries(),
    mainBranch: sessions.getBranch(),
    mainFile,
    transcripts,
    isRunning: file => running.has(path.resolve(file)),
  });
}

interface Frame {
  page: Page;
  selected: number;
  offset: number;
}

class CostView implements Component {
  #stack: Frame[];
  #notice: string | undefined;

  constructor(
    report: CostReport,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: () => void,
    private readonly reload: () => Promise<CostReport>,
  ) {
    this.#stack = [{ page: rootPage(report), selected: 0, offset: 0 }];
  }

  get #frame(): Frame {
    return this.#stack[this.#stack.length - 1]!;
  }

  handleInput(data: string): void {
    const frame = this.#frame;
    const last = frame.page.rows.length - 1;
    const page = this.#rowCapacity();
    if (this.keybindings.matches(data, "app.interrupt") || matchesKey(data, "q")) {
      this.done();
    } else if (matchesKey(data, "escape")) {
      if (this.#stack.length > 1) this.#stack.pop();
      else this.done();
    } else if (matchesKey(data, "left") || matchesKey(data, "backspace")) {
      if (this.#stack.length > 1) this.#stack.pop();
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      frame.selected = Math.max(0, frame.selected - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      frame.selected = Math.min(last, frame.selected + 1);
    } else if (matchesKey(data, "pageUp")) {
      frame.selected = Math.max(0, frame.selected - page);
    } else if (matchesKey(data, "pageDown")) {
      frame.selected = Math.min(last, frame.selected + page);
    } else if (matchesKey(data, "home")) {
      frame.selected = 0;
    } else if (matchesKey(data, "end")) {
      frame.selected = Math.max(0, last);
    } else if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      const open = frame.page.rows[frame.selected]?.open;
      if (open) this.#stack.push({ page: open(), selected: 0, offset: 0 });
    } else if (matchesKey(data, "r")) {
      this.#notice = "Refreshing…";
      this.reload().then(
        report => {
          this.#stack = [{ page: rootPage(report), selected: 0, offset: 0 }];
          this.#notice = undefined;
          this.tui.requestRender();
        },
        (error: unknown) => {
          this.#notice = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
          this.tui.requestRender();
        },
      );
    }
  }

  #rowCapacity(): number {
    return Math.max(5, Math.min(20, this.tui.terminal.rows - this.#frame.page.header.length - 8));
  }

  render(width: number): readonly string[] {
    const { theme } = this;
    const frame = this.#frame;
    const { page } = frame;
    const lines = [
      truncateToWidth(theme.bold(theme.fg("accent", this.#stack.map(item => item.page.title).join(" › "))), width),
      ...page.header.map(line => truncateToWidth(theme.fg("muted", line), width)),
      "",
    ];
    const capacity = this.#rowCapacity();
    if (frame.selected < frame.offset) frame.offset = frame.selected;
    if (frame.selected >= frame.offset + capacity) frame.offset = frame.selected - capacity + 1;
    const textWidth = Math.max(10, width - 2 - COST_COLUMN - 1);
    for (let index = frame.offset; index < Math.min(page.rows.length, frame.offset + capacity); index++) {
      const row = page.rows[index]!;
      const selected = index === frame.selected;
      const label = truncateToWidth(row.label + (row.open ? " ›" : ""), textWidth);
      const room = textWidth - visibleWidth(label);
      const detail = row.detail && room > 6 ? truncateToWidth(`  ${row.detail}`, room) : "";
      const padding = " ".repeat(Math.max(0, room - visibleWidth(detail)));
      const styledLabel = selected ? theme.bold(theme.fg("accent", label)) : row.muted ? theme.fg("dim", label) : label;
      const cost = (row.cost === undefined ? "" : formatCost(row.cost)).padStart(COST_COLUMN);
      lines.push(
        truncateToWidth(
          `${selected ? theme.fg("accent", "❯ ") : "  "}${styledLabel}${theme.fg("dim", detail)}${padding} ${row.muted ? theme.fg("dim", cost) : cost}`,
          width,
        ),
      );
    }
    if (page.rows.length === 0 && page.empty) lines.push(theme.fg("dim", truncateToWidth(page.empty, width)));
    const position = page.rows.length > capacity ? `${frame.selected + 1}/${page.rows.length} · ` : "";
    lines.push("", truncateToWidth(theme.fg("dim", this.#notice ?? `${position}${FOOTER}`), width));
    return lines;
  }
}

export default function sessionCost(pi: ExtensionAPI) {
  pi.registerCommand("cost", {
    description: "Session cost by main chat, turns, calls, subagents, and advisors",
    handler: async (_args, ctx) => {
      const report = await collectReport(ctx);
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify(textSummary(report), "info");
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keybindings, done) =>
          new CostView(report, tui, theme, keybindings, () => done(), () => collectReport(ctx)),
      );
    },
  });
}
