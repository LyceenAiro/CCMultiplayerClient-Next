import { t } from '../i18n';
import { showMpToast } from './toasts';

/**
 * ROUND 149 (feature): pause-menu "脱离卡死" (unstuck) button. In multiplayer a
 * player can get locked OUTSIDE an encounter's arena walls when the door seals
 * (the encounter started before they walked in — the walls are solid and there
 * is no way back in). This adds a button at the TOP of the pause screen's
 * bottom-right button list (above RESUME) that escapes the softlock using the
 * game's OWN fall-into-water sequence:
 *
 *   1. the player's respawn point is temporarily set next to a RANDOM hostile
 *      monster (preferring ones that currently hold a combat target);
 *   2. `player.quickFall(ig.TERRAIN.WATER)` runs the vanilla water fall:
 *      splash at the old spot, respawn-line to the new point, reappear effect,
 *      then instantDamage(floor(maxHp * fallDmgFactor)) — the standard ~10%
 *      "落水伤害". If no live enemy exists on the map the respawn point stays
 *      at the vanilla last-safe-ground, so the button doubles as a generic
 *      stuck-in-geometry escape.
 *
 * Everything is LOCAL to the pressing client: the player entity is owned by
 * its own client (position/HP stream out via the normal playerState blocks),
 * and instantDamage bypasses the attack pipeline, so no hit relays fire.
 *
 * Vanilla semantics preserved: the button only exists while CONNECTED, and
 * only in the plain pause branch (not during cutscenes with the skip button,
 * not with the cancel-reload button, not in arena mode with its own restart).
 */

function isAttached(b: any): boolean {
	return !!(b && b.hook && b.hook.parentHook);
}

/** Pick a random hostile monster and point the player's respawn at its feet. */
function aimRespawnAtMonster(player: any): void {
	try {
		const g: any = (ig as any).game;
		const Enemy: any = (ig.ENTITY as any).Enemy;
		const EnemyParty: any = (sc as any).COMBATANT_PARTY && (sc as any).COMBATANT_PARTY.ENEMY;
		const entities: any[] = (g && g.entities) || [];
		const hostile: any[] = [];
		const idle: any[] = [];
		for (let i = 0; i < entities.length; i++) {
			const e: any = entities[i];
			if (!(e instanceof Enemy) || e._killed || !e.coll || e._hidden || e._mpDying) continue;
			if (EnemyParty !== undefined && e.party !== EnemyParty) continue;
			if (e.params && typeof e.params.isDefeated === 'function' && e.params.isDefeated()) continue;
			if (e.target) hostile.push(e); else idle.push(e);
		}
		const pool = hostile.length ? hostile : idle;
		if (!pool.length) return; // no monster: keep the vanilla last-safe-ground point
		const target = pool[(Math.random() * pool.length) | 0];
		const c = target.coll;
		// land one tile (48px) off the monster in a random cardinal direction
		const cx = c.pos.x + c.size.x / 2;
		const cy = c.pos.y + c.size.y / 2;
		const dir = (Math.random() * 4) | 0;
		const off = dir === 0 ? { x: 0, y: 48 } : dir === 1 ? { x: 48, y: 0 } : dir === 2 ? { x: 0, y: -48 } : { x: -48, y: 0 };
		// ground level under the monster (flying enemies hover above baseZPos)
		const z = (typeof c.baseZPos === 'number' && isFinite(c.baseZPos)) ? c.baseZPos : c.pos.z;
		if (typeof player.setRespawnPoint === 'function') {
			player.setRespawnPoint({ x: cx + off.x, y: cy + off.y, z });
		}
	} catch (e) { console.warn('[multiplayer] unstuck: monster pick failed', e); }
}

/** ROUND 161 (unstuck mercy window): the first unstuck is FREE — no water-fall
 * damage. Any re-use within 60s of the LAST use pays the vanilla ~10% max-HP
 * fall damage; a 60s quiet period resets it, so the next use is free again.
 * Tracked per pressing client (the whole sequence is local — HP streams out
 * via the normal playerState blocks, unchanged). */
