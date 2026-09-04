import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';
import { showMpToast } from '../ui/toasts';

/**
 * 1.77.x (cutscene actor guard + manual unstuck).
 *
 * A story scene runs LOCALLY on every client (leader-authoritative replay),
 * but the scene's actors are map entities gated by per-client state
 * (spawnCondition quest/plot vars, a monster already defeated here, ...).
 * Where solo always has the actor, a diverged client does not:
 *
 *   - a spawnCondition-gated entity EXISTS but is HIDDEN (spawnEntity creates
 *     it, then returns before show()) — a hidden entity is detached from
 *     physics and never updates, so MOVE_TO_/DO_ACTION steps on it never
 *     complete: the blocking event call hangs with the letterbox on (卡死);
 *   - a truly absent entity (killed earlier / never spawned) resolves to null
 *     and the step's start() throws — EventCall.update has NO exception
 *     handling, so the throw kills the whole game-update frame, again with
 *     the cutscene state stuck on.
 *
 * This module fixes both at the single choke point every event/action step
 * resolves actors through — ig.Event.getEntity:
 *   1. While connected AND any event is running, a name lookup that lands on
 *      a hidden entity force-SHOWS it (the engine's own showEntity path); a
 *      lookup that lands on nothing / a corpse MATERIALIZES the actor from
 *      the current map's raw entity definitions (stashed at loadLevel) as a
 *      temporary stand-in at the authored position. Spawned monsters are
 *      PEACEFUL cinematic actors, tagged _mpCutsceneSpawned so the member
 *      reap pass leaves them alone, and never carry a mapId (the host's
 *      mapId-keyed enemy block can never adopt/puppet them).
 *   2. A try/catch shield on EventCall.update: while connected, a throwing
 *      step ends its call through the engine's normal path (returns done ->
 *      EventManager._endEventCall -> onEnd -> enterGame) instead of freezing
 *      the frame loop forever. Offline the exception propagates natively.
 *   3. An "脱离卡死" (unstuck) entry in the ESC PAUSE menu during any
 *      cutscene while connected (ui/unstuckButton.ts — same slot as the
 *      combat unstuck button, which is gated OUT of cutscene branches):
 *      click = one heal attempt via healFromPause(), gated on a real stall
 *      so a healthy scene is never disrupted (reader-wait steps and a
 *      stalled <3s scene report "no wedge"). A stalled DO_ACTION first gets
 *      an action-cancel nudge; a repeated click (or any >=3s stall)
 *      force-ends the blocking call via the engine's own _endEventCall.
 *   4. Temp actors are removed once the scene is over, PER ACTOR by last
 *      use: 1.5s after their last step resolution once all events drained,
 *      or after a 20s unused cap while permanent parallel events keep the
 *      event system busy (the pre-guard reason temp actors survived their
 *      scene). Spawned stand-ins are silently killed; force-shown entities
 *      are re-hidden ONLY when their spawnCondition still evaluates false
 *      (condition-truth restore through the engine's own bookkeeping).
 *
 * Offline nothing changes: every gate requires an open connection, and the
 * stash/force-show paths only ever fire while an event is running.
 */

export interface ICutsceneActorGuard {
	install(): void;
	/** Remove every live temp actor (scene end / unstuck / map change). */
	cleanupTemps(reason: string): void;
	/** One manual unstuck heal attempt from the ESC pause menu button. */
	healFromPause(): void;
}

let shared: CutsceneActorGuard | null = null;

export function installCutsceneActorGuard(getMain: () => Multiplayer | undefined): ICutsceneActorGuard {
	if (!shared) shared = new CutsceneActorGuard(getMain);
	return shared;
}

/** How long after the last scene activity before temp actors are removed. */
const IDLE_SWEEP_MS = 1500;
/** Hard cap for the "events never drain" case (permanent parallel events). */
const DRAIN_CAP_MS = 20000;
/** A step must be stalled at least this long before the button force-ends it. */
const STALL_FORCE_MS = 3000;

interface IStashDef {
	type: string;
	x: number;
	y: number;
	z: number;
	settings: any;
}

