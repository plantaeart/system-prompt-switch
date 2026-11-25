// OMP entry (package.json "omp.extensions"). OMP 19 rejects any pi-tui import, so nothing here may reach it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ompEditorComponent } from "../src/adapters/omp-editor.adapter";
import { systemPromptSwitchExtension } from "../src/extension";

export default function (pi: ExtensionAPI): void {
	systemPromptSwitchExtension(pi, ompEditorComponent);
}
