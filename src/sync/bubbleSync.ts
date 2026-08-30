import { Multiplayer } from '../multiplayer';

/**
 * 1.77.x — host-authoritative water-bubble sync (Faj'ro Temple / bubble caves).
 *
 * Vanilla spawns sc.WaterBubbleEntity independently on EVERY client from each
 * client's own ig.ENTITY.WaterBubblePanel copy, so bubbles (and the ice disks /
 * cooled coals they turn into) used to drift apart: positions, the pre-burst
 * blink, the steam/burst effects and the lava-solidification were all local.
 *
 * This module makes the MAP-INSTANCE HOST the single authority:
 *   - HOST: panels/bubbles/disks/coals run natively. Every effect-producing
 *     transition (bounce, last-second blink, steam, circular steam, burst,
 *     turn-to-ice, instant kill, ice slide, melt, break, coal solidification,
 *     consume) is relayed as one compact event, and positions stream at 30Hz
 *     while anything flies (10Hz changes + 1Hz full snapshot otherwise).
 *   - MEMBER: the local panel still spawns its bubble natively (it stays the
 *     ballHit target for the local player's balls and keeps the panel anims),
 *     but the entity is a PUPPET: its burst/blink/melt timers are frozen and
 *     enemy/barrier-triggered transitions are suppressed — only the host's
 *     relayed events drive them. A LOCAL ball hit predicts natively (instant
 *     feedback) AND forwards its ingredients to the host, which re-judges
 *     against its authoritative bubble and broadcasts the outcome; the
 *     shooter's duplicate relay is deduped (500ms window).
 *   - Steam damage forces are host-only (member replays are FX-only); enemy
 *     damage from a sliding ice disk likewise happens on the host only.
 *
 * Panels are keyed by mapId (unique per map). Enemy-SHOT homing bubbles
 * (SHOOT_BUBBLE action step — jellyfish/megamoth/brew-machine/...) get a shot
 * id "<shooterUid>.<seq>" assigned on the host once their combatant link is
 * visible; the whole bubble -> ice disk -> cooled coals chain rides the same
 * stream/events under that id. (The SPAWN_BUBBLE event step is unused by
 * heat-dng maps and stays local.) Offline / old-host sessions are untouched:
 * puppet mode only arms after the instance host proves it speaks the bubble
 * protocol (first bubbleState/bubbleEvent received), and disarms on host
 * loss / disconnect, restoring native timers.
 */

const BUBBLE_SCAN_INTERVAL = 0.1;    // seconds — change scan
const BUBBLE_FULL_INTERVAL = 1000;   // ms — host full snapshot
const BUBBLE_FAST_INTERVAL = 1 / 30; // seconds — flying bubble / sliding disk
const BUBBLE_LERP_RATE = 16;         // ~16% of the remaining distance per frame
const PREDICT_DEDUP_MS = 500;        // shooter's own relayed event is skipped
const PREDICT_RESET_MS = 800;        // unconfirmed prediction self-heal window
const FROZEN_TIMER = 99999;          // puppet timer freeze marker
const SNAP_DIST = 150;               // px — bigger jumps snap instead of gliding

/** Relayed transition kinds (bubbleEvent.k). */
const K = {
	BOUNCE: 1,        // bubble bounced by a ball (vx,vy = resulting velocity)
	LAST_SECOND: 2,   // bubble entered the blinking about-to-burst phase
	STEAM: 3,         // bubble steamed (vx,vy = steam direction)
	CIRCULAR_STEAM: 4,// bubble circular steam burst
	BURST: 5,         // bubble evaporated (timer ran out / panel hid)
	TURN_ICE: 6,      // bubble turned into an ice disk
	INSTANT_KILL: 7,  // bubble removed quietly (heat hit right after spawn)
	ICE_SLIDE: 8,     // ice disk started sliding (vx,vy = slide velocity)
	ICE_MELT: 9,      // ice disk started melting
	ICE_BREAK: 10,    // ice disk shattered (wall hits / slide timer)
	COALS: 11,        // ice disk solidified lava into cooled coals
	COALS_MELT: 12,   // cooled coals started melting away
	HIT_FX: 13,       // ball-impact flash on the bubble/disk (el, at, x, y, z)
	ICE_CONSUME: 14,  // ice disk absorbed by a regen-destructible barrier
} as const;

interface IBubbleEntry {
	mi?: number;             // panel-bound entities: the panel's mapId
	sid?: string;            // enemy-SHOT bubbles (SHOOT_BUBBLE): "<shooterUid>.<seq>"
	ph: number;              // 0 none | 1 bubble | 2 ice disk | 3 cooled coals
	st?: number;
	p?: [number, number, number];
	v?: [number, number, number];
}

interface IBubbleStatePacket {
	map: string;
	entries: IBubbleEntry[];
}

export interface IBubbleSync {
	install(): void;
	tick(): void;
	applyState(data: IBubbleStatePacket): void;
	applyEvent(data: any): void;
	applyHit(data: any): void;
	/** Diagnostic: list panels + puppet state near the player. */
	dump(): void;
}

let updateRegistered = false;
let hooksInstalled = false;
let shared: BubbleSync | null = null;
/** >0 while a receiver replays a relayed transition — never suppress or
 *  rebroadcast inside a replay. */
let netDepth = 0;
/** >0 while a member runs its local hit prediction (the native ballHit path on
 *  its puppet) — suppression wraps pass through, broadcasts stay off (member). */
let predictDepth = 0;

export function installBubbleSync(getMain: () => Multiplayer | undefined): IBubbleSync {
	if (!shared) shared = new BubbleSync(getMain);
	return shared;
}

class BubbleSync implements IBubbleSync {
	private scanTimer = 0;
	private fastTimer = 0;
	private lastFullAt = 0;
	private lastMap = '';
	private seen = new Set<number>();
	private lastSig = new Map<string, string>();
	private interp = new Map<string, { e: any, tx: number, ty: number, tz: number }>();
	private lastPredict = new Map<string, { k: number, at: number }>();
	/** Enemy-shot bubble chain (bubble -> ice disk -> coals), keyed by
	 *  "<shooterUid>.<seq>". ONE map for both roles: the host fills it via
	 *  sweepPendingShots (and event propagation), members via the reconcile /
	 *  spawn helpers — on host promotion the member's puppets are simply
	 *  adopted as the new authority's stream sources. */
	private shots = new Map<string, any>();
	private shotSeq = 1;
	/** True once the current instance host has proven it speaks the bubble
	 *  protocol (any bubble packet received). Only then do members enter puppet
	 *  mode — old hosts leave every client's bubbles fully native. */
	private hostCapable = false;
	private lastHostFlag = false;
	/** Guard while applying a state snapshot (mirrors puzzleSync.applying). */
	private applyingState = false;

	constructor(private getMain: () => Multiplayer | undefined) {
		(window as any).__mpBubbles = () => this.dump();
	}

	public install(): void {
		const m = this.getMain();
		if (!m || !m.connection) return;
		try { if (typeof (m.connection as any).onBubbleState === 'function') (m.connection as any).onBubbleState((data: any) => this.applyState(data)); } catch (_) { /* ignore */ }
		try { if (typeof (m.connection as any).onBubbleEvent === 'function') (m.connection as any).onBubbleEvent((data: any) => this.applyEvent(data)); } catch (_) { /* ignore */ }
		try { if (typeof (m.connection as any).onBubbleHit === 'function') (m.connection as any).onBubbleHit((data: any) => this.applyHit(data)); } catch (_) { /* ignore */ }
		if (!updateRegistered) {
			updateRegistered = true;
			simplify.registerUpdate(() => {
				if (!shared) return;
				try { shared.tick(); } catch (_) { /* never break the frame */ }
				try { shared.interpolate(); } catch (_) { /* never break the frame */ }
			});
			console.log('[bubblesync] installed');
		}
		this.installHooks();
	}

	// ------------------------------------------------------------- send (host)

