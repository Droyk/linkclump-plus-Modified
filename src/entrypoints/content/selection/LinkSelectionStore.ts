import type { LinkElement } from "@/assets/js/types/Content";

/**
 * A captured link is a value snapshot, not a live view of the page.
 *
 * selectionOrder records when an item first entered the collection. The array returned by
 * getEntries() is the current display/export order; sorting never rewrites selection history.
 */
export interface SelectedLink {
	readonly id: string;
	readonly url: string;
	readonly title: string;
	readonly text: string;
	readonly sourceUrl: string;
	readonly selectionOrder: number;
}

export type SelectedLinkUpdate = Partial<Pick<SelectedLink, "url" | "title" | "text" | "sourceUrl">>;

export interface AddLinkResult {
	readonly entry: Readonly<SelectedLink>;
	readonly added: boolean;
}

export interface ToggleLinkResult {
	readonly selected: boolean;
	readonly entry: Readonly<SelectedLink> | null;
}

export type LinkSelectionListener = (entries: readonly Readonly<SelectedLink>[]) => void;

/**
 * In-memory selection model for one content-script document/frame.
 *
 * Identity is based on the source DOM element, not URL. Two different anchors that point
 * to the same URL remain independently selectable. URL de-duplication belongs to the
 * action/export layer, where it can respect the user's separate "block repeats" choice.
 */
export class LinkSelectionStore {
	private entries: SelectedLink[] = [];
	private elementIds = new WeakMap<LinkElement, string>();
	private elementsById = new Map<string, LinkElement>();
	private nextId = 1;
	private nextSelectionOrder = 1;
	private listeners = new Set<LinkSelectionListener>();

	/** Returns detached, frozen snapshots in the current display order. */
	getEntries(): readonly Readonly<SelectedLink>[] {
		return this.entries.map((entry) => Object.freeze({ ...entry }));
	}

	get size(): number {
		return this.entries.length;
	}

	has(element: LinkElement): boolean {
		const id = this.elementIds.get(element);
		return id !== undefined && this.entries.some((entry) => entry.id === id);
	}

	findById(id: string): Readonly<SelectedLink> | undefined {
		const entry = this.entries.find((item) => item.id === id);
		return entry ? Object.freeze({ ...entry }) : undefined;
	}

	findByElement(element: LinkElement): Readonly<SelectedLink> | undefined {
		const id = this.elementIds.get(element);
		return id === undefined ? undefined : this.findById(id);
	}

	/** Returns the source element for a live page-backed row. */
	getElement(id: string): LinkElement | undefined {
		return this.elementsById.get(id);
	}

	/** Captures a usable link. Re-selecting the same element is idempotent. */
	addElement(element: LinkElement): AddLinkResult | null {
		const result = this.addElementWithoutNotify(element);
		if (result?.added) {
			this.notify();
		}
		return result ? { entry: Object.freeze({ ...result.entry }), added: result.added } : null;
	}

	/**
	 * Adds a URL not tied to a page element (for example, a manually entered row in a
	 * future collection manager). Duplicate URLs are intentionally allowed.
	 */
	addUrl(url: string, title = url, sourceUrl = ""): AddLinkResult | null {
		const normalizedUrl = url.trim();
		if (!isUsableUrl(normalizedUrl)) {
			return null;
		}

		const normalizedTitle = normalizeText(title) || normalizedUrl;
		const entry: SelectedLink = {
			id: this.createId(),
			url: normalizedUrl,
			title: normalizedTitle,
			text: normalizedTitle,
			sourceUrl,
			selectionOrder: this.nextSelectionOrder++
		};

		this.entries.push(entry);
		this.notify();
		return { entry: Object.freeze({ ...entry }), added: true };
	}

	/** Adds elements in their supplied order and emits one collection change. */
	addElements(elements: Iterable<LinkElement>): readonly Readonly<SelectedLink>[] {
		const added: SelectedLink[] = [];

		for (const element of elements) {
			const result = this.addElementWithoutNotify(element);
			if (result?.added) {
				added.push(result.entry);
			}
		}

		if (added.length > 0) {
			this.notify();
		}

		return added.map((entry) => Object.freeze({ ...entry }));
	}

