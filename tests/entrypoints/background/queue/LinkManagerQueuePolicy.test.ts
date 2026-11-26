import { describe, expect, it } from "vitest";
import {
	isBatchDrained,
	isManagedQueueTab,
	planQueueWork,
	type QueuePolicyState
} from "@/entrypoints/background/queue/LinkManagerQueuePolicy";

function createState(overrides: Partial<QueuePolicyState> = {}): QueuePolicyState {
	return {
		mode: "refill",
		paused: false,
		batchSize: 4,
		activeBatchId: "batch-1",
		nextBatchNumber: 2,
		items: [],
		...overrides
	};
}

describe("LinkManagerQueuePolicy", () => {
	it("A/refill replaces only the freed slot while the other tabs remain open", () => {
		const state = createState({
			items: [
				{ id: "a", batchId: "batch-1", queueStatus: "opened", managed: true },
				{ id: "b", batchId: "batch-1", queueStatus: "opened", managed: true },
				{ id: "c", batchId: "batch-1", queueStatus: "opened", managed: true }
			]
		});

		expect(planQueueWork(state, [ "d", "e", "f" ], "automatic")).toEqual({
			batchId: "batch-1",
			itemIds: [ "d" ],
			tabKind: "placeholder",
			nextBatchNumber: 2
		});
	});

	it("B/batch waits while any member of the current batch remains open", () => {
		const state = createState({
			mode: "batch",
			items: [
				{ id: "a", batchId: "batch-1", queueStatus: "closed", managed: true },
				{ id: "b", batchId: "batch-1", queueStatus: "opened", managed: true }
			]
		});

		expect(planQueueWork(state, [ "c", "d" ], "automatic")).toBeNull();
	});

	it("B/batch stages the next complete batch after the current batch drains", () => {
		const state = createState({
			mode: "batch",
			items: [
				{ id: "a", batchId: "batch-1", queueStatus: "closed", managed: true },
				{ id: "b", batchId: "batch-1", queueStatus: "closed", managed: true }
			]
		});

		expect(planQueueWork(state, [ "c", "d", "e", "f", "g" ], "automatic")).toEqual({
			batchId: "batch-2",
			itemIds: [ "c", "d", "e", "f" ],
			tabKind: "placeholder",
			nextBatchNumber: 3
		});
	});

	it("C/manual does not refill automatically but permits an explicit refill", () => {
		const state = createState({
			mode: "manual",
			items: [
				{ id: "a", batchId: "batch-1", queueStatus: "opened", managed: true },
				{ id: "b", batchId: "batch-1", queueStatus: "closed", managed: true }
			]
		});

		expect(planQueueWork(state, [ "c", "d" ], "automatic")).toBeNull();
		expect(planQueueWork(state, [ "c", "d" ], "manual")?.itemIds).toEqual([ "c", "d" ]);
	});

	it("D/sequential opens a direct destination only when no managed queue tab remains", () => {
		const blocked = createState({
			mode: "sequential",
			items: [
				{ id: "a", batchId: "batch-1", queueStatus: "opened", managed: true }
			]
		});
		const ready = createState({ mode: "sequential" });

		expect(planQueueWork(blocked, [ "b", "c" ], "automatic")).toBeNull();
		expect(planQueueWork(ready, [ "b", "c" ], "automatic")).toEqual({
			batchId: "batch-2",
			itemIds: [ "b" ],
			tabKind: "destination",
			nextBatchNumber: 3
		});
	});

	it("does not stage any work while paused", () => {
		expect(planQueueWork(createState({ paused: true }), [ "a" ], "manual")).toBeNull();
	});

	it("does not count unrelated browser tabs as queue slots", () => {
		const state = createState({
			items: [
				{ id: "external", batchId: "batch-1", queueStatus: "external", managed: false },
				{ id: "open", batchId: "batch-1", queueStatus: "opened", managed: true }
			]
		});

		expect(planQueueWork(state, [ "next" ], "automatic")?.itemIds).toEqual([ "next" ]);
		expect(isManagedQueueTab({ managed: false, queueStatus: "external" })).toBe(false);
	});

	it("considers suspended managed tabs part of their batch during pause", () => {
		expect(isBatchDrained([
			{ id: "a", batchId: "batch-1", queueStatus: "suspended", managed: true }
		], "batch-1")).toBe(false);
		expect(isBatchDrained([
			{ id: "a", batchId: "batch-1", queueStatus: "closed", managed: true }
		], "batch-1")).toBe(true);
	});
});
