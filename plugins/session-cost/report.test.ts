import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { activeWindowIds, buildReport, summarizeTranscript, type TranscriptSource } from "./report";
import { loadTranscripts } from "./transcripts";

type Entry = Record<string, unknown>;

function usage(cost: number, tokens = 100): Entry {
	return { input: tokens, output: tokens / 10, cacheRead: 0, cacheWrite: 0, totalTokens: tokens * 1.1, cost: { total: cost } };
}

function user(id: string, parentId: string | null, prompt = id): Entry {
	return { type: "message", id, parentId, timestamp: "2026-10-30T10:00:00.000Z", message: { role: "user", content: prompt } };
}

function assistant(id: string, parentId: string, cost: number): Entry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-30T10:00:01.000Z",
		message: { role: "assistant", provider: "anthropic", model: "claude", usage: usage(cost), content: [] },
	};
}

function taskResult(id: string, parentId: string, details: Entry): Entry {
	return { type: "message", id, parentId, timestamp: "2026-10-30T10:00:02.000Z", message: { role: "toolResult", toolName: "task", details } };
}

function jsonl(entries: readonly Entry[]): string {
	return entries.map(entry => JSON.stringify(entry)).join("\n");
}

// Main session: an abandoned branch (u2b), a compaction keeping u3 onward, an
// auxiliary model call, and three task spawns (async before compaction, sync
// before compaction, async inside the window).
const mainEntries: Entry[] = [
	user("u1", null),
	assistant("a1", "u1", 1),
	taskResult("t1", "a1", { results: [], progress: [{ id: "Early" }], async: { state: "running", jobId: "Early", type: "task" } }),
	user("u2b", "t1", "abandoned"),
	assistant("a2b", "u2b", 2),
	user("u2", "t1"),
	assistant("a2", "u2", 3),
	// The parent's copy of child usage must never be added on top of the child's transcript.
	taskResult("t2", "a2", { results: [{ id: "Sync", usage: usage(50) }], usage: usage(50) }),
	user("u3", "t2"),
	assistant("a3", "u3", 4),
	{ type: "compaction", id: "c1", parentId: "a3", timestamp: "2026-10-30T10:01:00.000Z", summary: "", firstKeptEntryId: "u3", tokensBefore: 0 },
	{ type: "model_usage", id: "mu1", parentId: "c1", timestamp: "2026-10-30T10:01:01.000Z", purpose: "find", provider: "openai", model: "mini", usage: usage(0.5) },
	user("u4", "mu1"),
	assistant("a4", "u4", 8),
	taskResult("t4", "a4", { results: [], progress: [{ id: "Late" }], async: { state: "completed", jobId: "Late", type: "task" } }),
];
const mainBranch = ["u1", "a1", "t1", "u2", "a2", "t2", "u3", "a3", "c1", "mu1", "u4", "a4", "t4"].map(
	id => mainEntries.find(entry => entry.id === id)!,
);

let tempDir: string | undefined;
afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

async function writeArtifacts(files: Record<string, string>): Promise<string> {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-cost-"));
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(tempDir, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await Bun.write(file, content);
	}
	return tempDir;
}

