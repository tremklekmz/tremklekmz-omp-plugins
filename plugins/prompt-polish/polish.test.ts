import { describe, expect, it } from "bun:test";
import { changeCount, DEFAULT_SHORTCUT, type DiffPart, extractRewrite, readConfig, sameText, wordDiff } from "./polish";

function side(parts: readonly DiffPart[], keep: "del" | "add"): string {
	return parts
		.filter(part => part.kind === "same" || part.kind === keep)
		.map(part => part.text)
		.join("");
}

describe("readConfig", () => {
	it("uses defaults for empty settings", () => {
		expect(readConfig({})).toEqual({ config: { intensity: "standard", shortcut: DEFAULT_SHORTCUT }, warnings: [] });
	});

	it("accepts valid values and normalizes the chord", () => {
		expect(readConfig({ intensity: "strong", shortcut: " Ctrl+Alt+P " }).config).toEqual({
			intensity: "strong",
			shortcut: "ctrl+alt+p",
		});
	});

	it.each([
		[{ intensity: "max" }, "intensity"],
		[{ intensity: 2 }, "intensity"],
		[{ shortcut: "" }, "shortcut"],
		[{ shortcut: 5 }, "shortcut"],
	])("falls back with a warning for %j", (raw, field) => {
		const { config, warnings } = readConfig(raw);
		expect(config).toEqual({ intensity: "standard", shortcut: DEFAULT_SHORTCUT });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toStartWith(field);
	});
});

describe("extractRewrite", () => {
	it("takes the last tagged rewrite and ignores surrounding chatter", () => {
		const reply = "Sure.\n<rewrite>first</rewrite>\nActually:\n<rewrite>\n  Fix the login bug.\n  Keep scope narrow.\n</rewrite>\nDone.";
		expect(extractRewrite(reply)).toEqual({ ok: true, text: "  Fix the login bug.\n  Keep scope narrow." });
	});

	it("rejects an unclosed tag as cut off", () => {
		expect(extractRewrite("<rewrite>Fix the login")).toEqual({ ok: false, reason: "The rewrite was cut off." });
	});

	it.each(["", "   \n", "<rewrite>\n \n</rewrite>"])("rejects empty output %j", reply => {
		expect(extractRewrite(reply).ok).toBe(false);
	});

	it("unwraps an untagged fenced reply", () => {
		expect(extractRewrite("```markdown\nExplain the cache.\n```\n")).toEqual({ ok: true, text: "Explain the cache." });
	});

	it("keeps code fences inside a tagged rewrite", () => {
		const text = "Run this:\n```sh\nbun test\n```";
		expect(extractRewrite(`<rewrite>${text}</rewrite>`)).toEqual({ ok: true, text });
	});
});

describe("sameText", () => {
	it("ignores whitespace layout only", () => {
		expect(sameText("fix  the\nbug ", " fix the bug")).toBe(true);
		expect(sameText("fix the bug", "fix the bug.")).toBe(false);
	});
});

describe("wordDiff", () => {
	it.each([
		["", ""],
		["fix the login bug", "fix the login bug"],
		["fix the login bug", "Fix the login bug: find the root cause."],
		["opravit chybu v přihlášení", "oprav chybu přihlášení, nic jiného"],
		["line one\nline two", "line one\n\nline 2\nline three"],
		["a b c", ""],
		["", "brand new"],
	])("reconstructs both sides of %j → %j", (before, after) => {
		const parts = wordDiff(before, after);
		expect(side(parts, "del")).toBe(before);
		expect(side(parts, "add")).toBe(after);
	});

	it("diffs whole words, not characters", () => {
		expect(wordDiff("fix the bug", "fix the issue")).toEqual([
			{ kind: "same", text: "fix the " },
			{ kind: "del", text: "bug" },
			{ kind: "add", text: "issue" },
		]);
	});

	it("groups a changed phrase as one removal then one addition", () => {
		const parts = wordDiff("please fix it now", "please repair everything now");
		expect(parts).toEqual([
			{ kind: "same", text: "please " },
			{ kind: "del", text: "fix it" },
			{ kind: "add", text: "repair everything" },
			{ kind: "same", text: " now" },
		]);
		expect(changeCount(parts)).toBe(1);
	});

	it("counts separate edits separately", () => {
		expect(changeCount(wordDiff("fix the bug now", "Fix the bug today"))).toBe(2);
		expect(changeCount(wordDiff("same", "same"))).toBe(0);
	});

	it("stays exact when the input is too large for word-level LCS", () => {
		const before = Array.from({ length: 2500 }, (_, index) => `a${index}`).join(" ");
		const after = Array.from({ length: 2500 }, (_, index) => `b${index}`).join(" ");
		const parts = wordDiff(`start ${before} end`, `start ${after} end`);
		expect(side(parts, "del")).toBe(`start ${before} end`);
		expect(side(parts, "add")).toBe(`start ${after} end`);
		expect(changeCount(parts)).toBe(1);
	});
});
