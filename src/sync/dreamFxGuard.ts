/**
 * Orphaned dream-effect watchdog ("过了梦境剧情后虚化特效卡住").
 *
 * The dream sequences (maps dreams.*) dress the screen with three effects that
 * only a later event step removes:
 *   - START_DREAM_FX  -> ig.dreamFx vignette (dark circle edges + dot overlay)
 *   - SET_ZOOM_BLUR name:"dream" duration:-1 -> persistent radial zoom blur
 *   - SET_SCREEN_BLUR -> ig.screenBlur base alpha (used by some dream chains)
 * Their clears (CLEAR_DREAM_FX / FADE_OUT_ZOOM_BLUR / CLEAR_SCREEN_BLUR) are
 * ordinary event steps near the end of the outro cutscene (verified in
 * assets/data/maps/dreams/*.json). ig.DreamFx and ig.ScreenBlur clear only on a
 * FULL game reset (GameAddon.onReset), NOT on map load — so when the outro
 * event chain is interrupted before its clear steps (cutscene skip, a
 * multiplayer event abort, a relayed copy racing the native trigger, a mod
 * teleport out of the dream island), the blur/vignette stays forever and only
 * re-entering the server (full reload) removes it. That matches the bug report
 * exactly.
 *
 * This guard clears the effects once they are provably orphaned:
 *   dream signature present (dreamFx active OR named zoom "dream" loaded)
 *   AND current map is NOT a dreams.* map (free-roam on the dream island
 *       legitimately keeps the effect on with no events running)
 *   AND no cutscene / blocking event / teleport in progress
 *   AND all of the above held continuously for GRACE_MS.
 *
 * Scope notes:
 *   - The base screen-blur alpha is reset ONLY together with the dream
 *     signature — non-dream scenes (arid/interior/the-room & co.) deliberately
 *     leave the base blur set across scene beats and must not be touched.
 *   - Named slow-mo "dream" needs no guard: ig.SlowMotion resets on every
 *     level load (onLevelLoadStart -> onReset), so it cannot survive a map
 *     change the way the visual effects can.
 */

let installed = false;
/** Timestamp (Date.now) since which the orphan conditions hold; 0 = not tracking. */
let orphanSince = 0;

const GRACE_MS = 3000;
const TICK_MS = 500;
const DREAM_ZOOM_NAME = 'dream';

function currentMapIsDream(): boolean {
	try {
		const name: string = (ig.game && (ig.game as any).mapName) || '';
		// Engine mapName is dot-form ("dreams.first"); accept path form too.
		return name.indexOf('dreams.') === 0 || name.indexOf('dreams/') === 0;
	} catch (_) { /* ignore */ }
	return false;
}

function sceneBusy(): boolean {
	try {
		const g: any = ig.game;
		if (!g || !g.playerEntity) return true; // not in game -> never clear
		if (typeof g.isTeleporting === 'function' && g.isTeleporting()) return true;
		const mdl: any = (sc as any).model;
		if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) return true;
		const ev: any = g.events;
		if (ev && typeof ev.getBlockingEventCall === 'function' && ev.getBlockingEventCall()) return true;
	} catch (_) { return true; /* unreadable engine state: stay conservative */ }
	return false;
}

function tick(): void {
	try {
		if (typeof ig === 'undefined' || typeof sc === 'undefined') return;
		const blur: any = (ig as any).screenBlur;
		const fx: any = (ig as any).dreamFx;
		if (!blur && !fx) return;
		const fxActive = !!(fx && typeof fx.isActive === 'function' && fx.isActive());
		const dreamZoom = !!(blur && blur.namedZooms && blur.namedZooms[DREAM_ZOOM_NAME]);
		if (!fxActive && !dreamZoom) { orphanSince = 0; return; }
		if (currentMapIsDream() || sceneBusy()) { orphanSince = 0; return; }
		const now = Date.now();
		if (!orphanSince) { orphanSince = now; return; }
		if (now - orphanSince < GRACE_MS) return;
		orphanSince = 0;
		// Orphaned: no running scene owns these effects any more. Clear exactly
		// like the lost outro steps would have (CLEAR_DREAM_FX / CLEAR_SCREEN_BLUR
		// are abrupt in vanilla too; the zoom gets the vanilla-style fade-out).
		const mapName: string = (ig.game && (ig.game as any).mapName) || '';
		if (fxActive) { try { fx.clear(); } catch (_) { /* ignore */ } }
		if (dreamZoom) { try { blur.fadeOutZoom(DREAM_ZOOM_NAME, 0.6); } catch (_) { /* ignore */ } }
		try { if (blur && typeof blur.minAlpha === 'number' && blur.minAlpha < 1) blur.clear(); } catch (_) { /* ignore */ }
		console.log('[dreamfxguard] cleared orphaned dream effects on map=' + mapName
			+ ' (fx=' + (fxActive ? 1 : 0) + ' zoom=' + (dreamZoom ? 1 : 0) + ')');
	} catch (_) { /* the guard must never break the game loop */ }
}

/** Install the watchdog timer (idempotent). Runs whether or not we are
 * connected — an orphaned overlay is wrong in every mode. */
export function installDreamFxGuard(): void {
	if (installed) return;
	installed = true;
	try { setInterval(tick, TICK_MS); } catch (_) { /* ignore */ }
}
