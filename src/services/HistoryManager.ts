export interface HistoryMapState {
	nodePositions: Record<string, { x: number; y: number }>;
	documents: Array<{ path: string; expanded: boolean }>;
}

export interface HistorySnapshot {
	files: Record<string, string | null>;
	maps: Record<string, HistoryMapState>;
}

export interface HistoryEntry {
	label: string;
	before: HistorySnapshot;
	after: HistorySnapshot;
	coalesceKey?: string;
}

interface HistoryStacks {
	undo: HistoryEntry[];
	redo: HistoryEntry[];
}

export class HistoryConflictError extends Error {}

export class HistoryManager {
	private readonly limit: number;
	private readonly byMap = new Map<string, HistoryStacks>();

	constructor(limit = 50) {
		this.limit = limit;
	}

	private stacks(mapId: string): HistoryStacks {
		const existing = this.byMap.get(mapId);
		if (existing) return existing;
		const created = { undo: [], redo: [] };
		this.byMap.set(mapId, created);
		return created;
	}

	record(mapId: string, entry: HistoryEntry): void {
		const stacks = this.stacks(mapId);
		const previous = stacks.undo[stacks.undo.length - 1];
		if (
			entry.coalesceKey
			&& previous?.coalesceKey === entry.coalesceKey
			&& JSON.stringify(previous.after) === JSON.stringify(entry.before)
		) {
			previous.after = entry.after;
			previous.label = entry.label;
		} else {
			stacks.undo.push(entry);
			if (stacks.undo.length > this.limit) stacks.undo.splice(0, stacks.undo.length - this.limit);
		}
		stacks.redo = [];
	}

	canUndo(mapId: string): boolean {
		return this.stacks(mapId).undo.length > 0;
	}

	canRedo(mapId: string): boolean {
		return this.stacks(mapId).redo.length > 0;
	}

	undoLabel(mapId: string): string | null {
		const entries = this.stacks(mapId).undo;
		return entries[entries.length - 1]?.label ?? null;
	}

	redoLabel(mapId: string): string | null {
		const entries = this.stacks(mapId).redo;
		return entries[entries.length - 1]?.label ?? null;
	}

	async undo(
		mapId: string,
		apply: (expected: HistorySnapshot, target: HistorySnapshot) => Promise<void>,
	): Promise<HistoryEntry | null> {
		const stacks = this.stacks(mapId);
		const entry = stacks.undo[stacks.undo.length - 1];
		if (!entry) return null;
		await apply(entry.after, entry.before);
		stacks.undo.pop();
		stacks.redo.push(entry);
		return entry;
	}

	async redo(
		mapId: string,
		apply: (expected: HistorySnapshot, target: HistorySnapshot) => Promise<void>,
	): Promise<HistoryEntry | null> {
		const stacks = this.stacks(mapId);
		const entry = stacks.redo[stacks.redo.length - 1];
		if (!entry) return null;
		await apply(entry.before, entry.after);
		stacks.redo.pop();
		stacks.undo.push(entry);
		return entry;
	}
}
