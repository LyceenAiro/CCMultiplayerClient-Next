/**
 * Orphaned dream-effect watchdog ("过了梦境剧情后虚化特效卡住").
 *
 * The dream sequences (maps dreams.*) dress the screen with effects that only a
 * later event step removes:
 *   - START_DREAM_FX              -> ig.dreamFx vignette (dark circle edges + dots)
 *   - SET_ZOOM_BLUR name:"dream" duration:-1 -> persistent radial zoom blur
 *   - SET_SCREEN_BLUR             -> ig.screenBlur base alpha
 *   - RUMBLE_SCREEN name:"dream"/"shock"/"rumble"/"strong" duration:-1
 *         -> continuous camera shake (视角晃动)
 * Their clears (CLEAR_DREAM_FX / FADE_OUT_ZOOM_BLUR / CLEAR_SCREEN_BLUR /
 * RUMBLE_STOP_CONTINUES) sit near the end of the outro cutscene. ig.DreamFx,
 * ig.ScreenBlur and ig.Rumble clear only on a FULL game reset (GameAddon
 * onReset), NOT on map load — so when the outro chain is interrupted before its
 * clear steps (cutscene skip, a multiplayer event abort, a relayed copy racing
 * the native trigger, a wedge force-end via _endEventCall, a mod teleport out
 * of the dream island), the blur/vignette AND the continuous shake stay forever.
 * Zoom blur is the one exception: duration:-1 attaches to the EventCall and
 * onEventEndDetach runs on setDone, so a force-end usually frees it — but the
 * watchdog still covers the orphaned named-zoom case.
 *
 * Continuous rumble is the piece the original guard missed: Rumble has no
 * onLevelLoadStart, so a lost RUMBLE_STOP_CONTINUES keeps shaking the camera
 * even after dreamFx/zoom were cleaned, and even while still standing on the
 * dream island (the "not on dreams.*" gate that correctly protects free-roam
 * vignette never fires for the shake).
 *
 * This guard clears effects once they are provably orphaned:
 *   - dream signature (dreamFx / named zoom "dream") — only off the dream maps,
 *     with no cutscene / blocking event / teleport, held for GRACE_MS;
 *   - continuous named dream rumbles — whenever no scene owns them, on ANY
 *     map, held for RUMBLE_GRACE_MS (shorter: free-roam never re-arms them).
 *
 * Also exported: clearDreamOutroEffects() — the exact clear the lost outro
 * steps would have run. cutsceneActorGuard / storySync call it when they
 * force-end a wedged call so the shake cannot outlive the scene they killed.
 */

let installed = false;
/** Timestamp (Date.now) since which the visual-orphan conditions hold; 0 = not tracking. */
let orphanSince = 0;
/** Separate timer for continuous rumble (independent of the off-map gate). */
let rumbleOrphanSince = 0;

const GRACE_MS = 3000;
const RUMBLE_GRACE_MS = 1500;
const TICK_MS = 500;
const DREAM_ZOOM_NAME = 'dream';
/** Named continuous rumbles the dream chains arm (see assets/data/maps/dreams/*). */
const DREAM_RUMBLE_NAMES = ['dream', 'shock', 'rumble', 'strong'];

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
		if (ev && ev.blockingEventCall) return true;
	} catch (_) { return true; /* unreadable engine state: stay conservative */ }
	return false;
}

/** Live continuous dream-named rumbles (duration -1 never auto-stops). */
function liveDreamRumbles(): any[] {
	const out: any[] = [];
	try {
		const rumble: any = (ig as any).rumble;
		if (!rumble || !rumble.namedRumbles) return out;
		for (const name of DREAM_RUMBLE_NAMES) {
			const h = rumble.namedRumbles[name];
			if (h && h._duration === -1) out.push(h);
		}
	} catch (_) { /* ignore */ }
	return out;
}

/** Stop every continuous dream-named rumble + zero the aggregated offset.
 * Mirrors what RUMBLE_STOP_CONTINUES would have run for each name. */
function stopDreamRumbles(): number {
	let n = 0;
	try {
		const rumble: any = (ig as any).rumble;
		if (!rumble) return 0;
		for (const name of DREAM_RUMBLE_NAMES) {
			const h = rumble.namedRumbles && rumble.namedRumbles[name];
			if (!h) continue;
			try {
				if (typeof h.stop === 'function') h.stop();
				if (typeof rumble.removeRumble === 'function') rumble.removeRumble(h);
				else if (rumble.rumbles && typeof rumble.rumbles.erase === 'function') rumble.rumbles.erase(h);
				if (rumble.namedRumbles) delete rumble.namedRumbles[name];
				n++;
			} catch (_) { /* ignore */ }
		}
		if (rumble.offset) { rumble.offset.x = 0; rumble.offset.y = 0; }
	} catch (_) { /* ignore */ }
	return n;
}

/**
 * Full dream-outro cleanup. Safe to call any time — each piece is a no-op when
 * already clear. Used by the watchdog and by force-end paths that skip the
 * remaining clear steps.
 */
