export const INTENSITIES = ["light", "standard", "strong"] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const DEFAULT_SHORTCUT = "alt+e";

export interface PolishConfig {
	intensity: Intensity;
	shortcut: string;
}

/** Unknown or malformed values fall back to defaults; `warnings` names each one. */
export function readConfig(raw: Record<string, unknown>): { config: PolishConfig; warnings: string[] } {
	const warnings: string[] = [];
	let intensity: Intensity = "standard";
	if (raw.intensity !== undefined) {
		if (INTENSITIES.includes(raw.intensity as Intensity)) intensity = raw.intensity as Intensity;
		else warnings.push(`intensity ${JSON.stringify(raw.intensity)} is not one of ${INTENSITIES.join(", ")}`);
	}
	let shortcut = DEFAULT_SHORTCUT;
	if (raw.shortcut !== undefined) {
		if (typeof raw.shortcut === "string" && raw.shortcut.trim() !== "") shortcut = raw.shortcut.trim().toLowerCase();
		else warnings.push(`shortcut ${JSON.stringify(raw.shortcut)} is not a key chord`);
	}
	return { config: { intensity, shortcut }, warnings };
}

const LEVELS: Record<Intensity, string> = {
	light:
		"light: fix wording, grammar, and obvious ambiguity only. Keep my structure and roughly my length; do not add steps or detail.",
	standard:
		"standard: make it clear and well ordered. Resolve references the conversation actually settles and add a little missing detail where it plainly helps, but do not turn it into a task brief.",
	strong:
		"strong: build a rough idea into a full prompt. Add the context, concrete specifics, edge cases, and verification or completion criteria that help reach the same goal; scale it to the size of the task. Explicit limits like \"keep it short\" or \"nothing else\" still win, and a question or brainstorm stays one.",
};

const RULES = `Rules:
- Keep my goal and the kind of request. A question stays a question, exploration stays exploration, and "look into" never becomes "fix".
- Keep my uncertainty (might, maybe, I suspect), constraints, exclusions, length limits, tone, and language. If I wrote in Czech, the rewrite is in Czech.
- Keep names, paths, commands, code, quoted text, and URLs exactly as written.
- Use this conversation and the project context only to resolve what I refer to ("that bug", "like before") and to add specifics that are already established. Never invent files, causes, requirements, or decisions.
- Do not address me, explain your changes, or add a preamble. If the draft is already good at this level, return it unchanged.`;

/** First pass: the side turn sees the conversation, so the prompt only frames the draft. */
export function firstPassPrompt(draft: string, intensity: Intensity): string {
	return `[prompt-polish] I have not sent the draft below yet. Do not answer it, act on it, or call tools. Rewrite it into a clearer, more effective prompt for you to receive as my next message, and reply with only the rewritten prompt inside <rewrite></rewrite> tags.

${RULES}

Level — ${LEVELS[intensity]}

<draft>
${draft}
</draft>`;
}

/** Later passes restate the candidate because the user may have edited or stepped back to another one. */
export function nextPassPrompt(candidate: string, notes: string, intensity: Intensity): string {
	const request = notes.trim()
		? `Revise it according to my notes:\n<notes>\n${notes.trim()}\n</notes>`
		: "Give me a noticeably different take on my original draft.";
	return `[prompt-polish] Another pass. Still do not answer or act on the prompt, and do not call tools. The current version is:
<current>
${candidate}
</current>
${request}

Same rules and level (${intensity}) as before; my notes override them where they conflict. Reply with only the rewritten prompt inside <rewrite></rewrite> tags.`;
}

export type Extraction = { ok: true; text: string } | { ok: false; reason: string };

const OPEN = "<rewrite>";
const CLOSE = "</rewrite>";

/** The last tagged rewrite; untagged replies are accepted minus a wrapping code fence. */
export function extractRewrite(reply: string): Extraction {
	const open = reply.lastIndexOf(OPEN);
	let body: string;
	if (open >= 0) {
		const close = reply.indexOf(CLOSE, open + OPEN.length);
		if (close < 0) return { ok: false, reason: "The rewrite was cut off." };
		body = reply.slice(open + OPEN.length, close);
	} else {
		const fenced = /^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/.exec(reply);
		body = fenced ? fenced[1]! : reply;
	}
	// Drop leading blank lines but keep the first line's indentation.
	const text = body.replace(/^\s*\n/, "").trimEnd();
	return text.trim() ? { ok: true, text } : { ok: false, reason: "The model returned no rewrite." };
}

/** Same text apart from whitespace runs and surrounding blanks. */
export function sameText(a: string, b: string): boolean {
	return a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");
}

export type DiffKind = "same" | "add" | "del";
export interface DiffPart {
	kind: DiffKind;
	text: string;
}

// Word-level LCS above this many cells falls back to replacing the changed middle wholesale.
const MAX_DIFF_CELLS = 4_000_000;
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/** Word-level diff: whitespace runs, words, and single symbols are the units. */
export function wordDiff(before: string, after: string): DiffPart[] {
	const a = before.match(TOKEN) ?? [];
	const b = after.match(TOKEN) ?? [];
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const parts: DiffPart[] = [];
	const push = (kind: DiffKind, text: string) => {
		if (!text) return;
		const last = parts[parts.length - 1];
		if (last?.kind === kind) last.text += text;
		else parts.push({ kind, text });
	};
	push("same", a.slice(0, start).join(""));
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	if ((midA.length + 1) * (midB.length + 1) > MAX_DIFF_CELLS) {
		push("del", midA.join(""));
		push("add", midB.join(""));
	} else {
		for (const part of lcsDiff(midA, midB)) push(part.kind, part.text);
	}
	push("same", a.slice(endA).join(""));
	return orderChanges(parts);
}

function lcsDiff(a: readonly string[], b: readonly string[]): DiffPart[] {
	const width = b.length + 1;
	const table = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1]! + 1
					: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
		}
	}
	const parts: DiffPart[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			parts.push({ kind: "same", text: a[i++]! });
			j++;
		} else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
			parts.push({ kind: "del", text: a[i++]! });
		} else {
			parts.push({ kind: "add", text: b[j++]! });
		}
	}
	while (i < a.length) parts.push({ kind: "del", text: a[i++]! });
	while (j < b.length) parts.push({ kind: "add", text: b[j++]! });
	return parts;
}

/**
 * Absorb lone whitespace between two changes into them and show each changed run as
 * one removal followed by one addition, so "a b" → "x y" reads as `-a b+x y`, not interleaved.
 */
function orderChanges(parts: DiffPart[]): DiffPart[] {
	const out: DiffPart[] = [];
	let del = "";
	let add = "";
	const flush = () => {
		if (del) out.push({ kind: "del", text: del });
		if (add) out.push({ kind: "add", text: add });
		del = "";
		add = "";
	};
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!;
		if (part.kind === "del") del += part.text;
		else if (part.kind === "add") add += part.text;
		else if ((del || add) && /^[ \t]+$/.test(part.text) && parts[index + 1] && parts[index + 1]!.kind !== "same") {
			del += part.text;
			add += part.text;
		} else {
			flush();
			out.push(part);
		}
	}
	flush();
	return out;
}

/** Count of changed runs; a removal directly followed by an addition is one change. */
export function changeCount(parts: readonly DiffPart[]): number {
	let count = 0;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index]!;
		if (part.kind === "same") continue;
		if (part.kind === "del" && parts[index + 1]?.kind === "add") index++;
		count++;
	}
	return count;
}
