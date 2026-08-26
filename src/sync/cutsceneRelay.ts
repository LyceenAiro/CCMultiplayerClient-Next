import { Multiplayer } from '../multiplayer';

/**
 * Dungeon cutscene-trigger relay ("gather on story moment").
 *
 * In a dungeon, a floor switch / puzzle switch often arms an EventTrigger
 * cutscene (Temple Mine g/room4: FloorSwitch sets map.activateElevator ->
 * the activateElevator CUTSCENE plays). The switch state syncs via
 * puzzleSync, but the CUTSCENE only fires on clients whose own EventTrigger
 * happens to be event-ready in that window — a teammate mid-combat or with a
 * menu open never sees it, and once the switch var falls back the moment is
 * gone for them.
 *
 * This module relays the trigger START itself: the first client whose
 * EventTrigger actually fires broadcasts {map, mapId, playerPos} to the map
 * instance. Receivers on the SAME map (same block) then
 *   1. teleport their player to the triggerer's EXACT coordinates, and
 *   2. start the same cutscene locally and mark the trigger consumed.
 *
 * Scope guards keep this from ever firing on mundane events:
 *   - eventType must be CUTSCENE or COMBAT_CUTSCENE (parallel snow-toggle
 *     style events never gather the party);
 *   - triggerType must be ONCE (map._entity<id>_triggered) — per-entry
 *     (tmp.*) and ALWAYS triggers are excluded, so walking into a map never
 *     chain-teleports anyone;
 *   - the trigger must have a real startCondition — condition-less entry
 *     cutscenes fire per-player on arrival by design;
 *   - while main-story sync is active, story sync owns trigger authority and
 *     this relay stays out of the way (both directions).
 */

interface ICutsceneRelayPacket {
	map: string;
	mi: number;
	p: [number, number, number];
	from?: string;
}

export interface ICutsceneRelay {
	install(): void;
	onRelay(data: ICutsceneRelayPacket): void;
}

let shared: CutsceneRelay | null = null;

export function installCutsceneRelay(getMain: () => Multiplayer | undefined): ICutsceneRelay {
	if (!shared) shared = new CutsceneRelay(getMain);
	return shared;
}

class CutsceneRelay implements ICutsceneRelay {
	private installed = false;
	/** True while WE start a relayed event locally — the sender hook must not
	 * re-broadcast it (the relayed start never touches EventTrigger.update, but
	 * keep the guard cheap and absolute). */
	private applying = false;

	constructor(private getMain: () => Multiplayer | undefined) { }

	public install(): void {
		if (this.installed) return;
		this.installed = true;
		try {
			const ET: any = (ig.ENTITY as any).EventTrigger;
			if (!ET || typeof ET.inject !== 'function') return;
			const self = this;
			ET.inject({
				init: function (this: any, a: any, b: any, c: any, e: any) {
					this.parent(a, b, c, e);
					// Keep the raw settings so a relayed start can rebuild the
					// event even when this client's load-condition skipped it.
					try { this._mpCsSettings = e ? JSON.parse(JSON.stringify(e)) : null; }
					catch (_) { this._mpCsSettings = null; }
				},
				update: function (this: any) {
					let was = false;
					try { was = !!(this.eventCall && this.eventCall.isRunning()); } catch (_) { /* ignore */ }
					this.parent();
					try {
						const now = !!(this.eventCall && this.eventCall.isRunning());
						if (!was && now) self.onLocalTriggerStart(this);
					} catch (_) { /* ignore */ }
				},
			});
			console.log('[cutscenerelay] hooks installed');
		} catch (e) { console.warn('[cutscenerelay] install failed', e); }
	}

	private storySyncActive(): boolean {
		try {
			const ctl: any = (window as any).__mpStory;
			return !!(ctl && typeof ctl.isStorySyncActive === 'function' && ctl.isStorySyncActive());
		} catch (_) { return false; }
	}