export function clearDreamOutroEffects(): { fx: boolean, zoom: boolean, blur: boolean, rumble: number } {
	const res = { fx: false, zoom: false, blur: false, rumble: 0 };
	try {
		const fx: any = (ig as any).dreamFx;
		if (fx && typeof fx.isActive === 'function' && fx.isActive()) {
			try { fx.clear(); res.fx = true; } catch (_) { /* ignore */ }
		}
		const blur: any = (ig as any).screenBlur;
		if (blur && blur.namedZooms && blur.namedZooms[DREAM_ZOOM_NAME]) {
			try { blur.fadeOutZoom(DREAM_ZOOM_NAME, 0.3); res.zoom = true; } catch (_) {
				try { delete blur.namedZooms[DREAM_ZOOM_NAME]; res.zoom = true; } catch (_) { /* ignore */ }
			}
		}
		// Base screen-blur: only with the dream signature, never for non-dream scenes.
		if (blur && typeof blur.minAlpha === 'number' && blur.minAlpha < 1 && blur.minAlpha > 0) {
			// Only treat as dream leftover when a dream piece is (or just was) live.
			if (res.fx || res.zoom || res.rumble) {
				try { blur.clear(); res.blur = true; } catch (_) { /* ignore */ }
			}
		}
		res.rumble = stopDreamRumbles();
		// Blur-only second pass: if rumble was the only live piece we still want
		// the base blur cleared when it was clearly part of the dream stack.
		if (!res.blur && res.rumble > 0 && blur && typeof blur.minAlpha === 'number'
			&& blur.minAlpha < 1 && blur.minAlpha > 0) {
			try { blur.clear(); res.blur = true; } catch (_) { /* ignore */ }
		}
	} catch (_) { /* never throw */ }
	return res;
}

function tick(): void {
	try {
		if (typeof ig === 'undefined' || typeof sc === 'undefined') return;
		const blur: any = (ig as any).screenBlur;
		const fx: any = (ig as any).dreamFx;
		const fxActive = !!(fx && typeof fx.isActive === 'function' && fx.isActive());
		const dreamZoom = !!(blur && blur.namedZooms && blur.namedZooms[DREAM_ZOOM_NAME]);
		const rumbles = liveDreamRumbles();
		const now = Date.now();
		const busy = sceneBusy();

		// --- continuous named rumbles (any map; free-roam never re-arms them) ---
		if (!rumbles.length || busy) {
			rumbleOrphanSince = 0;
		} else {
			if (!rumbleOrphanSince) rumbleOrphanSince = now;
			else if (now - rumbleOrphanSince >= RUMBLE_GRACE_MS) {
				rumbleOrphanSince = 0;
				const n = stopDreamRumbles();
				if (n) {
					console.log('[dreamfxguard] stopped orphaned continuous dream rumbles ('
						+ n + ') on map=' + (((ig.game as any) && (ig.game as any).mapName) || ''));
				}
			}
		}

		// --- vignette / named zoom / base blur (only off the dream island) ---
		if (!fxActive && !dreamZoom) { orphanSince = 0; return; }
		if (currentMapIsDream() || busy) { orphanSince = 0; return; }
		if (!orphanSince) { orphanSince = now; return; }
		if (now - orphanSince < GRACE_MS) return;
		orphanSince = 0;
		const mapName: string = (ig.game && (ig.game as any).mapName) || '';
		const res = clearDreamOutroEffects();
		console.log('[dreamfxguard] cleared orphaned dream effects on map=' + mapName
			+ ' (fx=' + (res.fx ? 1 : 0) + ' zoom=' + (res.zoom ? 1 : 0)
			+ ' blur=' + (res.blur ? 1 : 0) + ' rumble=' + res.rumble + ')');
	} catch (_) { /* the guard must never break the game loop */ }
}

/**
 * Immediate cleanup after a force-end / unstuck. The wedged call never reached
 * its CLEAR / RUMBLE_STOP steps, so do not wait for the orphan grace — run the
 * outro tail now if any dream piece is live. Safe on non-dream maps.
 */
export function forceClearDreamOutro(reason: string): void {
	try {
		const fx: any = (ig as any).dreamFx;
		const blur: any = (ig as any).screenBlur;
		const fxActive = !!(fx && typeof fx.isActive === 'function' && fx.isActive());
		const dreamZoom = !!(blur && blur.namedZooms && blur.namedZooms[DREAM_ZOOM_NAME]);
		const rumbles = liveDreamRumbles();
		if (!fxActive && !dreamZoom && !rumbles.length) return;
		const res = clearDreamOutroEffects();
		console.log('[dreamxfguard] force-cleared dream outro after ' + reason
			+ ' (fx=' + (res.fx ? 1 : 0) + ' zoom=' + (res.zoom ? 1 : 0)
			+ ' blur=' + (res.blur ? 1 : 0) + ' rumble=' + res.rumble + ')');
		orphanSince = 0;
		rumbleOrphanSince = 0;
	} catch (_) { /* never break a heal path */ }
}

/** Install the watchdog timer (idempotent). Runs whether or not we are
 * connected — an orphaned overlay/shake is wrong in every mode. */
export function installDreamFxGuard(): void {
	if (installed) return;
	installed = true;
	try { setInterval(tick, TICK_MS); } catch (_) { /* ignore */ }
}
