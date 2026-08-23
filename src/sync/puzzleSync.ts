import { Multiplayer } from '../multiplayer';

/**
 * 1.71.0 — dungeon interaction-mechanism sync.
 * 1.71.2 — box push/pull ownership + interpolation.
 * 1.71.3 — PushPullDest progress is personal save state.
 * 1.71.4 — platform positions are host-authoritative (no member echoes).
 * 1.71.5 — unowned boxes are host-authoritative; permanent OneTimeSwitch
 *          state is monotonic (once triggered, never reverted by a peer).
 * 1.71.6 — follower box z-physics is frozen while network-driven so a box
 *          pulled off a raised platform can't fall into the pit on peers.
 * 1.71.8 — when remote box ownership ends, the instance host hands the box
 *          back to REAL gravity before applying the release packet, so a box
 *          pushed off a ledge (Temple Chamber 1's upper-left box) can fall to
 *          the lower floor instead of being re-frozen at the ledge height.
 *
 * CrossCode dungeon puzzles are mostly var-driven, but each client owns its own
 * ig.vars, so the ENGINE never shares puzzle state across machines. This module
 * scans the live puzzle entities on dungeon maps and relays their compact state:
 *   - push/pull boxes, wave boxes, sliding blocks (position + anim + phased),
 *   - water blocks / ice pillars (state + remaining hits),
 *   - auto-circling dynamic platforms (position; var-driven OL/extract are per-player and NOT synced),
 *   - one-time / multi-hit / floor / bounce / group switches (on/off + hits),
 *   - bounce blocks and blockers (state/active).
 *
 * Push/pull boxes are special: only ONE player may grab a box at a time. The
 * gripping client stamps its entries with `own` (its username + a local claim
 * timestamp), every other client drops its own stale box packets while that
 * owner is alive, and the local map-interact entry is disabled for everyone
 * else. Remote positions are lerped per-frame so 10Hz snapshots glide instead
 * of stuttering. When nobody is gripping, only the map-instance host publishes
 * box positions (mechanism-raised boxes therefore can't be dragged back into
 * their pit by a peer's stale echo); the gripping member stays owner-authority.
 *
 * 1.71.3: "box already pushed onto the switch / plate half-lowered" is saved
 * per player (vanilla var `map.entity<destMapId>_placed`). Cross-syncing it
 * made an already-solved box fight an unsolved player's copy until the box
 * vanished. PushPullDest entities are therefore NEVER networked, and a box
 * whose own destination is already placed in THIS save neither sends nor
 * receives position — every player solves that particular box themselves.
 */

const PUZZLE_SCAN_INTERVAL = 0.1;   // seconds — change scan
const PUZZLE_FULL_INTERVAL = 1000;  // ms — host full snapshot
const PUZZLE_FAST_INTERVAL = 1 / 30; // seconds — moving pushable pillars/boxes at 30Hz
const PUZZLE_OWN_TTL = 700;         // ms without an owner heartbeat -> release
const PUZZLE_OWN_HEARTBEAT = 400;   // ms — owner re-asserts even when stationary
const PUZZLE_LERP_RATE = 16;        // ~16% of the remaining distance per frame

interface IPuzzleEntry {
	mi: number;
	p?: [number, number, number];
	on?: number;
	hits?: number;
	st?: number;
	anim?: string;
	ph?: number;
	act?: number;
	mv?: number;
	hd?: number;
	gone?: number;
	/** 1.71.2: username currently gripping this push/pull box ('' = release). */
	own?: string;
	/** 1.71.2: local claim timestamp for same-time grab arbitration. */
	ot?: number;
	/** ROUND 130: PushPullDest placement event. pl=1 marks "this box just locked
	 * into a plate"; dl = the plate's (PushPullDest) mapId. Relayed through the
	 * long-whitelisted server fields so a box sinks into stairs on EVERY client,
	 * not just the pusher's. */
	pl?: number;
	dl?: number;
}

interface IPuzzlePacket {
	map: string;
	entries: IPuzzleEntry[];
}

export interface IPuzzleSync {
	install(): void;
	tick(): void;
	apply(data: IPuzzlePacket): void;
	/** Diagnostic: list scanned puzzle entities near the player. */
	dump(): void;
}

let updateRegistered = false;
let pushHooksInstalled = false;
let shared: PuzzleSync | null = null;

export function installPuzzleSync(getMain: () => Multiplayer | undefined): IPuzzleSync {
	if (!shared) shared = new PuzzleSync(getMain);
	return shared;
}

class PuzzleSync implements IPuzzleSync {
	private scanTimer = 0;
	private fastTimer = 0;
	private lastFullAt = 0;
	private lastMap = '';
	private seen = new Set<number>();
	private lastSig = new Map<number, string>();
	private applying = false;
	private remoteOwners = new Map<number, { name: string, claim: number, at: number }>();
	private ownedLast = new Map<number, boolean>();
	private ownHeartbeat = new Map<number, number>();
	private interp = new Map<number, { e: any, tx: number, ty: number, tz: number }>();
	/** 1.71.6: push boxes that are currently FOLLOWERS (their position comes from
	 * the network). Their local z-physics is frozen every frame so the engine
	 * can't drop them into a pit the peer's copy already left behind. */
	private followers = new Map<number, any>();
	/** 1.71.3: mapIds of push/pull boxes whose PushPullDest is ALREADY PLACED in
	 * THIS client's save. That progress is per-player save state — solved boxes
	 * neither send nor receive network position (a solved player's lowered
	 * plate/box must never overwrite an unsolved player's still-raised puzzle). */
	private placedBoxIds = new Set<number>();
	private _varLogSeen = new Set<string>();

	constructor(private getMain: () => Multiplayer | undefined) {
		(window as any).__mppuzzle = () => this.dump();
	}

	public install(): void {
		const m = this.getMain();
		if (!m || !m.connection) return;
		try { m.connection.onPuzzleState((data) => this.apply(data)); } catch (_) { /* ignore */ }
		try { if (typeof (m.connection as any).onSlidingPush === 'function') (m.connection as any).onSlidingPush((data: any) => this.applySlidingPush(data)); } catch (_) { /* ignore */ }
		if (!updateRegistered) {
			updateRegistered = true;
			simplify.registerUpdate(() => {
				if (!shared) return;
				try { shared.tick(); } catch (_) { /* never break the frame */ }
				try { shared.interpolate(); } catch (_) { /* never break the frame */ }
			});
			console.log('[puzzlesync] installed');
		}
		this.installPushPullHooks();
	}

