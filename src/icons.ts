/** Touch-strip badge for the current account: a disc in the Claude accent with its initial. */

export const ACCENT = "#D97757";
const NEUTRAL = "#4A4A4A";

export const GREEN = "#3FB950";
export const YELLOW = "#D29922";
export const RED = "#F85149";
export const GREY = "#555555";

/** Bar colour by how full the window is. */
export function colorFor(percent: number | null): string {
	if (percent === null) return GREY;
	if (percent >= 80) return RED;
	if (percent >= 50) return YELLOW;
	return GREEN;
}

function svg(body: string): string {
	const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${body}</svg>`;
	return `data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}`;
}

export function badgeFor(label: string, healthy: boolean): string {
	const initial = (label.trim().charAt(0) || "?").toUpperCase();
	const disc = `<circle cx="24" cy="24" r="22" fill="${healthy ? ACCENT : NEUTRAL}"/>`;
	const letter = `<text x="24" y="33" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="26" font-weight="700" fill="#fff">${initial}</text>`;
	return svg(`${disc}${letter}`);
}
