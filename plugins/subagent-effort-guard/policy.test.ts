import { describe, expect, it } from "bun:test";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog";
import {
	approvalChoices,
	effectiveLimit,
	rank,
	readConfig,
	requiresApproval,
	safeTarget,
	type Config,
	type Level,
} from "./policy";

const levels: readonly Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const defaults: Config = { mode: "auto", maxAutonomousEffort: "parent", debug: false };

describe("configuration", () => {
	it("uses conservative defaults for missing settings", () => {
		expect(readConfig({})).toEqual(defaults);
		expect(readConfig({ mode: undefined, maxAutonomousEffort: undefined, debug: undefined })).toEqual(defaults);
	});

	it("accepts every mode and real autonomous limit", () => {
		for (const mode of ["off", "auto", "always"]) {
			for (const maxAutonomousEffort of ["parent", "none", ...THINKING_EFFORTS]) {
				expect(readConfig({ mode, maxAutonomousEffort, debug: true })).toEqual({ mode, maxAutonomousEffort, debug: true });
			}
		}
	});

	it("rejects invalid supplied modes instead of silently disabling protection", () => {
		for (const mode of [null, false, 0, "", "AUTO", "on", "lo", {}, []]) {
			expect(() => readConfig({ mode })).toThrow(/mode/);
		}
	});

	it("rejects invalid limits, including off and coarse task efforts", () => {
		for (const maxAutonomousEffort of [null, false, 0, "", "off", "lo", "med", "hi", "MAX", {}, []]) {
			expect(() => readConfig({ maxAutonomousEffort })).toThrow(/maxAutonomousEffort/);
		}
	});

	it("accepts boolean debug only", () => {
		expect(readConfig({ debug: false }).debug).toBe(false);
		for (const debug of [null, "true", "false", 1, {}]) {
			expect(() => readConfig({ debug })).toThrow(/debug/);
		}
	});
});

describe("actual effort ordering", () => {
	it("uses the catalog ladder with off below every reasoning effort", () => {
		expect(rank("off")).toBe(-1);
		for (const [index, level] of THINKING_EFFORTS.entries()) {
			expect(rank(level)).toBe(index);
		}
		for (let index = 1; index < levels.length; index++) {
			expect(rank(levels[index]!)).toBeGreaterThan(rank(levels[index - 1]!));
		}
	});
});

