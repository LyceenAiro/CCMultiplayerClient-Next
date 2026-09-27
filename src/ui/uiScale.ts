/**
 * 1.71.10 — one scale for every mod-owned EXTERNAL DOM UI.
 *
 * The mod draws two kinds of overlays:
 *   - IN-CANVAS (name tags, net-debug HUD): rendered inside the game canvas and
 *     therefore already zoomed by the engine. Those read `getMpUiCanvasScale()`
 *     in mpOptions.ts, where 'auto' = 1 and fixed tiers scale the GUI hook.
 *   - EXTERNAL DOM (panels, chat, toasts, tooltips, arrows, story banners):
 *     rendered as DOM outside the canvas at fixed CSS px sizes. This module sets
 *     the CSS variable `--mp-ui-scale` on <html> and applies `zoom` to each
 *     top-level overlay root, so the whole layout (fonts, paddings, sizes, and
 *     reflowed text wrapping) scales coherently.
 *
 * 'auto' is relative to the game's LAUNCH window size: the canvas CSS size at
 * the moment the game started (windowed) is captured as the 100% baseline, and
 * Auto then follows window resizing as `current canvas scale / launch scale`.
 * At the launch size the mod UI therefore looks exactly like the fixed 100%
 * tier; enlarging the window scales the DOM UIs up with the game canvas.
 *
 * NOTE: Chromium's `zoom` multiplies authored absolute offsets too. Modules
 * that position a zoomed root from canvas coordinates (teammate arrows,
 * net/map tooltips, chat name menu) therefore divide their computed CSS
 * coordinates by `getMpUiScale()` — the helpers here document that contract.
 */

/** Root elements the pump scales. Deliberately NOT full-screen scrims/flex
 * containers (zoom on 100% width/height roots doubles their viewport box);
 * their inner panels are scaled instead. */
const ZOOM_TARGETS = [
	'body > .mpChatBox',
	'body > .mpChatPops',
	'body > .mpChatNameMenu',
	'body > .mpLogin',
	'body > .mpWin',
	'body > .mpComm',
	'body > .mpCommToast',
	'body > .mpToastStack',
	'body > .mpTeammateArrow',
	'body > .mpMapTeamTip',
	'body > .mpNetBadgeTip',
	'body > .mpTriggerBanner',
	'body > .mpStoryStar',
	'body > .mpStoryScrim > .mpStoryBox',
	'body > .mpStoryComm > .mpStoryCommGlow',
	'body > .mpStoryComm > .mpStoryCommInner',
	'body > .mpStoryParty > .mpStoryPartyGlow',
	'body > .mpStoryParty > .mpStoryPartyInner',
	'body > .mpServerScrim > .mpServerPanel',
	'body > .mpServerModal > .mpServerForm',
	'body > .mpSaveBlock > .mpSavePanel',
];

let installed = false;
let styleInstalled = false;
let getOption: (() => number | 'auto') | null = null;
let current = 1;
let lastApplied = -1;
/** Launch-window canvas scale (canvas CSS px / virtual game px). Captured from
 * the FIRST valid canvas rect of the session — that is the windowed size the
 * game started at — and never updated afterwards. */
let launchScale: number | null = null;
/** 0.2.6: the window size this process booted into (install-time). Used to
 * derive the auto baseline when the FIRST canvas measure happens AFTER the
 * player already maximized during the loading progress bar — the old code
 * locked launchScale to that already-maximized canvas and auto stayed at 1.0
 * forever ("加载中最大化后 UI 不会自动放大"). */
let bootWinW = 0;
let bootWinH = 0;

/** Engine's on-screen zoom: canvas CSS box / virtual game resolution. The
 * geometric mean handles minor aspect-ratio rounding. Returns null when the
 * canvas is not measurable yet (hidden / zero-sized / not ready). */
function currentCanvasScale(): number | null {
	try {
		// The game's OptionModel sets window.IG_SCREEN_MODE inside _setDisplaySize;
		// until that runs the canvas CSS box is not the launch window yet. Waiting
		// for it guarantees the captured baseline is the real launch window size.
		if ((window as any).IG_SCREEN_MODE === undefined) return null;
		const sys: any = (ig as any).system;
		if (sys && sys.width > 0 && sys.height > 0 && sys.canvas
			&& typeof sys.canvas.getBoundingClientRect === 'function') {
			const r = sys.canvas.getBoundingClientRect();
			if (r && r.width > 0 && r.height > 0) {
				const sx = r.width / sys.width;
				const sy = r.height / sys.height;
				const s = Math.sqrt(sx * sy);
				if (isFinite(s) && s > 0) return s;
			}
		}
	} catch (_) { /* canvas not measurable */ }
	return null;
}