	public tick(): void {
		const m = this.getMain();
		if (!m || !m.connection || !m.connection.isOpen()) {
			if (this.hostCapable) { this.hostCapable = false; this.unfreezeAll(); }
			return;
		}
		const g: any = ig.game;
		if (!g || !g.playerEntity || g.isTeleporting()) return;
		// Host-flag migration watch (the connection's onSetHost is single-callback,
		// so poll the flag here instead). Losing authority drops puppet mode and
		// hands timers back to the engine until a NEW host proves capable.
		const hf = !!m.host;
		if (hf !== this.lastHostFlag) {
			this.lastHostFlag = hf;
			this.interp.clear();
			this.lastPredict.clear();
			this.lastSig.clear();
			// Demotion: drop protocol trust + hand timers back to the engine.
			// PROMOTION: this client's puppets just became the authority — their
			// frozen timers must thaw too, or the new host's bubbles never burst.
			if (!hf) { this.hostCapable = false; this.unfreezeAll(); }
			else this.unfreezeAll();
		}
		if (!hf) return; // members only apply
		const map = g.mapName || '';
		if (map !== this.lastMap) {
			this.lastMap = map;
			this.seen.clear();
			this.lastSig.clear();
			this.lastFullAt = 0;
			this.interp.clear();
			this.lastPredict.clear();
			this.shots.clear();
		}
		// 30Hz fast stream while anything flies (bounced/blinking bubble, sliding
		// disk) — mirrors the puzzleSync pushable fast path.
		this.fastTimer -= ig.system.tick;
		if (this.fastTimer <= 0) {
			this.fastTimer = BUBBLE_FAST_INTERVAL;
			this.scan(true, false);
		}
		this.scanTimer -= ig.system.tick;
		const full = Date.now() - this.lastFullAt >= BUBBLE_FULL_INTERVAL;
		if (this.scanTimer > 0 && !full) return;
		this.scanTimer = BUBBLE_SCAN_INTERVAL;
		if (full) this.lastFullAt = Date.now();
		this.scan(false, full);
	}

	private scan(fastOnly: boolean, full: boolean): void {
		try {
			const m = this.getMain();
			if (!m || !m.connection || !m.connection.isOpen() || !m.host) return;
			const g: any = ig.game;
			const map = (g && g.mapName) || '';
			if (!map) return;
			const panels = this.panels();
			const entries: IBubbleEntry[] = [];
			const nowSeen = new Set<number>();
			for (const panel of panels) {
				const mi = panel.mapId;
				nowSeen.add(mi);
				const moving = this.panelMoving(panel, mi);
				if (fastOnly && !moving) continue;
				// Moving panels ride the 30Hz fast stream; the 10Hz scan only ships
				// them on a full snapshot (same cadence split as puzzleSync pushables).
				if (!fastOnly && moving && !full) continue;
				const e = this.encodePanel(panel, mi, full || moving);
				if (!e) continue;
				if (fastOnly) { entries.push(e); continue; }
				// Change detection rides the STABLE part only (phase + state) — the
				// position/velocity tail changes every frame while moving and would
				// defeat it; positions of moving panels flow via the fast stream.
				const skey = 'p' + mi;
				const sig = e.ph + ':' + (e.st || 0);
				if (full || this.lastSig.get(skey) !== sig) {
					this.lastSig.set(skey, sig);
					entries.push(e);
				}
			}
			// Enemy-shot bubble chains (jellyfish & co): tag freshly spawned ones,
			// stream the tracked ones, and tell members once one is gone for good.
			this.sweepPendingShots();
			for (const [sid, e] of this.shots) {
				if (!e || e._killed) {
					this.shots.delete(sid);
					if (!fastOnly) entries.push({ sid, ph: 0 });
					continue;
				}
				const moving = this.shotMoving(e);
				if (fastOnly && !moving) continue;
				if (!fastOnly && moving && !full) continue;
				const ent = this.encodeShot(sid, e, full || moving);
				if (!ent) continue;
				if (fastOnly) { entries.push(ent); continue; }
				const skey = 's' + sid;
				const sig = ent.ph + ':' + (ent.st || 0);
				if (full || this.lastSig.get(skey) !== sig) {
					this.lastSig.set(skey, sig);
					entries.push(ent);
				}
			}
			if (!fastOnly) {
				// Panels that vanished entirely (spawnCondition flipped off): tell
				// members to drop any leftover puppet.
				for (const mi of this.seen) {
					if (nowSeen.has(mi)) continue;
					this.lastSig.delete('p' + mi);
					entries.push({ mi, ph: 0 });
				}
				this.seen = nowSeen;
			}
			if (!entries.length) return;
			try { (m.connection as any).bubbleState(map, entries); } catch (_) { /* ignore */ }
		} catch (_) { /* never break the frame */ }
	}

	// ---------------------------------------------------------- receive paths

	public applyState(data: IBubbleStatePacket): void {
		try {
			if (!data || typeof data.map !== 'string' || !Array.isArray(data.entries)) return;
			const m = this.getMain();
			if (!m || m.host) return; // the host never takes its own stream back
			const g: any = ig.game;
			if (!g || !g.playerEntity || (g.mapName || '') !== data.map) return;
			this.markHostCapable();
			this.applyingState = true;
			try {
				for (const s of data.entries) {
					if (!s) continue;
					if (typeof s.mi === 'number' && s.mi) this.reconcileEntry(s);
					else if (typeof s.sid === 'string' && s.sid) this.reconcileShotEntry(s);
				}
			} finally { this.applyingState = false; }
		} catch (_) { /* never break the frame */ }
	}

	public applyEvent(data: any): void {
		try {
			if (!data || typeof data.k !== 'number') return;
			const mi = typeof data.mi === 'number' ? data.mi : 0;
			const sid = typeof data.sid === 'string' ? data.sid : '';
			if (!mi && !sid) return;
			const m = this.getMain();
			if (!m || m.host) return; // host is the source of events
			const g: any = ig.game;
			if (!g || !g.playerEntity || (g.mapName || '') !== data.map) return;
			this.markHostCapable();
			const refs = this.resolveRefs(mi, sid);
			if (!refs) return;
			const k = data.k | 0;
			// Shooter dedup: the predicting client already ran this transition
			// natively — only correct its position, never double the FX.
			const predicted = this.consumePredict(refs.key, k);
			switch (k) {
				case K.BOUNCE: {
					const b = refs.bubble;
					if (!b || b._killed || b.state === 5) return;
					this.snapTo(b, data.x, data.y, data.z);
					if (predicted) return;
					this.netReplay(() => {
						const dir = this.dirFrom(data.vx, data.vy);
						const speed = (typeof data.vx === 'number' && typeof data.vy === 'number')
							? Math.sqrt(data.vx * data.vx + data.vy * data.vy) : 180;
						if (typeof b.bounce === 'function') b.bounce(dir, speed || 180);
					});
					return;
				}
				case K.LAST_SECOND: {
					const b = refs.bubble;
					if (!b || b._killed || b.state === 5 || b.state === 4) return;
					this.netReplay(() => { if (typeof b.setLastSecond === 'function') b.setLastSecond(); });
					return;
				}
				case K.STEAM: {
					const b = refs.bubble;
					if (!b || b._killed || b.state === 5) return;
					if (predicted) return;
					this.snapTo(b, data.x, data.y, data.z);
					// FX-only replay: the steam DAMAGE force stays host-side (its
					// CircleHitForce already hit the host's real enemies / member
					// mirrors ride the normal combatHit relay).
					this.netReplay(() => { if (typeof b.steam === 'function') b.steam(this.dirFrom(data.vx, data.vy), null); });
					return;
				}
				case K.CIRCULAR_STEAM: {
					const b = refs.bubble;
					if (!b || b._killed || b.state === 5) return;
					if (predicted) return;
					this.snapTo(b, data.x, data.y, data.z);
					this.netReplay(() => { if (typeof b.circularSteam === 'function') b.circularSteam(null); });
					return;
				}
				case K.BURST: {
					const b = refs.bubble;
					if (!b || b._killed || b.state === 5) return;
					if (predicted) return;
					this.snapTo(b, data.x, data.y, data.z);
					this.netReplay(() => { if (typeof b.burst === 'function') b.burst(); });
					return;
				}
				case K.INSTANT_KILL: {
					const b = refs.bubble;
					if (!b || b._killed || b.state === 5) return;
					this.netReplay(() => { if (typeof b.instantKill === 'function') b.instantKill(); });
					return;
				}
				case K.TURN_ICE: {
					if (predicted) {
						const own = refs.disk;
						if (own) this.snapTo(own, data.x, data.y, data.z);
						return;
					}
					const b = refs.bubble;
					if (b && !b._killed && b.state !== 5) {
						this.snapTo(b, data.x, data.y, data.z);
						// Native replay spawns the disk with the same panel/sid (the
						// propagateSid tail of the turnIce wrap tags shot chains).
						this.netReplay(() => { if (typeof b.turnIce === 'function') b.turnIce(); });
					} else if (!refs.disk) {
						this.spawnDisk(refs.panel, typeof data.x === 'number' ? [data.x, data.y, data.z] : undefined, sid || undefined);
					}
					return;
				}
				case K.ICE_SLIDE: {
					const d = refs.disk;
					if (!d || d._killed || d.state === 3) return;
					this.snapTo(d, data.x, data.y, data.z);
					if (predicted) return;
					this.netReplay(() => {
						if (d.state !== 2 && typeof d.slide === 'function') {
							d.slide(this.dirFrom(data.vx, data.vy), ig.game.playerEntity);
						} else if (d.coll && d.coll.vel && typeof data.vx === 'number' && typeof data.vy === 'number') {
							d.coll.vel.x = data.vx; d.coll.vel.y = data.vy;
						}
					});
					return;
				}
				case K.ICE_MELT: {
					const d = refs.disk;
					if (!d || d._killed || d.state === 3) return;
					if (predicted) return;
					this.snapTo(d, data.x, data.y, data.z);
					this.netReplay(() => { if (typeof d.startMelt === 'function') d.startMelt(); });
					return;
				}
				case K.ICE_BREAK: {
					const d = refs.disk;
					if (!d || d._killed) return;
					this.snapTo(d, data.x, data.y, data.z);
					this.netReplay(() => { if (typeof d.iceBreak === 'function') d.iceBreak(); });
					return;
				}
				case K.COALS: {
					const d = refs.disk;
					if (d && !d._killed) {
						this.snapTo(d, data.x, data.y, data.z);
						// Native path: spawns CooledCoals at the disk's bottom (with the
						// appear FX), detaches the panel and kills the disk.
						this.netReplay(() => { if (typeof d.turnCooledCoals === 'function') d.turnCooledCoals(); });
					} else if (!refs.coals) {
						this.spawnCoals(refs.panel, typeof data.x === 'number' ? [data.x, data.y, data.z] : undefined, sid || undefined);
					}
					return;
				}
				case K.COALS_MELT: {
					const c = refs.coals;
					if (!c || c._killed) return;
					this.netReplay(() => { if (typeof c.startMelt === 'function') c.startMelt(); });
					return;
				}
				case K.ICE_CONSUME: {
					const d = refs.disk;
					if (!d || d._killed || d.state === 3) return;
					this.netReplay(() => {
						if (typeof d.consume === 'function') {
							d.consume(typeof data.x === 'number' ? { x: data.x, y: data.y, z: data.z } : null);
						}
					});
					return;
				}
				case K.HIT_FX: {
					if (predicted) return; // the shooter's native ballHit already flashed
					const target = refs.disk || refs.bubble;
					if (!target || target._killed) return;
					const pos = (typeof data.x === 'number') ? { x: data.x, y: data.y, z: data.z || 0 }
						: (target.getAlignedPos ? target.getAlignedPos((ig as any).ENTITY_ALIGN.CENTER, Vec3.create()) : null);
					if (!pos) return;
					try {
						(sc as any).combat.showHitEffect(target, pos,
							typeof data.at === 'number' ? data.at : (sc as any).ATTACK_TYPE.LIGHT,
							typeof data.el === 'number' ? data.el : 0, false, false, true);
					} catch (_) { /* ignore */ }
					return;
				}
			}
		} catch (_) { /* never break the frame */ }
	}