	/** A trigger qualifies for relay only when it is a persistent one-shot
	 * story cutscene gated by a real condition (see module header). */
	private qualifies(trig: any): boolean {
		try {
			if (!trig || trig._killed) return false;
			const EVT: any = (ig as any).EVENT_TYPE || {};
			const isCutscene = trig.eventType === EVT.CUTSCENE || trig.eventType === EVT.COMBAT_CUTSCENE;
			// Encounter-battle intros are PARALLEL events carrying the dramatic
			// enemy-target signature (SET_SCREEN_ENEMY_TARGET / SET_FINAL_DRAMATIC_EFFECT)
			// — e.g. cold-dng.b3.center's BattleStart when stepping off the elevator.
			const isEncounter = trig.eventType === EVT.PARALLEL && this.hasEncounterSignature(trig);
			if (!isCutscene && !isEncounter && !this.isDrillBossIntroTrigger(trig)) return false;
			if (typeof trig.triggerVar !== 'string' || trig.triggerVar.indexOf('map._entity') !== 0) return false;
			// In the BAKED game VarCondition.condition is the COMPILED predicate
			// function, not the source string — the string check here silently
			// disqualified every trigger. Read the RAW settings string stashed at
			// init instead (undefined/''/'false' = condition-less entry cutscene).
			const raw = trig._mpCsSettings;
			const condStr = (raw && typeof raw.startCondition === 'string') ? raw.startCondition.trim() : '';
			if (!condStr || condStr === 'false' || condStr === '0') return false;
			// 1.74.x (element-get freeze): the per-player upgrade chain (element
			// get / tutorials / boss-defeat cutscenes) plays LOCALLY on every
			// client — never relay it (the receiver's own trigger fires natively;
			// a relayed copy racing it is what wedged members mid-scene).
			const ctl: any = (window as any).__mpStory;
			if (ctl && typeof ctl.isPerPlayerChainTrigger === 'function' && ctl.isPerPlayerChainTrigger(trig)) {
				return false;
			}
			// 1.76.x (master-door unlock per-player, direct check): a cutscene
			// armed by one of THIS map's key-lock unlock counters
			// (map.masterDoorOpened / map.keyUsed / ...) documents the LOCAL
			// player's own key spend — it must never gather/relay, no matter
			// which upstream判定 route classified it. Defense-in-depth on top of
			// storySync's isPerPlayerChainTrigger (case d).
			{
				const m: any = this.getMain();
				const ns: any = m && m.netSync;
				if (ns && typeof ns.isKeyLockGateCondition === 'function' && ns.isKeyLockGateCondition(condStr)) {
					return false;
				}
			}
			return true;
		} catch (_) { return false; }
	}

	/** An encounter-battle intro is a PARALLEL event whose steps carry the
	 * dramatic enemy-target signature. Matched by step TYPE only (the raw settings
	 * steps array), so it works for any map's battle trigger, not just cold-dng. */
	private hasEncounterSignature(trig: any): boolean {
		try {
			const raw = trig._mpCsSettings;
			const steps = raw && raw.event;
			if (!Array.isArray(steps)) return false;
			for (let i = 0; i < steps.length; i++) {
				const t = steps[i] && steps[i].type;
				if (t === 'SET_SCREEN_ENEMY_TARGET' || t === 'SET_FINAL_DRAMATIC_EFFECT') return true;
			}
		} catch (_) { /* ignore */ }
		return false;
	}

	/** 1.75.x (drill-boss barrier intro): the Temple Mine final-boss trigger —
	 * PARALLEL, named "Intro", sets map.barrierUp and carries both SET_CAMERA_POS
	 * and RUMBLE_SCREEN steps. Detected from the raw settings, scoped to the boss map. */
	private isDrillBossIntroTrigger(trig: any): boolean {
		try {
			if (!trig || trig._killed) return false;
			const mapName: string = ((ig.game as any).mapName || '') as string;
			if (mapName !== 'cold-dng/g/boss' && mapName !== 'cold-dng.g.boss') return false;
			const EVT: any = (ig as any).EVENT_TYPE || {};
			if (trig.eventType !== EVT.PARALLEL) return false;
			const raw = trig._mpCsSettings;
			if (!raw || raw.name !== 'Intro' || !Array.isArray(raw.event)) return false;
			let barrier = false, cam = false, rumble = false;
			const scan = (steps: any[]): void => {
				if (!Array.isArray(steps)) return;
				for (let i = 0; i < steps.length; i++) {
					const s = steps[i];
					if (!s || typeof s.type !== 'string') continue;
					if (s.type === 'CHANGE_VAR_BOOL' && s.varName === 'map.barrierUp' && s.value === true) barrier = true;
					if (s.type === 'SET_CAMERA_POS') cam = true;
					if (s.type === 'RUMBLE_SCREEN') rumble = true;
					if (Array.isArray(s.action)) scan(s.action);
					if (Array.isArray(s.thenStep)) scan(s.thenStep);
					if (Array.isArray(s.elseStep)) scan(s.elseStep);
				}
			};
			scan(raw.event);
			return barrier && cam && rumble;
		} catch (_) { return false; }
	}