	/** Toggles one exact page element without collapsing another element with the same URL. */
	toggleElement(element: LinkElement): ToggleLinkResult {
		const existingId = this.elementIds.get(element);
		if (existingId !== undefined && this.removeById(existingId)) {
			this.notify();
			return { selected: false, entry: null };
		}

		const result = this.addElementWithoutNotify(element);
		if (!result) {
			return { selected: false, entry: null };
		}

		if (result.added) {
			this.notify();
		}

		return { selected: true, entry: Object.freeze({ ...result.entry }) };
	}

	remove(target: string | LinkElement): boolean {
		const id = typeof target === "string" ? target : this.elementIds.get(target);
		if (id === undefined || !this.removeById(id)) {
			return false;
		}
		this.notify();
		return true;
	}

	clear(): boolean {
		if (this.entries.length === 0) {
			return false;
		}
		this.entries = [];
		this.elementIds = new WeakMap<LinkElement, string>();
		this.elementsById.clear();
		this.notify();
		return true;
	}

	/**
	 * Applies a complete reorder only when ids is an exact permutation of current ids.
	 * Partial, duplicated, or stale drag-and-drop results are rejected atomically.
	 */
	reorder(ids: readonly string[]): boolean {
		if (ids.length !== this.entries.length || new Set(ids).size !== ids.length) {
			return false;
		}

		const currentById = new Map<string, SelectedLink>();
		for (const entry of this.entries) {
			currentById.set(entry.id, entry);
		}

		const reordered: SelectedLink[] = [];
		for (const id of ids) {
			const entry = currentById.get(id);
			if (!entry) {
				return false;
			}
			reordered.push(entry);
		}

		if (ids.every((id, index) => this.entries[index]?.id === id)) {
			return true;
		}

		this.entries = reordered;
		this.notify();
		return true;
	}

	/** Updates editable row fields without changing identity or selection chronology. */
	update(id: string, changes: SelectedLinkUpdate): boolean {
		const index = this.entries.findIndex((entry) => entry.id === id);
		const current = this.entries[index];
		if (!current) {
			return false;
		}

		const url = changes.url === undefined ? current.url : changes.url.trim();
		if (!isUsableUrl(url)) {
			return false;
		}

		this.entries[index] = {
			...current,
			url,
			title: changes.title === undefined ? current.title : normalizeText(changes.title),
			text: changes.text === undefined ? current.text : normalizeText(changes.text),
			sourceUrl: changes.sourceUrl === undefined ? current.sourceUrl : changes.sourceUrl
		};
		this.notify();
		return true;
	}

	subscribe(listener: LinkSelectionListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private addElementWithoutNotify(element: LinkElement): AddLinkResult | null {
		const existingId = this.elementIds.get(element);
		if (existingId !== undefined) {
			const existing = this.entries.find((entry) => entry.id === existingId);
			if (existing) {
				return { entry: existing, added: false };
			}
		}

		const rawHref = element.getAttribute("href");
		if (rawHref === null || rawHref.trim() === "" || rawHref.trim() === "#") {
			return null;
		}

		const url = element.href.trim();
		if (!isUsableUrl(url)) {
			return null;
		}

		const isArea = element.tagName.toLowerCase() === "area";
		const text = normalizeText(isArea ? (element as HTMLAreaElement).alt : element.textContent);
		const title = normalizeText(element.getAttribute("aria-label"))
			|| normalizeText(element.getAttribute("title"))
			|| text
			|| url;

		const entry: SelectedLink = {
			id: this.createId(),
			url,
			title,
			text,
			sourceUrl: element.ownerDocument.URL,
			selectionOrder: this.nextSelectionOrder++
		};

		this.entries.push(entry);
		this.elementIds.set(element, entry.id);
		this.elementsById.set(entry.id, element);
		return { entry, added: true };
	}

	private removeById(id: string): boolean {
		const index = this.entries.findIndex((entry) => entry.id === id);
		if (index < 0) {
			return false;
		}
		this.entries.splice(index, 1);
		this.elementsById.delete(id);
		// The WeakMap may retain an old id for this element. IDs are never reused, so a
		// subsequent add sees that the old record is gone and safely allocates a new id.
		return true;
	}

	private createId(): string {
		return `link-${this.nextId++}`;
	}

	private notify(): void {
		const snapshot = this.getEntries();
		for (const listener of [ ...this.listeners ]) {
			listener(snapshot);
		}
	}
}

function isUsableUrl(url: string): boolean {
	return url.trim() !== "" && !/^javascript:/i.test(url.trim());
}

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}
