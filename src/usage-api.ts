import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("UsageApi");

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const FALLBACK_VERSION = "2.1.278";
const REQUEST_TIMEOUT_MS = 10_000;
/** Treat the token as dead this long before `expiresAt` so a poll never lands on the edge. */
const EXPIRY_SLACK_MS = 60 * 1000;

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type WindowKey = "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet";

export type UsageWindow = {
	/** Percent used, 0..100. */
	utilization: number;
	/** Epoch ms when the window resets. */
	resetsAt: number;
};

export type Usage = {
	windows: Partial<Record<WindowKey, UsageWindow>>;
	fetchedAt: number;
};

export type UsageError = "no-creds" | "expired" | "login" | "rate-limited" | "network";

export type UsageResult = { ok: true; usage: Usage } | { ok: false; error: UsageError; detail?: string };

type Credentials = { accessToken: string; expiresAt?: number; subscriptionType?: string };

/** Length of each window, used to estimate the average pace since the window opened. */
export function windowLength(key: WindowKey): number {
	return key === "five_hour" ? FIVE_HOURS_MS : SEVEN_DAYS_MS;
}

function expandHome(dir: string): string {
	const home = homedir();
	if (dir === "~") return home;
	if (dir.startsWith("~/") || dir.startsWith("~\\")) return join(home, dir.slice(2));
	return dir;
}

async function readCredentials(configDir: string): Promise<Credentials | null> {
	const file = join(expandHome(configDir), ".credentials.json");
	try {
		const raw = JSON.parse(await readFile(file, "utf8"));
		const oauth = raw?.claudeAiOauth;
		if (!oauth?.accessToken) return null;
		return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt, subscriptionType: oauth.subscriptionType };
	} catch {
		return null;
	}
}

/**
 * The endpoint throttles hard unless the request looks like Claude Code itself, so the
 * User-Agent carries the installed CLI version. Detected once; a fixed fallback otherwise.
 */
let versionPromise: Promise<string> | null = null;
function claudeVersion(): Promise<string> {
	if (versionPromise) return versionPromise;
	versionPromise = new Promise((resolve) => {
		exec("claude --version", { timeout: 8000, windowsHide: true }, (error, stdout) => {
			const match = !error ? /(\d+\.\d+\.\d+)/.exec(stdout) : null;
			if (!match) logger.warn(`could not detect claude version, using ${FALLBACK_VERSION}`);
			resolve(match?.[1] ?? FALLBACK_VERSION);
		});
	});
	return versionPromise;
}

function parseWindow(raw: unknown): UsageWindow | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const { utilization, resets_at } = raw as { utilization?: unknown; resets_at?: unknown };
	if (typeof utilization !== "number" || typeof resets_at !== "string") return undefined;
	const resetsAt = Date.parse(resets_at);
	if (Number.isNaN(resetsAt)) return undefined;
	return { utilization: Math.max(0, Math.min(100, utilization)), resetsAt };
}

/** Reads the OAuth token of one Claude Code config dir and asks the usage endpoint. */
export async function fetchUsage(configDir: string): Promise<UsageResult> {
	const creds = await readCredentials(configDir);
	if (!creds) return { ok: false, error: "no-creds" };
	// Never call the usage endpoint with a dead token: it answers 401, then 429 for that
	// token until a fresh one is used, which is how the dial got stuck on "429" for a day.
	if (typeof creds.expiresAt === "number" && creds.expiresAt - EXPIRY_SLACK_MS <= Date.now()) {
		return { ok: false, error: "expired" };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(USAGE_URL, {
			headers: {
				Authorization: `Bearer ${creds.accessToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": `claude-code/${await claudeVersion()}`,
				Accept: "application/json",
			},
			signal: controller.signal,
		});

		if (response.status === 401 || response.status === 403) return { ok: false, error: "login", detail: `${response.status}` };
		if (response.status === 429) return { ok: false, error: "rate-limited" };
		if (!response.ok) return { ok: false, error: "network", detail: `${response.status}` };

		const body = (await response.json()) as Record<string, unknown>;
		const windows: Usage["windows"] = {};
		for (const key of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const) {
			const window = parseWindow(body[key]);
			if (window) windows[key] = window;
		}
		return { ok: true, usage: { windows, fetchedAt: Date.now() } };
	} catch (error) {
		return { ok: false, error: "network", detail: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
}
