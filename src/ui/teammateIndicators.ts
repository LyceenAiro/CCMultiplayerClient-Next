import { Multiplayer } from '../multiplayer';
import { getMpUiScale } from './uiScale';

/**
 * 1.71.9 (QoL 1): off-screen teammate arrows.
 *
 * For every PARTY teammate (town strangers are never indicated), project their
 * live position onto the screen. When they are outside the viewport the arrow
 * is clamped flush against the screen edge and rotated toward them; the arrow
 * grows as the world distance shrinks. Hovering it shows the player name.
 * Lightweight SVG, pointer-events only on the arrow itself so it never blocks
 * the game.
 *
 * Fix round (user feedback):
 *  - EDGE_MARGIN 30 -> 6 so the arrow visually hugs the screen edge (the
 *    half-size clamp keeps even the largest arrow fully on-screen).
 *  - Arrow redrawn as a clean triangle arrowhead (dark outline + vivid red
 *    body, smooth edges), size 14-30 by distance (per user feedback).
 *    Rotation is atan2-deg + 90: the graphic points UP at rest while atan2's
 *    0deg means RIGHT (CSS rotate is clockwise in screen coordinates).
 *  - The arrow is pointer-events:none with a MANUAL hover hit-test (showTip
 *    class): CSS :hover let Chromium swap the game's custom cursor for the OS
 *    cursor while hovering the arrow.
 *  - The rotation now goes on the SVG child (CSS var --mpRot), NOT the root:
 *    the ::after name tooltip is a child of the root, so rotating the root
 *    rotated the tooltip with it. Tooltip also re-anchors when the arrow sits
 *    in a corner (tip-below / tip-left / tip-right) so it never overflows the
 *    screen.
 *  - Menu/cutscene hiding uses sc.model state predicates (isMenu / isPaused /
 *    isQuickMenu / isCutscene / isHUDBlocked / ONMAPMENU) instead of only
 *    sc.menu.menuStack.length: the ESC root menu never pushes menuStack, so
 *    arrows stayed visible over ESC, and cutscenes were not covered at all.
 */

const EDGE_MARGIN = 6;
// Small visual gap (page px, scales with UI zoom) between the arrow's extreme
// pixel and the screen border — user request: keep a hair of distance so the
// arrow never overflows at high zoom, while still visually hugging the edge.
const EDGE_GAP = 4;
// Max scale of the .mpArrowPulse breathing animation (matches the CSS keyframes).
const PULSE_MAX = 1.16;
// ROUND: user request — the arrow no longer grows/shrinks with distance; it is a
// single fixed size.
const ARROW_SIZE = 20;

let installed = false;
let getMain: (() => Multiplayer | undefined) | null = null;
let styleInstalled = false;
const els: { [name: string]: JQuery } = {};

