// Pen draws, fingers navigate. While the pen is down, hovers, or was seen a moment ago, touches
// are a resting palm: ignore them. A hover that sends no events for HOVER_STALE_MS counts as gone
// (in case the browser never reports the pen leaving).
export class PenGate {
	static readonly HOLD_MS = 600;
	static readonly HOVER_STALE_MS = 3000;
	private seen = -Infinity;
	private down = false;
	private hovering = false;

	/** Any pen event with contact state (down, move, up). */
	pen(now: number, down: boolean) {
		this.seen = now;
		this.down = down;
	}

	/** The pen entered (or moves in) hover range, or left it. */
	hover(now: number, on: boolean) {
		this.seen = now;
		this.hovering = on;
	}

	allowTouch(now: number): boolean {
		if (this.down) return false;
		if (this.hovering && now - this.seen <= PenGate.HOVER_STALE_MS) return false;
		return now - this.seen > PenGate.HOLD_MS;
	}
}