	/** HOST: a member forwarded the ingredients of ITS ball hit — re-judge the
	 *  transition against the authoritative entity and let the method wraps
	 *  broadcast the outcome (plus one HIT_FX for the other spectators). */
	public applyHit(data: any): void {
		try {
			if (!data) return;
			const mi = typeof data.mi === 'number' ? data.mi : 0;
			const sid = typeof data.sid === 'string' ? data.sid : '';
			if (!mi && !sid) return;
			const m = this.getMain();
			if (!m || !m.host) return; // only the authority judges forwarded hits
			const g: any = ig.game;
			if (!g || !g.playerEntity || (g.mapName || '') !== data.map) return;
			const refs = this.resolveRefs(mi, sid);
			if (!refs) return;
			const EL: any = (sc as any).ELEMENT;
			const el = typeof data.el === 'number' ? data.el : -1;
			const cbt = this.resolveCombatant(typeof data.from === 'string' ? data.from : '');
			const dir = this.dirFrom(data.vx, data.vy);
			const hasPoint = typeof data.hx === 'number' && typeof data.hy === 'number';
			const pos = hasPoint ? { x: data.hx, y: data.hy, z: (typeof data.hz === 'number' ? data.hz : 0) } : null;
			if (data.tgt === 2) {
				const d = refs.disk;
				if (!d || d._killed || d.state === 3) return;
				// Vanilla gate: only state-1 disks react to non-heat hits.
				if (EL && el !== EL.HEAT && d.state !== 1) return;
				if (EL && el === EL.HEAT) { if (typeof d.startMelt === 'function') d.startMelt(); }
				else if (typeof d.slide === 'function') d.slide(dir, cbt);
				if (pos) this.hostHitFx(refs.key, d, el, (sc as any).ATTACK_TYPE.MEDIUM, pos);
			} else {
				const b = refs.bubble;
				if (!b || b._killed || b.state === 5) return;
				if (EL && el === EL.HEAT) {
					if (b.noSteamFrames) { if (typeof b.instantKill === 'function') b.instantKill(); }
					else if (data.stm) { if (typeof b.circularSteam === 'function') b.circularSteam(cbt); }
					else if (typeof b.steam === 'function') b.steam(dir, cbt);
				} else if (EL && el === EL.COLD) {
					if (typeof b.turnIce === 'function') b.turnIce();
				} else {
					if (typeof b.bounce === 'function') b.bounce(dir, 120);
				}
				const AT: any = (sc as any).ATTACK_TYPE;
				if (pos) this.hostHitFx(refs.key, b, el, data.chg ? AT.MEDIUM : AT.LIGHT, pos);
			}
		} catch (_) { /* never break the frame */ }
	}

	// -------------------------------------------------------------- internals

	private panels(): any[] {
		try {
			const P: any = (ig.ENTITY as any).WaterBubblePanel;
			if (!P) return [];
			const list = ig.game.getEntitiesByType(P) as any[];
			const out: any[] = [];
			for (const p of list) {
				if (p && !p._killed && typeof p.mapId === 'number' && p.mapId) out.push(p);
			}
			return out;
		} catch (_) { return []; }
	}

	private panelById(mi: number): any {
		const panels = this.panels();
		for (const p of panels) { if (p.mapId === mi) return p; }
		return null;
	}

	private bubbleOf(panel: any): any {
		try {
			const b = panel && panel.currentBubble;
			return (b && !b._killed) ? b : null;
		} catch (_) { return null; }
	}

