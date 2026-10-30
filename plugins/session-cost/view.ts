import * as os from "node:os";
import { type AgentNode, type CallRecord, type CostReport, type Spend, type TurnRecord, sumSpend, turnSubagents } from "./report";

export interface Row {
	label: string;
	detail: string;
	cost: number | undefined;
	/** Rendered dimmed: history from a branch other than the active one. */
	muted: boolean;
	open: (() => Page) | undefined;
}

export interface Page {
	title: string;
	header: string[];
	rows: Row[];
	empty: string;
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

function tokenDetail(spend: Spend): string {
	return `in ${formatTokens(spend.input)} · out ${formatTokens(spend.output)} · cache r ${formatTokens(spend.cacheRead)} w ${formatTokens(spend.cacheWrite)}`;
}

function clock(timestamp: string | undefined): string {
	const date = timestamp ? new Date(timestamp) : undefined;
	if (!date || Number.isNaN(date.getTime())) return "--:--:--";
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, "0")).join(":");
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function countDescendants(agents: readonly AgentNode[]): number {
	let count = 0;
	for (const agent of agents) count += 1 + countDescendants(agent.subagents) + countDescendants(agent.advisors);
	return count;
}

function callRow(call: CallRecord): Row {
	const prefix = call.kind === "auxiliary" ? `aux${call.purpose ? ` ${call.purpose}` : ""} · ` : "";
	return {
		label: `${clock(call.timestamp)}  ${prefix}${call.model}`,
		detail: tokenDetail(call.spend),
		cost: call.spend.cost,
		muted: false,
		open: undefined,
	};
}

function agentRow(agent: AgentNode): Row {
	const nested = countDescendants(agent.subagents) + countDescendants(agent.advisors);
	const parts = [agent.summary.models.join(", ") || "no model calls yet", plural(agent.summary.own.calls, "call")];
	if (nested > 0) parts.push(`own ${formatCost(agent.summary.own.cost)} + ${nested} nested`);
	return {
		label: `${agent.id}${agent.running ? " (running)" : ""}`,
		detail: parts.join(" · "),
		cost: agent.tree.cost,
		muted: false,
		open: () => agentPage(agent),
	};
}

function turnRow(agent: AgentNode, turn: TurnRecord): Row {
	const subagents = sumSpend(turnSubagents(agent, turn).map(child => child.tree));
	const parts = [plural(turn.own.calls, "call")];
	if (subagents.calls > 0) parts.push(`own ${formatCost(turn.own.cost)} + subagents ${formatCost(subagents.cost)}`);
	if (!turn.onBranch) parts.push("other branch");
	return {
		label: `#${turn.index} ${clock(turn.timestamp)}  ${turn.prompt}`,
		detail: parts.join(" · "),
		cost: turn.own.cost + subagents.cost,
		muted: !turn.onBranch,
		open: () => turnPage(agent, turn),
	};
}

function turnPage(agent: AgentNode, turn: TurnRecord): Page {
	const subagents = turnSubagents(agent, turn);
	const subagentSpend = sumSpend(subagents.map(child => child.tree));
	return {
		title: `Turn #${turn.index}`,
		header: [
			turn.prompt,
			`Own ${formatCost(turn.own.cost)} (${plural(turn.own.calls, "call")})${subagents.length > 0 ? ` · Subagents ${formatCost(subagentSpend.cost)} (${plural(subagents.length, "agent")})` : ""}${turn.onBranch ? "" : " · other branch"}`,
		],
		rows: [...turn.calls.map(callRow), ...subagents.map(agentRow)],
		empty: "No billed calls in this turn.",
	};
}

function turnsPage(agent: AgentNode, title: string): Page {
	return {
		title,
		header: [
			`${plural(agent.summary.turns.length, "turn")} · own ${formatCost(agent.summary.own.cost)}; turn totals include the subagents its task calls reported`,
		],
		rows: agent.summary.turns.map(turn => turnRow(agent, turn)),
		empty: "No turns recorded.",
	};
}

function shortenHome(file: string): string {
	const home = os.homedir();
	return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}

function agentPage(agent: AgentNode): Page {
	const { summary } = agent;
	const header = [
		`${agent.kind}${agent.running ? " · running, totals are still growing" : ""} · ${summary.models.join(", ") || "no model calls yet"}`,
		`Own ${formatCost(summary.own.cost)} · with nested agents ${formatCost(agent.tree.cost)} · ${tokenDetail(summary.own)}`,
	];
	if (agent.file) header.push(shortenHome(agent.file));
	// A typical subagent answers one prompt; list its calls directly instead of a one-row turn list.
	const rows =
		summary.turns.length === 1 ? summary.turns[0]!.calls.map(callRow) : summary.turns.map(turn => turnRow(agent, turn));
	for (const child of agent.subagents) rows.push(agentRow(child));
	for (const advisor of agent.advisors) rows.push(agentRow(advisor));
	return { title: agent.id, header, rows, empty: "No billed calls recorded yet." };
}

/** Top-level `/cost` page; deeper pages are built lazily when opened. */
export function rootPage(report: CostReport): Page {
	const { main } = report;
	const auxiliary = main.summary.auxiliary.calls > 0 ? ` + ${main.summary.auxiliary.calls} auxiliary` : "";
	const rows: Row[] = [
		{
			label: "Main chat",
			detail: `${plural(main.summary.turns.length, "turn")} · ${plural(main.summary.assistant.calls, "call")}${auxiliary} · ${tokenDetail(main.summary.own)}`,
			cost: main.summary.own.cost,
			muted: false,
			open: () => turnsPage(main, "Main chat"),
		},
	];
	const running = (agents: readonly AgentNode[]): number =>
		agents.reduce((count, agent) => count + (agent.running ? 1 : 0) + running(agent.subagents), 0);
	const runningCount = running(main.subagents);
	rows.push({
		label: "Subagents",
		detail: `${plural(main.subagents.length, "agent")}, ${countDescendants(main.subagents)} incl. nested${runningCount > 0 ? ` · ${runningCount} running` : ""}`,
		cost: report.subagents.cost,
		muted: false,
		open:
			main.subagents.length > 0
				? () => ({
						title: "Subagents",
						header: ["Totals include each agent's nested subagents and advisors."],
						rows: main.subagents.map(agentRow),
						empty: "",
					})
				: undefined,
	});
	if (main.advisors.length > 0) {
		rows.push({
			label: "Advisors",
			detail: plural(main.advisors.length, "advisor"),
			cost: report.advisors.cost,
			muted: false,
			open: () => ({
				title: "Advisors",
				header: ["Advisors reviewing the main chat."],
				rows: main.advisors.map(agentRow),
				empty: "",
			}),
		});
	}
	return {
		title: "Session cost",
		header: [
			`Total ${formatCost(report.total.cost)}: everything recorded, incl. other branches, compacted history, subagents, advisors`,
			`Active window ${formatCost(report.window.cost)}: the /session info scope (active branch since the last compaction) plus subagents spawned there, async ones included`,
		],
		rows,
		empty: "",
	};
}

/** Plain-text summary for modes that cannot mount an interactive component. */
export function textSummary(report: CostReport): string {
	return rootPage(report)
		.rows.map(row => `${row.label}: ${formatCost(row.cost ?? 0)} (${row.detail})`)
		.concat(`Total: ${formatCost(report.total.cost)} · Active window: ${formatCost(report.window.cost)}`)
		.join("\n");
}
