import { IBallInfo } from '../../ballInfo';
import { Multiplayer } from '../../multiplayer';

export class OnThrownBallListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		this.main.connection.onThrowBall(this.onThrowBall.bind(this));
	}

	public onThrowBall(ballInfo: IBallInfo): void {
		if (ballInfo.combatant === null) {
			return; // malformed; nothing to do
		}

		const entity = this.resolveEntity(ballInfo.combatant);
		if (!entity) {
			// Mirror not spawned yet (they entered while we were loading a map). Skip
			// this one ball quietly — the next update will land once their mirror is up.
			return;
		}

		// The mirror's `proxies` was captured at spawn time; element switches make
		// 1.4.2 reassign playerEntity.proxies to a NEW object, leaving the mirror
		// with a stale reference and SHOOT_PROXY unable to resolve the proxy name.
		// Refresh it so the proxy lookup succeeds.
		(entity as any).proxies = ig.game.playerEntity.proxies;

		// 1.72.0 (assault fix): 'assault:<elementKey>' relays the 强袭/ASSAULT
		// modifier's extra projectile. It has no proxy — spawn the engine's shared
		// per-element template directly, using the same geometry AssaultTools does
		// (BOTTOM-aligned spawn at BALL_HEIGHT). One relay arrives per ball, so the
		// sender's random spread is already baked into the relayed dir.
		if (ballInfo.ballInfo.indexOf('assault:') === 0) {
			try {
				const el = ballInfo.ballInfo.slice('assault:'.length);
				const assault: any = (sc as any).ASSAULT_PROJECTILES;
				const tmpl: any = assault && assault[el];
				if (!tmpl || typeof tmpl.spawn !== 'function') return;
				const root: any = (entity as any).getCombatantRoot
					? ((entity as any).getCombatantRoot() || entity) : entity;
				const pos = root.getAlignedPos((ig as any).ENTITY_ALIGN.BOTTOM, Vec3.create());
				pos.z = pos.z + ((window as any).Constants ? (window as any).Constants.BALL_HEIGHT : 12);
				// 1.73.x: spawn the template then NEUTRALIZE the copy (visual-only, no
				// collisions/behaviors/attackInfo). Its real timer (0.166s) is kept, so
				// the short flight ends exactly like the sender's.
				this.neutralizeReplayBall(tmpl.spawn(pos.x, pos.y, pos.z, root, ballInfo.dir));
			} catch (_) { /* a failed ball replay must never break the frame */ }
			return;
		}

		// 1.72.0 (dungeon-key relay): the sender stood on an active KeyPanel and
	// threw the dungeon key. Resolve a LOCAL KeyPanel of the matching kind and
	// spawn its key spawner on the mirror, so our own panels/key walls react
	// to it exactly like the thrower's world did. No matching panel loaded
	// (we're not on that map) -> nothing to show, skip quietly.
	if (ballInfo.ballInfo.indexOf('key:') === 0) {
		try {
			const wantMaster = ballInfo.ballInfo === 'key:master';
			const KP: any = (ig.ENTITY as any).KeyPanel;
			const ents: any[] = (ig.game as any).entities || [];
			for (let i = 0; i < ents.length; i++) {
				const e: any = ents[i];
				if (!KP || !(e instanceof KP)) continue;
				const kt: any = e.keyType;
				const spawner: any = kt && kt.ballInfo;
				if (!spawner || typeof spawner.spawn !== 'function') continue;
				let master = false;
				try {
					const hints: any = spawner.data && spawner.data.attack && spawner.data.attack.hints;
					master = !!(hints && hints.indexOf('DUNGEON_MASTER_KEY') !== -1);
				} catch (_) { /* treat as regular */ }
				if (master !== wantMaster) continue;
				const root: any = (entity as any).getCombatantRoot
					? ((entity as any).getCombatantRoot() || entity) : entity;
				const pos = root.getAlignedPos((ig as any).ENTITY_ALIGN.BOTTOM, Vec3.create());
				pos.z = pos.z + ((window as any).Constants ? (window as any).Constants.BALL_HEIGHT : 12);
				spawner.spawn(pos.x, pos.y, pos.z, root, ballInfo.dir);
				return;
			}
		} catch (_) { /* a failed ball replay must never break the frame */ }
		return;
	}

	// 1.72.0 (generic fallback relay): an unrecognized ball type on the
	// sender (inline event proxy, modded spawner, future override) is replayed
	// as the thrower's default neutral ball — purely a visual stand-in so
	// teammates always see SOMETHING fly instead of nothing.
	if (ballInfo.ballInfo.indexOf('generic:') === 0) {
		try {
			// 1.73.x: the stand-in must be a NEUTRALIZED visual, not a real SHOOT_PROXY
			// ball — a real one flies the normal range with live attackInfo/behaviors,
			// which is exactly how the assault bug painted the screen with normal balls.
			const name = ballInfo.ballInfo.slice('generic:'.length);
			const proxies: any = (entity as any).proxies;
			const proxy: any = proxies && proxies[name];
			if (!proxy || typeof proxy.spawn !== 'function') return;
			const root: any = (entity as any).getCombatantRoot
				? ((entity as any).getCombatantRoot() || entity) : entity;
			const pos = root.getAlignedPos((ig as any).ENTITY_ALIGN.BOTTOM, Vec3.create());
			pos.z = pos.z + ((window as any).Constants ? (window as any).Constants.BALL_HEIGHT : 12);
			this.neutralizeReplayBall(proxy.spawn(pos.x, pos.y, pos.z, root, ballInfo.dir));
		} catch (_) { /* a failed ball replay must never break the frame */ }
		return;
	}

	// ROUND 132: in a dungeon the peer's NORMAL thrown balls are position-streamed
		// (playerBall) so the bounce-puzzle ball stays visible through every steered
		// bounce. Spawning a second physical ball here would double the visual — skip
		// it. The puzzle/block/switch state already syncs via puzzleSync (ROUND 131)
		// and combat damage via combatHit, so the physical replay is unneeded. The
		// assault:/key:/generic: branches above already returned and are unaffected.
		const smAny: any = (sc as any).map;
		if (smAny && typeof smAny.isDungeon === 'function' && smAny.isDungeon()) return;

	// `SHOOT_PROXY` settings are an internal shape that has shifted between
		// game versions; the values we pass are part of our own wire protocol, so
		// we cast rather than track the game's exact constructor types.
		const actonStep = new ig.ACTION_STEP.SHOOT_PROXY({ proxy: ballInfo.ballInfo, dir: ballInfo.dir } as any);
		actonStep.run(entity as sc.BasicCombatant);
	}

	/** 1.73.x: turn a relayed ball into a purely VISUAL copy — OTHER party,
	 * IGNORE collision, no attackInfo/behaviors/destroy/bounce proxies. Keeps its
	 * own timer (assault = 0.166s short flight; defaults to 1.5s) so the copy ends
	 * like the sender's instead of lingering. Marked so no stream re-broadcasts it. */
	private neutralizeReplayBall(e: any): void {
		if (!e) return;
		try {
			e.party = (sc as any).COMBATANT_PARTY.OTHER;
			const c = e.coll;
			if (c && typeof c.setType === 'function') c.setType((ig as any).COLLTYPE.IGNORE);
			else if (c) c.type = (ig as any).COLLTYPE.IGNORE;
			e.attackInfo = null;
			e.hitProxy = null;
			if (typeof e.onProjectileHit === 'function') e.onProjectileHit = function () { return false; };
			e.target = null;
			e.behaviors = null;
			e.grab = null;
			e.destroyProxySrc = null;
			e.bounceProxySrc = null;
			if (!(e.timer > 0)) e.timer = 1.5;
			e._mpPlayerBall = true;
		} catch (_) { /* visuals must never break sync */ }
	}

	private resolveEntity(combatant: number | string | undefined): ig.Entity | undefined {
		if (combatant === undefined) {
			return ig.game.playerEntity;
		}

		if (typeof combatant === 'string') {
			const player = this.main.players[combatant];
			if (!player) {
				return;
			}

			return player.entity;
		}

		if (typeof combatant === 'number') {
			return this.main.entities[combatant];
		}

		return undefined;
	}
}