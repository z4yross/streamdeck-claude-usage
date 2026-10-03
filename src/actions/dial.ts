import streamDeck, {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { ACCENT, colorFor, GREY } from "../icons";
import { PaceTracker } from "../predict";
import { fetchUsage, type UsageError, type UsageResult, type UsageWindow, type WindowKey } from "../usage-api";

type Feedback = Parameters<DialAction<Settings>["setFeedback"]>[0];

export type Settings = {
	/** Comma-separated `Label=configDir` pairs. */
	accounts?: string;
	/** Poll interval in seconds. */
	refreshSeconds?: number;
	/** Index of the account currently shown; persisted so it survives restarts. */
	account?: number;
};

type Account = { label: string; dir: string };

const DEFAULT_ACCOUNTS = "Claude=~/.claude";
const DEFAULT_REFRESH = 60;
const MIN_REFRESH = 30;
/** Press held this long opens the usage page instead of showing the prediction. */
const HOLD_MS = 600;
const PREDICTION_MS = 6000;
const USAGE_PAGE = "https://claude.ai/settings/usage";

const SECONDARY_ORDER: WindowKey[] = ["seven_day", "seven_day_opus", "seven_day_sonnet"];
const LABELS: Record<WindowKey, string> = {
	five_hour: "5h",
	seven_day: "7d",
	seven_day_opus: "Op",
	seven_day_sonnet: "So",
};

const logger = streamDeck.logger.createScope("Dial");

type DialState = {
	index: number;
	secondary: WindowKey;
	/** While set, the screen shows the extrapolation instead of the live numbers. */
	predictionTimer: NodeJS.Timeout | null;
	downAt: number | null;
};

type Cached = { result: UsageResult | null; fetching: boolean; at: number; retryAt: number };

/**
 * How long to leave an account alone after each failure. Polling a dead token every
 * minute is what turned a 401 into a day-long 429: the endpoint rate-limits bad auth per
 * token, so the only cure is to stop asking until the token has had a chance to change.
 */
const BACKOFF_MS: Record<UsageError, number> = {
	"no-creds": 5 * 60_000,
	expired: 5 * 60_000,
	login: 10 * 60_000,
	"rate-limited": 15 * 60_000,
	network: 2 * 60_000,
};

function parseAccounts(settings: Settings): Account[] {
	const accounts = (settings.accounts ?? DEFAULT_ACCOUNTS)
		.split(",")
		.map((pair) => {
			const eq = pair.indexOf("=");
			if (eq < 0) return { label: pair.trim(), dir: pair.trim() };
			return { label: pair.slice(0, eq).trim(), dir: pair.slice(eq + 1).trim() };
		})
		.filter((a) => a.label && a.dir);
	return accounts.length ? accounts : [{ label: "Claude", dir: "~/.claude" }];
}

function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const mins = minutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

function formatClock(epochMs: number): string {
	const date = new Date(epochMs);
	const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
	const sameDay = new Date().toDateString() === date.toDateString();
	return sameDay ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

function formatPace(perHour: number): string {
	return `${perHour < 10 ? perHour.toFixed(1) : Math.round(perHour)}%/h`;
}

const ERROR_TEXT = {
	"no-creds": "no creds",
	expired: "expired",
	login: "login",
	"rate-limited": "429",
	network: "offline",
} as const;

/**
 * One dial showing Claude Code plan usage for a list of accounts.
 *
 * Rotating switches the account (each is a Claude Code config dir with its own OAuth
 * token). Tap or short press swaps the numbers for an extrapolation: the clock at which
 * the window hits 100%, or the percent it lands on at reset. Tapping again while the
 * prediction is up cycles the second row through the 7d windows the API returns. A held
 * press or hold-tap opens the usage page in the browser.
 *
 * Fetches are cached per config dir so two dials showing the same account share one poll.
 */
@action({ UUID: "com.z4yross.claudeusage.dial" })
export class UsageDial extends SingletonAction<Settings> {
	private timer: NodeJS.Timeout | null = null;
	private refreshing = false;
	private states = new Map<string, DialState>();
	private cache = new Map<string, Cached>();
	private pace = new PaceTracker();

	private stateFor(id: string, settings: Settings): DialState {
		let state = this.states.get(id);
		if (!state) {
			state = { index: settings.account ?? 0, secondary: "seven_day", predictionTimer: null, downAt: null };
			this.states.set(id, state);
		}
		return state;
	}

	private currentAccount(state: DialState, settings: Settings): Account {
		const accounts = parseAccounts(settings);
		state.index = ((state.index % accounts.length) + accounts.length) % accounts.length;
		return accounts[state.index];
	}

	private async fetchAccount(account: Account, force = false): Promise<void> {
		let cached = this.cache.get(account.dir);
		if (!cached) {
			cached = { result: null, fetching: false, at: 0, retryAt: 0 };
			this.cache.set(account.dir, cached);
		}
		// Two dials on the same account, or a spin landing mid-poll, must not double-fetch.
		if (cached.fetching || (!force && (Date.now() - cached.at < 5000 || Date.now() < cached.retryAt))) return;

		cached.fetching = true;
		try {
			const result = await fetchUsage(account.dir);
			cached.at = Date.now();
			if (result.ok) {
				for (const [key, window] of Object.entries(result.usage.windows)) {
					this.pace.push(account.dir, key as WindowKey, window);
				}
				const summary = Object.entries(result.usage.windows)
					.map(([k, w]) => `${k}=${Math.round(w.utilization)}%`)
					.join(" ");
				logger.info(`${account.label}: ${summary}`);
				cached.result = result;
				cached.retryAt = 0;
			} else {
				logger.warn(`${account.label}: ${result.error}${result.detail ? ` (${result.detail})` : ""}`);
				cached.retryAt = Date.now() + BACKOFF_MS[result.error];
				// Keep the last good numbers on a transient 429 or network blip; drop them on auth loss.
				if (result.error === "no-creds" || result.error === "expired" || result.error === "login" || !cached.result?.ok) cached.result = result;
			}
		} finally {
			cached.fetching = false;
		}
	}

	private secondaryWindow(state: DialState, windows: Partial<Record<WindowKey, UsageWindow>>): [WindowKey, UsageWindow | undefined] {
		const key = windows[state.secondary] ? state.secondary : "seven_day";
		return [key, windows[key]];
	}

	private async paint(dial: DialAction<Settings>, settings: Settings): Promise<void> {
		const state = this.stateFor(dial.id, settings);
		const account = this.currentAccount(state, settings);
		const cached = this.cache.get(account.dir);
		const result = cached?.result ?? null;

		if (!result) {
			await dial.setFeedback({
				acct: { value: `${account.label} · loading...`, color: GREY },
				r1: "5h",
				r1r: "",
				bar1: { value: 0, bar_fill_c: colorFor(null) },
				r2: "7d",
				r2r: "",
				bar2: { value: 0, bar_fill_c: colorFor(null) },
			});
			return;
		}

		if (!result.ok) {
			await dial.setFeedback({
				acct: { value: `${account.label} · ${result.error === "login" || result.error === "expired" ? "run claude with this account" : (result.detail ?? "")}`, color: GREY },
				r1: ERROR_TEXT[result.error],
				r1r: "",
				bar1: { value: 0, bar_fill_c: colorFor(null) },
				r2: "",
				r2r: "",
				bar2: { value: 0, bar_fill_c: colorFor(null) },
			});
			return;
		}

		const { windows, fetchedAt } = result.usage;
		const [secondaryKey, w2] = this.secondaryWindow(state, windows);
		const rows: Array<[WindowKey, UsageWindow | undefined]> = [
			["five_hour", windows.five_hour],
			[secondaryKey, w2],
		];
		const now = Date.now();
		const predicting = state.predictionTimer !== null;
		const feedback: Feedback = {};
		let paceSource: string | null = null;

		rows.forEach(([key, window], i) => {
			const n = i + 1;
			if (!window) {
				feedback[`r${n}`] = `${LABELS[key]} --`;
				feedback[`r${n}r`] = "";
				feedback[`bar${n}`] = { value: 0, bar_fill_c: colorFor(null) };
				return;
			}
			if (!predicting) {
				feedback[`r${n}`] = `${LABELS[key]} ${Math.round(window.utilization)}%`;
				feedback[`r${n}r`] = formatDuration(window.resetsAt - now);
				feedback[`bar${n}`] = { value: Math.round(window.utilization), bar_fill_c: colorFor(window.utilization) };
				return;
			}
			const prediction = this.pace.predict(account.dir, key, window, now);
			if (!prediction) {
				feedback[`r${n}`] = `${LABELS[key]} n/a`;
				feedback[`r${n}r`] = "";
				feedback[`bar${n}`] = { value: Math.round(window.utilization), bar_fill_c: colorFor(window.utilization) };
				return;
			}
			paceSource ??= prediction.source;
			feedback[`r${n}`] = prediction.hitsLimitAt
				? `${LABELS[key]} out ${formatClock(prediction.hitsLimitAt)}`
				: `${LABELS[key]} ok ${Math.round(prediction.atReset)}%`;
			feedback[`r${n}r`] = formatPace(prediction.perHour);
			feedback[`bar${n}`] = { value: Math.round(prediction.atReset), bar_fill_c: colorFor(prediction.atReset) };
		});

		feedback.acct = predicting
			? { value: `${account.label} · prediction (${paceSource === "recent" ? "recent pace" : paceSource === "window" ? "avg pace" : "no data"})`, color: "#ffffff" }
			: { value: `${account.label} · upd ${formatClock(fetchedAt)}`, color: ACCENT };

		await dial.setFeedback(feedback);
	}

	private async refreshAll(force = false): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			const dials: Array<[DialAction<Settings>, Settings]> = [];
			const accounts = new Map<string, Account>();
			for (const dial of this.actions) {
				if (!dial.isDial()) continue;
				const settings = await dial.getSettings();
				dials.push([dial, settings]);
				for (const account of parseAccounts(settings)) accounts.set(account.dir, account);
			}
			await Promise.all([...accounts.values()].map((account) => this.fetchAccount(account, force)));
			for (const [dial, settings] of dials) await this.paint(dial, settings);
		} finally {
			this.refreshing = false;
		}
	}

	private startTimer(seconds: number): void {
		this.stopTimer();
		this.timer = setInterval(() => {
			void this.refreshAll().catch((error) => logger.error("refresh failed", error));
		}, Math.max(MIN_REFRESH, seconds) * 1000);
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private async showPrediction(dial: DialAction<Settings>, settings: Settings): Promise<void> {
		const state = this.stateFor(dial.id, settings);
		if (state.predictionTimer) {
			// Already predicting: a second tap cycles which 7d window the bottom row tracks.
			clearTimeout(state.predictionTimer);
			const account = this.currentAccount(state, settings);
			const result = this.cache.get(account.dir)?.result;
			const available = result?.ok ? SECONDARY_ORDER.filter((k) => result.usage.windows[k]) : ["seven_day" as WindowKey];
			const at = available.indexOf(state.secondary);
			state.secondary = available[(at + 1) % available.length] ?? "seven_day";
		}
		state.predictionTimer = setTimeout(() => {
			state.predictionTimer = null;
			void this.paint(dial, settings).catch((error) => logger.error("paint failed", error));
		}, PREDICTION_MS);
		await this.paint(dial, settings);
	}

	private async openUsagePage(): Promise<void> {
		logger.info("opening usage page");
		await streamDeck.system.openUrl(USAGE_PAGE);
	}

	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		if (!ev.action.isDial()) return;
		logger.info(`willAppear ${ev.action.id}`);
		this.stateFor(ev.action.id, ev.payload.settings);
		await this.paint(ev.action, ev.payload.settings);
		this.startTimer(ev.payload.settings.refreshSeconds ?? DEFAULT_REFRESH);
		await this.refreshAll();
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		const state = this.states.get(ev.action.id);
		if (state?.predictionTimer) clearTimeout(state.predictionTimer);
		this.states.delete(ev.action.id);
		if (this.states.size === 0) this.stopTimer();
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
		if (!ev.action.isDial()) return;
		this.startTimer(ev.payload.settings.refreshSeconds ?? DEFAULT_REFRESH);
		await this.refreshAll();
	}

	override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
		const settings = ev.payload.settings;
		const state = this.stateFor(ev.action.id, settings);
		const accounts = parseAccounts(settings);
		if (accounts.length < 2) return;

		state.index += Math.sign(ev.payload.ticks);
		const account = this.currentAccount(state, settings);
		logger.info(`switched to ${account.label}`);
		await ev.action.setSettings({ ...settings, account: state.index });
		await this.paint(ev.action, settings);

		const cached = this.cache.get(account.dir);
		const stale = !cached || Date.now() - cached.at > (settings.refreshSeconds ?? DEFAULT_REFRESH) * 1000;
		if (stale) {
			await this.fetchAccount(account);
			await this.paint(ev.action, settings);
		}
	}

	override onDialDown(ev: DialDownEvent<Settings>): void {
		this.stateFor(ev.action.id, ev.payload.settings).downAt = Date.now();
	}

	override async onDialUp(ev: DialUpEvent<Settings>): Promise<void> {
		const state = this.stateFor(ev.action.id, ev.payload.settings);
		const held = state.downAt !== null && Date.now() - state.downAt >= HOLD_MS;
		state.downAt = null;
		if (held) await this.openUsagePage();
		else await this.showPrediction(ev.action, ev.payload.settings);
	}

	override async onTouchTap(ev: TouchTapEvent<Settings>): Promise<void> {
		if (ev.payload.hold) await this.openUsagePage();
		else await this.showPrediction(ev.action, ev.payload.settings);
	}
}