	/** Fade + collision-off for other mirrors while an encounter-battle intro plays
	 * — mirrors the fade a story cutscene triggers, without blocking input. The
	 * netSync timestamp self-expires ~1.5s later (the intro is a short PARALLEL event). */
	/** Ask netSync to respawn a stale encounter battle (HOST-only no-op elsewhere).
	 * Scoped to PARALLEL encounter intros so a story cutscene never re-spawns a
	 * battle the host legitimately cleared. */
	private maybeRespawn(trig: any): void {
		try {
			if (!this.isEncounterTrigger(trig)) return;
			const m: any = this.getMain();
			const ns: any = m && m.netSync;
			if (ns && typeof ns.maybeRespawnStaleBattle === 'function') ns.maybeRespawnStaleBattle();
		} catch (_) { /* ignore */ }
	}

	private isEncounterTrigger(trig: any): boolean {
		try {
			const EVT: any = (ig as any).EVENT_TYPE || {};
			return trig.eventType === EVT.PARALLEL && this.hasEncounterSignature(trig);
		} catch (_) { return false; }
	}

	/** 1.75.x (overworld side-quest cutscenes): true when the trigger's RAW
	 * startCondition references `quest.*`. Only then is a relayed copy gated on the
	 * RECEIVER's own quest state — main-story/dungeon/puzzle conditions (plot/tmp/map
	 * vars) must keep the old always-replay behaviour, because the relay exists to
	 * cover exactly the case where those vars/event-readiness were missed locally. */
	private hasQuestGate(trig: any): boolean {
		try {
			const raw = trig && trig._mpCsSettings;
			let cond = (raw && typeof raw.startCondition === 'string') ? raw.startCondition : '';
			// Fallback for triggers that existed before the relay hook stashed their
			// raw settings (map loaded pre-install): VarCondition keeps the source in
			// `pretty` even in the baked game.
			if (!cond && trig && trig.startCondition && typeof trig.startCondition.pretty === 'string') {
				cond = trig.startCondition.pretty;
			}
			return /quest\./.test(cond);
		} catch (_) { return false; }
	}

	/** Extract every quest id referenced by the trigger condition (`quest.a-b_1...`). */
	private questIdsReferenced(cond: string): string[] {
		const out: string[] = [];
		try {
			if (!cond) return out;
			const re = /quest\.([A-Za-z0-9_\-]+)/g;
			let m: RegExpExecArray | null;
			while ((m = re.exec(cond)) && out.length < 16) {
				if (m[1] && out.indexOf(m[1]) === -1) out.push(m[1]);
			}
		} catch (_) { /* ignore */ }
		return out;
	}

	/** A referenced quest is "locally known" when this save has accepted it or
	 * already solved it. Never compare task steps here — the full condition
	 * evaluation below handles that; this only rejects players whose save has no
	 * trace of the side quest at all. */
	private questLocallyKnown(id: string): boolean {
		try {
			const q: any = (sc as any).quests;
			if (!q) return true; // no quest model to ask: keep the old behaviour
			if (typeof q.isQuestActive === 'function' && q.isQuestActive(id)) return true;
			if (typeof q.isQuestSolved === 'function' && q.isQuestSolved(id)) return true;
		} catch (_) { /* fall through to false */ }
		return false;
	}

