// Pi entry (package.json "pi.extensions"). Pi's editor is pi-tui's Editor, which OMP 19 refuses to load.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { editorComponent } from "../src/adapters/pi-editor.adapter";
import { systemPromptSwitchExtension } from "../src/extension";

export default function (pi: ExtensionAPI): void {
	systemPromptSwitchExtension(pi, editorComponent);
}