describe("buildReport", () => {
	it("prices the whole transcript and the /session info window from child transcripts", async () => {
		const dir = await writeArtifacts({
			"Early.jsonl": jsonl([user("e1", null), assistant("e2", "e1", 0.1)]),
			"Early.jsonl.bak": jsonl([user("x1", null), assistant("x2", "x1", 99)]),
			"Sync.jsonl": jsonl([user("s1", null), assistant("s2", "s1", 0.25)]),
			// A running writer can leave a partial last line.
			"Late.jsonl": `${jsonl([user("l1", null), assistant("l2", "l1", 0.7)])}\n{"type":"message","id":"l3"`,
			"Late/Grand.jsonl": jsonl([user("g1", null), assistant("g2", "g1", 0.05)]),
			"Late/__advisor.jsonl": jsonl([user("la1", null), assistant("la2", "la1", 0.02)]),
			"__advisor.review.jsonl": jsonl([user("ma1", null), assistant("ma2", "ma1", 0.3)]),
		});
		const report = buildReport({
			mainEntries,
			mainBranch,
			mainFile: undefined,
			transcripts: await loadTranscripts(dir),
			isRunning: () => false,
		});

		expect(report.main.summary.own.cost).toBeCloseTo(18.5);
		expect(report.subagents.cost).toBeCloseTo(0.1 + 0.25 + 0.7 + 0.05 + 0.02);
		expect(report.advisors.cost).toBeCloseTo(0.3);
		expect(report.total.cost).toBeCloseTo(18.5 + 1.12 + 0.3);
		// Window: a3 + mu1 + a4, plus the Late tree spawned inside it; Early and Sync predate the compaction.
		expect(report.window.cost).toBeCloseTo(12.5 + 0.77);

		expect(report.main.subagents.map(agent => agent.id).sort()).toEqual(["Early", "Late", "Sync"]);
		expect(report.main.advisors.map(agent => agent.id)).toEqual(["advisor:review"]);
		const late = report.main.subagents.find(agent => agent.id === "Late")!;
		expect(late.subagents.map(agent => agent.id)).toEqual(["Grand"]);
		expect(late.advisors.map(agent => agent.id)).toEqual(["advisor"]);
		expect(late.summary.own.calls).toBe(1);
	});

	it("lists a running agent before its first call but drops finished header-only stubs", () => {
		const header = [{ type: "session", id: "h", timestamp: "2026-10-30T10:00:00.000Z" }];
		const stub = (id: string): TranscriptSource => ({ id, kind: "subagent", file: `/s/${id}.jsonl`, entries: header, children: [] });
		const report = buildReport({
			mainEntries: [],
			mainBranch: [],
			mainFile: undefined,
			transcripts: [stub("Starting"), stub("NeverRan")],
			isRunning: file => file === "/s/Starting.jsonl",
		});
		expect(report.main.subagents.map(agent => [agent.id, agent.running])).toEqual([["Starting", true]]);
	});
});

describe("summarizeTranscript", () => {
	it("groups calls into prompt turns with spawned agents and branch membership", () => {
		const branchIds = new Set(mainBranch.map(entry => entry.id as string));
		const summary = summarizeTranscript(mainEntries, { branchIds, windowIds: activeWindowIds(mainBranch) });
		expect(
			summary.turns.map(turn => ({ prompt: turn.prompt, cost: turn.own.cost, children: turn.childIds, onBranch: turn.onBranch })),
		).toEqual([
			{ prompt: "u1", cost: 1, children: ["Early"], onBranch: true },
			{ prompt: "abandoned", cost: 2, children: [], onBranch: false },
			{ prompt: "u2", cost: 3, children: ["Sync"], onBranch: true },
			{ prompt: "u3", cost: 4.5, children: [], onBranch: true },
			{ prompt: "u4", cost: 8, children: ["Late"], onBranch: true },
		]);
		expect(summary.turns[3]!.calls.map(call => [call.kind, call.purpose, call.model])).toEqual([
			["assistant", undefined, "anthropic/claude"],
			["auxiliary", "find", "openai/mini"],
		]);
		expect([...summary.windowChildIds]).toEqual(["Late"]);
	});

	it("counts usage without a stored total from its component prices and skips calls without usage", () => {
		const entries = [
			user("u", null),
			{
				type: "message",
				id: "a",
				parentId: "u",
				message: { role: "assistant", model: "m", usage: { input: 10, cost: { input: 0.01, output: 0.02 } } },
			},
			{ type: "message", id: "b", parentId: "a", message: { role: "assistant", model: "m" } },
		];
		const summary = summarizeTranscript(entries);
		expect(summary.own.calls).toBe(1);
		expect(summary.own.cost).toBeCloseTo(0.03);
		expect(summary.own.input).toBe(10);
		expect(summary.own.output).toBe(0);
	});
});

describe("activeWindowIds", () => {
	it("starts after the latest reset boundary when it follows the last compaction", () => {
		const branch = [
			user("u1", null),
			{ type: "compaction", id: "c", parentId: "u1", firstKeptEntryId: "u1" },
			user("u2", "c"),
			{ type: "reset_boundary", id: "r", parentId: "u2" },
			user("u3", "r"),
		];
		expect([...activeWindowIds(branch)]).toEqual(["u3"]);
	});

	it("covers the whole branch when nothing was compacted or reset", () => {
		expect([...activeWindowIds([user("u1", null), assistant("a1", "u1", 1)])]).toEqual(["u1", "a1"]);
	});
});