	/** Evaluate the trigger's own compiled startCondition against THIS client's vars,
	 * after confirming every referenced quest exists in this save. A player who never
	 * accepted the side quest fails the first part even for negated conditions like
	 * `!quest.x.solved` (which would otherwise evaluate true for a missing quest), and
	 * a player on a different task step fails the second part — either way they must
	 * not be teleported nor play the cutscene, because the quest data/entities are
	 * missing locally and the scene would wedge. */
	private questGateMet(trig: any): boolean {
		try {
			const raw = trig && trig._mpCsSettings;
			let cond = (raw && typeof raw.startCondition === 'string') ? raw.startCondition : '';
			if (!cond && trig && trig.startCondition && typeof trig.startCondition.pretty === 'string') {
				cond = trig.startCondition.pretty;
			}
			const ids = this.questIdsReferenced(cond);
			for (const id of ids) {
				if (!this.questLocallyKnown(id)) return false;
			}
			if (!trig || !trig.startCondition || typeof trig.startCondition.evaluate !== 'function') return true;
			return trig.startCondition.evaluate() === true;
		} catch (_) { return false; /* quest-gated and unverifiable: skip, never wedge */ }
	}

	private markEncounterFade(trig: any): void {
		try {
			const EVT: any = (ig as any).EVENT_TYPE || {};
			if (trig.eventType !== EVT.PARALLEL) return;
			const m = this.getMain();
			const ns: any = m && m.netSync;
			if (ns && typeof ns.encounterFadeUntil === 'number') {
				ns.encounterFadeUntil = Date.now() + 1500;
			}
		} catch (_) { /* ignore */ }
	}

	/** Bail diagnostics are logged ONCE per key per map — enough to diagnose a
	 * silent relay failure from one console dump without spamming the frame. */
	private bailLogged = new Set<string>();
	private bailMap = '';
	private logOnce(key: string, msg: string): void {
		try {
			const map = (ig.game && (ig.game as any).mapName) || '';
			if (map !== this.bailMap) { this.bailMap = map; this.bailLogged.clear(); }
			if (this.bailLogged.has(key)) return;
			this.bailLogged.add(key);
			console.log('[cutscenerelay] ' + msg);
		} catch (_) { /* ignore */ }
	}
	private trigLabel(trig: any): string {
		return 'name=' + ((trig && trig.name) || '(none)') + ' mi=' + ((trig && trig.mapId) || 0)
			+ ' type=' + (trig && trig.eventType) + ' var=' + ((trig && trig.triggerVar) || '(none)');
	}

