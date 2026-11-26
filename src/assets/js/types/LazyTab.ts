export interface PendingLazyTab {
	readonly token: string;
	readonly url: string;
	readonly title: string;
	readonly tabId: number | null;
}
