import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TranscriptSource } from "./report";

const ADVISOR_STEM = "__advisor";

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Parses JSONL, skipping blank and unparsable lines (a running writer can leave a partial last line). */
export function parseJsonl(content: string): unknown[] {
	const entries: unknown[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// Partial or foreign line: it carries no usable usage record.
		}
	}
	return entries;
}

/**
 * Loads the subagent and advisor transcripts stored in a session's artifacts
 * directory, following OMP's layout: `<dir>/<AgentId>.jsonl`, that agent's own
 * children under `<dir>/<AgentId>/`, and advisors as `__advisor.jsonl` or
 * `__advisor.<slug>.jsonl` beside the transcripts of the session they review.
 */
export async function loadTranscripts(dir: string): Promise<TranscriptSource[]> {
	let dirents: Dirent[];
	try {
		dirents = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isMissing(error)) return [];
		throw error;
	}
	const directories = new Set(dirents.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name));
	const sources: TranscriptSource[] = [];
	for (const dirent of dirents) {
		if (!dirent.isFile() || !dirent.name.endsWith(".jsonl") || dirent.name.includes(".bak")) continue;
		const stem = dirent.name.slice(0, -".jsonl".length);
		const advisor = stem === ADVISOR_STEM || stem.startsWith(`${ADVISOR_STEM}.`);
		const file = path.join(dir, dirent.name);
		let content: string;
		try {
			content = await Bun.file(file).text();
		} catch (error) {
			if (isMissing(error)) continue;
			throw error;
		}
		sources.push({
			id: advisor ? (stem === ADVISOR_STEM ? "advisor" : `advisor:${stem.slice(ADVISOR_STEM.length + 1)}`) : stem,
			kind: advisor ? "advisor" : "subagent",
			file,
			entries: parseJsonl(content),
			children: !advisor && directories.has(stem) ? await loadTranscripts(path.join(dir, stem)) : [],
		});
	}
	return sources;
}
