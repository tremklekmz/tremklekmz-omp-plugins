/** Token and USD totals for one or more model calls. */
export interface Spend {
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	calls: number;
}

/** One billed model call: a transcript assistant turn or an auxiliary `model_usage` entry. */
export interface CallRecord {
	kind: "assistant" | "auxiliary";
	entryId: string;
	timestamp: string | undefined;
	model: string;
	/** Why an auxiliary call ran, as recorded by OMP (e.g. a tool's internal inference). */
	purpose: string | undefined;
	spend: Spend;
}

/** Calls from one user prompt up to the next; index 0 collects calls before the first prompt. */
export interface TurnRecord {
	index: number;
	entryId: string | undefined;
	timestamp: string | undefined;
	prompt: string;
	calls: CallRecord[];
	/** Agent IDs named by `task` results recorded in this turn, in order of appearance. */
	childIds: string[];
	own: Spend;
	/** False when the prompt belongs to a branch other than the session's active one. */
	onBranch: boolean;
}

/** One transcript's own spend; subagent spend is never read from its `task` results. */
export interface TranscriptSummary {
	turns: TurnRecord[];
	own: Spend;
	assistant: Spend;
	auxiliary: Spend;
	/** Own spend inside the active window (latest compaction/reset on the active branch). */
	window: Spend;
	/** Agent IDs whose `task` results lie inside the active window. */
	windowChildIds: Set<string>;
	models: string[];
	firstTimestamp: string | undefined;
}

/** A subagent or advisor transcript discovered beside its parent session. */
export interface TranscriptSource {
	id: string;
	kind: "subagent" | "advisor";
	file: string;
	entries: readonly unknown[];
	children: readonly TranscriptSource[];
}

export interface AgentNode {
	id: string;
	kind: "main" | "subagent" | "advisor";
	file: string | undefined;
	running: boolean;
	summary: TranscriptSummary;
	subagents: AgentNode[];
	advisors: AgentNode[];
	/** Own spend plus every descendant subagent and advisor. */
	tree: Spend;
}

export interface CostReport {
	main: AgentNode;
	/** Everything recorded: all branches, compacted history, subagents, advisors. */
	total: Spend;
	/** The `/session info` scope: the main chat's active window plus subagents spawned in it. */
	window: Spend;
	subagents: Spend;
	advisors: Spend;
}

type Json = Record<string, unknown>;

const BEFORE_FIRST_PROMPT = "(before the first prompt)";