	public tick(): void {
		const m = this.getMain();
		if (!m || !m.connection || !m.connection.isOpen()) return;
		const g: any = ig.game;
		if (!g || !g.playerEntity || g.isTeleporting()) return;
		if (!this.inDungeon()) {
			if (this.seen.size || this.lastSig.size || this.interp.size || this.remoteOwners.size || this.placedBoxIds.size || this.followers.size) {
				this.seen.clear();
				this.lastSig.clear();
				this.lastMap = '';
				this.interp.clear();
				this.remoteOwners.clear();
				this.ownedLast.clear();
				this.ownHeartbeat.clear();
				this.placedBoxIds.clear();
				this.followers.clear();
			}
			return;
		}
		const map = g.mapName || '';
		if (map !== this.lastMap) {
			this.lastMap = map;
			this.seen.clear();
			this.lastSig.clear();
			this.lastFullAt = 0;
			this.interp.clear();
			this.remoteOwners.clear();
			this.ownedLast.clear();
			this.ownHeartbeat.clear();
			this.placedBoxIds.clear();
			this.followers.clear();
		}
		this.expireRemoteOwners((g.entities as any[]) || []);
		// Fast 30Hz stream for MOVING pushable pillars/boxes (idle ones stay at the
		// 1Hz full snapshot). Runs on its own timer, independent of the 10Hz scan.
		this.fastTimer -= ig.system.tick;
		if (this.fastTimer <= 0) {
			this.fastTimer = PUZZLE_FAST_INTERVAL;
			this.scanFast();
		}
		this.scanTimer -= ig.system.tick;
		const hostFull = m.host && Date.now() - this.lastFullAt >= PUZZLE_FULL_INTERVAL;
		if (hostFull) this.lastFullAt = Date.now();
		if (this.scanTimer > 0 && !hostFull) return;
		this.scanTimer = PUZZLE_SCAN_INTERVAL;
		const entities = (g.entities as any[]) || [];
		this.refreshPlacedBoxIds(entities);
		const myName = (m.name || '').trim();
		const entries: IPuzzleEntry[] = [];
		const nowSeen = new Set<number>();
		for (const e of entities) {
			const mi = e && e.mapId;
			if (!e || e._killed || typeof mi !== 'number' || !mi) continue;
			if (!this.isPuzzleEntity(e)) continue;
			nowSeen.add(mi);
			const push = this.isPushPull(e);
			// Moving pushable pillars/boxes ride the 30Hz fast stream (scanFast); the
			// 10Hz scan only handles them while idle (1Hz full snapshot). The one-shot
			// release (own:'') still fires here so the host takes over authority at once.
			if ((push || this.isSlidingBlock(e)) && this.isPushableMoving(e)
				&& !(push && !this.isLocalGripping(e) && !!this.ownedLast.get(mi))) continue;
			// 1.71.3 (pillar/OL-platform echo loop): moving platforms are var-driven
			// on every client — once the switch variable arrives each client moves its
			// own platform natively. Only the map-instance HOST ships platform
			// POSITIONS (authoritative self-heal); members must not echo their own
			// half-finished transition back, which made the Temple Chamber 1 pillars
			// oscillate at ~80% and never reach their final height.
			if (!m.host && this.isMovingPlatform(e)) continue;
			// Ball-pushed ice pillars are host-authoritative too: members must not echo
			// their own (slightly-ahead) slide — the host's copy moves via the synced
			// ball and streams the one true position back.
			if (!m.host && this.isSlidingBlock(e)) continue;
			// Solved-in-this-save boxes are personal save state: never ship them,
			// but keep them in `seen` so they don't turn into a `gone` packet.
			if (push && this.placedBoxIds.has(mi)) continue;
			// A box that belongs to someone else right now is a FOLLOWER copy:
			// never ship its stale position (that is exactly the rollback the
			// gripping player complained about), and never ship `gone` for it.
			if (push && this.remoteOwners.has(mi)) {
				if (this.ownedLast.has(mi)) this.ownedLast.delete(mi);
				continue;
			}
			// 1.71.4 (raised-box pit echo): mechanism-driven boxes are exactly like
			// the platforms under them — only the HOST may publish their position
			// while nobody is gripping them. A member echoing its still-in-the-pit
			// copy kept pulling the raised box back down, and the next grip aligned
			// the player to that underground z (the "grabbed it and teleported below
			// the floor" report). The gripping member stays the owner-authority, and
			// its one-shot own='' release still ships when it lets go.
			if (push && !m.host && !this.isLocalGripping(e) && !this.ownedLast.has(mi)) continue;
			const entry = this.encode(e);
			let force = false;
			if (push) {
				if (this.isLocalGripping(e)) {
					this.interp.delete(mi);
					if (typeof (e as any)._mpPuzzleGripAt !== 'number') (e as any)._mpPuzzleGripAt = Date.now();
					entry.own = myName || 'unknown';
					entry.ot = (e as any)._mpPuzzleGripAt;
					this.ownedLast.set(mi, true);
					const lastHb = this.ownHeartbeat.get(mi) || 0;
					if (!hostFull && Date.now() - lastHb >= PUZZLE_OWN_HEARTBEAT) {
						this.ownHeartbeat.set(mi, Date.now());
						force = true;
					}
				} else {
					delete (e as any)._mpPuzzleGripAt;
					if (this.ownedLast.get(mi)) {
						entry.own = '';
						this.ownedLast.delete(mi);
						this.ownHeartbeat.delete(mi);
						force = true;
					}
				}
			}
			const sig = this.signature(entry);
			if (!force && !hostFull && this.lastSig.get(mi) === sig) continue;
			this.lastSig.set(mi, sig);
			entries.push(entry);
		}
		// Gone entries: an entity the peer has must be killed. Remote-owned boxes
		// are in nowSeen (the follower-copy branch above), so they never go out;
		// belt-and-braces: never `gone` a box that still has a live remote owner.
		for (const mi of this.seen) {
			if (nowSeen.has(mi)) continue;
			if (this.remoteOwners.has(mi)) continue;
			if (this.placedBoxIds.has(mi)) continue;
			this.lastSig.delete(mi);
			entries.push({ mi, gone: 1 });
		}
		this.seen = nowSeen;
		if (!entries.length) return;
		try {
			m.connection.puzzleState(map, entries);
		} catch (_) { /* ignore */ }
	}

	/** 30Hz fast stream for MOVING pushable pillars/boxes. Idle pushables are NOT
	 * touched here — they fall back to the 1Hz host full snapshot. Only entities
	 * that are actively sliding / being pushed / coasting are shipped, so position
	 * updates arrive ~3x faster than the 10Hz general scan while moving and cost
	 * nothing while idle. */
	private scanFast(): void {
		try {
			const m = this.getMain();
			if (!m || !m.connection || !m.connection.isOpen()) return;
			const g: any = ig.game;
			if (!g || !g.playerEntity || g.isTeleporting()) return;
			if (!this.inDungeon()) return;
			const map = (g.mapName || '');
			const myName = (m.name || '').trim();
			const entities = (g.entities as any[]) || [];
			const entries: IPuzzleEntry[] = [];
			for (const e of entities) {
				const mi = e && e.mapId;
				if (!e || e._killed || typeof mi !== 'number' || !mi) continue;
				const push = this.isPushPull(e);
				const sliding = this.isSlidingBlock(e);
				if (!push && !sliding) continue;
				if (!this.isPushableMoving(e)) continue;
				// Same authority fence as the 10Hz scan (see tick).
				if (sliding && !m.host) continue;
				if (push && this.placedBoxIds.has(mi)) continue;
				if (push && this.remoteOwners.has(mi)) continue;
				if (push && !m.host && !this.isLocalGripping(e) && !this.ownedLast.has(mi)) continue;
				const entry = this.encode(e);
				if (push && this.isLocalGripping(e)) {
					if (typeof (e as any)._mpPuzzleGripAt !== 'number') (e as any)._mpPuzzleGripAt = Date.now();
					entry.own = myName || 'unknown';
					entry.ot = (e as any)._mpPuzzleGripAt;
					this.ownedLast.set(mi, true);
				}
				entries.push(entry);
			}
			if (!entries.length) return;
			try { m.connection.puzzleState(map, entries); } catch (_) { /* ignore */ }
		} catch (_) { /* never break the frame */ }
	}
	/** 1.74.0: forward a member's sliding-block push to the instance host. Only the
	 * host is the pillar authority — the member sends the push DIRECTION, the host
	 * slides its local pillar and streams the position back (puzzleState 30Hz). */
	private broadcastSlidingPush(mi: number, dx: number, dy: number): void {
		try {
			const m = this.getMain();
			if (!m || !m.connection || !m.connection.isOpen()) return;
			if (typeof (m.connection as any).slidingPush !== 'function') return;
			const g: any = ig.game;
			const map = (g && g.mapName) || '';
			(m.connection as any).slidingPush(map, mi, Math.round(dx), Math.round(dy));
		} catch (_) { /* ignore */ }
	}

