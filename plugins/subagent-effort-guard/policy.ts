import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";

export type Mode = "off" | "auto" | "always";
export type Level = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Limit = "parent" | "none" | Exclude<Level, "off">;

export interface Config {
	mode: Mode;
	maxAutonomousEffort: Limit;
	debug: boolean;
}

export interface ApprovalChoice {
	label: string;
	level?: Level;
	action: "set" | "allow" | "override" | "cancel";
}

const thinkingEfforts: readonly string[] = THINKING_EFFORTS;

export function readConfig(values: Record<string, unknown>): Config {
	const mode = values.mode === undefined ? "auto" : values.mode;
	const maxAutonomousEffort = values.maxAutonomousEffort === undefined ? "parent" : values.maxAutonomousEffort;
	const debug = values.debug === undefined ? false : values.debug;
	if (mode !== "off" && mode !== "auto" && mode !== "always") {
		throw new Error("Subagent Effort Guard mode must be off, auto, or always");
	}
	if (maxAutonomousEffort !== "parent" && maxAutonomousEffort !== "none" &&
		!thinkingEfforts.some(level => level === maxAutonomousEffort)) {
		throw new Error("Subagent Effort Guard maxAutonomousEffort must be parent, none, or a real thinking effort");
	}
	if (typeof debug !== "boolean") {
		throw new Error("Subagent Effort Guard debug must be a boolean");
	}
	return { mode, maxAutonomousEffort: maxAutonomousEffort as Limit, debug };
}

export function rank(level: Level): number {
	return level === "off" ? -1 : thinkingEfforts.indexOf(level);
}

export function effectiveLimit(config: Config, parent: Level | undefined): Level | undefined {
	if (config.maxAutonomousEffort === "none") return undefined;
	if (config.maxAutonomousEffort === "parent") return parent;
	return config.maxAutonomousEffort;
}

export function requiresApproval(config: Config, requested: Level | undefined, parent: Level | undefined): boolean {
	if (config.mode === "off") return false;
	if (config.mode === "always") return true;
	const limit = effectiveLimit(config, parent);
	if (requested === undefined || limit === undefined) return true;
	return rank(requested) > rank(limit);
}

// OMP's model clamp may fall back upward to the lowest supported tier. A policy
// ceiling must instead have no target when every supported tier exceeds it.
export function safeTarget(limit: Level | undefined, supported: readonly Level[]): Level | undefined {
	if (limit === undefined) return undefined;
	const ceiling = rank(limit);
	let target: Level | undefined;
	for (const level of supported) {
		if (rank(level) <= ceiling && (target === undefined || rank(level) > rank(target))) {
			target = level;
		}
	}
	return target;
}

export function approvalChoices(
	requested: Level | undefined,
	parent: Level | undefined,
	limit: Level | undefined,
	supported: readonly Level[],
): ApprovalChoice[] {
	const choices: ApprovalChoice[] = [];
	const limitTarget = safeTarget(limit, supported);
	if (limitTarget !== undefined) {
		choices.push({ label: `Clamp to limit (${limitTarget.toUpperCase()})`, level: limitTarget, action: "set" });
	}
	const parentTarget = safeTarget(parent, supported);
	if (parentTarget !== undefined && parentTarget !== limitTarget && parentTarget !== requested) {
		choices.push({ label: `Clamp to parent (${parentTarget.toUpperCase()})`, level: parentTarget, action: "set" });
	}
	if (requested === undefined || requested !== limitTarget) {
		choices.push({
			label: `Allow requested (${requested?.toUpperCase() ?? "UNKNOWN"})`,
			...(requested === undefined ? {} : { level: requested }),
			action: "allow",
		});
	}
	choices.push({ label: "Override...", action: "override" }, { label: "Cancel task", action: "cancel" });
	return choices;
}