function ensureStyle(): void {
	if (styleInstalled || typeof document === 'undefined' || !document.head) return;
	styleInstalled = true;
	const style = document.createElement('style');
	style.id = 'mpTeammateArrowStyle';
	style.textContent = `.mpTeammateArrow { position: fixed; z-index: 10002; pointer-events: none;
	filter: drop-shadow(0 1px 3px rgba(0,0,0,0.9)); animation: mpArrowFadeIn 0.28s ease-out; }
.mpTeammateArrow svg { display: block;
	transform: rotate(var(--mpRot, 0deg));
	animation: mpGoldBreath 0.8s ease-in-out infinite alternate; }
.mpTeammateArrow::after { content: attr(data-tip); position: absolute; left: 50%; bottom: calc(100% + 6px);
	transform: translateX(-50%); background: rgba(30,6,6,0.95); border: 1px solid #ff5a52;
	border-radius: 4px; padding: 3px 8px; color: #ffe9e7; white-space: nowrap;
	font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif; font-size: 12px;
	opacity: 0; pointer-events: none; transition: opacity 0.12s ease; }
.mpTeammateArrow.tip-below::after { bottom: auto; top: calc(100% + 6px); }
.mpTeammateArrow.tip-left::after { left: -6px; transform: none; }
.mpTeammateArrow.tip-right::after { left: auto; right: -6px; transform: none; }
.mpTeammateArrow.showTip::after { opacity: 1; }
`;
	document.head.appendChild(style);
	// Golden breathing glow (user request: the off-screen teammate arrows were not
	// noticeable enough). Animates only the filter, so the arrow rotation transform is
	// untouched; paired with the svg rule's infinite-alternate so it pulses dim<->bright.
	style.textContent += '@keyframes mpGoldBreath { from { filter: drop-shadow(0 0 3px rgba(255,242,205,0.72)) drop-shadow(0 0 9px rgba(255,232,175,0.50)); } to { filter: drop-shadow(0 0 5px rgba(255,251,238,1)) drop-shadow(0 0 16px rgba(255,240,196,0.90)); } }';
	// Terraria-style scale breathing (user request): the arrow gently grows/shrinks.
	// On a wrapper span so it never fights the svg's rotate(var(--mpRot)) direction
	// transform. transform-origin centre keeps it anchored on the arrow point.
	style.textContent += '.mpArrowPulse { display: block; transform-origin: 50% 50%; animation: mpArrowPulse 1.3s ease-in-out infinite alternate; }';
	style.textContent += '@keyframes mpArrowPulse { from { transform: scale(1); } to { transform: scale(1.16); } }';
	// Sci-fi vanish (user request, area-switch only): bright cyan flash, a horizontal
	// glitch jitter, a vertical stretch, then collapse to a thin line and fade.
	style.textContent += '.mpTeammateArrow.mpArrowVanish { transform-origin: 50% 50%; animation: mpArrowVanish 0.7s ease-in forwards; }';
	style.textContent += '@keyframes mpArrowVanish { 0% { opacity: 1; transform: scale(1) translateX(0) rotate(0deg); filter: brightness(1) drop-shadow(0 0 4px rgba(150,240,255,0.6)); } 15% { opacity: 1; transform: scale(1.6) translateX(0) rotate(0deg); filter: brightness(3) drop-shadow(0 0 18px rgba(150,245,255,1)); } 32% { opacity: 1; transform: scale(1.35) translateX(-9px) rotate(-8deg); } 50% { opacity: 0.85; transform: scale(1.3) translateX(9px) rotate(8deg); } 68% { opacity: 0.6; transform: scale(1.15) translateX(-6px) scaleY(2.2); filter: brightness(2.4) drop-shadow(0 0 12px rgba(150,245,255,0.9)); } 100% { opacity: 0; transform: scale(0.2) scaleY(0.05) translateX(0) rotate(0deg); filter: brightness(3.2) drop-shadow(0 0 8px rgba(150,245,255,0.9)); } }';
	// Fade-in on appearance (user request): any time the arrow appears it eases from
	// transparent to normal. The animation lives on the root and restarts whenever the
	// element goes display:none->block (see the show-on-transition guard in tick).
	style.textContent += '@keyframes mpArrowFadeIn { from { opacity: 0; } to { opacity: 1; } }';
}

// Pixel-art silhouette of the up-pointing arrowhead (same shape as before: wide
// triangle body with a bottom-centre notch). '#' = a filled block.
const ARROW_PIXELS = [
	"....#....",
	"...###...",
	"...###...",
	"..#####..",
	"..#####..",
	".#######.",
	".#######.",
	"#########",
	"####.####",
	"###...###",
	"##.....##",
];

function arrowSvg(size: number): string {
	// Pixel-art redraw (user request): keep the same up-pointing arrowhead look (dark
	// outline + vivid red body) but as chunky pixels. A filled block with all 4
	// orthogonal neighbours filled is BODY (red); any block touching an empty/outside
	// cell is the OUTLINE (dark). shape-rendering:crispEdges keeps every block
	// hard-edged when the SVG is scaled up, which is what reads as "pixelated".
	const gw = ARROW_PIXELS[0].length, gh = ARROW_PIXELS.length;
	const filled = (x: number, y: number): boolean =>
		y >= 0 && y < gh && x >= 0 && x < gw && ARROW_PIXELS[y].charAt(x) === '#';
	let body = '';
	for (let y = 0; y < gh; y++) {
		for (let x = 0; x < gw; x++) {
			if (!filled(x, y)) continue;
			const inner = filled(x - 1, y) && filled(x + 1, y) && filled(x, y - 1) && filled(x, y + 1);
			body += '<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + (inner ? '#ff3229' : '#26060a') + '"/>';
		}
	}
	return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + gw + ' ' + gh + '" shape-rendering="crispEdges">'
		+ body + '</svg>';
}

