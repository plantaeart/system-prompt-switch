import { describe, expect, it } from "bun:test";
import ompEntry from "../../extensions/index";
import piEntry from "../../extensions/pi";

/**
 * Pi and OMP load different entry files. The smoke test only proves each one loads in its CLI; this proves both wire
 * the same extension (same commands and events), so a change to one entry cannot quietly drop a command on that host.
 */
function surfaceOf(entry: (pi: never) => void): { commands: string[]; events: string[] } {
	const commands: string[] = [];
	const events: string[] = [];
	const pi = new Proxy(
		{},
		{
			get: (_target, key) => {
				if (key === "registerCommand") return (name: string) => commands.push(name);
				if (key === "on") return (event: string) => events.push(event);
				return () => undefined;
			},
		},
	);
	entry(pi as never);
	return { commands: commands.sort(), events: events.sort() };
}

describe("host entries", () => {
	it("register the same commands and events on Pi and OMP", () => {
		const omp = surfaceOf(ompEntry);
		const pi = surfaceOf(piEntry);

		expect(omp.commands.length).toBeGreaterThan(0);
		expect(pi).toEqual(omp);
	});
});
