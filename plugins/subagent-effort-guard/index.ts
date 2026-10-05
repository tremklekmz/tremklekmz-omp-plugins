import { getSupportedEfforts, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import { logger, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { approvalChoices, effectiveLimit, rank, readConfig, requiresApproval, safeTarget, type Config, type Level } from "./policy";

const PLUGIN = "subagent-effort-guard";
// Prepared factories share this module, but each getter remains bound to its own session.
interface ApprovalUI {
  context: ExtensionUIContext;
  tail: Promise<void>;
}
interface Binding {
  effort: () => Level | undefined;
  ui?: ApprovalUI;
}
const bindings = new Map<string, Binding>();
const APPROVAL_TIMEOUT_MS = 20_000;

function actualLevel(pi: ExtensionAPI, ctx: ExtensionContext): Level | undefined {
  const level = pi.getThinkingLevel();
  if (level === "off" || THINKING_EFFORTS.includes(level as never)) return level as Level;
  return ctx.model && !ctx.model.reasoning ? "off" : undefined;
}

function supportedLevels(ctx: ExtensionContext): Level[] {
  const model = ctx.model;
  if (!model) return [];
  if (!model.reasoning) return ["off"];
  const efforts = getSupportedEfforts(model);
  // No controllable surface is not evidence that reasoning can be switched off.
  if (efforts.length === 0) return [];
  return model.thinking?.requiresEffort ? [...efforts] : ["off", ...efforts];
}

export default function effortGuard(pi: ExtensionAPI) {
  let config: Config = { mode: "auto", maxAutonomousEffort: "none", debug: false };
  let binding: Binding | undefined;
  let id: string | undefined;
  let approved = false;
  let cancelled = false;
  let ceiling: Level | undefined;
  let pending: Promise<void> | undefined;
  const lifetime = new AbortController();

  const cancel = (ctx: ExtensionContext) => {
    cancelled = true;
    // Never await: abort completion waits for the very loop executing this handler.
    ctx.abort();
  };

  const log = (ctx: ExtensionContext, requested: Level | undefined, parent: Level | undefined, limit: Level | undefined, action: string) => {
    if (!config.debug) return;
    logger.debug("[effort-guard]", {
      child: ctx.agent.id, parentId: ctx.agent.parentId, model: ctx.model && `${ctx.model.provider}/${ctx.model.id}`,
      parent: parent ?? "unknown", requested: requested ?? "unknown", limit: limit ?? "none",
      action, final: actualLevel(pi, ctx) ?? "unknown",
    });
  };

  const apply = (ctx: ExtensionContext, target: Level): boolean => {
    pi.setThinkingLevel(target);
    const final = actualLevel(pi, ctx);
    // Host ceilings can lower a selection; capability normalization must never raise it.
    if (final === undefined || rank(final) > rank(target)) {
      cancel(ctx);
      return false;
    }
    ceiling = final;
    approved = true;
    return true;
  };

  async function decide(ctx: ExtensionContext): Promise<void> {
    const requested = actualLevel(pi, ctx);
    const parentBinding = ctx.agent.parentId ? bindings.get(ctx.agent.parentId) : undefined;
    const parent = parentBinding?.effort();
    const limit = effectiveLimit(config, parent);
    const supported = supportedLevels(ctx);
    if (!requiresApproval(config, requested, parent)) {
      if (requested !== undefined) apply(ctx, requested);
      log(ctx, requested, parent, limit, "automatic");
      return;
    }

    const fallback = safeTarget(limit, supported);
    const ui = parentBinding?.ui;
    if (!ui) {
      if (fallback === undefined) cancel(ctx);
      else apply(ctx, fallback);
      log(ctx, requested, parent, limit, fallback === undefined ? "headless-cancel" : "headless-clamp");
      return;
    }

    // Establish a fail-safe BEFORE any await. Handler errors/timeouts must not release MAX.
    if (fallback !== undefined) pi.setThinkingLevel(fallback);
    const dialog = new AbortController();
    const signal = AbortSignal.any([dialog.signal, lifetime.signal]);
    const timer = ctx.setTimeout(() => {
      if (fallback === undefined) cancel(ctx);
      else apply(ctx, fallback);
      log(ctx, requested, parent, limit, fallback === undefined ? "timeout-cancel" : "timeout-clamp");
      dialog.abort();
    }, APPROVAL_TIMEOUT_MS);
    const previous = ui.tail;
    const slot = Promise.withResolvers<void>();
    ui.tail = slot.promise;
    try {
      await previous;
      if (signal.aborted || cancelled) return;
      const choices = approvalChoices(requested, parent, limit, supported);
      const limitText = config.maxAutonomousEffort === "parent" ? `PARENT (${parent ?? "unknown"})` : config.maxAutonomousEffort;
      const title = `Subagent Effort Approval\nAgent: ${ctx.agent.name} (${ctx.agent.id})\nModel: ${ctx.model?.provider}/${ctx.model?.id}\nRequested: ${requested ?? "unknown"} | Parent: ${parent ?? "unknown"}\nAutonomous limit: ${limitText}\n${config.mode === "always" ? "Approval required for every subagent." : "Requested effort exceeds the autonomous limit or cannot be verified."}`;
      const label = await ui.context.select(title, choices.map(choice => choice.label), { signal, initialIndex: fallback === undefined ? choices.findIndex(choice => choice.action === "cancel") : 0 });
      if (signal.aborted || cancelled) return;
      const choice = choices.find(item => item.label === label);
      if (!choice || choice.action === "cancel") {
        cancel(ctx);
        log(ctx, requested, parent, limit, "cancel");
        return;
      }
      if (choice.action === "override") {
        const selected = await ui.context.select("Select subagent effort", supported, { signal, initialIndex: Math.max(0, supported.indexOf(fallback ?? "off")) });
        if (signal.aborted || cancelled) return;
        if (!selected || !supported.includes(selected as Level)) {
          cancel(ctx);
          return;
        }
        apply(ctx, selected as Level);
      } else if (choice.action === "allow" && requested === undefined) {
        // Explicit approval of a model without a controllable effort surface.
        pi.setThinkingLevel(undefined);
        approved = true;
      } else {
        apply(ctx, choice.action === "allow" ? requested! : choice.level!);
      }
      log(ctx, requested, parent, limit, choice.action);
    } catch {
      if (!cancelled && !lifetime.signal.aborted) {
        if (fallback === undefined) cancel(ctx);
        else apply(ctx, fallback);
        log(ctx, requested, parent, limit, "dialog-fallback");
      }
    } finally {
      slot.resolve();
      ctx.clearTimer(timer);
      dialog.abort();
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = readConfig(await getPluginSettings(PLUGIN, ctx.cwd));
    } catch {
      // Invalid/unreadable policy is no authorization. Never silently disable the guard.
      config = { mode: "auto", maxAutonomousEffort: "none", debug: false };
      logger.warn("[effort-guard] Cannot read valid plugin settings; subagents require approval.");
    }
    if (config.mode === "off") return;
    id = ctx.agent.id;
    const parent = ctx.agent.parentId ? bindings.get(ctx.agent.parentId) : undefined;
    binding = { effort: () => actualLevel(pi, ctx), ui: ctx.hasUI ? { context: ctx.ui, tail: Promise.resolve() } : parent?.ui };
    bindings.set(id, binding);
  });

  pi.on("context", async (_event, ctx) => {
    if (config.mode === "off" || ctx.agent.kind !== "sub") return;
    if (cancelled || lifetime.signal.aborted) {
      cancel(ctx);
      return;
    }
    try {
      if (pending) await pending;
      else if (!approved) {
        pending = decide(ctx);
        try { await pending; } finally { pending = undefined; }
      }
      if (cancelled) {
        cancel(ctx);
        return;
      }
      if (approved) {
        const current = actualLevel(pi, ctx);
        if (ceiling === undefined) {
          if (current !== undefined) cancel(ctx);
        } else if (current === undefined || rank(current) > rank(ceiling)) {
          const target = safeTarget(ceiling, supportedLevels(ctx));
          if (target === undefined) cancel(ctx);
          else apply(ctx, target);
        }
      }
    } catch {
      cancel(ctx);
    }
  });

  pi.on("session_shutdown", () => {
    lifetime.abort();
    if (id && bindings.get(id) === binding) bindings.delete(id);
    binding = undefined;
  });
}