function record(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function emptySpend(): Spend {
	return { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
}

export function addSpend(target: Spend, source: Spend): void {
	target.cost += source.cost;
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.calls += source.calls;
}

export function sumSpend(spends: Iterable<Spend>): Spend {
	const total = emptySpend();
	for (const spend of spends) addSpend(total, spend);
	return total;
}

/** Reads persisted usage; absent fields count as zero, as OMP's loader normalizes them. */
export function usageSpend(usage: unknown): Spend | undefined {
	const fields = record(usage);
	if (!fields) return undefined;
	const cost = record(fields.cost);
	const parts = (finite(cost?.input) ?? 0) + (finite(cost?.output) ?? 0) + (finite(cost?.cacheRead) ?? 0) + (finite(cost?.cacheWrite) ?? 0);
	return {
		cost: finite(cost?.total) ?? parts,
		input: finite(fields.input) ?? 0,
		output: finite(fields.output) ?? 0,
		cacheRead: finite(fields.cacheRead) ?? 0,
		cacheWrite: finite(fields.cacheWrite) ?? 0,
		calls: 1,
	};
}

/** Entries that start a `/session info` usage window when walking back from a compaction's kept entry. */
const WINDOW_BOUNDARY_TYPES: Record<string, true> = {
	message: true,
	custom_message: true,
	branch_summary: true,
	compaction: true,
	reset_boundary: true,
};

/** Entry IDs of the active branch that `/session info` still counts after compaction or reset. */
export function activeWindowIds(branch: readonly unknown[]): Set<string> {
	const entries = branch.map(record);
	let compactionIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	let resetIndex = -1;
	for (let index = entries.length - 1; index > compactionIndex; index--) {
		if (entries[index]?.type === "reset_boundary") {
			resetIndex = index;
			break;
		}
	}
	let start = 0;
	if (resetIndex > compactionIndex) {
		start = resetIndex + 1;
	} else if (compactionIndex >= 0) {
		const firstKept = entries[compactionIndex]?.firstKeptEntryId;
		const keptIndex = entries.findIndex(entry => entry?.id === firstKept);
		start = keptIndex >= 0 ? keptIndex : compactionIndex + 1;
		while (start > 0 && WINDOW_BOUNDARY_TYPES[String(entries[start - 1]?.type)] !== true) start--;
	}
	const ids = new Set<string>();
	for (const entry of entries.slice(start)) {
		const id = text(entry?.id);
		if (id) ids.add(id);
	}
	return ids;
}

function promptText(content: unknown): string {
	let raw = "";
	if (typeof content === "string") raw = content;
	else if (Array.isArray(content)) {
		raw = content
			.map(part => {
				const fields = record(part);
				return fields?.type === "text" && typeof fields.text === "string" ? fields.text : "";
			})
			.join(" ");
	}
	// Prompts are rendered on one terminal row: drop control characters and collapse whitespace.
	return raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
}

function modelName(provider: unknown, model: unknown): string {
	const id = text(model) ?? "unknown model";
	const host = text(provider);
	return host ? `${host}/${id}` : id;
}

/** Agent IDs a `task` result names: settled results, progress rows, and an async job. */
export function taskAgentIds(details: unknown): string[] {
	const fields = record(details);
	if (!fields) return [];
	const ids: string[] = [];
	for (const key of ["results", "progress"]) {
		const items = fields[key];
		if (!Array.isArray(items)) continue;
		for (const item of items) {
			const id = text(record(item)?.id);
			if (id) ids.push(id);
		}
	}
	const jobId = text(record(fields.async)?.jobId);
	if (jobId) ids.push(jobId);
	return [...new Set(ids)];
}

/**
 * Summarize one transcript's own billed calls. Without a scope (subagent and
 * advisor files) every entry counts as on-branch and in-window.
 */
export function summarizeTranscript(
	entries: readonly unknown[],
	scope?: { branchIds: ReadonlySet<string>; windowIds: ReadonlySet<string> },
): TranscriptSummary {
	const turns: TurnRecord[] = [];
	const summary: TranscriptSummary = {
		turns,
		own: emptySpend(),
		assistant: emptySpend(),
		auxiliary: emptySpend(),
		window: emptySpend(),
		windowChildIds: new Set(),
		models: [],
		firstTimestamp: undefined,
	};
	const models = new Set<string>();
	let turn: TurnRecord = {
		index: 0,
		entryId: undefined,
		timestamp: undefined,
		prompt: BEFORE_FIRST_PROMPT,
		calls: [],
		childIds: [],
		own: emptySpend(),
		onBranch: true,
	};
	const close = () => {
		if (turn.index > 0 || turn.calls.length > 0 || turn.childIds.length > 0) turns.push(turn);
	};
	const inWindow = (id: string) => !scope || scope.windowIds.has(id);

	for (const raw of entries) {
		const entry = record(raw);
		const id = text(entry?.id);
		if (!entry || !id) continue;
		const timestamp = text(entry.timestamp);
		summary.firstTimestamp ??= timestamp;

		let call: CallRecord | undefined;
		if (entry.type === "model_usage") {
			const spend = usageSpend(entry.usage);
			if (spend) {
				call = {
					kind: "auxiliary",
					entryId: id,
					timestamp,
					model: modelName(entry.provider, entry.model),
					purpose: text(entry.purpose),
					spend,
				};
			}
		} else if (entry.type === "message") {
			const message = record(entry.message);
			if (message?.role === "user") {
				close();
				turn = {
					index: turn.index + 1,
					entryId: id,
					timestamp,
					prompt: promptText(message.content),
					calls: [],
					childIds: [],
					own: emptySpend(),
					onBranch: !scope || scope.branchIds.has(id),
				};
			} else if (message?.role === "assistant") {
				const spend = usageSpend(message.usage);
				if (spend) {
					call = {
						kind: "assistant",
						entryId: id,
						timestamp,
						model: modelName(message.provider, message.model),
						purpose: undefined,
						spend,
					};
				}
			} else if (message?.role === "toolResult" && message.toolName === "task") {
				for (const childId of taskAgentIds(message.details)) {
					if (!turn.childIds.includes(childId)) turn.childIds.push(childId);
					if (inWindow(id)) summary.windowChildIds.add(childId);
				}
			}
		}
		if (!call) continue;
		turn.calls.push(call);
		addSpend(turn.own, call.spend);
		addSpend(summary.own, call.spend);
		addSpend(call.kind === "assistant" ? summary.assistant : summary.auxiliary, call.spend);
		if (inWindow(id)) addSpend(summary.window, call.spend);
		if (call.spend.cost > 0 || call.kind === "assistant") models.add(call.model);
	}
	close();
	summary.models = [...models];
	return summary;
}

function buildNode(source: TranscriptSource, isRunning: (file: string) => boolean): AgentNode | undefined {
	const children = source.children
		.map(child => buildNode(child, isRunning))
		.filter((child): child is AgentNode => child !== undefined);
	const node: AgentNode = {
		id: source.id,
		kind: source.kind,
		file: source.file,
		running: isRunning(source.file),
		summary: summarizeTranscript(source.entries),
		subagents: children.filter(child => child.kind === "subagent").sort(byStart),
		advisors: children.filter(child => child.kind === "advisor"),
		tree: emptySpend(),
	};
	node.tree = sumSpend([node.summary.own, ...children.map(child => child.tree)]);
	// Header-only stubs (a spawn that never ran) carry nothing worth listing.
	return node.tree.calls > 0 || node.running ? node : undefined;
}

const byStart = (a: AgentNode, b: AgentNode) =>
	(a.summary.firstTimestamp ?? "").localeCompare(b.summary.firstTimestamp ?? "");

/** Subagents a turn's `task` results name, in the order they were reported. */
export function turnSubagents(node: AgentNode, turn: TurnRecord): AgentNode[] {
	return turn.childIds
		.map(id => node.subagents.find(child => child.id === id))
		.filter((child): child is AgentNode => child !== undefined);
}

export function buildReport(input: {
	mainEntries: readonly unknown[];
	mainBranch: readonly unknown[];
	mainFile: string | undefined;
	transcripts: readonly TranscriptSource[];
	isRunning: (file: string) => boolean;
}): CostReport {
	const branchIds = new Set<string>();
	for (const entry of input.mainBranch) {
		const id = text(record(entry)?.id);
		if (id) branchIds.add(id);
	}
	const summary = summarizeTranscript(input.mainEntries, {
		branchIds,
		windowIds: activeWindowIds(input.mainBranch),
	});
	const children = input.transcripts
		.map(source => buildNode(source, input.isRunning))
		.filter((child): child is AgentNode => child !== undefined);
	const subagents = children.filter(child => child.kind === "subagent").sort(byStart);
	const advisors = children.filter(child => child.kind === "advisor");
	const subagentSpend = sumSpend(subagents.map(child => child.tree));
	const advisorSpend = sumSpend(advisors.map(child => child.tree));
	const main: AgentNode = {
		id: "main",
		kind: "main",
		file: input.mainFile,
		running: false,
		summary,
		subagents,
		advisors,
		tree: sumSpend([summary.own, subagentSpend, advisorSpend]),
	};
	return {
		main,
		total: main.tree,
		window: sumSpend([
			summary.window,
			...subagents.filter(child => summary.windowChildIds.has(child.id)).map(child => child.tree),
		]),
		subagents: subagentSpend,
		advisors: advisorSpend,
	};
}