	private onLocalTriggerStart(trig: any): void {
		try {
			if (this.applying) return;
			// Probe EVERY story-type trigger start — this is the ground truth for
			// 'the local engine really fired the cutscene on this client'.
			const EVT: any = (ig as any).EVENT_TYPE || {};
			if (trig.eventType === EVT.CUTSCENE || trig.eventType === EVT.COMBAT_CUTSCENE) {
				this.logOnce('probe:' + (trig.mapId || trig.name || '?'),
					'local cutscene start: ' + this.trigLabel(trig)
					+ ' storySync=' + (this.storySyncActive() ? 1 : 0));
			}
			if (this.storySyncActive() && !this.isDrillBossIntroTrigger(trig)) return; // story sync owns trigger authority (except the drill-boss barrier)
			if (!this.qualifies(trig)) {
				if (trig.eventType === EVT.CUTSCENE || trig.eventType === EVT.COMBAT_CUTSCENE) {
					this.logOnce('qual:' + (trig.mapId || '?'), 'start NOT relay-qualified: ' + this.trigLabel(trig)
						+ ' cond=' + (trig.startCondition && trig.startCondition.condition));
				}
				return;
			}
			this.markEncounterFade(trig);
			this.maybeRespawn(trig);
			const m: any = this.getMain();
			const conn: any = m && m.connection;
			if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) { this.logOnce('conn', 'relay bail: connection closed'); return; }
			if (typeof conn.sendCutsceneTrigger !== 'function') { this.logOnce('conn2', 'relay bail: no sendCutsceneTrigger'); return; }
			const me = m && m.name;
			const members: string[] = (m && m.partyMembers) || [];
			let hasOther = false;
			for (const n of members) { if (n && n !== me) { hasOther = true; break; } }
			if (!hasOther) { this.logOnce('alone', 'relay bail: no other party members (roster=' + JSON.stringify(members) + ')'); return; }
			const player: any = ig.game && ig.game.playerEntity;
			if (!player || !player.coll) return;
			const map: string = (ig.game as any).mapName || '';
			const mi = trig.mapId || 0;
			if (!map || !mi) { this.logOnce('mi', 'relay bail: no map or mapId: ' + this.trigLabel(trig)); return; }
			conn.sendCutsceneTrigger(map, mi, [
				Math.round(player.coll.pos.x),
				Math.round(player.coll.pos.y),
				Math.round(player.coll.pos.z),
			]);
			console.log('[cutscenerelay] relayed trigger map=' + map + ' mi=' + mi
				+ ' name=' + (trig.name || '(none)'));
		} catch (_) { /* never break the local cutscene */ }
	}

	/** A relay that arrived while we were momentarily busy (teleporting / event
	 * not start-ready) is retried briefly instead of being dropped forever —
	 * the engine's own trigger retry covers the var-synced native path, but the
	 * relay is the only carrier when that path never engaged. */
	private pendingRelay: { data: ICutsceneRelayPacket, until: number } | null = null;
	private pendingTimer: any = null;

	public onRelay(data: ICutsceneRelayPacket): void {
		try {
			if (!data || typeof data.map !== 'string' || typeof data.mi !== 'number') return;
			if (!Array.isArray(data.p) || data.p.length !== 3) return;
			if (this.storySyncActive() && data.map !== 'cold-dng/g/boss' && data.map !== 'cold-dng.g.boss') { this.logOnce('rs:' + data.mi, 'relay mi=' + data.mi + ' ignored: storySync active'); return; }
			const g: any = ig.game;
			if (!g || !g.playerEntity) return;
			if ((g.mapName || '') !== data.map) return; // different block — not for us
			if (g.isTeleporting() || (typeof g.isEventStartReady === 'function' && !g.isEventStartReady())) {
				// Busy right now — retry for up to 10s instead of losing the moment.
				this.logOnce('busy:' + data.mi, 'relay mi=' + data.mi + ' deferred (busy), retrying');
				this.pendingRelay = { data, until: Date.now() + 10000 };
				this.armPendingRetry();
				return;
			}
			const trig = this.findTrigger(data.mi);
			if (!trig) { this.logOnce('nf:' + data.mi, 'relay mi=' + data.mi + ' — trigger NOT FOUND on this map'); return; }
		// storySync owns every other trigger on the boss map — the drill-boss barrier
		// intro is the one exception (blocked players must be pulled inside).
		if (this.storySyncActive() && !this.isDrillBossIntroTrigger(trig)) {
			this.logOnce('rs:' + data.mi, 'relay mi=' + data.mi + ' ignored: storySync active');
			return;
		}
			// 1.74.x (element-get freeze): per-player upgrade chain — skip the
			// relayed copy; our own native trigger plays it locally (mixed
			// old/new client pairs still send these).
			{
				const ctl: any = (window as any).__mpStory;
				if (ctl && typeof ctl.isPerPlayerChainTrigger === 'function' && ctl.isPerPlayerChainTrigger(trig)) {
					this.logOnce('chain:' + data.mi, 'relay mi=' + data.mi + ' skipped: per-player upgrade chain');
					return;
				}
			}
			// 1.76.x (master-door unlock per-player, direct check): never replay a
			// cutscene armed by a key-lock unlock counter — each client plays its
			// own when IT spends the key.
			{
				const m: any = this.getMain();
				const ns: any = m && m.netSync;
				const raw2 = trig && (trig._mpCsSettings || trig._mpStorySettings);
				const cond2 = (raw2 && typeof raw2.startCondition === 'string') ? raw2.startCondition
					: ((trig && trig.startCondition && typeof trig.startCondition.pretty === 'string') ? trig.startCondition.pretty : '');
				if (ns && typeof ns.isKeyLockGateCondition === 'function' && ns.isKeyLockGateCondition(cond2)) {
					this.logOnce('keylock:' + data.mi, 'relay mi=' + data.mi + ' skipped: key-lock unlock cutscene (per-player)');
					return;
				}
			}
			// 1.75.x (overworld side-quest cutscenes): a quest-gated trigger must be
			// locally available for US. Otherwise we have not accepted that side quest
			// (or are on a different step) — no teleport, no replay, or the scene's
			// quest data is missing locally and we'd be stuck.
			if (this.hasQuestGate(trig) && !this.questGateMet(trig)) {
				this.logOnce('quest:' + data.mi, 'relay mi=' + data.mi + ' skipped: local quest condition not met');
				return;
			}
			// We already consumed it (we were standing in the zone ourselves, or
			// saw it in an earlier session) — no teleport, no replay.
		// 1.75.x (drill-boss barrier): never replay the full Intro event on teammates
		// — it would block mobility, pause BGM and drive the boss puppet. Instead mark
		// consumed FIRST (prevents our own native trigger from firing once we teleport
		// into the zone), then netSync does the one-shot teleport + camera/rumble-only
		// replay.
		if (this.isDrillBossIntroTrigger(trig)) {
			if (trig.triggerVar && ig.vars.get(trig.triggerVar)) {
				this.logOnce('done:' + data.mi, 'drill intro already consumed');
				return;
			}
			if (trig.triggerVar) {
				// Write the per-map storage object DIRECTLY — the hooked ig.vars.set
				// would let an active story sync relay this per-player consumed flag
				// to players outside the boss block and pre-consume their trigger.
				try {
					const vars: any = (ig as any).vars;
					const mapObj: any = vars && vars.storage && vars.storage.map;
					const key: string = trig.triggerVar.slice(4);
					if (mapObj && typeof mapObj === 'object' && key) mapObj[key] = true;
				} catch (_) { /* consumed flag is best-effort */ }
			}
			const m: any = this.getMain();
			const ns: any = m && m.netSync;
			if (ns && typeof ns.applyDrillBossIntro === 'function') {
				ns.applyDrillBossIntro(data.p);
				console.log('[cutscenerelay] drill-boss intro relayed mi=' + data.mi
					+ ' from=' + (data.from || '?'));
			}
			return;
		}
			this.maybeRespawn(trig);
			if (trig.triggerVar && ig.vars.get(trig.triggerVar)) { this.logOnce('done:' + data.mi, 'relay mi=' + data.mi + ' already consumed'); return; }
			if (trig.eventCall && trig.eventCall.isRunning()) { this.logOnce('run:' + data.mi, 'relay mi=' + data.mi + ' already running natively'); return; }
			const ev = this.eventOf(trig);
			if (!ev) {
				console.warn('[cutscenerelay] no event object for trigger mi=' + data.mi);
				return;
			}
			// 1) gather: jump to the triggerer's exact coordinates.
			try { g.playerEntity.setPos(data.p[0], data.p[1], data.p[2]); } catch (_) { /* ignore */ }
			// 2) start the same cutscene locally and mark the trigger consumed.
			this.applying = true;
			try {
				(sc as any).Cutscene.startEvent(trig.eventType, ev);
				this.markEncounterFade(trig);
				if (trig.triggerVar) { try { ig.vars.set(trig.triggerVar, true); } catch (_) { /* ignore */ } }
				console.log('[cutscenerelay] started relayed trigger mi=' + data.mi
					+ ' from=' + (data.from || '?'));
			} finally { this.applying = false; }
		} catch (e) { console.warn('[cutscenerelay] relay failed', e); }
	}

	private armPendingRetry(): void {
		if (this.pendingTimer) return;
		const self = this;
		this.pendingTimer = setInterval(() => {
			try {
				const p = self.pendingRelay;
				if (!p || Date.now() > p.until) { self.pendingRelay = null; return; }
				const g: any = ig.game;
				if (!g || !g.playerEntity || g.isTeleporting()) return;
				if ((g.mapName || '') !== p.data.map) { self.pendingRelay = null; return; }
				if (typeof g.isEventStartReady === 'function' && !g.isEventStartReady()) return;
				const data = p.data;
				self.pendingRelay = null;
				self.onRelay(data);
			} catch (_) { /* ignore */ }
		}, 500);
	}

	private findTrigger(mi: number): any {
		try {
			const ET: any = (ig.ENTITY as any).EventTrigger;
			const list: any[] = (ig.game as any).entities || [];
			for (const e of list) {
				if (e && !e._killed && ET && e instanceof ET && e.mapId === mi) return e;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	private eventOf(trig: any): any {
		try {
			if (trig.event) return trig.event;
			const raw = trig._mpCsSettings;
			if (raw && raw.event) return new (ig as any).Event({ name: trig.name || undefined, steps: raw.event });
		} catch (_) { /* ignore */ }
		return null;
	}
}
