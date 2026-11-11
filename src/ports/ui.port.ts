export interface MultiSelectItem {
	id: string;
	label: string;
	selected: boolean;
	name?: string;
	scope?: string;
	isSpecial?: "save" | "none" | "create-omp" | "create-pi" | "create-local";
}

export interface MultiSelectResult {
	cancelled?: boolean;
	selectedIds: string[];
	action?: "create-omp" | "create-pi" | "create-local";
}

export interface SelectPromptToEditResult {
	cancelled?: boolean;
	choice?: string;
	action?: "edit" | "rename";
}

export interface UIPort {
	select(title: string, options: string[]): Promise<string | undefined>;
	selectPromptToEdit?(
		title: string,
		options: string[],
		initialIndex?: number,
	): Promise<SelectPromptToEditResult | undefined>;
	multiSelect?(
		title: string,
		items: MultiSelectItem[],
	): Promise<MultiSelectResult | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setWidget(content: string[] | undefined): void;
	hasUI(): boolean;
}