describe("approval decisions", () => {
	it.each([
		["medium", "low", false],
		["medium", "medium", false],
		["medium", "high", true],
		["high", "max", true],
		["max", "max", false],
	] as const)("auto parent %s with requested %s requires approval: %s", (parent, requested, approval) => {
		expect(requiresApproval(defaults, requested, parent)).toBe(approval);
	});

	it.each([
		["low", false],
		["medium", false],
		["high", true],
		["max", true],
	] as const)("auto fixed medium with requested %s requires approval: %s", (requested, approval) => {
		expect(requiresApproval({ ...defaults, maxAutonomousEffort: "medium" }, requested, "high")).toBe(approval);
	});

	it("compares all real levels, with fixed limits independent of known parent effort", () => {
		for (const parent of levels) {
			for (const requested of levels) {
				expect(requiresApproval(defaults, requested, parent)).toBe(rank(requested) > rank(parent));
				expect(requiresApproval({ ...defaults, maxAutonomousEffort: "medium" }, requested, parent))
					.toBe(rank(requested) > rank("medium"));
			}
		}
	});

	it("always requires approval, including lower and unknown efforts", () => {
		for (const requested of [...levels, undefined]) {
			for (const parent of [...levels, undefined]) {
				expect(requiresApproval({ ...defaults, mode: "always" }, requested, parent)).toBe(true);
			}
		}
	});

	it("off never requires approval regardless of limits or unknown efforts", () => {
		for (const maxAutonomousEffort of ["parent", "none", "medium"] as const) {
			for (const requested of [...levels, undefined]) {
				for (const parent of [...levels, undefined]) {
					expect(requiresApproval({ ...defaults, mode: "off", maxAutonomousEffort }, requested, parent)).toBe(false);
				}
			}
		}
	});

	it("none approves no autonomous effort, not even off", () => {
		for (const requested of [...levels, undefined]) {
			expect(requiresApproval({ ...defaults, maxAutonomousEffort: "none" }, requested, "max")).toBe(true);
		}
	});

	it("requires approval for unknown requests, and unknown parents when the limit is parent", () => {
		for (const maxAutonomousEffort of ["parent", "medium", "max"] as const) {
			const config = { ...defaults, maxAutonomousEffort };
			expect(requiresApproval(config, undefined, "high")).toBe(true);
			expect(requiresApproval(config, undefined, undefined)).toBe(true);
		}
		expect(requiresApproval(defaults, "off", undefined)).toBe(true);
	});

	it("uses fixed limits even when the parent effort is unknown", () => {
		for (const maxAutonomousEffort of THINKING_EFFORTS) {
			const config = { ...defaults, maxAutonomousEffort };
			for (const requested of levels) {
				expect(requiresApproval(config, requested, undefined))
					.toBe(rank(requested) > rank(maxAutonomousEffort));
			}
		}
	});

	it("uses the immediate parent for nested effort comparisons", () => {
		expect(requiresApproval(defaults, "medium", "high")).toBe(false);
		expect(requiresApproval(defaults, "high", "medium")).toBe(true);
	});

	it("distinguishes a known off parent from none and an unknown parent", () => {
		expect(effectiveLimit(defaults, "off")).toBe("off");
		expect(requiresApproval(defaults, "off", "off")).toBe(false);
		expect(requiresApproval(defaults, "minimal", "off")).toBe(true);
		expect(effectiveLimit(defaults, undefined)).toBeUndefined();
		expect(effectiveLimit({ ...defaults, maxAutonomousEffort: "none" }, "off")).toBeUndefined();
		expect(effectiveLimit({ ...defaults, maxAutonomousEffort: "medium" }, undefined)).toBe("medium");
	});
});

describe("safe capability normalization", () => {
	it("selects the greatest supported tier at or below a ceiling, regardless of input order", () => {
		const supported: readonly Level[] = ["max", "low", "off", "high", "low"];
		expect(safeTarget("medium", supported)).toBe("low");
		expect(safeTarget("xhigh", supported)).toBe("high");
		expect(safeTarget("max", supported)).toBe("max");
		expect(safeTarget("off", supported)).toBe("off");
	});

	it("never falls upward when all supported tiers exceed the ceiling", () => {
		expect(safeTarget("minimal", ["low", "high"])).toBeUndefined();
		expect(safeTarget("medium", ["high", "max"])).toBeUndefined();
		expect(safeTarget("off", ["minimal", "low"])).toBeUndefined();
		expect(safeTarget("medium", ["off", "high", "max"])).toBe("off");
	});

	it("has no target without a ceiling or supported efforts", () => {
		expect(safeTarget(undefined, levels)).toBeUndefined();
		expect(safeTarget("max", [])).toBeUndefined();
		expect(safeTarget(effectiveLimit({ ...defaults, maxAutonomousEffort: "none" }, "high"), levels)).toBeUndefined();
	});

	it("obeys non-escalation and maximality for every capability subset", () => {
		for (let mask = 0; mask < 1 << levels.length; mask++) {
			const supported = levels.filter((_, index) => (mask & (1 << index)) !== 0).reverse();
			for (const limit of levels) {
				const target = safeTarget(limit, supported);
				const eligible = supported.filter(level => rank(level) <= rank(limit));
				if (eligible.length === 0) {
					expect(target).toBeUndefined();
				} else {
					expect(target).toBeDefined();
					expect(supported).toContain(target);
					expect(rank(target!)).toBeLessThanOrEqual(rank(limit));
					expect(rank(target!)).toBe(Math.max(...eligible.map(rank)));
				}
			}
		}
	});
});

