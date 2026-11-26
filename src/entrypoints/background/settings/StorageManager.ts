/**
 * Persists settings in either browser-local storage or sync storage.
 *
 * Sync remains the compatibility default for existing installations. The selected scope
 * is recorded in local storage so the choice itself is never dependent on sync being
 * enabled or available. Switching scope copies current settings/version first, then flips
 * the local marker; the old copy is retained as a non-destructive fallback.
 */
import { browser } from "wxt/browser";
import {
	linkclumpSettingsKey,
	linkclumpStorageModeKey,
	linkclumpVersionKey
} from "@/assets/js/constants/setting";
import type { SettingsStorageMode } from "@/assets/js/types/Settings";

const SETTINGS_KEYS = [ linkclumpSettingsKey, linkclumpVersionKey ] as const;

export class StorageManager {
	private operationChain: Promise<void> = Promise.resolve();

	async get(key: string): Promise<unknown> {
		return this.serialize(async () => {
			const mode = await this.readMode();
			const result = mode === "local"
				? await browser.storage.local.get(key)
				: await browser.storage.sync.get(key);
			return result[key];
		});
	}

	async set(key: string, value: unknown): Promise<void> {
		return this.serialize(async () => {
			const mode = await this.readMode();
			if (mode === "local") {
				await browser.storage.local.set({ [key]: value });
			} else {
				await browser.storage.sync.set({ [key]: value });
			}
		});
	}

	/** Returns the active settings scope. Missing or invalid marker means legacy Sync. */
	async getMode(): Promise<SettingsStorageMode> {
		return this.serialize(() => this.readMode());
	}

	/**
	 * Copies the current settings/version to the destination before changing the marker.
	 * A failed copy leaves the active scope unchanged. Old copies are retained deliberately.
	 */
	async switchMode(mode: SettingsStorageMode): Promise<void> {
		return this.serialize(async () => {
			const currentMode = await this.readMode();
			if (currentMode === mode) {
				return;
			}

			const source = currentMode === "local" ? browser.storage.local : browser.storage.sync;
			const destination = mode === "local" ? browser.storage.local : browser.storage.sync;
			const stored = await source.get([ ...SETTINGS_KEYS ]);
			const copy: Record<string, unknown> = {};

			for (const key of SETTINGS_KEYS) {
				if (Object.hasOwn(stored, key)) {
					copy[key] = stored[key];
				}
			}

			if (Object.keys(copy).length > 0) {
				await destination.set(copy);
			}

			// Marker is committed last: readers continue using the old scope until its
			// complete settings snapshot has safely been copied to the new scope.
			await browser.storage.local.set({ [linkclumpStorageModeKey]: mode });
		});
	}

	private async readMode(): Promise<SettingsStorageMode> {
		const stored = await browser.storage.local.get(linkclumpStorageModeKey);
		return stored[linkclumpStorageModeKey] === "local" ? "local" : "sync";
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operationChain.then(operation, operation);
		this.operationChain = result.then(() => undefined, () => undefined);
		return result;
	}
}
