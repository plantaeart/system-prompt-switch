/**
 * Lets promise chains the code under test started (an async editor, a content loader) run to their end, without
 * waiting on a clock: only microtasks are drained, so it is deterministic and instant.
 */
export async function settle(): Promise<void> {
	for (let i = 0; i < 25; i++) await Promise.resolve();
}