	/** 1.74.0: host receives a member's push — slide the local pillar natively (or
	 * flash "blocked" if a wall/fence is in the way). The position streams out via
	 * the normal 30Hz fast path. */
	private applySlidingPush(data: { map: string, mi: number, dx: number, dy: number }): void {
		try {
			if (!data || typeof data.mi !== 'number' || typeof data.dx !== 'number' || typeof data.dy !== 'number') return;
			if (!this.isInstanceHost()) return; // only the host pushes
			const g: any = ig.game;
			if (data.map && (g.mapName || '') !== data.map) return;
			const E: any = (ig.ENTITY as any);
			if (!E || !E.SlidingBlock) return;
			const entities = (g.entities as any[]) || [];
			for (const e of entities) {
				if (!e || e._killed || !(e instanceof E.SlidingBlock) || e.mapId !== data.mi) continue;
				if (e.moving) return; // already sliding
				const dir = Vec2.create();
				dir.x = data.dx; dir.y = data.dy;
				const trace: any = (ig as any).game.physics.initTraceResult(Vec3.create());
				if ((ig as any).game.traceEntity(trace, e, dir.x, dir.y, 0, 0, 0, (ig as any).COLLTYPE.IGNORE)) {
					try { if (e.effects && e.effects.sheet && typeof e.effects.sheet.spawnOnTarget === 'function') e.effects.sheet.spawnOnTarget('blocked', e); } catch (_) { /* ignore */ }
				} else {
					Vec2.assign(e.moveDir, dir);
					e.moving = true;
					try { if (e.effects && e.effects.sheet && typeof e.effects.sheet.spawnOnTarget === 'function') e.effects.handle = e.effects.sheet.spawnOnTarget('slide', e, { duration: -1 }); } catch (_) { /* ignore */ }
				}
				return;
			}
		} catch (_) { /* never break */ }
	}
	public apply(data: IPuzzlePacket): void {
		if (!data || typeof data.map !== 'string' || !Array.isArray(data.entries)) return;
		const g: any = ig.game;
		if (!g || !g.playerEntity || (g.mapName || '') !== data.map) return;
		this.applying = true;
		try {
			const m = this.getMain();
			this.updateMyName(m);
			const entities = (g.entities as any[]) || [];
			this.refreshPlacedBoxIds(entities);
			const byId = new Map<number, any>();
			for (const e of entities) {
				if (e && typeof e.mapId === 'number' && e.mapId && !e._killed) byId.set(e.mapId, e);
			}
			for (const s of data.entries) {
				if (!s || typeof s.mi !== 'number') continue;
				const e = byId.get(s.mi);
				if (!e) continue;
				const push = this.isPushPull(e);
				// ROUND 130: a box locked into a plate on a peer — reproduce the sink
				// (plate lowers, box snaps on, becomes stairs) on THIS client too.
				if (push && s.pl === 1 && typeof s.dl === 'number') {
					this.applyPlacement(e, byId.get(s.dl));
					continue;
				}
				// Personal save progress wins: a solved-in-this-save box must keep
				// its lowered plate position and must never follow another client's
				// still-unsolved copy (and vice versa).
				if (push && this.placedBoxIds.has(s.mi)) continue;
				if (s.gone) {
					try { if (typeof e.kill === 'function') e.kill(true); } catch (_) { /* ignore */ }
					continue;
				}
				if (push) this.applyOwnership(e, s);
				this.applyEntry(e, s, push);
			}
		} catch (_) { /* never break the frame */ }
		finally {
			this.applying = false;
		}
	}