const UNSTUCK_FREE_WINDOW_MS = 60000;
let lastUnstuckUseAt = 0; // 0 = never used -> first use is free

function doUnstuck(getMp: () => any): void {
	const m = getMp && getMp();
	const conn = m && m.connection;
	if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return;
	const g: any = (ig as any).game;
	const player: any = g && g.playerEntity;
	if (!player || player._killed || !player.coll) return;
	if (player.respawn && player.respawn.timer) return;                          // already falling
	if (player.params && typeof player.params.isDefeated === 'function' && player.params.isDefeated()) return;
	if (typeof player.quickFall !== 'function') return;
	aimRespawnAtMonster(player);
	// close the pause menu first (vanilla resume does exactly this), then run the
	// vanilla water fall: splash -> respawn line -> reappear -> ~10% max-HP damage.
	try { (sc as any).model.enterRunning(); } catch (_) { /* fall through */ }
	// ROUND 161: free iff the last use was >60s ago (or never). The fall damage
	// is frozen SYNCHRONOUSLY inside quickFall from player.fallDmgFactor
	// (b = floor(maxHp * fallDmgFactor) -> doQuickRespawn), so zeroing the factor
	// around the call makes this use free; restoring right after keeps every
	// later fall (real water/hole falls included) at vanilla damage. Only touch
	// it when the current value is a finite number — restoring an undefined
	// factor would turn later real falls into NaN damage.
	const now = Date.now();
	const free = now - lastUnstuckUseAt > UNSTUCK_FREE_WINDOW_MS;
	let savedFallFactor: number | null = null;
	if (free) {
		try {
			const cur = player.fallDmgFactor;
			if (typeof cur === 'number' && isFinite(cur)) { savedFallFactor = cur; player.fallDmgFactor = 0; }
		} catch (_) { savedFallFactor = null; }
	}
	let fell = false;
	try { player.quickFall((ig as any).TERRAIN.WATER); fell = true; lastUnstuckUseAt = now; } catch (e) { console.warn('[multiplayer] unstuck: quickFall failed', e); }
	if (savedFallFactor !== null) { try { player.fallDmgFactor = savedFallFactor; } catch (_) { /* ignore */ } }
	if (fell) { try { showMpToast({ title: t(free ? 'mpUnstuckFree' : 'mpUnstuckPaid') }); } catch (_) { /* ignore */ } }
}

/** 1.77.x: same button DURING a cutscene — the player is scene-controlled, so
 * the water-fall teleport would be wrong; instead run one stall-gated cutscene
 * heal (cutsceneActorGuard.healFromPause: nudge a stuck action, or force-end a
 * wedged event call through the engine's own _endEventCall). The pause menu is
 * closed first, exactly like the vanilla RESUME button (enterRunning). */
function doCutsceneUnstuck(getMp: () => any): void {
	const m = getMp && getMp();
	const conn = m && m.connection;
	if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return;
	try { (sc as any).model.enterRunning(); } catch (_) { /* fall through */ }
	const guard: any = m && m.cutsceneActorGuard;
	if (guard && typeof guard.healFromPause === 'function') {
		try { guard.healFromPause(); } catch (e) { console.warn('[multiplayer] cutscene unstuck failed', e); }
	}
}

function inCutscene(): boolean {
	try {
		const mdl: any = (sc as any).model;
		return !!(mdl && (mdl.currentState === (sc as any).GAME_MODEL_STATE.CUTSCENE
			|| (typeof mdl.isCutscene === 'function' && mdl.isCutscene())));
	} catch (_) { return false; }
}