function ensureEl(name: string): JQuery {
	let el = els[name];
	if (!el || !document.body.contains(el[0])) {
		el = $('<div class="mpTeammateArrow"></div>').attr('data-tip', name);
		$(document.body).append(el);
		els[name] = el;
	}
	return el;
}

function inGameOk(m: Multiplayer): boolean {
	try {
		const g: any = (ig as any).game;
		if (!g || !g.playerEntity) return false;
		if (typeof g.isTeleporting === 'function' && g.isTeleporting()) return false;
		// Hide while ANY menu/pause/quick-menu/cutscene/loading state is active.
		// The old sc.menu.menuStack check missed the ESC root menu (START never
		// pushes menuStack) and cutscenes entirely.
		const model: any = (sc as any).model;
		if (model) {
			if (typeof model.isPaused === 'function' && model.isPaused()) return false;
			if (typeof model.isMenu === 'function' && model.isMenu()) return false;
			if (typeof model.isQuickMenu === 'function' && model.isQuickMenu()) return false;
			if (typeof model.isCutscene === 'function' && model.isCutscene()) return false;
			if (typeof model.isHUDBlocked === 'function' && model.isHUDBlocked()) return false;
			const sub = (sc as any).GAME_MODEL_SUBSTATE;
			if (sub && typeof model.currentSubState !== 'undefined'
				&& (model.currentSubState === sub.ONMAPMENU || model.currentSubState === sub.TITLE)) return false;
		}
		const menu: any = (sc as any).menu;
		if (menu && menu.menuStack && menu.menuStack.length > 0) return false;
		if (!m.connection || typeof m.connection.isOpen !== 'function' || !m.connection.isOpen()) return false;
		return true;
	} catch (_) { return false; }
}

const prevOnMap: { [name: string]: boolean } = {};
const vanishUntil: { [name: string]: number } = {};
const VANISH_MS = 700;

// Sci-fi vanish (user request): when the pointed teammate SWITCHES AREA, play a
// digital teleport-out on their arrow instead of it popping off. Entering our area
// stays instant (no animation). The tick stops repositioning the arrow once they are
// off-map, so it freezes at its last edge spot while the root plays mpArrowVanish,
// then it is hidden. Only triggered if the arrow was actually pointing (visible) —
// an on-screen teammate's arrow is already hidden, so there is nothing to vanish.
function startVanish(name: string): void {
	const el = els[name];
	if (!el) return;
	vanishUntil[name] = Date.now() + VANISH_MS;
	try { el.removeClass('showTip').addClass('mpArrowVanish'); } catch (_) { /* ignore */ }
}
function endVanish(name: string): void {
	const el = els[name];
	if (el) { try { el.removeClass('mpArrowVanish').hide(); } catch (_) { /* ignore */ } }
	delete vanishUntil[name];
}

function hideAll(): void {
	for (const name in els) {
		try { els[name].removeClass('mpArrowVanish').hide(); } catch (_) { /* ignore */ }
		delete vanishUntil[name];
	}
}