	public dump(): void {
		try {
			const g: any = ig.game;
			const player = g && g.playerEntity;
			const list: any[] = (g && g.entities) || [];
			let n = 0;
			for (const e of list) {
				if (!e || e._killed || !this.isPuzzleEntity(e)) continue;
				const d = player && player.coll && e.coll ? Math.round(Math.sqrt(
					Math.pow(e.coll.pos.x - player.coll.pos.x, 2) + Math.pow(e.coll.pos.y - player.coll.pos.y, 2))) : -1;
				if (d > 600) continue;
				n++;
				const s = this.encode(e);
				const owner = this.remoteOwners.get(e.mapId || 0);
				console.log('[puzzlesync] ' + (e.constructor && e.constructor.name || e.type || '?')
					+ ' mapId=' + e.mapId + ' dist=' + d + ' sig=' + this.signature(s)
					+ (owner ? ' remoteOwner=' + owner.name : '')
					+ (this.isLocalGripping(e) ? ' localGrip' : '')
					+ (this.isPushPull(e) && e.coll
						? ' z=' + Math.round(e.coll.pos.z) + ' base=' + Math.round(e.coll.baseZPos || 0)
							+ ' grav=' + (e.coll.zGravityFactor || 0)
							+ (this.followers.has(e.mapId || 0) ? ' FROZEN' : '') : ''));
			}
			console.log('[puzzlesync] ' + n + ' puzzle entities nearby, dungeon=' + this.inDungeon()
				+ ', remoteOwners=' + this.remoteOwners.size + ', interp=' + this.interp.size);
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------------ internals

	private updateMyName(m?: Multiplayer | undefined): void {
		try { (this as any)._mpMyName = (m && m.name) || ((this as any)._mpMyName || ''); } catch (_) { /* ignore */ }
	}

	private myName(): string {
		const m = this.getMain();
		return (m && m.name) || (this as any)._mpMyName || '';
	}

	private inDungeon(): boolean {
		try {
			const map: any = (sc as any).map;
			return !!(map && typeof map.isDungeon === 'function' && map.isDungeon());
		} catch (_) { return false; }
	}

	private isPuzzleEntity(e: any): boolean {
		const E: any = (ig.ENTITY as any);
		if (!E) return false;
		// NOTE (1.71.3): PushPullDest is deliberately NOT listed here — its
		// raised/lowered height is a per-player SAVE mechanism. A solved player's
		// lowered plate must never be broadcast over an unsolved player's raised
		// one, and the box that belongs to it is excluded via placedBoxIds.
		// NOTE (1.74.x): OLPlatform / ExtractPlatform are VAR-DRIVEN — each state's
		// condition picks a save var, and every client moves its OWN copy natively
		// when its own ig.vars change. Syncing their position froze the transition
		// timer and fought the native motion (cold-dng.b3.center's two heat pillars
		// never lowered on members after the battle cutscene). They are therefore
		// NOT synced at all. DynamicPlatform (auto-circling) stays in this list and
		// is handled by the isMovingPlatform host-authority branch.
		const kinds = [E.PushPullBlock, E.WavePushPullBlock, E.SlidingBlock,
			E.WaterBlock, E.DynamicPlatform, E.OneTimeSwitch,
			E.MultiHitSwitch, E.FloorSwitch, E.Switch, E.BounceSwitch, E.BounceBlock,
			E.GroupSwitch, E.RotateBlocker, E.Blocker];
		for (const k of kinds) {
			if (k && e instanceof k) return true;
		}
		return false;
	}

	/** Which push/pull boxes are already PLACED in this client's own save? The
	 * PushPullDest keeps `placedData.id` = the box mapId it saved (vanilla var
	 * `map.entity<mapId>_placed`). Those boxes are local-only from now on. */
	private refreshPlacedBoxIds(entities: any[]): void {
		const E: any = (ig.ENTITY as any);
		const next = new Set<number>();
		try {
			if (E && E.PushPullDest) {
				for (const e of entities) {
					if (!e || e._killed || !(e instanceof E.PushPullDest)) continue;
					const id = e.placedData && e.placedData.id;
					if (typeof id === 'number' && id) next.add(id);
				}
			}
		} catch (_) { /* keep the previous set */ }
		this.placedBoxIds = next;
	}

	private isPushPull(e: any): boolean {
		const E: any = (ig.ENTITY as any);
		if (!E) return false;
		return (E.PushPullBlock && e instanceof E.PushPullBlock)
			|| (E.WavePushPullBlock && e instanceof E.WavePushPullBlock);
	}

	/** Auto-circling moving platforms (DynamicPlatform with a looping action):
	 * their positions are host-authoritative; members never echo them (see tick).
	 * OLPlatform / ExtractPlatform are var-driven per-player state and are NOT
	 * synced at all (see isPuzzleEntity). */
	private isMovingPlatform(e: any): boolean {
		const E: any = (ig.ENTITY as any);
		if (!E) return false;
		return (E.DynamicPlatform && e instanceof E.DynamicPlatform);
	}

	/** Ball-pushed sliding blocks (cold-dng ice pillars): host-authoritative position.
	 * Only the HOST pushes + publishes them; members mirror the streamed position. */
	private isSlidingBlock(e: any): boolean {
		const E: any = (ig.ENTITY as any);
		return !!(E && E.SlidingBlock && e instanceof E.SlidingBlock);
	}

	/** True while a pushable pillar/box is actively MOVING (needs the 30Hz fast
	 * stream): a ball-pushed sliding block is `moving`, a gripped box is in a push/
	 * pull/lock-in drag state, or a released box still carries velocity (coasting/
	 * falling). Idle => 1Hz. */
	private isPushableMoving(e: any): boolean {
		if (this.isSlidingBlock(e)) return !!e.moving;
		if (this.isPushPull(e)) {
			const p = e.pushPullable;
			if (p && (p.dragState === 2 || p.dragState === 3 || p.dragState === 4)) return true;
			const c = e.coll;
			if (c && c.vel && (Math.abs(c.vel.x) > 0.5 || Math.abs(c.vel.y) > 0.5 || Math.abs(c.vel.z) > 0.5)) return true;
		}
		return false;
	}


	/** 1.73.x (auto-circling DynamicPlatform): a member's own looping action keeps
	 * moving the platform between syncs and its phase drifts away from the host
	 * (cold-dng center's two endless circling plates). Freeze the LOCAL motion so
	 * the host's position stream (10Hz changes + the 1Hz full snapshot) is the
	 * single authority. Idempotent + re-asserting: the engine's varsChanged can
	 * re-play a state action, so every applied entry re-checks the hold. */
	private freezeMovingPlatform(e: any): void {
		try {
			e._mpPlatformFollow = true;
			const ED: any = (ig.ENTITY as any);
			if (ED && ED.DynamicPlatform && e instanceof ED.DynamicPlatform) {
				const cur = e.currentAction;
				if (!cur || (typeof cur.name === 'string' && cur.name !== 'mpPlatformHold')) {
					try {
						const hold = new (ig as any).Action('mpPlatformHold', [{ type: 'WAIT', time: -1 }], false, false);
						e.setAction(hold);
					} catch (_) { try { if (typeof e.stashAction === 'function') e.stashAction(); } catch (__) { /* ignore */ } }
				}
			}
		} catch (_) { /* never break the sync */ }
	}

	private isLocalGripping(e: any): boolean {
		try {
			const p = e && e.pushPullable;
			if (!p) return false;
			return !!(p.gripDir || p.dragState === 2 || p.dragState === 3 || p.dragState === 4);
		} catch (_) { return false; }
	}

	/** 1.72.x (Temple Mine g/room1 risen pillar): the OneTimeSwitch raises an
	 * OLPlatform with a PushPullBlock riding it. The block's vertical link to the
	 * platform (_collData.groundEntry) is fragile under network sync — the
	 * follower interp setPos() marks zBaseUncertain and baseZPos only ever moves
	 * DOWN, so a synced copy can sit at the risen z with no groundEntry at all.
	 * Vanilla PushPullable.onUpdate then reads the terrain under a resting block
	 * via ig.terrain.getTerrain, which WITHOUT a groundEntry falls through to the
	 * MAP terrain at that tile — the HOLE the platform covers — and respawns the
	 * block into the pit the moment you grip or push it. Find a platform whose
	 * top surface the block is standing on (x/y overlap + z match) so the link
	 * can be repaired (or the bogus respawn vetoed). */
	private findSupportingPlatform(e: any): any {
		try {
			const c = e && e.coll;
			const g: any = ig.game;
			if (!c || !g || !Array.isArray(g.entities)) return null;
			const E: any = ig.ENTITY as any;
			if (!E) return null;
			const bx1 = c.pos.x, by1 = c.pos.y;
			const bx2 = bx1 + c.size.x, by2 = by1 + c.size.y, bz = c.pos.z;
			const list: any[] = g.entities;
			for (let i = 0; i < list.length; i++) {
				const ent = list[i];
				if (!ent || ent._killed || !ent.coll) continue;
				const isPlat = (E.OLPlatform && ent instanceof E.OLPlatform)
					|| (E.DynamicPlatform && ent instanceof E.DynamicPlatform)
					|| (E.ExtractPlatform && ent instanceof E.ExtractPlatform);
				if (!isPlat) continue;
				const pc = ent.coll;
				const top = pc.pos.z + (pc.size.z || 0);
				if (Math.abs(top - bz) > 6) continue; // riding = block bottom at platform top (±interp lag)
				if (bx2 <= pc.pos.x || bx1 >= pc.pos.x + pc.size.x) continue;
				if (by2 <= pc.pos.y || by1 >= pc.pos.y + pc.size.y) continue;
				return ent;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	/** 1.71.8: true on the map-instance host. Used to decide whether a box whose
	 * remote grip just ended should return to local gravity (host) or stay a
	 * network follower (everyone else, who still follows the host's fall). */
	private isInstanceHost(): boolean {
		try {
			const m = this.getMain();
			return !!(m && m.host);
		} catch (_) { return false; }
	}

	/** True when someone ELSE currently owns this box (with heartbeat expiry). */
	public isRemoteOwned(e: any): boolean {
		const mi = e && e.mapId;
		if (!mi) return false;
		const rec = this.remoteOwners.get(mi);
		if (!rec) return false;
		if (Date.now() - rec.at > PUZZLE_OWN_TTL) {
			this.remoteOwners.delete(mi);
			this.restoreRemoteState(e);
			return false;
		}
		return rec.name !== this.myName();
	}

	private applyOwnership(e: any, s: IPuzzleEntry): void {
		const mi = e.mapId || 0;
		const my = this.myName();
		const localGrip = this.isLocalGripping(e);
		const localAt = (e as any)._mpPuzzleGripAt;
		if (typeof s.own === 'string' && s.own.length > 0) {
			if (s.own === my) {
				// An echo of our own claim (server normally excludes the sender).
				this.remoteOwners.delete(mi);
				return;
			}
			const claim = typeof s.ot === 'number' && isFinite(s.ot) ? s.ot : Date.now();
			// Same-time grab arbitration: the client whose grip started FIRST wins.
			// If we are the later gripper, drop our grip and follow the winner.
			const weWin = localGrip && typeof localAt === 'number' && localAt < claim;
			if (weWin) {
				// Keep our grip; the other client will see OUR claim next packet and
				// release. Do NOT record them as a remote owner — tick() would then
				// stop shipping our own authoritative claim and the box would freeze.
				return;
			}
			this.remoteOwners.set(mi, { name: s.own, claim, at: Date.now() });
			if (localGrip) this.cancelLocalGrip(e);
			if (!e._mpPuzzleRemote) {
				e._mpPuzzleRemote = true;
				e._mpPuzzleWasActive = !!(e.pushPullable && e.pushPullable.active);
				try { if (e.pushPullable && typeof e.pushPullable.setActive === 'function') e.pushPullable.setActive(false); } catch (_) { /* ignore */ }
			}
		} else if (s.own === '') {
			if (this.remoteOwners.delete(mi)) this.restoreRemoteState(e);
		}
	}

	private cancelLocalGrip(e: any): void {
		try {
			if (e && e.pushPullable && typeof e.pushPullable.cancelGrip === 'function') e.pushPullable.cancelGrip();
		} catch (_) { /* ignore */ }
		try { delete (e as any)._mpPuzzleGripAt; } catch (_) { /* ignore */ }
	}

	private dropInterp(e: any): void {
		try {
			if (e && typeof e.mapId === 'number' && e.mapId) this.interp.delete(e.mapId);
		} catch (_) { /* ignore */ }
	}

	/** 1.71.6: the local player is about to grab a follower box. Hand z-physics
	 * back to the engine (gravity 1 = grounded native value; deferredUpdate will
	 * keep it there) and, if the frozen network z is above the stale baseZPos,
	 * trust the visible position as the new ground so the grip aligns on top
	 * instead of in the pit. */
	private prepareLocalGrip(e: any): void {
		try {
			if (!e) return;
			(e as any)._mpPuzzleFollow = false;
			if (e.mapId) this.followers.delete(e.mapId);
			const c = e.coll;
			if (!c) return;
			if (typeof c.zGravityFactor === 'number') c.zGravityFactor = 1;
			try { if (c.vel) c.vel.z = 0; } catch (_) { /* ignore */ }
			const z = c.pos.z;
			const b = c.baseZPos;
			if (typeof z === 'number' && typeof b === 'number' && z > b + 1) {
				c.baseZPos = z;
				try {
					const g: any = ig.game;
					if (g && typeof g.getLevelIdx === 'function') {
						const lvl = g.getLevelIdx(Math.round(z));
						if (typeof lvl === 'number') c.level = lvl;
					}
				} catch (_) { /* ignore */ }
			}
			// 1.72.x: re-link a broken/missing groundEntry to the platform the
			// block is actually standing on (risen-pillar case — see
			// findSupportingPlatform). Without it the vanilla resting-terrain
			// check reads the HOLE the platform covers and "respawns" the block
			// into the pit on grip.
			try {
				const ge = c._collData && c._collData.groundEntry;
				const geEnt = ge && ge.entity;
				if (!geEnt || geEnt._killed) {
					const plat = this.findSupportingPlatform(e);
					if (plat && plat.coll && typeof c.setGroundEntry === 'function') {
						c.setGroundEntry(plat.coll);
						const top = plat.coll.pos.z + (plat.coll.size.z || 0);
						if (typeof c.baseZPos === 'number' && top > c.baseZPos) c.baseZPos = top;
						if (typeof plat.coll.level === 'number') c.level = plat.coll.level;
					}
				}
			} catch (_) { /* ignore */ }
		} catch (_) { /* ignore */ }
	}

	/** 1.71.5 safety net: a network-written box z can lag below its own baseZPos
	 * (e.g. the Temple Chamber 1 box echoed from the pit while the platform under
	 * it had already risen). Vanilla PushPullable aligns the PLAYER to the box's
	 * raw coll.pos.z on grip, so a stale pit z teleports the player underground.
	 * Before any local grip, snap a sunken box back up to its real ground. */
	private reconcileBoxGround(e: any): void {
		try {
			const c = e && e.coll;
			if (!c) return;
			const z = c.pos.z;
			const b = typeof c.baseZPos === 'number' ? c.baseZPos : z;
			if (typeof z === 'number' && typeof b === 'number' && z < b - 8) {
				c.setPos(c.pos.x, c.pos.y, b);
			}
		} catch (_) { /* ignore */ }
	}

	private restoreRemoteState(e: any): void {
		if (!e || e._killed) return;
		if (!e._mpPuzzleRemote) return;
		e._mpPuzzleRemote = false;
		try {
			if (e.pushPullable && typeof e.pushPullable.setActive === 'function' && e._mpPuzzleWasActive && !e._hidden) {
				e.pushPullable.setActive(true);
			}
		} catch (_) { /* ignore */ }
		// 1.71.8: this client is the box authority again (the remote grip ended).
		// Stop the network z-freeze and hand the box back to engine gravity. The
		// release packet's position is applied right after this call; applyEntry
		// deliberately does NOT re-freeze the box on the instance host, so it can
		// fall off the ledge instead of hovering at the old ledge height forever.
		this.restoreBoxGravity(e);
	}

	/** 1.71.8: undo the follower z-freeze (`zGravityFactor=0`) and let the coll
	 * recompute its real ground. `zBaseUncertain` is the same flag the vanilla
	 * magnet path uses after a forced move — it makes the next coll update re-trace
	 * the ground instead of trusting a stale baseZPos from the frozen ledge. */
	private restoreBoxGravity(e: any): void {
		try {
			if (!e) return;
			(e as any)._mpPuzzleFollow = false;
			if (typeof e.mapId === 'number' && e.mapId) {
				this.followers.delete(e.mapId);
				this.interp.delete(e.mapId);
			}
			const c = e.coll;
			if (!c) return;
			if (typeof c.zGravityFactor === 'number') c.zGravityFactor = 1;
			try { if (c.vel) c.vel.z = 0; } catch (_) { /* ignore */ }
			// Only the new box authority (the instance host) should force a ground
			// re-trace. A non-host re-freezes in applyEntry right after this, and a
			// one-frame local gravity pass could fight the host's fall snapshots.
			if (this.isInstanceHost()) {
				try { if (c._collData) c._collData.zBaseUncertain = true; } catch (_) { /* ignore */ }
			}
		} catch (_) { /* ignore */ }
	}

	private expireRemoteOwners(entities: any[]): void {
		if (!this.remoteOwners.size) return;
		const now = Date.now();
		const byId = new Map<number, any>();
		for (const rec of this.remoteOwners) {
			if (now - rec[1].at <= PUZZLE_OWN_TTL) continue;
			this.remoteOwners.delete(rec[0]);
			if (!byId.size) {
				for (const e of entities) {
					if (e && typeof e.mapId === 'number' && e.mapId) byId.set(e.mapId, e);
				}
			}
			this.restoreRemoteState(byId.get(rec[0]));
		}
	}

	private encode(e: any): IPuzzleEntry {
		const s: IPuzzleEntry = { mi: e.mapId || 0 };
		if (e.coll && e.coll.pos) {
			s.p = [Math.round(e.coll.pos.x), Math.round(e.coll.pos.y), Math.round(e.coll.pos.z)];
		}
		if (typeof e.isOn === 'boolean' || typeof e.isOn === 'number') s.on = e.isOn ? 1 : 0;
		if (typeof e.currentHits === 'number') s.hits = e.currentHits;
		if (typeof e.remainingHits === 'number') s.hits = e.remainingHits;
		if (typeof e.state === 'number') s.st = e.state;
		if (typeof e.blockState === 'number') s.st = e.blockState;
		// ROUND 131 (Temple Chamber 2): do NOT sync the raw animation for
		// state-driven entities whose anims are CHAINED TRANSITIONS — the toggle
		// Switch (off->switchOn->on) and the bounce-puzzle core/blocks (rolling->
		// rollingEnd->flyDown->impact->on). Force-feeding a mid-transition frame
		// every snapshot re-triggers the chain from frame 0 and deadlocks it (the
		// "stuck in the switching animation" / "core stuck about to retract"
		// reports). These entities sync STATE only; each client renders its own
		// animation natively (varsChanged for the Switch, resolveGroup for the
		// bounce group). Position/one-time/WaterBlock anims are unaffected.
		const E: any = (ig.ENTITY as any);
		const chainedAnim = !!(E && ((E.Switch && e instanceof E.Switch)
			|| (E.BounceSwitch && e instanceof E.BounceSwitch)
			|| (E.BounceBlock && e instanceof E.BounceBlock)));
		if (!chainedAnim && typeof e.currentAnim === 'string' && e.currentAnim) s.anim = e.currentAnim;
		// ROUND 131: the bounce core's authoritative state is the GROUP-RESOLVED
		// var, not isOn (isOn flips at the FIRST ball hit, long before retract).
		if (E && E.BounceSwitch && e instanceof E.BounceSwitch) {
			try { s.on = (sc as any).bounceSwitchGroups.isGroupResolved(e.group) ? 1 : 0; } catch (_) { /* ignore */ }
		}
		if (typeof e.phased === 'boolean') s.ph = e.phased ? 1 : 0;
		if (e.pushPullable && typeof e.pushPullable.active === 'boolean') s.act = e.pushPullable.active ? 1 : 0;
		if (typeof e.moving === 'boolean') s.mv = e.moving ? 1 : 0;
		if (e._hidden) s.hd = 1;
		return s;
	}

	private applyEntry(e: any, s: IPuzzleEntry, push: boolean): void {
		// Box authority: the gripping client never accepts box echoes (server
		// already excludes the sender, but a different client's 1Hz host snapshot
		// or a stale non-owner packet can still arrive), and follower copies only
		// accept the CURRENT owner's packets.
		const localOwner = push && this.isLocalGripping(e);
		const ownerRec = push ? this.remoteOwners.get(e.mapId || 0) : undefined;
		const ownerSpeaks = typeof s.own === 'string' && ownerRec && (s.own === ownerRec.name || s.own === '');
		const staleBoxState = push && !localOwner && ownerRec && !ownerSpeaks;
		const skipBoxPos = push && (localOwner || staleBoxState);
		// While a remote player owns this box its interact entry must stay OFF
		// locally; the owner's own `act` field says "still grabbable on THEIR
		// client", which must not re-enable grabbing here.
		const followerLocked = push && !localOwner && !!ownerRec;
		// 1.71.8: a box stays a network-follower while somebody else owns it, OR
		// while this client is a non-host listening to host snapshots. The host
		// itself must NOT be re-frozen by the ex-owner's release packet — it just
		// became the box authority and needs real gravity to let the box fall
		// down from a ledge (restoreRemoteState already restored the physics).
		const boxShouldFollow = push && !localOwner && (!!ownerRec || !this.isInstanceHost());

		if (s.p && e.coll && !skipBoxPos) {
			this.setInterpTarget(e, s.p[0], s.p[1], s.p[2]);
			// 1.73.x (auto-circling platforms): freeze the member's local platform
			// motion so the host's position stream stays authoritative (entry
			// alignment comes from the first full block; 1Hz fulls + 10Hz changes
			// keep it pinned afterwards).
			if (!this.isInstanceHost() && this.isMovingPlatform(e)) this.freezeMovingPlatform(e);
			// 1.71.6: this box is a network follower — freeze its local z-physics
			// until the LOCAL player grabs it (prepareLocalGrip restores gravity).
			if (boxShouldFollow) {
				try { (e as any)._mpPuzzleFollow = true; } catch (_) { /* ignore */ }
				this.followers.set(e.mapId || 0, e);
			}
		}
		// ROUND 131 (Temple Chamber 2): state-driven entities with chained
		// transition animations — apply STATE and let THIS client render its own
		// animation natively, instead of force-feeding a transition frame (which
		// deadlocks the chain). Each branch returns early so the generic anim/isOn
		// force-feed below never runs for these types.
		const ED: any = (ig.ENTITY as any);
		if (ED && ED.Switch && e instanceof ED.Switch) {
			// Toggle lever: purely var-driven. Setting the var fires the entity's own
			// varsChanged, which plays switchOn/switchOff -> on/off. (Melee and ball
			// both go through ballHit -> vars.set, so this single path fixes the melee
			// desync where the linked slider never moved.)
			try {
				if (typeof s.on === 'number' && typeof e.variable === 'string' && e.variable) {
					(ig as any).vars.set(e.variable, s.on === 1);
				}
				if (typeof s.hits === 'number' && typeof e.currentHits === 'number') e.currentHits = s.hits;
			} catch (_) { /* ignore */ }
			return;
		}
		if (ED && ED.BounceSwitch && e instanceof ED.BounceSwitch) {
			// Bounce-puzzle core: resolve/reset the whole GROUP natively — resolveGroup
			// retracts every block AND the core (sets the var, rolls each block's
			// retract timer, runs the core's rolling->flyDown->impact->on chain).
			try {
				if (typeof s.on === 'number' && e.group) {
					const grp: any = (sc as any).bounceSwitchGroups;
					const resolved = grp && grp.isGroupResolved(e.group);
					if (s.on === 1 && !resolved && typeof grp.resolveGroup === 'function') grp.resolveGroup(e.group);
					else if (s.on === 0 && resolved && typeof grp.resetGroup === 'function') grp.resetGroup(e.group);
				}
			} catch (_) { /* ignore */ }
			return;
		}
		if (ED && ED.BounceBlock && e instanceof ED.BounceBlock) {
			// Individual bounce block: mirror the LIT state only (blockState 0/1). The
			// final retract (blockState 2) is driven by the group's resolveGroup above;
			// never overwrite an already-resolved block from a stale echo.
			try {
				if (typeof s.st === 'number' && (s.st === 0 || s.st === 1) && e.blockState !== 2 && e.blockState !== s.st) {
					e.blockState = s.st;
					if (typeof e.setCurrentAnim === 'function') e.setCurrentAnim(s.st ? 'on' : 'off');
				}
			} catch (_) { /* ignore */ }
			return;
		}
		// WaterBlock: state transitions have real effects (freeze/break).
		const WB: any = (ig.ENTITY as any).WaterBlock;
		if (WB && e instanceof WB && typeof s.st === 'number') {
			try {
				if (s.st === 2 && e.state !== 2 && typeof e.turnIce === 'function') e.turnIce();
				else if (s.st !== 2 && e.state === 2 && typeof e.iceBreak === 'function') e.iceBreak();
				else e.state = s.st;
				if (typeof s.hits === 'number') e.remainingHits = s.hits;
			} catch (_) { /* ignore */ }
		} else if (!staleBoxState) {
			if (typeof s.st === 'number') {
				try {
					if (typeof e.blockState === 'number') e.blockState = s.st;
					else if (typeof e.state === 'number' && typeof e.turnIce !== 'function') e.state = s.st;
				} catch (_) { /* ignore */ }
			}
		}
		if (typeof s.on === 'number' && (typeof e.isOn === 'boolean' || typeof e.isOn === 'number')) {
			try {
				const want = s.on === 1;
				// 1.71.5: permanent OneTimeSwitch (the Temple Chamber 1 attack
				// switch) is monotonic across clients. One player entering with
				// `map.extraPullable` already true and another with it false used to
				// ping-pong on/off and settle untriggered — while the synced switch
				// kept its activated zero-height coll, so the player could no longer
				// physically hit it. Once ANY peer reports it on, keep it on.
				const OT: any = (ig.ENTITY as any).OneTimeSwitch;
				if (OT && e instanceof OT) {
					const permanent = !e.activeTime;
					if (permanent && !want) return; // stale off must never revert a solved switch
					const changed = e.isOn !== want;
					if (changed) e.isOn = want;
					try {
						// Always repair the height: the pre-1.71.5 sync could leave a
						// triggered switch at activated height while isOn was flipped
						// back off by a peer, making it physically unattackable.
						if (want) e.coll.size.z = (e.data && typeof e.data.activeZHeight === 'number') ? e.data.activeZHeight : 0;
						else if (typeof e.fullZHeight === 'number') e.coll.size.z = e.fullZHeight;
					} catch (_) { /* ignore */ }
					if (changed && typeof e.variable === 'string' && e.variable) {
						try { (ig as any).vars.set(e.variable, want); } catch (_) { /* ignore */ }
					}
					if (changed && !s.anim && typeof e.setCurrentAnim === 'function') {
						try { e.setCurrentAnim(want ? 'on' : (typeof e.getOffAnim === 'function' ? e.getOffAnim() : 'off'), true, null, true); } catch (_) { /* ignore */ }
					}
				} else {
					if (e.isOn !== want) e.isOn = want;
					// Keep the entity's backing var coherent too (linked platforms /
					// blockers on this client re-evaluate via varsChanged).
					if (typeof e.variable === 'string' && e.variable) {
						try { (ig as any).vars.set(e.variable, want); } catch (_) { /* ignore */ }
						// 1.73.x diag: prove a switch var actually landed on this client
						// (once per var per map) — the EventTrigger should fire off it.
						try {
							const k = 'var:' + e.variable + ':' + (e.mapId || 0) + ':' + ((ig.game as any).mapName || '');
							if (!this._varLogSeen.has(k)) {
								this._varLogSeen.add(k);
								console.log('[puzzlesync] applied ' + e.variable + '=' + want + ' (mi=' + (e.mapId || 0) + ')');
							}
						} catch (_) { /* ignore */ }
					}
					if (!s.anim && typeof e.setCurrentAnim === 'function') {
						try { e.setCurrentAnim(want ? 'on' : 'off', true, null, true); } catch (_) { /* ignore */ }
					}
				}
			} catch (_) { /* ignore */ }
		}
		if (typeof s.hits === 'number' && typeof e.currentHits === 'number') e.currentHits = s.hits;
		if (typeof s.ph === 'number' && typeof e.phased === 'boolean') {
			const want = s.ph === 1;
			if (e.phased !== want) {
				try {
					e.phased = want;
					if (typeof e.setCurrentAnim === 'function') e.setCurrentAnim(want ? 'phasing' : 'default', true, null, true);
				} catch (_) { /* ignore */ }
			}
		}
		if (!staleBoxState) {
			if (typeof s.act === 'number' && e.pushPullable && typeof e.pushPullable.setActive === 'function' && !followerLocked) {
				try { e.pushPullable.setActive(s.act === 1); } catch (_) { /* ignore */ }
			}
			if (typeof s.mv === 'number' && typeof e.moving === 'boolean') {
				if (this.isSlidingBlock(e) && !this.isInstanceHost()) {
					e.moving = false; // host's position stream drives the pillar (never slide natively)
					// Mirror the white "slide" trail: the host streams mv=1 while sliding,
					// mv=0 once it stops. Drive the local effect off that flag so members
					// see the trail too (the native slide effect only plays on the host).
					const wantSlide = s.mv === 1;
					if (wantSlide && !e._mpSlidingFx) {
						e._mpSlidingFx = true;
						try { if (e.effects && e.effects.sheet && typeof e.effects.sheet.spawnOnTarget === 'function') e.effects.handle = e.effects.sheet.spawnOnTarget('slide', e, { duration: -1 }); } catch (_) { /* ignore */ }
					} else if (!wantSlide && e._mpSlidingFx) {
						e._mpSlidingFx = false;
						try { if (e.effects && e.effects.handle && typeof e.effects.handle.stop === 'function') e.effects.handle.stop(); } catch (_) { /* ignore */ }
					}
				} else {
					e.moving = s.mv === 1;
				}
			}
			if (typeof s.anim === 'string' && s.anim && typeof e.setCurrentAnim === 'function') {
				try { e.setCurrentAnim(s.anim, true, null, true); } catch (_) { /* ignore */ }
			}
		}
		if (typeof s.hd === 'number') {
			try {
				if (s.hd === 1 && typeof e.hide === 'function') e.hide();
				else if (s.hd === 0 && typeof e.show === 'function') e.show();
			} catch (_) { /* ignore */ }
		}
	}

	/** Store a network position as a per-frame interpolation target. Big jumps
	 * (teleport/load/reset) snap instantly instead of gliding across the map. */
	private setInterpTarget(e: any, x: number, y: number, z: number): void {
		const mi = e.mapId || 0;
		const c: any = e.coll;
		const dx = x - c.pos.x, dy = y - c.pos.y, dz = z - c.pos.z;
		if (dx * dx + dy * dy > 250 * 250 || Math.abs(dz) > 200) {
			try { c.setPos(x, y, z); } catch (_) { /* ignore */ }
			this.interp.delete(mi);
			return;
		}
		(e as any)._mpPuzzleToX = x;
		(e as any)._mpPuzzleToY = y;
		(e as any)._mpPuzzleToZ = z;
		this.interp.set(mi, { e, tx: x, ty: y, tz: z });
	}

	/** Per-frame glide toward the latest network position (runs every frame via
	 * simplify.registerUpdate, unlike the 10Hz scan). */
	private interpolate(): void {
		if (!this.interp.size && !this.followers.size) return;
		const g: any = ig.game;
		if (!g || !g.playerEntity || g.isTeleporting()) return;
		const t = Math.min(1, (ig.system.tick || 0) * PUZZLE_LERP_RATE);
		for (const [mi, rec] of this.interp) {
			const e = rec.e;
			if (!e || e._killed || !e.coll) { this.interp.delete(mi); continue; }
			// The local gripping player's box is engine-driven; never fight it.
			if (this.isPushPull(e) && this.isLocalGripping(e)) continue;
			const c: any = e.coll;
			const dx = rec.tx - c.pos.x;
			const dy = rec.ty - c.pos.y;
			const dz = rec.tz - c.pos.z;
			if (dx === 0 && dy === 0 && dz === 0) { this.interp.delete(mi); continue; }
			if (dx * dx + dy * dy > 250 * 250 || Math.abs(dz) > 200) {
				try { c.setPos(rec.tx, rec.ty, rec.tz); } catch (_) { /* ignore */ }
				this.interp.delete(mi);
				continue;
			}
			try { c.setPos(c.pos.x + dx * t, c.pos.y + dy * t, c.pos.z + dz * t); } catch (_) { /* ignore */ }
			if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1 && Math.abs(dz) < 0.1) this.interp.delete(mi);
		}
		// 1.71.6: follower boxes are network puppets for the vertical axis. Freeze
		// z every frame (the engine's deferredUpdate can re-enable gravity when
		// z==baseZPos, so re-assert here) until the LOCAL player grabs the box —
		// prepareLocalGrip removes it from this map and restores gravity.
		for (const [mi, e] of this.followers) {
			if (!e || e._killed || !e.coll) { this.followers.delete(mi); continue; }
			if (this.isPushPull(e) && this.isLocalGripping(e)) { this.followers.delete(mi); continue; }
			try {
				const c: any = e.coll;
				if (typeof c.zGravityFactor === 'number') c.zGravityFactor = 0;
				if (c.vel) c.vel.z = 0;
			} catch (_) { /* ignore */ }
		}
	}

	private installPushPullHooks(): void {
		if (pushHooksInstalled) return;
		pushHooksInstalled = true;
		try {
			const P: any = (sc as any).PushPullable;
			if (!P || !P.prototype) return;
			const self = this;
			const origBlocked = P.prototype.isInteractionBlocked;
			P.prototype.isInteractionBlocked = function (this: any) {
				try {
					if (self.isRemoteOwned(this.entity)) return true;
				} catch (_) { /* fall through to vanilla */ }
				return origBlocked.apply(this, arguments as any);
			};
			// 1.72.x (risen-pillar fall veto): PushPullable.onUpdate respawns a
			// RESTING block (pos.z == baseZPos) standing on fall terrain via
			// resetPos() — no args. With the groundEntry link broken by network
			// sync, that check reads the HOLE under a risen platform and teleports
			// the block into the pit on grip/push ("柱子坠入地板"). Veto the
			// respawn while a platform genuinely supports the block. Pushing the
			// block OFF the platform (or any real hole) still respawns natively —
			// no platform overlaps then — and no gravity behaviour changes, so the
			// 1.71.8 ledge-fall fix ("箱子无重力无法从高处推下") is untouched.
			const origResetPos = P.prototype.resetPos;
			P.prototype.resetPos = function (this: any, a: any, b: any) {
				try {
					if (a === undefined && b === undefined
						&& self.isPushPull(this.entity)
						&& self.findSupportingPlatform(this.entity)) {
						return; // platform-supported: the fall-terrain read is a sync artifact
					}
				} catch (_) { /* fall through to vanilla */ }
				return origResetPos.apply(this, arguments as any);
			};
			const origInteraction = P.prototype.onInteraction;
			P.prototype.onInteraction = function (this: any) {
				try {
					if (self.isRemoteOwned(this.entity)) return;
					self.dropInterp(this.entity);
					self.prepareLocalGrip(this.entity);
					self.reconcileBoxGround(this.entity);
					if (this.entity && typeof this.entity._mpPuzzleGripAt !== 'number') {
						this.entity._mpPuzzleGripAt = Date.now();
					}
				} catch (_) { /* ignore */ }
				return origInteraction.apply(this, arguments as any);
			};
			// ROUND 130: when the LOCAL box locks into a PushPullDest plate, relay the
			// placement so every peer sinks the box into stairs too (not just the
			// pusher). onPushPullablePlaced is the single funnel the engine uses when a
			// gripped box reaches its plate (dragState 4 -> getGroundEntity ->
			// onPushPullablePlaced). Guard with self.applying so a network-applied
			// placement never echoes back out.
			const D: any = (ig.ENTITY as any).PushPullDest;
			if (D && D.prototype && !D.prototype._mpPlacedWrapped) {
				D.prototype._mpPlacedWrapped = true;
				const origPlaced = D.prototype.onPushPullablePlaced;
				D.prototype.onPushPullablePlaced = function (this: any, box: any) {
					try {
						if (!self.applying) self.broadcastPlacement(box, this);
					} catch (_) { /* ignore */ }
					return origPlaced.apply(this, arguments as any);
				};
			}
			// Ball-pushed ice pillars (SlidingBlock) are host-authoritative: on a non-host
			// member, never slide locally. Replay the native push check (blocked red flash
			// or forward the push to the host via slidingPush), absorb the ball + show the
			// hit FX — the host slides and streams the authoritative position back.
			const SB: any = (ig.ENTITY as any).SlidingBlock;
			if (SB && SB.prototype && typeof SB.prototype.ballHit === 'function' && !SB.prototype._mpSlidingWrapped) {
				SB.prototype._mpSlidingWrapped = true;
				const origSBHit = SB.prototype.ballHit;
				SB.prototype.ballHit = function (this: any, d: any) {
					try {
						if (!self.isInstanceHost()) {
							// Host-authoritative: never slide locally. Recompute the push
							// direction, flash the red "blocked" effect if a wall/fence is in
							// the way, and otherwise forward the push to the host (its copy
							// slides and streams the authoritative position back).
							const c = d && typeof d.getHitCenter === 'function' ? d.getHitCenter(this) : null;
							try {
								const dir = Vec2.create();
								(ig as any).ActorEntity.getFaceVec(d.getCollideSide(this), dir);
								Vec2.flip(dir);
								const trace: any = (ig as any).game.physics.initTraceResult(Vec3.create());
								if ((ig as any).game.traceEntity(trace, this, dir.x, dir.y, 0, 0, 0, (ig as any).COLLTYPE.IGNORE)) {
									if (this.effects && this.effects.sheet && typeof this.effects.sheet.spawnOnTarget === 'function') this.effects.sheet.spawnOnTarget('blocked', this);
								} else {
									self.broadcastSlidingPush(this.mapId, dir.x, dir.y);
								}
							} catch (_) { /* ignore */ }
							if (c) {
								try { (sc as any).combat.showHitEffect(this, c, (sc as any).ATTACK_TYPE.NONE, typeof d.getElement === 'function' ? d.getElement() : 0, true, false, true); } catch (_) { /* ignore */ }
							}
							return true;
						}
					} catch (_) { /* fall through to vanilla */ }
					return origSBHit.apply(this, arguments as any);
				};
			}
			console.log('[puzzlesync] push/pull ownership hooks installed');
		} catch (_) { /* ignore */ }
	}

	/** ROUND 130: broadcast a box->plate placement. Sent as a one-shot entry
	 * { mi: boxMapId, pl: 1, dl: destMapId } — the server whitelist has carried
	 * pl/dl since 1.71.2. Mark the box placed locally right away so this client
	 * immediately stops shipping its position (refreshPlacedBoxIds would take a
	 * scan to notice). */
	private broadcastPlacement(box: any, dest: any): void {
		try {
			const m = this.getMain();
			if (!m || !m.connection || !m.connection.isOpen()) return;
			if (!this.inDungeon()) return;
			const g: any = ig.game;
			const map = (g && g.mapName) || '';
			const boxId = box && box.mapId;
			const destId = dest && dest.mapId;
			if (!boxId || !destId) return;
			if (boxId) this.placedBoxIds.add(boxId);
			try { m.connection.puzzleState(map, [{ mi: boxId, pl: 1, dl: destId }]); } catch (_) { /* ignore */ }
		} catch (_) { /* ignore */ }
	}

	/** ROUND 130: reproduce a peer's box->plate placement locally. Guards against
	 * re-triggering an already-solved plate (the 1.71.3 personal-save concern):
	 * a client that already placed this box keeps its own state and ignores the
	 * echo, so solved and unsolved saves never fight. For a same-progress peer
	 * this runs the EXACT native lock-in path (onPushPullablePlaced), so the box
	 * snaps onto the plate and sinks into stairs identically to the pusher's
	 * client. */
	private applyPlacement(box: any, dest: any): void {
		try {
			if (!box || !dest) return;
			// Already solved here -> never re-trigger.
			if (dest.placed) return;
			const mi = box.mapId || 0;
			if (mi && this.placedBoxIds.has(mi)) return;
			// Detach the box from any network-follow / ownership state so the frozen
			// follower z-physics can't fight the sink, then hand it back to gravity.
			if (mi) {
				this.remoteOwners.delete(mi);
				this.interp.delete(mi);
				this.followers.delete(mi);
				this.ownedLast.delete(mi);
			}
			try { (box as any)._mpPuzzleRemote = false; (box as any)._mpPuzzleFollow = false; } catch (_) { /* ignore */ }
			this.restoreBoxGravity(box);
			// Mark placed BEFORE triggering so no further position echo is accepted
			// for this box (apply/tick both skip placedBoxIds).
			if (mi) this.placedBoxIds.add(mi);
			// Reproduce the native lock-in: sets the personal save var, plays the
			// boxLockIn effect + plate sink (placeTimer), and deferredUpdate ->
			// initPushPullable snaps the box onto the plate + disables pushing.
			// self.applying is true here, so the wrapped sender does NOT echo.
			if (typeof dest.onPushPullablePlaced === 'function') dest.onPushPullablePlaced(box);
		} catch (_) { /* ignore */ }
	}

	private signature(s: IPuzzleEntry): string {
		return JSON.stringify(s);
	}
}