/** Auto multiplier = current canvas scale / launch-window canvas scale. At the
 * launch size this is exactly 100%; afterwards it tracks window resizing.
 * 0.2.6: when the first successful measure happens after the player already
 * maximized during loading, the baseline is back-solved from the BOOT window
 * size so auto still reports >1 instead of locking to 1.0. */
function autoScale(): number {
	const raw = currentCanvasScale();
	if (raw == null) return 1;
	if (launchScale == null) {
		const curW = (window.innerWidth || bootWinW || 0) || 0;
		const curH = (window.innerHeight || bootWinH || 0) || 0;
		// k = boot/current geometric ratio. First measure at the boot size → k=1
		// (unchanged). First measure after maximize-during-load → k<1, so
		// launchScale = raw*k and auto = 1/k > 1 (UI grows with the window).
		let k = 1;
		if (bootWinW > 0 && bootWinH > 0 && curW > 0 && curH > 0
			&& (curW !== bootWinW || curH !== bootWinH)) {
			k = Math.sqrt((bootWinW / curW) * (bootWinH / curH));
			if (!isFinite(k) || k <= 0) k = 1;
		}
		launchScale = Math.max(0.1, Math.min(16, raw * k));
	}
	const base = launchScale || 1;
	return Math.max(0.25, Math.min(8, raw / base));
}

function compute(): number {
	try {
		const v = getOption ? getOption() : 'auto';
		return typeof v === 'number' && isFinite(v) && v > 0 ? v : autoScale();
	} catch (_) { return 1; }
}

function ensureStyle(): void {
	if (styleInstalled || typeof document === 'undefined') return;
	const style = document.createElement('style');
	style.id = 'mpUiScaleStyle';
	style.textContent = `
:root { --mp-ui-scale: 1; }
${ZOOM_TARGETS.join(',\n')} {
	zoom: var(--mp-ui-scale);
}
`;
	try {
		if (document.head) document.head.appendChild(style);
		else if (document.documentElement) document.documentElement.appendChild(style);
		styleInstalled = true;
	} catch (_) { /* document not ready — a later refresh retries */ }
}

/** Recompute from the option + engine zoom and push the CSS variable. Cheap and
 * change-gated; safe to run every frame from the simplify pump. */
export function refreshMpUiScaleNow(): void {
	try {
		if (!styleInstalled && typeof document !== 'undefined') ensureStyle();
	} catch (_) { /* ignore */ }
	const next = compute();
	if (next === current && lastApplied === current) return;
	current = next;
	let applied = false;
	try {
		if (document && document.documentElement) {
			document.documentElement.style.setProperty('--mp-ui-scale', String(current));
			applied = true;
		}
	} catch (_) { /* retry on a later frame */ }
	if (applied) lastApplied = current;
}

/** Current external-DOM UI multiplier (1 until install / a fixed tier / auto). */
export function getMpUiScale(): number {
	return current;
}

/** Install the once-per-frame scale pump. `getOption` is injected by main.ts so
 * this module never imports mpOptions (avoids a multiplayer import cycle). */
export function installMpUiScale(optionGetter: () => number | 'auto'): void {
	if (installed) return;
	installed = true;
	getOption = optionGetter;
	// 0.2.6: remember the boot window for the auto baseline (see autoScale).
	try {
		bootWinW = window.innerWidth || 0;
		bootWinH = window.innerHeight || 0;
	} catch (_) { /* ignore */ }
	refreshMpUiScaleNow();
	const s: any = (typeof simplify !== 'undefined') ? (simplify as any) : null;
	if (s && typeof s.registerUpdate === 'function') {
		s.registerUpdate(() => {
			try { refreshMpUiScaleNow(); } catch (_) { /* never break the frame */ }
		});
	}
	// 0.2.6: the simplify pump only ticks once the game loop is running. During
	// the loading progress bar a maximize left --mp-ui-scale stale until the
	// title/main screen. Always attach a resize listener + a light interval so
	// the scale tracks the window even while the engine is still loading.
	try {
		window.addEventListener('resize', () => {
			try { refreshMpUiScaleNow(); } catch (_) { /* ignore */ }
		});
	} catch (_) { /* ignore */ }
	try {
		window.setInterval(() => refreshMpUiScaleNow(), 250);
	} catch (_) { /* ignore */ }
}
