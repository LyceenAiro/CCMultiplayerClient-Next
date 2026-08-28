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

		// 1.76.x (bot attack sync): bn names one of the SENDER's party bots — anchor
		// the replay on OUR local bot puppet instead of the sender's mirror.
		const botName = ballInfo.bn;
		const entity = botName
			? this.main.botEntityByName(botName)
			: this.resolveEntity(ballInfo.combatant);
		if (!entity) {
			// Mirror not spawned yet (they entered while we were loading a map). Skip
			// this one ball quietly — the next update will land once their mirror is up.
			return;
		}

		// The mirror's `proxies` was captured at spawn time; element switches make
		// 1.4.2 reassign playerEntity.proxies to a NEW object, leaving the mirror
		// with a stale reference and SHOOT_PROXY unable to resolve the proxy name.
		// Refresh it so the proxy lookup succeeds. (Bots keep their OWN proxies —
		// they resolve the same proxy names natively.)
		if (!botName) (entity as any).proxies = ig.game.playerEntity.proxies;

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

		// 1.75.x (dungeon-key VISUAL-ONLY sync): teammates SEE the key throw, but the
	// replayed ball is NEUTRALIZED (neutralizeReplayBall: OTHER party, IGNORE
	// collision, no attackInfo) so it can never open OUR key walls/doors or flip
	// switches — key-locked progression stays per-client. Resolve a LOCAL
	// KeyPanel of the matching kind for the authentic key-ball visuals (trail /
	// pop effects, 1.5s flight). No matching panel loaded (not on that map) ->
	// skip quietly.
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
				// Visual-only copy: passes through the wall instead of opening it.
				this.neutralizeReplayBall(spawner.spawn(pos.x, pos.y, pos.z, root, ballInfo.dir));
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

	// 1.75.x (player skill-proxy relay): 'proxy:<name>' is a GENERIC combat proxy
	// (sc.CombatProxyEntity) the caster's art placed — the heat dash-art mines
	// ('mine'/'moveMine'), flameWall, meteorShower, wave/shock dash dummies, ...
	// These are not Balls, so no other relay covers them (and the dungeon
	// playerBall skip below must NOT apply — they replay everywhere). The copy
	// runs its native action (blink/fuse/explode/move) but is neutralized:
	// its TACKLE is a pure no-op so a streamed puppet/mirror position skew can
	// never trip cancelOnHit and detonate the copy early (the "heat mine
	// explodes after ~1s for spectators" bug). The copy's own WAIT-driven
	// native fuse is its single timing authority, and its damage chains are
	// swallowed by the _mpProxyVisual gates in netSync — the real damage
	// arrives via the caster's combatHit/enemyDamage packets exactly like
	// their melee/ball hits.
	if (ballInfo.ballInfo.indexOf('proxy:') === 0) {
		try {
			const name = ballInfo.ballInfo.slice('proxy:'.length);
			const me: any = ig.game.playerEntity;
			const proxies: any = me && me.proxies;
			const proxy: any = proxies && proxies[name];
			if (!proxy || typeof proxy.spawn !== 'function') return;
			// Only GENERIC proxies belong on this channel — a BALL-type name here
			// means a mismatched sender; those belong to the normal ball branches.
			const GenericCtor: any = (sc as any).PROXY_TYPE && (sc as any).PROXY_TYPE.GENERIC;
			if (GenericCtor && !(proxy instanceof GenericCtor)) return;
			const root: any = (entity as any).getCombatantRoot
				? ((entity as any).getCombatantRoot() || entity) : entity;
			// GENERIC spawn wants the CENTER point (it subtracts half its size);
			// the relay carried the engine's final top-left spawn coords — add it
			// back. Without pos (old sender) fall back to the mirror's face point.
			const size: any = proxy.data && proxy.data.size;
			let px: number, py: number, pz: number;
			if (ballInfo.pos && typeof ballInfo.pos.x === 'number') {
				px = ballInfo.pos.x; py = ballInfo.pos.y; pz = ballInfo.pos.z;
			} else {
				const fp = root.getAlignedPos((ig as any).ENTITY_ALIGN.BOTTOM, Vec3.create());
				px = fp.x - (size ? size.x / 2 : 0); py = fp.y - (size ? size.y / 2 : 0); pz = fp.z;
			}
			const e = proxy.spawn(
				px + (size && typeof size.x === 'number' ? size.x / 2 : 0),
				py + (size && typeof size.y === 'number' ? size.y / 2 : 0),
				pz, root, ballInfo.dir, true);
			if (e) this.neutralizeProxyVisual(e);
		} catch (_) { /* a failed proxy replay must never break the frame */ }
		return;
	}

	// ROUND 132: in a dungeon the peer's NORMAL thrown balls are position-streamed
		// (playerBall) so the bounce-puzzle ball stays visible through every steered
		// bounce. Spawning a second physical ball here would double the visual — skip
		// it. The puzzle/block/switch state already syncs via puzzleSync (ROUND 131)
		// and combat damage via combatHit, so the physical replay is unneeded. The
		// assault:/key:/generic: branches above already returned and are unaffected.
		// 1.76.x: BOT balls are NOT position-streamed (the playerBall stream covers
		// the local player only) — replay them even in dungeons.
		const smAny: any = (sc as any).map;
		if (!botName && smAny && typeof smAny.isDungeon === 'function' && smAny.isDungeon()) return;

	// 1.75.x: when the relay carries the engine's exact spawn coords, spawn the
	// resolved proxy right there. Skill bursts (SHOOT_PROXY_RANGE's startDist/
	// offset — the Burn! flame cone) otherwise collapse onto the mirror's face
	// point and read as a plain bullet stream. Old senders without pos keep the
	// legacy SHOOT_PROXY-at-face behaviour.
	// 1.76.x (bot attack sync): a BOT-thrown ball is NEUTRALIZED (visual-only) —
	// the bot puppet is a native Player-typed party entity, so a live ball rooted
	// at it would deal REAL local damage on this client and double with the
	// leader's own ball.
	if (ballInfo.pos && typeof ballInfo.pos.x === 'number') {
		try {
			const proxy: any = (sc as any).ProxyTools.getProxy(ballInfo.ballInfo, entity as any);
			if (proxy && typeof proxy.spawn === 'function') {
				const root: any = (entity as any).getCombatantRoot
					? ((entity as any).getCombatantRoot() || entity) : entity;
				const spawnedBall = proxy.spawn(ballInfo.pos.x, ballInfo.pos.y, ballInfo.pos.z, root, ballInfo.dir);
				if (botName) this.neutralizeReplayBall(spawnedBall);
			}
		} catch (_) { /* a failed ball replay must never break the frame */ }
		return;
	}

	// `SHOOT_PROXY` settings are an internal shape that has shifted between
		// game versions; the values we pass are part of our own wire protocol, so
		// we cast rather than track the game's exact constructor types.
		const actonStep = new ig.ACTION_STEP.SHOOT_PROXY({ proxy: ballInfo.ballInfo, dir: ballInfo.dir } as any);
		actonStep.run(entity as sc.BasicCombatant);
	}

	/** 1.75.x: neutralize a relayed GENERIC skill-proxy copy (the heat mine & co.).
	 * The copy keeps its native action (blink/move/explode — full visual fidelity)
	 * but NEVER self-triggers: its TACKLE is a pure no-op. The old override counted
	 * contacts (cancelOnHit nulls attackInfo) so the art's timing played out — but
	 * on receivers the streamed puppet/mirror positions skew off the caster's local
	 * view, and a "contact" that the caster's real mine never saw tripped
	 * cancelOnHit the moment the TACKLE phase began: the mine exploded ~1.3s after
	 * placement for everyone watching (armed 1.1s + 0.2s) while the caster's own
	 * mine ran its full fuse. The copy's WAIT-driven native fuse is the single
	 * timing authority now; the real damage always arrives via the caster's
	 * combatHit/enemyDamage packets, and the copy's later damage steps
	 * (CIRCLE_ATTACK & co.) stay swallowed by the _mpProxyVisual gates. */
	private neutralizeProxyVisual(e: any): void {
		if (!e) return;
		try {
			e._mpProxyVisual = true;
			e._mpProxyVisualBorn = Date.now();
			e.checkTackle = function (_a: any, _c: any, _d: any): boolean {
				return false;
			};
		} catch (_) { /* visuals must never break sync */ }
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