/** updateButtons post-hook: (re)place the button above RESUME, or detach it. */
function refreshUnstuckButton(gui: any, getMp: () => any): void {
	let btn: any = gui._mpUnstuckBtn;
	if (!btn) {
		btn = new (sc as any).ButtonGui(t('unstuck'), (sc as any).BUTTON_DEFAULT_WIDTH);
		btn.setAlign((ig as any).GUI_ALIGN.X_RIGHT, (ig as any).GUI_ALIGN.Y_BOTTOM);
		// 1.77.x: dispatch at CLICK time — outside a cutscene this is the combat
		// water-fall escape, during one it's the stall-gated scene heal.
		btn.onButtonPress = () => {
			try {
				if (inCutscene()) doCutsceneUnstuck(getMp); else doUnstuck(getMp);
			} catch (e) { console.warn('[multiplayer] unstuck failed', e); }
		};
		gui._mpUnstuckBtn = btn;
	}
	// the parent's updateButtons rebuilds its own list; we re-evaluate every call
	if (isAttached(btn)) { try { gui.removeChildGui(btn); } catch (_) { /* ignore */ } }
	const m = getMp && getMp();
	const conn = m && m.connection;
	const connected = !!(conn && typeof conn.isOpen === 'function' && conn.isOpen());
	if (!connected) return;
	const cs = inCutscene();
	if (isAttached(gui.arenaRestart) || isAttached(gui.arenaLobby) || isAttached(gui.cancelButton)) return;
	if (!cs) {
		// plain pause branch only: resume+save+toTitle visible, no cutscene skip
		if (!isAttached(gui.resumeButton) || !isAttached(gui.saveGameButton) || !isAttached(gui.toTitleButton)) return;
		if (isAttached(gui.skipButton)) return;
	} else {
		// 1.77.x: cutscene branch (with or without the skip button — skipBlock
		// scenes fall back to the plain layout). RESUME is always attached here.
		if (!isAttached(gui.resumeButton)) return;
	}
	const grp: any = gui.buttonGroup;
	if (!grp || typeof grp.clear !== 'function' || !gui.resumeButton.hook) return;
	// one slot above RESUME (same +4 gap the vanilla stack uses)
	const bh: number = (gui.toTitleButton.hook.size && gui.toTitleButton.hook.size.y) || 20;
	gui.addChildGui(btn);
	btn.setPos(3, gui.resumeButton.hook.pos.y + bh + 4);
	grp.clear();
	grp.addFocusGui(btn, 0, 0);                       // top entry
	grp.addFocusGui(gui.resumeButton, 0, 1, true);    // resume keeps the ESC/back binding
	grp.addFocusGui(gui.optionsButton, 0, 2);
	grp.addFocusGui(gui.saveGameButton, 0, 3);
	let idx = 4;
	if (cs && isAttached(gui.skipButton)) grp.addFocusGui(gui.skipButton, 0, idx++);
	if (isAttached(gui.toTitleButton)) grp.addFocusGui(gui.toTitleButton, 0, idx);
	// default focus stays on RESUME so mashing confirm to unpause can't
	// accidentally trigger the heal/teleport
	if ((ig as any).input.mouseGuiActive) {
		grp.setCurrentFocus(0, 1);
		grp.unfocusCurrentButton();
	} else {
		grp.focusCurrentButton(0, 1, false, true);
	}
}

export function installUnstuckButton(getMp: () => any): void {
	if (typeof sc === 'undefined' || !(sc as any).PauseScreenGui) {
		console.warn('[multiplayer] sc.PauseScreenGui not available; unstuck button not installed');
		return;
	}
	// updateButtons alone covers both cases: injected inits run for screens created
	// after install, and the boot-time live instance gets its button lazily on the
	// first refresh (no separate init/live-instance pass needed).
	(sc as any).PauseScreenGui.inject({
		updateButtons(this: any, ...args: any[]) {
			this.parent(...args);
			try { refreshUnstuckButton(this, getMp); } catch (e) { console.warn('[multiplayer] unstuck refresh failed', e); }
		},
	});
}