interface ITempRec {
	ent: any;
	/** true = we spawned this stand-in (kill on cleanup); false = we only
	 * force-showed a hidden map entity (condition-truth re-hide on cleanup). */
	spawned: boolean;
	/** Compiled spawnCondition of the original entity (evaluate(): boolean). */
	cond: any;
	/** Last time any event step resolved this actor — a temp still being
	 * referenced (e.g. by a permanent parallel event) is never swept. */
	lastUsed: number;
}

class CutsceneActorGuard implements ICutsceneActorGuard {
	private installed = false;
	/** Current map's named raw entity definitions, stashed at loadLevel. */
	private stash: { [name: string]: IStashDef } = Object.create(null);
	/** Live temp actors by entity name. */
	private temps: { [name: string]: ITempRec } = Object.create(null);
	/** Unstuck stall tracking (the button itself lives in the pause menu —
	 * ui/unstuckButton.ts calls healFromPause()). */
	private stallSig = '';
	private stallSince = 0;
	private nudged = false;
	/** Rate-limit identical materialize logs. */
	private lastMatLog: { [name: string]: number } = Object.create(null);

	constructor(private getMain: () => Multiplayer | undefined) { }

	public install(): void {
		if (this.installed) return;
		this.installed = true;
		const self = this;

		// 1) Stash the raw named entity definitions of every map at load time.
		try {
			const gProto: any = (ig as any).Game && (ig as any).Game.prototype;
			if (gProto && typeof gProto.loadLevel === 'function' && !gProto._mpCsLoadWrapped) {
				gProto._mpCsLoadWrapped = true;
				const origLoad = gProto.loadLevel;
				gProto.loadLevel = function (this: any, data: any) {
					const r = origLoad.apply(this, arguments as any);
					try { self.buildStash(this, data); } catch (_) { /* stash is best-effort */ }
					return r;
				};
			}
		} catch (e) { console.warn('[mpcsactor] loadLevel hook failed', e); }

		// 2) JIT actor materialization at the single entity-resolution choke point.
		try {
			const Ev: any = (ig as any).Event;
			if (Ev && typeof Ev.getEntity === 'function' && !Ev._mpCsGetEntityWrapped) {
				Ev._mpCsGetEntityWrapped = true;
				const origGetEntity = Ev.getEntity;
				Ev.getEntity = function (spec: any, call: any) {
					const ent = origGetEntity.apply(Ev, arguments as any);
					try {
						const fixed = self.guardResolvedEntity(spec, ent);
						return fixed || ent;
					} catch (_) { return ent; /* resolution must never break a step */ }
				};
			}
		} catch (e) { console.warn('[mpcsactor] getEntity hook failed', e); }

		// 3) Keep our force-shown actors visible against the engine's automatic
		//    spawnCondition re-hide (varsChanged) while a scene is running.
		try {
			const gProto: any = (ig as any).Game && (ig as any).Game.prototype;
			if (gProto && typeof gProto.requestEntityHide === 'function' && !gProto._mpCsHideWrapped) {
				gProto._mpCsHideWrapped = true;
				const origHide = gProto.requestEntityHide;
				gProto.requestEntityHide = function (this: any, ent: any) {
					try {
						if (ent && ent._mpCsShownByUs && self.sceneBusy()) return; // scene still needs the actor
					} catch (_) { /* fall through */ }
					return origHide.apply(this, arguments as any);
				};
			}
		} catch (e) { console.warn('[mpcsactor] requestEntityHide hook failed', e); }

		// 4) Crash shield: a throwing event step must not freeze the frame loop
		//    (and with it the cutscene state) forever. While connected, end the
		//    call through the engine's own done path instead.
		try {
			const EC: any = (ig as any).EventCall;
			if (EC && EC.prototype && typeof EC.prototype.update === 'function' && !EC.prototype._mpCsShieldWrapped) {
				EC.prototype._mpCsShieldWrapped = true;
				const origUpdate = EC.prototype.update;
				EC.prototype.update = function (this: any) {
					try {
						return origUpdate.apply(this, arguments as any);
					} catch (err) {
						if (!self.connected()) throw err; // offline: native behavior
						try {
							const fr = this.stack && this.stack[this.stack.length - 1];
							console.warn('[mpcsactor] event step threw ('
								+ self.stepTypeName(fr && fr.currentStep) + ' @ '
								+ String((fr && fr.event && fr.event.name) || '(event)')
								+ ') — ending the call to avoid a softlock', err);
						} catch (_) { /* ignore */ }
						return true; // EventManager splices + _endEventCall (onEnd -> enterGame)
					}
				};
			}
		} catch (e) { console.warn('[mpcsactor] event shield failed', e); }

		// 5) Per-frame: temp sweep + stall tracking for the pause-menu button.
		try {
			(simplify as any).registerUpdate(() => { try { self.tick(); } catch (_) { /* never break the frame */ } });
		} catch (_) { /* ignore */ }

		// Diagnostic: window.__mpCsActors() -> stash size + live temps.
		(window as any).__mpCsActors = () => {
			try {
				const names: string[] = [];
				for (const n in self.temps) {
					const r = self.temps[n];
					names.push(n + ':' + (r.spawned ? 'spawned' : 'shown') + (r.ent && r.ent._killed ? '(dead)' : ''));
				}
				console.log('[mpcsactor] stash=' + Object.keys(self.stash).length + ' temps=[' + names.join(', ') + ']');
				return names;
			} catch (e) { return null; }
		};
		console.log('[mpcsactor] cutscene actor guard installed');
	}

