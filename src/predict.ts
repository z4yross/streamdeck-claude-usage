import { type UsageWindow, type WindowKey, windowLength } from "./usage-api";

type Sample = { t: number; u: number };
type Series = { resetsAt: number; samples: Sample[] };

const KEEP_MS = 60 * 60 * 1000;
/** Recent samples must span at least this long before their slope beats the window average. */
const MIN_RECENT_SPAN_MS = 10 * 60 * 1000;
const MIN_WINDOW_ELAPSED_MS = 5 * 60 * 1000;

export type Prediction = {
	/** Percent per hour. */
	perHour: number;
	/** Where the window lands if the pace holds, capped at 100. */
	atReset: number;
	/** Epoch ms when it hits 100%, if before the reset. */
	hitsLimitAt: number | null;
	source: "recent" | "window";
};

/**
 * Keeps a short history of utilization samples per account and window and extrapolates.
 *
 * Preferred pace is the slope of the last hour of samples. Right after start there is
 * nothing to fit yet, so it falls back to the average since the window opened
 * (`resets_at` minus the window length, assuming 0% then), which is available from the
 * very first fetch.
 */
export class PaceTracker {
	private series = new Map<string, Series>();

	push(account: string, key: WindowKey, window: UsageWindow, now = Date.now()): void {
		const id = `${account}:${key}`;
		let series = this.series.get(id);
		const last = series?.samples.at(-1);
		// A new reset time, or usage going down, means the window rolled over: start fresh.
		if (!series || series.resetsAt !== window.resetsAt || (last && window.utilization < last.u - 0.5)) {
			series = { resetsAt: window.resetsAt, samples: [] };
			this.series.set(id, series);
		}
		series.samples.push({ t: now, u: window.utilization });
		series.samples = series.samples.filter((s) => now - s.t <= KEEP_MS);
	}

	predict(account: string, key: WindowKey, window: UsageWindow, now = Date.now()): Prediction | null {
		const series = this.series.get(`${account}:${key}`);
		const remainingMs = Math.max(0, window.resetsAt - now);

		let perHour: number | null = null;
		let source: Prediction["source"] = "window";

		const samples = series?.resetsAt === window.resetsAt ? series.samples : [];
		const first = samples[0];
		const last = samples.at(-1);
		if (first && last && last.t - first.t >= MIN_RECENT_SPAN_MS) {
			perHour = ((last.u - first.u) / (last.t - first.t)) * 3_600_000;
			source = "recent";
		} else {
			const elapsedMs = windowLength(key) - remainingMs;
			if (elapsedMs >= MIN_WINDOW_ELAPSED_MS) perHour = (window.utilization / elapsedMs) * 3_600_000;
		}
		if (perHour === null) return null;
		perHour = Math.max(0, perHour);

		const projected = window.utilization + (perHour * remainingMs) / 3_600_000;
		const hitsLimitAt = perHour > 0 && projected >= 100 ? now + ((100 - window.utilization) / perHour) * 3_600_000 : null;
		return { perHour, atReset: Math.min(100, projected), hitsLimitAt, source };
	}
}