function tick(): void {
	try {
		ensureStyle();
		const m = getMain && getMain();
		if (!m || !inGameOk(m)) { hideAll(); return; }
		// The story video owns the whole screen; off-screen arrows would clutter it.
		if (m.storySync && typeof m.storySync.storyEventActive === 'function' && m.storySync.storyEventActive()) {
			hideAll();
			return;
		}
		const sys: any = (ig as any).system;
		const g: any = (ig as any).game;
		const player = g.playerEntity;
		if (!sys || typeof sys.getScreenFromMapPos !== 'function' || !player || !player.coll) { hideAll(); return; }
		const canvas: any = sys.canvas;
		let scaleX = 1, scaleY = 1, left0 = 0, top0 = 0;
		try {
			if (canvas && typeof canvas.getBoundingClientRect === 'function') {
				const r = canvas.getBoundingClientRect();
				scaleX = sys.width > 0 && r.width > 0 ? r.width / sys.width : (sys.scale || 1);
				scaleY = sys.height > 0 && r.height > 0 ? r.height / sys.height : (sys.scale || 1);
				left0 = r.left; top0 = r.top;
			}
		} catch (_) { /* fall back to game coords */ }
		const roster: string[] = Array.isArray(m.partyMembers) ? m.partyMembers : [];
		const shown: { [name: string]: boolean } = {};
		const vw = sys.width || 1;
		const vh = sys.height || 1;
		const cx = vw / 2;
		const cy = vh / 2;
		const pcx = player.coll.pos.x + (player.coll.size ? player.coll.size.x / 2 : 0);
		const pcy = player.coll.pos.y + (player.coll.size ? player.coll.size.y / 2 : 0) - player.coll.pos.z;
		for (const name of roster) {
			if (!name || name === m.name) continue;
			const onMap = !!m.isPartyMateOnMap(name);
			// Area-switch vanish: on our map last frame, gone now.
			if (prevOnMap[name] && !onMap && !vanishUntil[name]) {
				const elV = els[name];
				try { if (elV && elV.is(':visible')) startVanish(name); } catch (_) { /* ignore */ }
			}
			prevOnMap[name] = onMap;
			if (vanishUntil[name]) {
				// Finished, or they re-entered quickly -> end the vanish (a re-entry falls
				// through and re-shows instantly); otherwise leave it frozen and skip.
				if (onMap || Date.now() >= vanishUntil[name]) endVanish(name);
				if (!onMap) continue;
			}
			if (!onMap) continue;
			const rec = m.players && m.players[name];
			// A soft-dead teammate's corpse is removed; do not keep pointing the arrow at
			// their last known position (marked by netSync's applyPlayerState dead branch).
			if (rec && (rec as any)._mpSoftDead) continue;
			const ent = rec && rec.entity;
			let wx = 0, wy = 0, dist = 99999;
			if (ent && ent.coll && !ent._killed) {
				wx = ent.coll.pos.x + (ent.coll.size ? ent.coll.size.x / 2 : 8);
				wy = ent.coll.pos.y + (ent.coll.size ? ent.coll.size.y / 2 : 8) - ent.coll.pos.z;
			} else if (rec && rec.position && typeof rec.position.x === 'number') {
				wx = rec.position.x; wy = rec.position.y - (typeof rec.position.z === 'number' ? rec.position.z : 0);
			} else {
				continue;
			}
			dist = Math.hypot(wx - pcx, wy - pcy);
			// ig.system.getScreenFromMapPos(dest, x, y) MUTATES and returns `dest`;
			// give it a real vector like the name-tag projection does.
			const scr: any = {};
			sys.getScreenFromMapPos(scr, Math.round(wx), Math.round(wy));
			const sx = Number(scr && scr.x);
			const sy = Number(scr && scr.y);
			if (!isFinite(sx) || !isFinite(sy)) continue;
			const margin = EDGE_MARGIN;
			if (sx >= margin && sx <= vw - margin && sy >= margin && sy <= vh - margin) continue;
			// Clamp to the edge and point toward the teammate.
			const dx = sx - cx;
			const dy = sy - cy;
			const ang = Math.atan2(dy, dx);
			let px = sx, py = sy;
			if (sx < margin) { px = margin; py = cy + Math.tan(ang) * (margin - cx); }
			else if (sx > vw - margin) { px = vw - margin; py = cy + Math.tan(ang) * ((vw - margin) - cx); }
			if (py < margin) { py = margin; if (Math.abs(Math.cos(ang)) > 0.001) px = cx + (margin - cy) / Math.tan(ang); }
			else if (py > vh - margin) { py = vh - margin; if (Math.abs(Math.cos(ang)) > 0.001) px = cx + ((vh - margin) - cy) / Math.tan(ang); }
			px = Math.max(margin, Math.min(vw - margin, px));
			py = Math.max(margin, Math.min(vh - margin, py));
			const size = ARROW_SIZE;
			const el = ensureEl(name);
			if (el.attr('data-size') !== String(Math.round(size))) {
				el.attr('data-size', Math.round(size));
				el.html('<span class="mpArrowPulse">' + arrowSvg(Math.round(size)) + '</span>');
			}
			// Tooltip: name + live distance (user request: 'Name 25m', single space).
			el.attr('data-tip', name + ' ' + Math.round(dist / 10) + 'm');
			// The arrow root is zoom: var(--mp-ui-scale), and Chromium's zoom
			// multiplies authored left/top too. Convert the desired CSS center back
			// into PRE-ZOOM coords (desired / ui - size/2) so the visual center
			// still lands on the canvas-projected teammate position. Also clamp by
			// the VISUAL half-extent of the ROTATED glyph: the svg spins toward the
			// teammate and .mpArrowPulse breathes up to PULSE_MAX, so a plain size/2
			// clamp let diagonal tips poke past the edge at high UI zoom. The drawn
			// arrow spans ~9/11 of the box width and the full box height (viewBox
			// 9x11, preserveAspectRatio meet) and points along `ang`, so its rotated
			// bounding half-extents are (a*sin+b*cos, a*cos+b*sin). A small EDGE_GAP
			// keeps the tip hovering just off the border instead of touching it.
			const ui = getMpUiScale();
			const rotS = Math.abs(Math.sin(ang)), rotC = Math.abs(Math.cos(ang));
			const drawA = size * 0.41, drawB = size * 0.5; // drawn glyph half-extents at rest (points up)
			const halfX = scaleX > 0 ? ((drawA * rotS + drawB * rotC) * PULSE_MAX + EDGE_GAP) * ui / scaleX : 0;
			const halfY = scaleY > 0 ? ((drawA * rotC + drawB * rotS) * PULSE_MAX + EDGE_GAP) * ui / scaleY : 0;
			px = Math.max(halfX, Math.min(vw - halfX, px));
			py = Math.max(halfY, Math.min(vh - halfY, py));
			const cssX = left0 + px * scaleX;
			const cssY = top0 + py * scaleY;
			// The arrow graphic points UP at rest while atan2's 0deg means RIGHT
			// (CSS rotate is clockwise in screen coords), so shift by +90.
			const deg = Math.round(ang * 180 / Math.PI) + 90;
			// Rotate ONLY the svg (CSS var); the root stays axis-aligned so the
			// ::after name tooltip never tilts with the arrow.
			try { (el[0] as HTMLElement).style.setProperty('--mpRot', deg + 'deg'); } catch (_) { /* ignore */ }
			// Keep the tooltip on-screen when the arrow sits in a corner.
			el.toggleClass('tip-below', py < 56);
			el.toggleClass('tip-left', px < 96);
			el.toggleClass('tip-right', px > vw - 96);
			// Manual hover: the arrow is pointer-events:none so it NEVER steals the
			// mouse from the canvas — CSS :hover made Chromium swap the game's own
			// cursor for the OS cursor. Hit-test the engine mouse position against
			// the arrow's on-screen box and toggle the showTip class instead.
			const mo: any = (ig as any).input && (ig as any).input.mouse;
			const hov = !!(mo && typeof mo.x === 'number' && mo.x >= 0
				&& Math.abs(mo.x - px) <= halfX + 2 && Math.abs(mo.y - py) <= halfY + 2);
			el.toggleClass('showTip', hov);
			el.css({
				left: Math.round(cssX / ui - size / 2),
				top: Math.round(cssY / ui - size / 2),
				width: size,
				height: size,
			});
			// Fade-in guard: only toggle display on the hidden->shown transition so the
			// mpArrowFadeIn animation restarts once per appearance, not every frame. (On
			// first creation the insertion itself already plays the fade-in.)
			if (el.is(':hidden')) el.show();
			shown[name] = true;
		}
		for (const name in els) {
			if (!shown[name] && !vanishUntil[name]) { try { els[name].hide(); } catch (_) { /* ignore */ } }
		}
	} catch (_) { /* never break the frame */ }
}

/** Install the per-frame off-screen teammate arrows (idempotent). */
export function installTeammateIndicators(getter: () => Multiplayer | undefined): void {
	if (installed) return;
	if (typeof simplify === 'undefined' || typeof ig === 'undefined') return;
	installed = true;
	getMain = getter;
	simplify.registerUpdate(() => { try { tick(); } catch (_) { /* ignore */ } });
}
