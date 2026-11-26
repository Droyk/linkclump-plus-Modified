import type {
	LinkManagerQueueMode,
	LinkManagerQueueStatus,
	LinkManagerTabKind
} from "@/assets/js/types/LinkManager";

export interface QueuePolicyItem {
	readonly id: string;
	readonly batchId: string | null;
	readonly queueStatus: LinkManagerQueueStatus;
	readonly managed: boolean;
}

export interface QueuePolicyState {
	readonly mode: LinkManagerQueueMode;
	readonly paused: boolean;
	readonly batchSize: number;
	readonly activeBatchId: string | null;
	readonly nextBatchNumber: number;
	readonly items: readonly QueuePolicyItem[];
}

export type QueuePolicyTrigger = "start" | "automatic" | "manual";

export interface QueuePolicyPlan {
	readonly batchId: string;
	readonly itemIds: readonly string[];
	readonly tabKind: Exclude<LinkManagerTabKind, "external" | null>;
	readonly nextBatchNumber: number;
}

const ACTIVE_STATUSES = new Set<LinkManagerQueueStatus>([
	"opening",
	"staged",
	"opened",
	"suspended"
]);

/**
 * Returns the queue work that should be staged for a given event.
 *
 * A/refill: keep up to batchSize managed tabs alive; one closure frees one slot.
 * B/batch: never open the next batch until every managed tab in the current batch closes.
 * C/manual: like A's slot filling, but only on an explicit manual trigger.
 * D/sequential: open one destination URL directly, and only when no managed queue tab remains.
 *
 * The function is pure so the scheduling rules can be tested without browser APIs.
 */
export function planQueueWork(
	state: QueuePolicyState,
	queuedItemIds: readonly string[],
	trigger: QueuePolicyTrigger
): QueuePolicyPlan | null {
	if (state.paused || queuedItemIds.length === 0) {
		return null;
	}

	if (state.mode === "manual" && trigger !== "manual") {
		return null;
	}

	const activeItems = state.items.filter((item) => item.managed && ACTIVE_STATUSES.has(item.queueStatus));
	const activeCount = activeItems.length;
	const currentBatchIsActive = state.activeBatchId !== null
		&& activeItems.some((item) => item.batchId === state.activeBatchId);

	if (state.mode === "batch" && currentBatchIsActive) {
		return null;
	}

	if (state.mode === "sequential" && activeCount > 0) {
		return null;
	}

	const capacity = state.mode === "sequential"
		? 1
		: Math.max(0, Math.min(50, Math.floor(state.batchSize)) - activeCount);

	if (capacity === 0) {
		return null;
	}

	const itemIds = queuedItemIds.slice(0, capacity);
	if (itemIds.length === 0) {
		return null;
	}

	const hasActiveBatch = state.activeBatchId !== null
		&& activeItems.some((item) => item.batchId === state.activeBatchId);
	const batchId = hasActiveBatch
		? state.activeBatchId!
		: "batch-" + state.nextBatchNumber;

	return {
		batchId,
		itemIds,
		tabKind: state.mode === "sequential" ? "destination" : "placeholder",
		nextBatchNumber: hasActiveBatch ? state.nextBatchNumber : state.nextBatchNumber + 1
	};
}

/** Whether a batch has fully drained after a managed tab closes. */
export function isBatchDrained(
	items: readonly QueuePolicyItem[],
	batchId: string | null
): boolean {
	if (batchId === null) {
		return true;
	}

	return !items.some((item) =>
		item.managed
		&& item.batchId === batchId
		&& ACTIVE_STATUSES.has(item.queueStatus)
	);
}

/** Keeps external tabs out of pause, refill, and sequential execution decisions. */
export function isManagedQueueTab(
	item: Pick<QueuePolicyItem, "managed" | "queueStatus">
): boolean {
	return item.managed && ACTIVE_STATUSES.has(item.queueStatus);
}
