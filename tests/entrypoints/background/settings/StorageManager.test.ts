/**
 * StorageManager Tests
 *
 * Verifies the Local/Sync storage selector, migrations, and single-key reads/writes.
 *
 * @file
 * @see {@link project/vitest.config.ts} - Global settings
 * @see {@link project/tests/shared/support/setup.ts} - Shared mocks
 * @see {@link project/tests/shared/support/TestRunner.ts} - Test execution engine
 */

import { describe, beforeEach, vi } from "vitest";
import { browser } from "wxt/browser";
import { StorageManager } from "@/entrypoints/background/settings/StorageManager";
import { linkclumpSettingsKey, linkclumpStorageModeKey, linkclumpVersionKey } from "@/assets/js/constants/setting";
import { TestRunner, type TestCase } from "../../../shared/support/TestRunner";

// =============================================================================
// 1. Test Data (Separation of Data and Logic)
// =============================================================================

const testData = {
	getCases: [
		{ name: "should return the value stored under the key", input: { key: "k", stored: { k: { a: 1 }, other: 2 } }, expected: { a: 1 } },
		{ name: "should return undefined when the key is not stored", input: { key: "k", stored: {} }, expected: undefined }
	],
	setCases: [
		{ name: "should store the value wrapped in an object keyed by the key", input: { key: "k", value: [ 1, 2 ] }, expected: [ { k: [ 1, 2 ] } ] }
	]
} as const satisfies Record<string, readonly TestCase[]>;

// =============================================================================
// 2. Orchestration (Structure)
// =============================================================================

describe("StorageManager", () => {
	let manager: StorageManager;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(browser.storage.local.get).mockResolvedValue({} as never);
		manager = new StorageManager();
	});

	describe("get", () => {
		TestRunner.success(testData.getCases, undefined, ({ key, stored }: { key: string, stored: object }) => {
			vi.mocked(browser.storage.sync.get).mockResolvedValue(stored as never);

			return manager.get(key);
		});
	});

	describe("set", () => {
		TestRunner.success(testData.setCases, undefined, async ({ key, value }: { key: string, value: unknown }) => {
			vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined as never);

			await manager.set(key, value);

			return vi.mocked(browser.storage.sync.set).mock.calls.map(([ items ]) => items);
		});
	});

	it("routes reads and writes to local storage when Local mode is selected", async () => {
		vi.mocked(browser.storage.local.get).mockImplementation(async (key) => {
			if (key === linkclumpStorageModeKey) {
				return { [linkclumpStorageModeKey]: "local" } as never;
			}
			return { k: "local value" } as never;
		});
		vi.mocked(browser.storage.local.set).mockResolvedValue(undefined as never);

		expect(await manager.get("k")).toBe("local value");
		await manager.set("k", "updated");

		expect(browser.storage.local.set).toHaveBeenCalledWith({ k: "updated" });
		expect(browser.storage.sync.get).not.toHaveBeenCalled();
		expect(browser.storage.sync.set).not.toHaveBeenCalled();
	});

	it("copies settings and version before switching from Sync to Local", async () => {
		const stored = {
			[linkclumpSettingsKey]: { actions: {}, blocked: [] },
			[linkclumpVersionKey]: "5"
		};
		vi.mocked(browser.storage.sync.get).mockResolvedValue(stored as never);
		vi.mocked(browser.storage.local.get).mockResolvedValue({} as never);
		vi.mocked(browser.storage.local.set).mockResolvedValue(undefined as never);

		await manager.switchMode("local");

		expect(browser.storage.sync.get).toHaveBeenCalledWith([ linkclumpSettingsKey, linkclumpVersionKey ]);
		expect(browser.storage.local.set).toHaveBeenNthCalledWith(1, stored);
		expect(browser.storage.local.set).toHaveBeenNthCalledWith(2, { [linkclumpStorageModeKey]: "local" });
	});

	it("does not change the active scope if copying settings to the destination fails", async () => {
		const stored = { [linkclumpSettingsKey]: { actions: {}, blocked: [] } };
		const failure = new Error("Destination storage failed");
		vi.mocked(browser.storage.sync.get).mockResolvedValue(stored as never);
		vi.mocked(browser.storage.local.get).mockResolvedValue({} as never);
		vi.mocked(browser.storage.local.set).mockRejectedValueOnce(failure);

		await expect(manager.switchMode("local")).rejects.toThrow("Destination storage failed");
		expect(browser.storage.local.set).toHaveBeenCalledTimes(1);
		expect(await manager.getMode()).toBe("sync");
	});

	it("copies settings back to Sync when changing from Local to Sync", async () => {
		const stored = {
			[linkclumpSettingsKey]: { actions: {}, blocked: [] },
			[linkclumpVersionKey]: "5"
		};
		vi.mocked(browser.storage.local.get).mockImplementation(async (key) => {
			if (key === linkclumpStorageModeKey) {
				return { [linkclumpStorageModeKey]: "local" } as never;
			}
			return stored as never;
		});
		vi.mocked(browser.storage.sync.set).mockResolvedValue(undefined as never);

		await manager.switchMode("sync");

		expect(browser.storage.sync.set).toHaveBeenCalledWith(stored);
		expect(browser.storage.local.set).toHaveBeenCalledWith({ [linkclumpStorageModeKey]: "sync" });
	});
});