	private diskOf(mi: number): any {
		try {
			const T: any = (sc as any).IceDiskEntity;
			if (!T) return null;
			const list = ig.game.getEntitiesByType(T) as any[];
			for (const d of list) {
				if (d && !d._killed && this.miOf(d) === mi) return d;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	private coalsOf(mi: number): any {
		try {
			const T: any = (sc as any).CooledCoals;
			if (!T) return null;
			const list = ig.game.getEntitiesByType(T) as any[];
			for (const c of list) {
				if (c && !c._killed && this.miOf(c) === mi) return c;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	/** Panel identity: tagged at spawn (survives panel detachment), else the
	 *  live panel reference's mapId. Panel-less entities return 0 (never synced). */
	private miOf(e: any): number {
		try {
			if (!e) return 0;
			if (typeof e._mpMi === 'number' && e._mpMi) return e._mpMi;
			const mi = e.panel && e.panel.mapId;
			if (typeof mi === 'number' && mi) { e._mpMi = mi; return mi; }
		} catch (_) { /* ignore */ }
		return 0;
	}

	/** Unified identity: 'p<panelMapId>' for panel-bound entities, 's<sid>' for
	 *  enemy-shot bubble chains. '' = never synced (panel-less locals). */
	private keyOf(e: any): string {
		try {
			if (!e) return '';
			const mi = this.miOf(e);
			if (mi) return 'p' + mi;
			if (typeof e._mpShot === 'string' && e._mpShot) return 's' + e._mpShot;
		} catch (_) { /* ignore */ }
		return '';
	}

	private isPuppet(e: any): boolean {
		try {
			if (!this.keyOf(e)) return false;
			if (netDepth || predictDepth) return false;
			const m = this.getMain();
			if (!m || !m.connection || !m.connection.isOpen()) return false;
			if (m.host) return false;
			return this.hostCapable;
		} catch (_) { return false; }
	}

	private markHostCapable(): void {
		if (this.hostCapable) return;
		this.hostCapable = true;
		console.log('[bubblesync] instance host speaks the bubble protocol — puppet mode on');
	}

	private dirFrom(vx: any, vy: any): { x: number, y: number } {
		const x = (typeof vx === 'number' && isFinite(vx)) ? vx : 0;
		const y = (typeof vy === 'number' && isFinite(vy)) ? vy : 0;
		const len = Math.sqrt(x * x + y * y);
		if (len < 0.0001) return { x: 0, y: -1 };
		return { x: x / len, y: y / len };
	}

	private netReplay(fn: () => void): void {
		netDepth++;
		try { fn(); } catch (_) { /* ignore */ }
		finally { netDepth--; }
	}

	private consumePredict(key: string, k: number): boolean {
		const lp = this.lastPredict.get(key);
		if (!lp) return false;
		if (Date.now() - lp.at > PREDICT_DEDUP_MS) { this.lastPredict.delete(key); return false; }
		// HIT_FX accompanies whichever transition was predicted. The record stays
		// until the window expires: the transition event and its HIT_FX arrive
		// back-to-back and BOTH must dedup against the same prediction.
		if (lp.k === k || k === K.HIT_FX) return true;
		return false;
	}

	private panelMoving(panel: any, mi: number): boolean {
		try {
			const b = this.bubbleOf(panel);
			if (b && b.coll) {
				if (b.state >= 2 && b.state !== 5) return true;
				const v = b.coll.vel;
				if (v && (Math.abs(v.x) > 20 || Math.abs(v.y) > 20 || Math.abs(v.z) > 20)) return true;
			}
			const d = this.diskOf(mi);
			if (d && d.coll) {
				if (d.state === 2) return true;
				const v = d.coll.vel;
				if (v && (Math.abs(v.x) > 20 || Math.abs(v.y) > 20 || Math.abs(v.z) > 20)) return true;
			}
		} catch (_) { /* ignore */ }
		return false;
	}

	private shotMoving(e: any): boolean {
		try {
			if (!e || !e.coll) return false;
			const WB: any = (sc as any).WaterBubbleEntity;
			const ID: any = (sc as any).IceDiskEntity;
			if (WB && e instanceof WB) return e.state >= 2 && e.state !== 5;
			if (ID && e instanceof ID) {
				if (e.state === 2) return true;
			}
			const v = e.coll.vel;
			if (v && (Math.abs(v.x) > 20 || Math.abs(v.y) > 20 || Math.abs(v.z) > 20)) return true;
		} catch (_) { /* ignore */ }
		return false;
	}

	private encodeShot(sid: string, e: any, withPos: boolean): IBubbleEntry | null {
		try {
			const WB: any = (sc as any).WaterBubbleEntity;
			const ID: any = (sc as any).IceDiskEntity;
			const CC: any = (sc as any).CooledCoals;
			if (WB && e instanceof WB) {
				const o: IBubbleEntry = { sid, ph: 1, st: e.state };
				if (withPos && e.coll && e.coll.pos) {
					o.p = [Math.round(e.coll.pos.x), Math.round(e.coll.pos.y), Math.round(e.coll.pos.z)];
					const v = e.coll.vel;
					if (v) o.v = [Math.round(v.x || 0), Math.round(v.y || 0), Math.round(v.z || 0)];
				}
				return o;
			}
			if (ID && e instanceof ID) {
				const o: IBubbleEntry = { sid, ph: 2, st: e.state };
				if (withPos && e.coll && e.coll.pos) {
					o.p = [Math.round(e.coll.pos.x), Math.round(e.coll.pos.y), Math.round(e.coll.pos.z)];
					const v = e.coll.vel;
					if (v) o.v = [Math.round(v.x || 0), Math.round(v.y || 0), Math.round(v.z || 0)];
				}
				return o;
			}
			if (CC && e instanceof CC) {
				const o: IBubbleEntry = { sid, ph: 3 };
				if (e.coll && e.coll.pos) {
					o.p = [Math.round(e.coll.pos.x + (e.coll.size.x || 0) / 2),
						Math.round(e.coll.pos.y + (e.coll.size.y || 0) / 2), Math.round(e.coll.pos.z)];
				}
				return o;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	/** HOST: adopt freshly SHOOT_BUBBLE-spawned bubbles. followTarget (init) runs
	 *  BEFORE init assigns .combatant, so the wrap only marks _mpShotPending;
	 *  this sweep (every scan) reads the now-linked combatant's multiplayerId
	 *  and assigns the streamable shot id. */
	private sweepPendingShots(): void {
		try {
			const g: any = ig.game;
			const list: any[] = (g && g.entities) || [];
			for (const e of list) {
				if (!e || e._killed || !e._mpShotPending) continue;
				e._mpShotPending = false;
				if (e._mpShot || this.miOf(e)) continue;
				const cbt = e.combatant;
				// netSync mode: host enemies stay multiplayerId-free BY DESIGN (block
				// sync keys them by mapId/engine uid instead). Mirror netSync's own
				// identity preference (sendEnemyBlock: i = _mpAdoptedUid || uid) so a
				// sid correlates with the group's enemy ids, surviving host migration.
				const uid = cbt && (cbt._mpAdoptedUid || cbt._mpUid || cbt.multiplayerId || cbt.uid);
				if (typeof uid !== 'number' || !uid) {
					console.warn('[bubblesync] shot bubble has no identifiable shooter — stays local'
						+ ' combatant=' + (cbt ? (cbt.enemyName || cbt.name || cbt.constructor && cbt.constructor.name || '?') : 'null')
						+ ' uid=' + (cbt && cbt.uid));
					continue;
				}
				const sid = uid + '.' + (this.shotSeq++);
				e._mpShot = sid;
				this.shots.set(sid, e);
			}
		} catch (_) { /* ignore */ }
	}

	/** The bubble->disk and disk->coals transitions spawn the NEXT entity inside
	 *  the wrapped method. Carry the shot id over (both roles: host broadcasts,
	 *  member replay/prediction tags its local copy the same way). */
	private propagateSid(src: any, typeName: string): void {
		try {
			const sid = src && src._mpShot;
			if (!sid) return;
			const T: any = (sc as any)[typeName];
			if (!T) return;
			const list = ig.game.getEntitiesByType(T) as any[];
			for (const e of list) {
				if (!e || e._killed || e._mpShot || this.miOf(e)) continue;
				e._mpShot = sid;
				this.shots.set(sid, e);
				return;
			}
		} catch (_) { /* ignore */ }
	}

	/** Member: materialize a host-side enemy shot bubble. Vanilla's init skipped
	 *  followTarget (we pass no target — positions stream in), so reproduce the
	 *  homing-bubble look here: state 2, IGNORE coll, the selfExplode aura. */
	private spawnShotBubble(sid: string, x: number, y: number, z: number): any {
		try {
			const T: any = (sc as any).WaterBubbleEntity;
			if (!T) return null;
			const b = ig.game.spawnEntity(T, x, y, z, {});
			if (!b) return null;
			b._mpShot = sid;
			this.shots.set(sid, b);
			try {
				b.state = 2;
				if (b.coll && typeof b.coll.setType === 'function') {
					b.coll.setType((ig as any).COLLTYPE.IGNORE);
					b.coll.bounciness = 1;
				}
			} catch (_) { /* ignore */ }
			try { if (b.effects && b.effects.sheet) b.effects.sheet.spawnOnTarget('selfExplode', b, { duration: -1 }); } catch (_) { /* ignore */ }
			return b;
		} catch (_) { return null; }
	}

	/** Resolve a packet identity (panel mi OR shot sid) to the live entities. */
	private resolveRefs(mi: number, sid: string): { key: string, panel: any, bubble: any, disk: any, coals: any } | null {
		try {
			if (mi) {
				const panel = this.panelById(mi);
				if (!panel) return null;
				return { key: 'p' + mi, panel, bubble: this.bubbleOf(panel), disk: this.diskOf(mi), coals: this.coalsOf(mi) };
			}
			if (!sid) return null;
			const WB: any = (sc as any).WaterBubbleEntity;
			const ID: any = (sc as any).IceDiskEntity;
			const CC: any = (sc as any).CooledCoals;
			let cur = this.shots.get(sid);
			if (cur && cur._killed) { this.shots.delete(sid); cur = null; }
			let bubble: any = null, disk: any = null, coals: any = null;
			const cls = (e: any): any => {
				if (WB && e instanceof WB) { bubble = e; return e; }
				if (ID && e instanceof ID) { disk = e; return e; }
				if (CC && e instanceof CC) { coals = e; return e; }
				return null;
			};
			if (cur) cls(cur);
			if (!bubble && !disk && !coals) {
				// Fallback: the tracking map lost it (host flip mid-flight) — scan.
				const list: any[] = (ig.game && (ig.game as any).entities) || [];
				for (const e of list) {
					if (!e || e._killed || e._mpShot !== sid) continue;
					if (cls(e)) { this.shots.set(sid, e); break; }
				}
			}
			return { key: 's' + sid, panel: null, bubble, disk, coals };
		} catch (_) { return null; }
	}

	private encodePanel(panel: any, mi: number, full: boolean): IBubbleEntry | null {
		const bubble = this.bubbleOf(panel);
		if (bubble) {
			const e: IBubbleEntry = { mi, ph: 1, st: bubble.state };
			if (full || this.panelMoving(panel, mi)) {
				if (bubble.coll && bubble.coll.pos) {
					e.p = [Math.round(bubble.coll.pos.x), Math.round(bubble.coll.pos.y), Math.round(bubble.coll.pos.z)];
					const v = bubble.coll.vel;
					if (v) e.v = [Math.round(v.x || 0), Math.round(v.y || 0), Math.round(v.z || 0)];
				}
			}
			return e;
		}
		const disk = this.diskOf(mi);
		if (disk) {
			const e: IBubbleEntry = { mi, ph: 2, st: disk.state };
			if (full || this.panelMoving(panel, mi)) {
				if (disk.coll && disk.coll.pos) {
					e.p = [Math.round(disk.coll.pos.x), Math.round(disk.coll.pos.y), Math.round(disk.coll.pos.z)];
					const v = disk.coll.vel;
					if (v) e.v = [Math.round(v.x || 0), Math.round(v.y || 0), Math.round(v.z || 0)];
				}
			}
			return e;
		}
		const coals = this.coalsOf(mi);
		if (coals) {
			const e: IBubbleEntry = { mi, ph: 3 };
			if (coals.coll && coals.coll.pos) {
				e.p = [Math.round(coals.coll.pos.x + (coals.coll.size.x || 0) / 2),
					Math.round(coals.coll.pos.y + (coals.coll.size.y || 0) / 2), Math.round(coals.coll.pos.z)];
			}
			return e;
		}
		return { mi, ph: 0 };
	}

	/** Member-side reconcile for an enemy-SHOT chain entry (sid-keyed). The
	 *  tracked entity type must match the host's phase; a mismatch quietly drops
	 *  the stale one and materializes the correct puppet. */
	private reconcileShotEntry(s: IBubbleEntry): void {
		try {
			const sid = s.sid || '';
			if (!sid) return;
			const WB: any = (sc as any).WaterBubbleEntity;
			const ID: any = (sc as any).IceDiskEntity;
			const CC: any = (sc as any).CooledCoals;
			let e = this.shots.get(sid);
			if (e && e._killed) { this.shots.delete(sid); e = null; }
			const ph = s.ph | 0;
			if (ph === 1) {
				if (e && !(WB && e instanceof WB)) { this.quietKill(e); e = null; }
				if (!e) {
					if (!s.p) return;
					// Don't resurrect a bubble we just predicted DEAD (steam/burst…):
					// the host's kill event / ph0 is still in flight. Panel bubbles are
					// guarded by respawnTimer; shot bubbles have no panel, so gate on
					// the prediction record instead.
					const lp = this.lastPredict.get('s' + sid);
					if (lp && Date.now() - lp.at < PREDICT_RESET_MS
						&& (lp.k === K.STEAM || lp.k === K.CIRCULAR_STEAM || lp.k === K.BURST || lp.k === K.INSTANT_KILL)) return;
					e = this.spawnShotBubble(sid, s.p[0], s.p[1], s.p[2]);
					if (!e) return;
				}
				this.applyBubbleState(e, s);
			} else if (ph === 2) {
				if (e && !(ID && e instanceof ID)) { this.quietKill(e); e = null; }
				if (!e) {
					// State-stream positions are raw coll.pos (top-left); spawnDisk takes
					// CENTER coords. The disk coll is 16x16 -> half-size 8.
					e = this.spawnDisk(null, s.p ? [s.p[0] + 8, s.p[1] + 8, s.p[2]] : undefined, sid);
					if (!e) return;
				}
				this.applyDiskState(e, s);
			} else if (ph === 3) {
				if (e && !(CC && e instanceof CC)) { this.quietKill(e); e = null; }
				if (!e) this.spawnCoals(null, s.p, sid);
			} else {
				if (e) this.quietKill(e);
				this.shots.delete(sid);
			}
		} catch (_) { /* never break the frame */ }
	}

	private reconcileEntry(s: IBubbleEntry): void {
		const panel = this.panelById(s.mi);
		if (!panel) return;
		const ph = s.ph | 0;
		const bubble = this.bubbleOf(panel);
		const disk = this.diskOf(s.mi);
		const coals = this.coalsOf(s.mi);
		if (ph === 1) {
			if (disk) this.quietKill(disk);
			if (coals) this.quietKill(coals);
			let b = bubble;
			if (!b) {
				// Late join / missed spawn: materialize the host's bubble SILENTLY
				// (a truthy arg skips the appear FX), unless the panel is mid-respawn
				// (then the native 1.5s timer will spawn it in lockstep with the host).
				if (panel._hidden || !panel.active) return;
				if ((panel.respawnTimer || 0) > 0) return;
				if (typeof panel.spawnBubble !== 'function') return;
				panel.spawnBubble(true);
				b = this.bubbleOf(panel);
				if (!b) return;
				if (s.p) this.hardSetPos(b, s.p[0], s.p[1], s.p[2]);
			}
			this.applyBubbleState(b, s);
		} else if (ph === 2) {
			if (bubble) this.quietKill(bubble);
			if (coals) this.quietKill(coals);
			let d = disk;
			if (!d) {
				// State-stream positions are raw coll.pos (top-left); spawnDisk takes
				// CENTER coords. The disk coll is 16x16 -> half-size 8.
				const cp: [number, number, number] | undefined = s.p ? [s.p[0] + 8, s.p[1] + 8, s.p[2]] : undefined;
				d = this.spawnDisk(panel, cp);
				if (!d) return;
			}
			this.applyDiskState(d, s);
		} else if (ph === 3) {
			if (bubble) this.quietKill(bubble);
			if (disk) this.quietKill(disk);
			if (!coals) this.spawnCoals(panel, s.p);
		} else {
			if (bubble) this.quietKill(bubble);
			if (disk) this.quietKill(disk);
			if (coals) this.quietKill(coals);
		}
	}

	private applyBubbleState(b: any, s: IBubbleEntry): void {
		try {
			if (s.p) this.setInterp(b, s.p[0], s.p[1], s.p[2]);
			if (s.v && b.coll && b.coll.vel) {
				b.coll.vel.x = s.v[0]; b.coll.vel.y = s.v[1]; b.coll.vel.z = s.v[2];
			}
			if (typeof s.st !== 'number') return;
			const bst = b.state;
			if (s.st === 4 && bst !== 4 && bst !== 5) {
				this.netReplay(() => { if (typeof b.setLastSecond === 'function') b.setLastSecond(); });
			} else if ((s.st === 3 || s.st === 2) && bst === 1) {
				// Missed the bounce event (late join): adopt the flying state; the
				// position stream keeps it glued from here on.
				b.state = s.st;
			} else if (s.st === 1 && (bst === 3 || bst === 4)) {
				// Host's bubble is IDLE on the panel while ours flies — only legal
				// when our prediction was never confirmed (dropped forward). Wait
				// out the confirmation window before snapping back.
				const pkey = s.mi ? 'p' + s.mi : 's' + (s.sid || '');
				const lp = this.lastPredict.get(pkey);
				if (lp && Date.now() - lp.at < PREDICT_RESET_MS) return;
				b.state = 1;
				if (b.timer > 90000) b.timer = 0;
				try { if (b.coll && b.coll.vel) { b.coll.vel.x = 0; b.coll.vel.y = 0; b.coll.vel.z = 0; } } catch (_) { /* ignore */ }
				if (b.effects && b.effects.handle && typeof b.effects.handle.stop === 'function') {
					try { b.effects.handle.stop(); b.effects.handle = null; } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* ignore */ }
	}

	private applyDiskState(d: any, s: IBubbleEntry): void {
		try {
			if (s.p) this.setInterp(d, s.p[0], s.p[1], s.p[2]);
			if (s.v && d.coll && d.coll.vel && d.state === 2) {
				d.coll.vel.x = s.v[0]; d.coll.vel.y = s.v[1];
			}
			if (typeof s.st !== 'number') return;
			if (s.st === 2 && d.state !== 2 && d.state !== 3) {
				// Missed the slide event: reproduce it (iceTrail FX + attackInfo).
				const dir = this.dirFrom(s.v && s.v[0], s.v && s.v[1]);
				this.netReplay(() => { if (typeof d.slide === 'function') d.slide(dir, ig.game.playerEntity); });
			} else if (s.st === 1 && d.state !== 1 && d.state !== 3) {
				d.state = 1;
			}
		} catch (_) { /* ignore */ }
	}

	/** Kill without the panel respawn callback and without death FX — used when
	 *  the host's stream contradicts a local leftover (its real transition event
	 *  either already played or never happened here). */
	private quietKill(e: any): void {
		try {
			this.interp.delete(this.keyOf(e));
			e.panel = null;
			if (typeof e.kill === 'function') e.kill();
		} catch (_) { /* ignore */ }
	}

	/** Spawn a puppet ice disk. panel may be NULL for enemy-shot chains (the
	 *  vanilla turnIce passes panel=null the same way); p is CENTER x/y + z. */
	private spawnDisk(panel: any, p?: [number, number, number], sid?: string): any {
		try {
			const T: any = (sc as any).IceDiskEntity;
			if (!T) return null;
			if (!panel && !p) return null;
			const x = p ? p[0] : panel.coll.pos.x + (panel.coll.size.x || 0) / 2;
			const y = p ? p[1] : panel.coll.pos.y + (panel.coll.size.y || 0) / 2;
			const z = p && typeof p[2] === 'number' ? p[2] : panel.coll.pos.z + 8;
			const d = ig.game.spawnEntity(T, x, y, z, { panel: panel || null, coalCoolTime: panel && panel.coalCoolTime });
			try {
				if (sid) { d._mpShot = sid; this.shots.set(sid, d); }
				else if (panel) d._mpMi = panel.mapId;
			} catch (_) { /* ignore */ }
			return d;
		} catch (_) { return null; }
	}

	/** Spawn puppet cooled coals. panel may be NULL for enemy-shot chains; p is
	 *  CENTER x/y + coll z (the CooledCoals spawn convention). */
	private spawnCoals(panel: any, p?: [number, number, number], sid?: string): any {
		try {
			const T: any = (sc as any).CooledCoals;
			if (!T) return null;
			if (!panel && !p) return null;
			const x = p ? p[0] : panel.coll.pos.x + (panel.coll.size.x || 0) / 2;
			const y = p ? p[1] : panel.coll.pos.y + (panel.coll.size.y || 0) / 2;
			const z = p && typeof p[2] === 'number' ? p[2] : panel.coll.pos.z;
			const c = ig.game.spawnEntity(T, x, y, z, { panel: panel || null, coalCoolTime: panel && panel.coalCoolTime });
			try {
				if (sid) { c._mpShot = sid; this.shots.set(sid, c); }
				else if (panel) c._mpMi = panel.mapId;
			} catch (_) { /* ignore */ }
			return c;
		} catch (_) { return null; }
	}

	private hardSetPos(e: any, x: number, y: number, z: number): void {
		try {
			this.interp.delete(this.keyOf(e));
			if (e && e.coll) e.coll.setPos(x, y, z);
		} catch (_) { /* ignore */ }
	}

	/** Event positions ride as entity CENTER x/y + coll z; state-stream
	 *  positions are raw coll.pos (both match their vanilla spawn conventions). */
	private snapTo(e: any, x?: number, y?: number, z?: number): void {
		try {
			if (!e || !e.coll || typeof x !== 'number' || typeof y !== 'number') return;
			this.interp.delete(this.keyOf(e));
			e.coll.setPos(x - (e.coll.size.x || 0) / 2, y - (e.coll.size.y || 0) / 2,
				typeof z === 'number' ? z : e.coll.pos.z);
		} catch (_) { /* ignore */ }
	}

	private setInterp(e: any, x: number, y: number, z: number): void {
		try {
			if (!e || !e.coll) return;
			const key = this.keyOf(e);
			const c: any = e.coll;
			const dx = x - c.pos.x, dy = y - c.pos.y, dz = z - c.pos.z;
			if (dx * dx + dy * dy > SNAP_DIST * SNAP_DIST || Math.abs(dz) > 200) {
				c.setPos(x, y, z);
				this.interp.delete(key);
				return;
			}
			if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1 && Math.abs(dz) < 0.1) {
				this.interp.delete(key);
				return;
			}
			this.interp.set(key, { e, tx: x, ty: y, tz: z });
		} catch (_) { /* ignore */ }
	}

	private interpolate(): void {
		if (!this.interp.size) return;
		const g: any = ig.game;
		if (!g || !g.playerEntity || g.isTeleporting()) return;
		const t = Math.min(1, (ig.system.tick || 0) * BUBBLE_LERP_RATE);
		for (const [mi, rec] of this.interp) {
			const e = rec.e;
			if (!e || e._killed || !e.coll) { this.interp.delete(mi); continue; }
			const c: any = e.coll;
			const dx = rec.tx - c.pos.x, dy = rec.ty - c.pos.y, dz = rec.tz - c.pos.z;
			if (dx === 0 && dy === 0 && dz === 0) { this.interp.delete(mi); continue; }
			if (dx * dx + dy * dy > SNAP_DIST * SNAP_DIST || Math.abs(dz) > 200) {
				try { c.setPos(rec.tx, rec.ty, rec.tz); } catch (_) { /* ignore */ }
				this.interp.delete(mi);
				continue;
			}
			try { c.setPos(c.pos.x + dx * t, c.pos.y + dy * t, c.pos.z + dz * t); } catch (_) { /* ignore */ }
			if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1 && Math.abs(dz) < 0.1) this.interp.delete(mi);
		}
	}

	/** A genuinely LOCAL attacker (our player / our bots): remote player-ball
	 *  puppets and remote skill projectiles are collision-neutered markers. */
	private isLocalAttacker(a: any): boolean {
		try {
			if (!a) return false;
			if (a._mpPlayerBall || a._mpProj || a._mpMirror) return false;
			const cbt = typeof a.getCombatant === 'function' ? a.getCombatant() : (a.combatant || null);
			if (cbt && cbt._mpMirror) return false;
			const CP: any = (sc as any).COMBATANT_PARTY;
			if (CP && typeof a.party === 'number' && a.party !== CP.PLAYER) return false;
			return true;
		} catch (_) { return false; }
	}

	private predictKindFor(tgt: number, el: number, ball: any, entity: any): number {
		try {
			const EL: any = (sc as any).ELEMENT;
			if (tgt === 2) return (EL && el === EL.HEAT) ? K.ICE_MELT : K.ICE_SLIDE;
			if (EL && el === EL.HEAT) {
				if (entity && entity.noSteamFrames) return K.INSTANT_KILL;
				const stm = !!(ball && ball.attackInfo && typeof ball.attackInfo.hasHint === 'function' && ball.attackInfo.hasHint('STEAM'));
				return stm ? K.CIRCULAR_STEAM : K.STEAM;
			}
			if (EL && el === EL.COLD) return K.TURN_ICE;
		} catch (_) { /* ignore */ }
		return K.BOUNCE;
	}

	private forwardHit(key: string, tgt: number, ball: any, entity: any): void {
		try {
			const m = this.getMain();
			const conn: any = m && m.connection;
			if (!conn || !conn.isOpen() || typeof conn.bubbleHit !== 'function') return;
			const mi = key[0] === 'p' ? Number(key.slice(1)) || 0 : 0;
			const sid = key[0] === 's' ? key.slice(1) : '';
			const g: any = ig.game;
			const map = (g && g.mapName) || '';
			if (!map) return;
			let el = 0;
			try { if (typeof ball.getElement === 'function') el = Number(ball.getElement()) || 0; } catch (_) { /* ignore */ }
			const stm = !!(ball && ball.attackInfo && typeof ball.attackInfo.hasHint === 'function' && ball.attackInfo.hasHint('STEAM'));
			const chg = !!(ball && (!ball.isBall || (ball.attackInfo && typeof ball.attackInfo.hasHint === 'function' && ball.attackInfo.hasHint('CHARGED'))));
			let vx: number | undefined, vy: number | undefined;
			try {
				const v = typeof ball.getHitVel === 'function' ? ball.getHitVel(entity) : null;
				if (v && typeof v.x === 'number' && isFinite(v.x) && typeof v.y === 'number' && isFinite(v.y)) { vx = v.x; vy = v.y; }
			} catch (_) { /* ignore */ }
			let hx: number | undefined, hy: number | undefined, hz: number | undefined;
			try {
				const c = typeof ball.getHitCenter === 'function' ? ball.getHitCenter(entity) : null;
				if (c && typeof c.x === 'number' && isFinite(c.x) && typeof c.y === 'number' && isFinite(c.y)) {
					hx = c.x; hy = c.y; hz = (typeof c.z === 'number' && isFinite(c.z)) ? c.z : 0;
				}
			} catch (_) { /* ignore */ }
			conn.bubbleHit({ map, mi: mi || undefined, sid: sid || undefined, tgt, el, stm: stm ? 1 : 0, chg: chg ? 1 : 0, vx, vy, hx, hy, hz });
		} catch (_) { /* ignore */ }
	}

	private sendEvent(key: string, k: number, pos?: { x: number, y: number, z: number }, vx?: number, vy?: number, el?: number, at?: number): void {
		try {
			const m = this.getMain();
			const conn: any = m && m.connection;
			if (!conn || !conn.isOpen() || typeof conn.bubbleEvent !== 'function') return;
			const g: any = ig.game;
			const map = (g && g.mapName) || '';
			if (!map) return;
			const pkt: any = { map, k };
			if (key[0] === 'p') pkt.mi = Number(key.slice(1)) || 0;
			else if (key[0] === 's') pkt.sid = key.slice(1);
			else return;
			if (pos) { pkt.x = Math.round(pos.x); pkt.y = Math.round(pos.y); pkt.z = Math.round(pos.z); }
			if (typeof vx === 'number' && isFinite(vx)) pkt.vx = Math.round(vx * 10) / 10;
			if (typeof vy === 'number' && isFinite(vy)) pkt.vy = Math.round(vy * 10) / 10;
			if (typeof el === 'number') pkt.el = el;
			if (typeof at === 'number') pkt.at = at;
			conn.bubbleEvent(pkt);
		} catch (_) { /* ignore */ }
	}

	/** HOST: the ball-impact flash for a judged hit (own ballHit wrap and the
	 *  forwarded-hit path both funnel here) — shown locally AND relayed so the
	 *  other spectators replay it on their copies. */
	private hostHitFx(key: string, entity: any, el: number, at: number, pos: { x: number, y: number, z: number }): void {
		try { (sc as any).combat.showHitEffect(entity, pos, at, el, false, false, true); } catch (_) { /* ignore */ }
		this.sendEvent(key, K.HIT_FX, pos, undefined, undefined, el, at);
	}

	/** HOST-side broadcast of a native transition (method wrap tail). */
	private broadcastTransition(e: any, key: string, k: number, px: number, py: number, pz: number, args: IArguments | any[]): void {
		let vx: number | undefined, vy: number | undefined;
		try {
			if (k === K.STEAM) {
				const a0 = args && args[0];
				if (a0 && typeof a0.x === 'number') { vx = a0.x; vy = a0.y; }
			} else if (k === K.BOUNCE || k === K.ICE_SLIDE) {
				const c = e && e.coll;
				if (c && c.vel) { vx = c.vel.x; vy = c.vel.y; }
			}
		} catch (_) { /* ignore */ }
		this.sendEvent(key, k, { x: px, y: py, z: pz }, vx, vy);
	}

	/** Combatant for a forwarded hit's host-side steam force / disk slide. We
	 *  deliberately do NOT use the attacker's mirror: netSync's ROUND-80 damage
	 *  guard swallows ANY mirror-rooted hit on a host real enemy (protection
	 *  against stray mirrored-projectile chips), which would make the steam
	 *  blast deal zero damage and never break guards (e.g. the heat-dng
	 *  jellyfish shield). The force's attack spec is self-contained
	 *  (MASSIVE/HEAT/damageFactor 1, party OTHER), so the host's own player is
	 *  a safe, non-mirror carrier — same targeting, native damage pipeline. */
	private resolveCombatant(from: string): any {
		try { return ig.game.playerEntity; } catch (_) { return null; }
	}

	/** Leaving puppet mode (host lost / disconnect): hand frozen timers back to
	 *  the engine so local bubbles age normally again. */
	private unfreezeAll(): void {
		try {
			const assist = (() => { try { return (sc as any).options.get('assist-puzzle-speed') || 1; } catch (_) { return 1; } })();
			const g: any = ig.game;
			const list: any[] = (g && g.entities) || [];
			for (const e of list) {
				if (!e || e._killed || !(e.timer > 90000)) continue;
				const WB: any = (sc as any).WaterBubbleEntity;
				const ID: any = (sc as any).IceDiskEntity;
				const CC: any = (sc as any).CooledCoals;
				if (WB && e instanceof WB) e.timer = 10 / assist;
				else if (ID && e instanceof ID) e.timer = e.state === 1 ? 8 / assist : 1.5;
				else if (CC && e instanceof CC) e.timer = (e.coalCoolTime || 5) / assist;
			}
			this.interp.clear();
			this.lastPredict.clear();
		} catch (_) { /* ignore */ }
	}

	public dump(): void {
		try {
			const m = this.getMain();
			const panels = this.panels();
			console.log('[bubblesync] host=' + !!(m && m.host) + ' hostCapable=' + this.hostCapable
				+ ' panels=' + panels.length + ' interp=' + this.interp.size
				+ ' predicts=' + this.lastPredict.size);
			for (const p of panels) {
				const mi = p.mapId;
				const b = this.bubbleOf(p);
				const d = this.diskOf(mi);
				const c = this.coalsOf(mi);
				console.log('[bubblesync] panel mi=' + mi + ' active=' + !!p.active + ' respawn=' + (p.respawnTimer || 0).toFixed(2)
					+ (b ? ' bubble st=' + b.state + ' timer=' + (b.timer || 0).toFixed(2) + ' pos=' + Math.round(b.coll.pos.x) + ',' + Math.round(b.coll.pos.y) + ',' + Math.round(b.coll.pos.z) : '')
					+ (d ? ' disk st=' + d.state + ' timer=' + (d.timer || 0).toFixed(2) + ' pos=' + Math.round(d.coll.pos.x) + ',' + Math.round(d.coll.pos.y) + ',' + Math.round(d.coll.pos.z) : '')
					+ (c ? ' coals timer=' + (c.timer || 0).toFixed(2) : '')
					+ (!b && !d && !c ? ' (empty)' : ''));
			}
			for (const [sid, e] of this.shots) {
				try {
					const WB: any = (sc as any).WaterBubbleEntity;
					const ID: any = (sc as any).IceDiskEntity;
					const kind = !e ? 'gone' : (WB && e instanceof WB) ? 'bubble' : (ID && e instanceof ID) ? 'disk' : 'coals';
					console.log('[bubblesync] shot sid=' + sid + ' ' + kind
						+ (e && e.coll ? ' pos=' + Math.round(e.coll.pos.x) + ',' + Math.round(e.coll.pos.y) + ',' + Math.round(e.coll.pos.z) : '')
						+ (e && typeof e.state === 'number' ? ' st=' + e.state : '')
						+ (e && e._killed ? ' KILLED' : ''));
				} catch (_) { /* ignore */ }
			}
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------------ hooks

	private installHooks(): void {
		if (hooksInstalled) return;
		hooksInstalled = true;
		try { this.installPanelHooks(); } catch (e) { console.warn('[bubblesync] panel hooks failed', e); }
		try { this.installBubbleHooks(); } catch (e) { console.warn('[bubblesync] bubble hooks failed', e); }
		try { this.installDiskHooks(); } catch (e) { console.warn('[bubblesync] disk hooks failed', e); }
		try { this.installCoalsHooks(); } catch (e) { console.warn('[bubblesync] coals hooks failed', e); }
	}

	/** Tag every panel-spawned bubble with its panel's mapId (survives the
	 *  panel detachment in onHideRequest, so the burst still relays its mi). */
	private installPanelHooks(): void {
		const P: any = (ig.ENTITY as any).WaterBubblePanel;
		if (!P || !P.prototype || typeof P.prototype.spawnBubble !== 'function') return;
		if (P.prototype._mpBubbleWrapped) return;
		P.prototype._mpBubbleWrapped = true;
		const orig = P.prototype.spawnBubble;
		P.prototype.spawnBubble = function (this: any) {
			const r = orig.apply(this, arguments as any);
			try {
				const b = this.currentBubble;
				if (b && typeof this.mapId === 'number' && this.mapId) b._mpMi = this.mapId;
			} catch (_) { /* ignore */ }
			return r;
		};
	}

	/** Wrap one transition method: suppress on member puppets (the host's event
	 *  drives it), broadcast after native execution on the host. */
	private wrapTransition(proto: any, name: string, k: number): void {
		if (!proto || typeof proto[name] !== 'function') return;
		const guard = '_mpBw_' + name;
		if (proto[guard]) return;
		proto[guard] = true;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		const orig = proto[name];
		proto[name] = function (this: any) {
			const args = arguments as any;
			let key = '';
			let m: Multiplayer | undefined;
			try { key = self.keyOf(this); m = self.getMain(); } catch (_) { /* ignore */ }
			if (key && self.isPuppet(this)) return;
			// Member-side PREDICTION of a steam transition must stay FX-only: with
			// the real combatant the vanilla method would spawn a local CircleHit
			// damage force that forwards enemy damage, and the host's judged steam
			// would then apply the same damage a second time. Strip the combatant.
			if (predictDepth > 0 && m && !m.host && (k === K.STEAM || k === K.CIRCULAR_STEAM)) {
				const a2 = Array.prototype.slice.call(args);
				if (k === K.STEAM) { if (a2.length > 1) a2[1] = null; }
				else { a2[0] = null; }
				return orig.apply(this, a2);
			}
			// Snapshot the position up front: kill-type transitions destroy the entity.
			let px = 0, py = 0, pz = 0;
			try {
				const c = this.coll;
				if (c && c.pos) { px = c.pos.x + (c.size.x || 0) / 2; py = c.pos.y + (c.size.y || 0) / 2; pz = c.pos.z; }
			} catch (_) { /* ignore */ }
			const r = orig.apply(this, args);
			try {
				if (key && m && m.host && m.connection && m.connection.isOpen() && !netDepth) {
					self.broadcastTransition(this, key, k, px, py, pz, args);
				}
				// A shot chain keeps its id across the bubble -> disk -> coals
				// handoff (member replays and predictions tag their copies too).
				if (k === K.TURN_ICE) self.propagateSid(this, 'IceDiskEntity');
				else if (k === K.COALS) self.propagateSid(this, 'CooledCoals');
			} catch (_) { /* ignore */ }
			return r;
		};
	}

	/** Freeze the autonomous transition timer on member puppets (burst / blink /
	 *  melt / slide-end all arrive as host events instead). */
	private wrapTimerFreeze(proto: any): void {
		if (!proto || typeof proto.update !== 'function') return;
		const guard = '_mpBw_update';
		if (proto[guard]) return;
		proto[guard] = true;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		const orig = proto.update;
		proto.update = function (this: any) {
			try {
				if (self.isPuppet(this) && this.state !== 5 && this.timer > 0 && this.timer < 90000) {
					this.timer = FROZEN_TIMER;
				}
			} catch (_) { /* ignore */ }
			return orig.apply(this, arguments as any);
		};
	}

	private installBubbleHooks(): void {
		const T: any = (sc as any).WaterBubbleEntity;
		if (!T || !T.prototype) return;
		const proto = T.prototype;
		// Transition suppression (member) + broadcast (host):
		this.wrapTransition(proto, 'bounce', K.BOUNCE);
		this.wrapTransition(proto, 'setLastSecond', K.LAST_SECOND);
		this.wrapTransition(proto, 'steam', K.STEAM);
		this.wrapTransition(proto, 'circularSteam', K.CIRCULAR_STEAM);
		this.wrapTransition(proto, 'burst', K.BURST);
		this.wrapTransition(proto, 'instantKill', K.INSTANT_KILL);
		this.wrapTransition(proto, 'turnIce', K.TURN_ICE);
		this.wrapTimerFreeze(proto);
		// Enemy SHOOT_BUBBLE bubbles are panel-less homing bubbles: followTarget
		// only runs for them (panels never pass a target). init assigns .combatant
		// AFTER followTarget, so just mark here — the host's sweepPendingShots
		// assigns the streamable "<shooterUid>.<seq>" id once the link exists.
		if (typeof proto.followTarget === 'function' && !proto._mpBw_followTarget) {
			proto._mpBw_followTarget = true;
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			const self = this;
			const orig = proto.followTarget;
			proto.followTarget = function (this: any) {
				const r = orig.apply(this, arguments as any);
				try {
					if (!this._mpShot && !this._mpShotPending && !self.miOf(this)) this._mpShotPending = true;
				} catch (_) { /* ignore */ }
				return r;
			};
		}
		// ballHit: host broadcasts the impact flash; a member forwards the hit
		// ingredients to the host and predicts the outcome natively.
		if (typeof proto.ballHit === 'function' && !proto._mpBw_ballHit) {
			proto._mpBw_ballHit = true;
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			const self = this;
			const orig = proto.ballHit;
			proto.ballHit = function (this: any, a: any) {
				let key = '';
				let m: Multiplayer | undefined;
				try { key = self.keyOf(this); m = self.getMain(); } catch (_) { /* ignore */ }
				if (!key || !m || !m.connection || !m.connection.isOpen()) {
					return orig.apply(this, arguments as any);
				}
				if (m.host) {
					const r = orig.apply(this, arguments as any);
					try {
						if (r === true && !netDepth) {
							const el = (a && typeof a.getElement === 'function') ? Number(a.getElement()) || 0 : 0;
							const AT: any = (sc as any).ATTACK_TYPE;
							const chg = !!(a && (!a.isBall || (a.attackInfo && typeof a.attackInfo.hasHint === 'function' && a.attackInfo.hasHint('CHARGED'))));
							let pos: any = null;
							try { pos = typeof a.getHitCenter === 'function' ? a.getHitCenter(this) : null; } catch (_) { /* ignore */ }
							if (pos && typeof pos.x === 'number') {
								self.hostHitFx(key, this, el, chg ? AT.MEDIUM : AT.LIGHT, pos);
							}
						}
					} catch (_) { /* ignore */ }
					return r;
				}
				if (!self.hostCapable) return orig.apply(this, arguments as any);
				// Member puppet: non-local attackers (enemy balls / forces) are the
				// host's call — absorb HEAT balls like vanilla, ignore the rest.
				if (!self.isLocalAttacker(a)) {
					try {
						const EL: any = (sc as any).ELEMENT;
						if (EL && a && typeof a.getElement === 'function' && a.getElement() === EL.HEAT) return true;
					} catch (_) { /* ignore */ }
					return false;
				}
				if (this.state === 5) return false; // vanilla gate
				let el = 0;
				try { el = (a && typeof a.getElement === 'function') ? Number(a.getElement()) || 0 : 0; } catch (_) { /* ignore */ }
				self.lastPredict.set(key, { k: self.predictKindFor(1, el, a, this), at: Date.now() });
				self.forwardHit(key, 1, a, this);
				predictDepth++;
				try { return orig.apply(this, arguments as any); } finally { predictDepth--; }
			};
		}
	}

	private installDiskHooks(): void {
		const T: any = (sc as any).IceDiskEntity;
		if (!T || !T.prototype) return;
		const proto = T.prototype;
		this.wrapTransition(proto, 'slide', K.ICE_SLIDE);
		this.wrapTransition(proto, 'startMelt', K.ICE_MELT);
		this.wrapTransition(proto, 'iceBreak', K.ICE_BREAK);
		this.wrapTransition(proto, 'turnCooledCoals', K.COALS);
		this.wrapTransition(proto, 'consume', K.ICE_CONSUME);
		this.wrapTimerFreeze(proto);
		// Enemy damage / barrier consume from a member puppet: host-native only
		// (its real disk collides with real enemies/barriers; members replay the
		// outcome events). A member-side collide would double-forward damage.
		if (typeof proto.collideWith === 'function' && !proto._mpBw_collideWith) {
			proto._mpBw_collideWith = true;
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			const self = this;
			const orig = proto.collideWith;
			proto.collideWith = function (this: any) {
				try { if (self.isPuppet(this)) return; } catch (_) { /* fall through */ }
				return orig.apply(this, arguments as any);
			};
		}
		if (typeof proto.ballHit === 'function' && !proto._mpBw_ballHit) {
			proto._mpBw_ballHit = true;
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			const self = this;
			const orig = proto.ballHit;
			proto.ballHit = function (this: any, a: any) {
				let key = '';
				let m: Multiplayer | undefined;
				try { key = self.keyOf(this); m = self.getMain(); } catch (_) { /* ignore */ }
				if (!key || !m || !m.connection || !m.connection.isOpen()) {
					return orig.apply(this, arguments as any);
				}
				if (m.host) {
					const r = orig.apply(this, arguments as any);
					try {
						if (r === true && !netDepth) {
							const el = (a && typeof a.getElement === 'function') ? Number(a.getElement()) || 0 : 0;
							let pos: any = null;
							try { pos = typeof a.getHitCenter === 'function' ? a.getHitCenter(this) : null; } catch (_) { /* ignore */ }
							if (pos && typeof pos.x === 'number') {
								self.hostHitFx(key, this, el, (sc as any).ATTACK_TYPE.MEDIUM, pos);
							}
						}
					} catch (_) { /* ignore */ }
					return r;
				}
				if (!self.hostCapable) return orig.apply(this, arguments as any);
				if (!self.isLocalAttacker(a)) return false;
				// Vanilla gate: molten disks ignore everything, non-heat only on state 1.
				try {
					const EL: any = (sc as any).ELEMENT;
					const el0 = (a && typeof a.getElement === 'function') ? a.getElement() : -1;
					if (this.state === 3 || (EL && el0 !== EL.HEAT && this.state !== 1)) return false;
					let el = 0;
					try { el = Number(el0) || 0; } catch (_) { /* ignore */ }
					self.lastPredict.set(key, { k: self.predictKindFor(2, el, a, this), at: Date.now() });
					self.forwardHit(key, 2, a, this);
					predictDepth++;
					try { return orig.apply(this, arguments as any); } finally { predictDepth--; }
				} catch (_) { return orig.apply(this, arguments as any); }
			};
		}
	}

	private installCoalsHooks(): void {
		const T: any = (sc as any).CooledCoals;
		if (!T || !T.prototype) return;
		const proto = T.prototype;
		this.wrapTransition(proto, 'startMelt', K.COALS_MELT);
		this.wrapTimerFreeze(proto);
	}
}