describe("approval choices", () => {
	it("orders safe limit, distinct parent, allow, override, then cancel", () => {
		expect(approvalChoices("max", "high", "medium", levels)).toEqual([
			{ label: "Clamp to limit (MEDIUM)", level: "medium", action: "set" },
			{ label: "Clamp to parent (HIGH)", level: "high", action: "set" },
			{ label: "Allow requested (MAX)", level: "max", action: "allow" },
			{ label: "Override...", action: "override" },
			{ label: "Cancel task", action: "cancel" },
		]);
	});

	it("deduplicates parent and limit even when normalization converges", () => {
		expect(approvalChoices("max", "high", "high", levels).map(choice => choice.level))
			.toEqual(["high", "max", undefined, undefined]);
		expect(approvalChoices("max", "xhigh", "high", ["off", "high", "max"]).map(choice => choice.level))
			.toEqual(["high", "max", undefined, undefined]);
	});

	it("omits allow when the first set choice already preserves the requested effort", () => {
		expect(approvalChoices("medium", "high", "medium", levels).map(choice => choice.action))
			.toEqual(["set", "set", "override", "cancel"]);
		expect(approvalChoices("off", "off", "off", levels)).toEqual([
			{ label: "Clamp to limit (OFF)", level: "off", action: "set" },
			{ label: "Override...", action: "override" },
			{ label: "Cancel task", action: "cancel" },
		]);
	});

	it("does not offer a meaningless parent clamp that merely preserves the requested effort", () => {
		expect(approvalChoices("high", "high", "medium", levels).map(choice => choice.level))
			.toEqual(["medium", "high", undefined, undefined]);
		expect(approvalChoices("high", "high", "medium", levels)[1]?.action).toBe("allow");
	});

	it("normalizes parent downward and omits unsupported clamps rather than escalating", () => {
		expect(approvalChoices("max", "xhigh", "medium", ["low", "high", "max"]).slice(0, 2).map(choice => choice.level))
			.toEqual(["low", "high"]);
		expect(approvalChoices("max", "medium", "minimal", ["high", "max"]).map(choice => choice.action))
			.toEqual(["allow", "override", "cancel"]);
	});

	it("retains explicit allow for unknown efforts and missing model capabilities", () => {
		expect(approvalChoices(undefined, undefined, undefined, [])).toEqual([
			{ label: "Allow requested (UNKNOWN)", action: "allow" },
			{ label: "Override...", action: "override" },
			{ label: "Cancel task", action: "cancel" },
		]);
		expect(approvalChoices("max", "high", "medium", []).map(choice => choice.action))
			.toEqual(["allow", "override", "cancel"]);
	});

	it("none has no limit clamp but can offer an explicit parent approval", () => {
		const choices = approvalChoices("max", "off", undefined, levels);
		expect(choices[0]).toEqual({ label: "Clamp to parent (OFF)", level: "off", action: "set" });
		expect(choices.some(choice => choice.label.startsWith("Clamp to limit"))).toBe(false);
	});

	it("keeps effort targets unique, safe, and ordered throughout the input matrix", () => {
		for (const requested of [...levels, undefined]) {
			for (const parent of [...levels, undefined]) {
				for (const limit of [...levels, undefined]) {
					const supported: readonly Level[] = ["max", "low", "off", "high"];
					const choices = approvalChoices(requested, parent, limit, supported);
					const targets = choices.flatMap(choice => choice.level === undefined ? [] : [choice.level]);
					expect(new Set(targets).size).toBe(targets.length);
					expect(choices.slice(-2).map(choice => choice.action)).toEqual(["override", "cancel"]);
					const limitTarget = safeTarget(limit, supported);
					if (limitTarget !== undefined) {
						expect(choices[0]?.level).toBe(limitTarget);
						expect(choices[0]?.action).toBe("set");
					}
					expect(choices.some(choice => choice.action === "allow"))
						.toBe(requested === undefined || requested !== limitTarget);
					for (const choice of choices.filter(choice => choice.action === "set")) {
						expect(supported).toContain(choice.level);
						const ceiling = choice.label.startsWith("Clamp to limit") ? limit : parent;
						expect(ceiling).toBeDefined();
						expect(rank(choice.level!)).toBeLessThanOrEqual(rank(ceiling!));
					}
				}
			}
		}
	});
});
