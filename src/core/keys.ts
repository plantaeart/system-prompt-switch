/**
 * Names the unmodified navigation and editing keys whatever encoding the terminal uses: legacy bytes, xterm application
 * mode (`ESC O x`), the Kitty keyboard protocol (`CSI code ; mods : event final`) and modifyOtherKeys
 * (`CSI 27 ; mods ; code ~`). OMP turns the Kitty protocol on, so one key can arrive in several shapes depending on the
 * terminal, caps lock and whether key releases are reported.
 * shortcut: unmodified keys only (chords return undefined and stay with their own handler); upgrade if the editor
 * needs word motions or selection.
 */
export type PlainKey =
	| "escape"
	| "enter"
	| "backspace"
	| "tab"
	| "delete"
	| "up"
	| "down"
	| "left"
	| "right"
	| "home"
	| "end"
	| "pageUp"
	| "pageDown";

const LEGACY: Record<string, PlainKey> = {
	"\x1b": "escape",
	"\r": "enter",
	"\n": "enter",
	"\r\n": "enter",
	"\x7f": "backspace",
	"\b": "backspace",
	"\t": "tab",
};
const LETTER: Record<string, PlainKey> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE: Record<string, PlainKey> = { "1": "home", "3": "delete", "4": "end", "5": "pageUp", "6": "pageDown", "7": "home", "8": "end" };
const CODEPOINT: Record<string, PlainKey> = { "9": "tab", "13": "enter", "27": "escape", "127": "backspace" };
// eslint-disable-next-line no-control-regex
const SS3 = /^\x1bO([ABCDHF])$/;
// eslint-disable-next-line no-control-regex
const MODIFY_OTHER_KEYS = /^\x1b\[27;(\d+);(\d+)~$/;
// eslint-disable-next-line no-control-regex
const CSI = /^\x1b\[(\d*)(?::\d+)*(?:;(\d*)(?::(\d+))?)?([A-Za-z~])$/;
const LOCK_BITS = 64 | 128; // caps lock and num lock ride along in the modifier field

export function plainKey(data: string): PlainKey | undefined {
	const legacy = LEGACY[data];
	if (legacy) return legacy;
	const ss3 = SS3.exec(data);
	if (ss3) return LETTER[ss3[1]!];

	let code: string;
	let mods: string | undefined;
	let event: string | undefined;
	let final: string;
	const mok = MODIFY_OTHER_KEYS.exec(data);
	if (mok) {
		[, mods, code] = mok as unknown as [string, string, string];
		final = "u";
	} else {
		const csi = CSI.exec(data);
		if (!csi) return undefined;
		[, code, mods, event, final] = csi as unknown as [string, string, string | undefined, string | undefined, string];
	}
	if (event === "3") return undefined; // a key release
	if (mods && ((Number(mods) - 1) & ~LOCK_BITS) !== 0) return undefined; // shift, alt, ctrl or super held
	if (final === "~") return TILDE[code];
	if (final === "u") return CODEPOINT[code];
	return code === "" || code === "1" ? LETTER[final] : undefined;
}