	// ---------------------------------------------------------------- hooks

	private connected(): boolean {
		try {
			const m = this.getMain();
			return !!(m && m.connection && typeof m.connection.isOpen === 'function' && m.connection.isOpen());
		} catch (_) { return false; }
	}

	/** True while a cutscene / blocking event owns the player (also drives the
	 * requestEntityHide veto and the unstuck button). */
	private sceneBusy(): boolean {
		try {
			if ((ig as any).loading) return true;
			const g: any = (ig as any).game;
			if (!g) return false;
			if (typeof g.isTeleporting === 'function' && g.isTeleporting()) return true;
			const mdl: any = (sc as any).model;
			if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) return true;
			if (g.events && g.events.blockingEventCall) return true;
		} catch (_) { /* ignore */ }
		return false;
	}

	/** True while ANY event call runs (incl. parallel encounter intros). */
	private anyEventRunning(): boolean {
		try {
			const ev: any = (ig as any).game && (ig as any).game.events;
			return !!(ev && ev.runningEventCalls && ev.runningEventCalls.length > 0);
		} catch (_) { return false; }
	}

	/** Stash raw defs of named entities for the freshly loaded map; the old
	 * map's temp actors died with clearMap, so just drop their records. */
	private buildStash(game: any, data: any): void {
		this.stash = Object.create(null);
		this.temps = Object.create(null);
		try {
			const defs: any[] = (data && data.entities) || [];
			for (let i = 0; i < defs.length; i++) {
				const d = defs[i];
				const name = d && d.settings && d.settings.name;
				if (!name || typeof name !== 'string' || !d.type) continue;
				let z = 0;
				try { z = game.getHeightFromLevelOffset(d.level); } catch (_) { z = d.z || 0; }
				this.stash[name] = { type: d.type, x: d.x || 0, y: d.y || 0, z, settings: d.settings };
			}
		} catch (_) { /* ignore */ }
	}

	/** Post-process an ig.Event.getEntity result: revive a hidden actor,
	 * respawn a dead/absent one from the stash. MP + running event only. */
	private guardResolvedEntity(spec: any, ent: any): any {
		if (!this.connected()) return null;
		if (!(this.sceneBusy() || this.anyEventRunning())) return null;
		let name: string | null = null;
		try {
			if (spec && typeof spec.name === 'string' && spec.name) {
				name = spec.name;
			} else if (spec && spec.varName !== undefined) {
				// Indirect {varName} fetch: resolve the var to the entity NAME,
				// exactly like the native varName fetch does.
				const Ev: any = (ig as any).Event;
				const vn = Ev && typeof Ev.getVarName === 'function' ? Ev.getVarName(spec.varName) : null;
				const v = vn ? (ig as any).vars.get(vn) : null;
				if (typeof v === 'string' && v) name = v;
			}
		} catch (_) { return null; }
		if (!name) return null;
		// A tracked temp being resolved again (healthy or not) is still in use —
		// the sweep keys off this timestamp (see tick).
		const rec0 = this.temps[name];
		if (rec0) rec0.lastUsed = Date.now();
		if (ent && typeof ent === 'object' && !ent._killed && !ent._hidden) {
			return null; // healthy actor — nothing to do
		}

		// Hidden but alive: force-show through the engine's own path so the
		// scene's actor can move/act. (A hidden entity is detached from physics
		// and never updates — every MOVE/DO_ACTION on it hangs forever.)
		if (ent && !ent._killed && ent._hidden) {
			try {
				if (!ent._mpCsShownByUs) {
					ent._mpCsShownByUs = true;
					if (!this.temps[name]) {
						this.temps[name] = { ent, spawned: false, cond: this.conditionOf(ent), lastUsed: Date.now() };
					}
					this.logMat(name, 'force-shown hidden actor');
				}
				if (typeof ent.show === 'function') ent.show(true);
				return ent;
			} catch (_) { return null; }
		}
		// Killed or never spawned: materialize a stand-in from the raw map def.
		if (!ent || ent._killed) {
			return this.spawnFromStash(name);
		}
		return null;
	}

	/** The compiled spawnCondition of a conditional map entity (null if the
	 * entity was hidden for another reason). */
	private conditionOf(ent: any): any {
		try {
			const list: any[] = (ig.game as any).conditionalEntities || [];
			for (let i = 0; i < list.length; i++) {
				if (list[i] && list[i].entity === ent) return list[i].condition || null;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	/** Spawn a temporary stand-in from the raw map definition, at the authored
	 * position, ignoring its spawnCondition. Never synced: no mapId, monsters
	 * are PEACEFUL + _mpCutsceneSpawned (member reap exempt). */
	private spawnFromStash(name: string): any {
		try {
			const def = this.stash[name];
			if (!def) return null;
			const g: any = (ig as any).game;
			if (!g || typeof g.spawnEntity !== 'function') return null;
			const settings = JSON.parse(JSON.stringify(def.settings || {}));
			delete settings.spawnCondition; // spawn shown, and never enter conditionalEntities
			delete settings.mapId;          // the host's mapId-keyed block must never adopt it
			settings.name = name;
			const e = g.spawnEntity(def.type, def.x, def.y, def.z, settings);
			if (!e) return null;
			e._mpCsTemp = true;
			try {
				const Enemy: any = (ig.ENTITY as any).Enemy;
				if (Enemy && e instanceof Enemy) {
					e._mpCutsceneSpawned = true; // member stale-puppet reap exemption
					if ((sc as any).ENEMY_AGGRESSION) e.aggression = (sc as any).ENEMY_AGGRESSION.PEACEFUL;
				}
			} catch (_) { /* ignore */ }
			const rec = this.temps[name];
			this.temps[name] = {
				ent: e,
				spawned: true,
				cond: def.settings && def.settings.spawnCondition
					? new (ig as any).VarCondition(def.settings.spawnCondition) : (rec ? rec.cond : null),
				lastUsed: Date.now(),
			};
			this.logMat(name, 'materialized missing actor (' + def.type + ')');
			return e;
		} catch (err) {
			console.warn('[mpcsactor] temp spawn failed for "' + name + '"', err);
			return null;
		}
	}

	private logMat(name: string, what: string): void {
		try {
			const now = Date.now();
			if (this.lastMatLog[name] && now - this.lastMatLog[name] < 5000) return;
			this.lastMatLog[name] = now;
			console.log('[mpcsactor] ' + what + ': "' + name + '"');
		} catch (_) { /* ignore */ }
	}

	// ---------------------------------------------------------------- sweep

	private tick(): void {
		const busy = this.sceneBusy();
		this.trackStall();
		// Sweep stale temps once the scene is over, PER ACTOR (a global idle
		// window would be held forever by permanent parallel event calls — the
		// exact reason temp actors survived their scene before this guard):
		//   - cutscene/blocking event active  -> never sweep (the scene owns its
		//     actors, referenced or not);
		//   - all events drained              -> sweep actors unused for
		//     IDLE_SWEEP_MS;
		//   - events still running (parallels)-> sweep only actors unused for
		//     DRAIN_CAP_MS — an actor a live event still references keeps
		//     refreshing lastUsed via the getEntity hook and is never swept.
		if (busy) return;
		let any = false;
		for (const _ in this.temps) { any = true; break; }
		if (!any) return;
		const now = Date.now();
		const eventsDrained = !this.anyEventRunning();
		for (const name in this.temps) {
			const r = this.temps[name];
			// Records whose entity is already gone (killed mid-scene / map change).
			if (!r.ent || (r.spawned && r.ent._killed)) { delete this.temps[name]; continue; }
			const idle = now - (r.lastUsed || 0);
			const due = (eventsDrained && idle >= IDLE_SWEEP_MS) || idle >= DRAIN_CAP_MS;
			if (due) this.cleanupTemp(name, eventsDrained ? 'scene over' : 'actor unused (drain cap)');
		}
	}

	/** Remove/restore ONE temp actor by name (see cleanupTemps for the batch). */
	private cleanupTemp(name: string, reason: string): void {
		const r = this.temps[name];
		if (!r) return;
		delete this.temps[name];
		const e = r.ent;
		if (!e) return;
		if (r.spawned) {
			// Our stand-in: the map state without the scene does not have this
			// entity — remove it silently (no loot/FX).
			try { if (!e._killed) e.kill(true); } catch (_) { /* ignore */ }
			console.log('[mpcsactor] temp actor "' + name + '" removed (' + reason + ')');
			return;
		}
		// Force-shown map entity: restore condition truth. A still-false
		// spawnCondition re-hides it through the engine's own bookkeeping
		// (requestEntityHide sets _hideRequest so a later true re-shows it).
		try {
			if (e._killed || e._hidden) { try { delete e._mpCsShownByUs; } catch (_) { /* ignore */ } return; }
			let condOk = false;
			try { condOk = !!(r.cond && typeof r.cond.evaluate === 'function' && r.cond.evaluate()); } catch (_) { condOk = false; }
			if (!condOk) {
				try { (ig.game as any).requestEntityHide(e); } catch (_) { try { e.hide(); } catch (_) { /* ignore */ } }
				console.log('[mpcsactor] force-shown actor "' + name + '" re-hidden (' + reason + ')');
			}
			try { delete e._mpCsShownByUs; } catch (_) { /* ignore */ }
		} catch (_) { /* ignore */ }
	}

	public cleanupTemps(reason: string): void {
		const names: string[] = [];
		for (const name in this.temps) names.push(name);
		for (const name of names) this.cleanupTemp(name, reason);
	}

	// ---------------------------------------------------- unstuck heal (pause-menu button)

	private stepTypeName(st: any): string {
		try {
			if (!st) return '(none)';
			const ES: any = (ig as any).EVENT_STEP || {};
			for (const k in ES) { if (ES[k] && st instanceof ES[k]) return k; }
		} catch (_) { /* ignore */ }
		return '(?)';
	}

	/** Track the blocking call's innermost step so the button can tell a real
	 * stall from a healthy scene (mirrors the storySync watchdog's signature). */
	private trackStall(): void {
		try {
			const evm: any = (ig.game as any) && (ig.game as any).events;
			const call = evm && evm.blockingEventCall;
			if (!call || call.done || !call.stack || !call.stack.length) {
				this.stallSig = ''; this.stallSince = 0; this.nudged = false;
				return;
			}
			const fr = call.stack[call.stack.length - 1];
			const st = fr && fr.currentStep;
			const type = this.stepTypeName(st);
			const ent = fr && fr.stepData && fr.stepData._actionEntity;
			const sig = type + '@' + String((fr && fr.event && fr.event.name) || '')
				+ '@' + String((ent && (ent.name || ent.partyMemberName)) || '');
			if (sig !== this.stallSig) {
				this.stallSig = sig;
				this.stallSince = Date.now();
				this.nudged = false;
			}
		} catch (_) { /* ignore */ }
	}

	/** One click on the ESC-pause "脱离卡死" button = one heal attempt, gated
	 * on a real stall so a healthy scene is never disrupted (ui/unstuckButton.ts
	 * closes the pause menu first — the vanilla resume path):
	 *   - reader-wait steps (dialogue/choice)       -> "no wedge" (by design);
	 *   - stalled DO_ACTION, first click            -> cancel the stuck action
	 *     (the wait step then completes and the scene continues);
	 *   - same step again / any >=3s stall          -> force-end the blocking
	 *     call via the engine's own _endEventCall (onEnd -> enterGame);
	 *   - cutscene state with no event call at all  -> enterGame(). */
	public healFromPause(): void {
		try {
			const now = Date.now();
			const evm: any = (ig.game as any) && (ig.game as any).events;
			const call = evm && evm.blockingEventCall;
			if (!call || call.done) {
				const mdl: any = (sc as any).model;
				if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) {
					try { if (typeof mdl.enterGame === 'function') mdl.enterGame(); } catch (_) { /* ignore */ }
					this.afterHeal('stuck cutscene state');
					showMpToast({ title: t('mpCsUnstuckState') });
				} else {
					showMpToast({ title: t('mpCsUnstuckNone') });
				}
				return;
			}
			const fr = call.stack && call.stack[call.stack.length - 1];
			const st = fr && fr.currentStep;
			const type = this.stepTypeName(st);
			// Waiting on the reader is normal — never "heal" a healthy pause.
			if (type === 'SHOW_MSG' || type === 'SHOW_SIDE_MSG' || type === 'SHOW_CENTER_MSG'
				|| type === 'SHOW_CHOICE' || type === 'SHOW_MODAL_CHOICE' || type === 'SHOW_AR_MSG'
				|| type === 'SHOW_GET_MSG' || type === 'SHOW_LEARN_MSG') {
				showMpToast({ title: t('mpCsUnstuckNone') });
				return;
			}
			const stalled = this.stallSince ? now - this.stallSince : 0;
			const ent = fr && fr.stepData && fr.stepData._actionEntity;
			if ((type === 'DO_ACTION' || type === 'WAIT_UNTIL_ACTION_DONE')
				&& ent && typeof ent.cancelAction === 'function' && !this.nudged) {
				this.nudged = true;
				console.warn('[mpcsactor] unstuck nudge: cancelling stalled action on '
					+ String((ent && (ent.name || ent.partyMemberName)) || '(entity)'));
				try { ent.cancelAction(); } catch (_) { /* ignore */ }
				showMpToast({ title: t('mpCsUnstuckNudge') });
				return;
			}
			if (stalled >= STALL_FORCE_MS || this.nudged) {
				console.warn('[mpcsactor] unstuck: force-ending wedged event call ('
					+ type + ', stalled ' + Math.round(stalled / 1000) + 's)');
				try { if (typeof evm._endEventCall === 'function') evm._endEventCall(call); } catch (_) { /* ignore */ }
				this.stallSig = ''; this.stallSince = 0; this.nudged = false;
				this.afterHeal('wedged event call');
				showMpToast({ title: t('mpCsUnstuckEnded') });
				return;
			}
			showMpToast({ title: t('mpCsUnstuckNone') });
		} catch (_) { /* the button must never break the game */ }
	}

	/** Shared post-heal cleanup: drop temp actors + temp party bots — the
	 * scene they served is over (or being force-ended). */
	private afterHeal(reason: string): void {
		try { this.cleanupTemps('unstuck: ' + reason); } catch (_) { /* ignore */ }
		try {
			const m: any = this.getMain();
			const bots: any = m && (m as any).tempPartyBots;
			if (bots && typeof bots.cleanupTemps === 'function') bots.cleanupTemps('unstuck: ' + reason);
		} catch (_) { /* ignore */ }
	}
}
