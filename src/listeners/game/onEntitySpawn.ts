import { IBallInfo } from '../../ballInfo';
import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';

export class OnEntitySpawnListener {
	private unknownEntities: Array<string | typeof ig.Entity> = [];
	private recursiveEntities: Array<string | typeof ig.Entity> = [];
	/** Rate-limit for the null-enemyType spawn diagnostic (can be batchy). */
	private lastNullTypeLog = 0;
	private original!: <T extends ig.Entity>(type: string | (new(...args: any[]) => T),
											x: number,
											y: number,
											z: number,
											settings: any,
											showAppearEffects?: boolean) => T;

	constructor(
		private main: Multiplayer,
	) { }

	public register(): void {
		this.original = ig.game.spawnEntity;
		ig.game.spawnEntity = <T extends ig.Entity>(type: string | (new(...args: any[]) => T),
			x: number,
			y: number,
			z: number,
			settings: any,
			showAppearEffects?: boolean) => {
			const entity = (settings && settings.skipHook)
				? this.original.call(ig.game, type, x, y, z, settings, showAppearEffects) as T
				: this.onEntitySpawned(type as string | typeof ig.Entity, x, y, z, settings, showAppearEffects) as T;
			// Enemy.init leaves enemyType null when settings lack enemyInfo — such an
			// enemy is INVISIBLE and crashes in onKill. Repair when the type is
			// recoverable, otherwise log a stack so we can find the offending spawner.
			this.verifyEnemyType(type, entity, settings);
			return entity;
		};
	}

	private verifyEnemyType(type: string | (new(...args: any[]) => ig.Entity), entity: any, settings: any): void {
		try {
			// NOTE: the engine's EnemySpawner spawns with the CONSTRUCTOR
			// (ig.ENTITY.Enemy), not the string 'Enemy' — accept both forms.
			const isEnemy = type === 'Enemy' || type === (ig.ENTITY as any).Enemy;
			if (!isEnemy || !entity || entity.enemyType) return;
			const t = settings && settings.enemyInfo && settings.enemyInfo.type;
			if (t) {
				entity.enemyType = new sc.EnemyType(t);
				entity.enemyName = entity.enemyName || t;
				console.warn('[multiplayer] repaired NULL enemyType post-spawn (type=' + t + ')');
			} else {
				const now = Date.now();
				if (now - this.lastNullTypeLog > 2000) {
					this.lastNullTypeLog = now;
					console.warn('[multiplayer] Enemy spawned WITHOUT enemyInfo (invisible until killed; onKill guarded). stack: '
						+ ((new Error().stack || '').split('\n').slice(1, 6).join(' <- ')));
				}
			}
		} catch (_) { /* diagnostics must never break a spawn */ }
	}

	/** ROUND 164 (ice-skill sync): neutralize a proxy spawned BY a replayed visual
	 * copy (nested proxy-of-proxy). Same contract as
	 * OnThrownBallListener.neutralizeProxyVisual — kept in sync by hand: marked for
	 * the damage gates + 25s stale sweep, checkTackle/setTackle nooped, and a
	 * non-null target fallback so the TACKLE step can't insta-end-shatter it. */
	private neutralizeNestedProxyCopy(e: any): void {
		if (!e) return;
		try {
			e._mpProxyVisual = true;
			e._mpProxyVisualBorn = Date.now();
			e.checkTackle = function (): boolean { return false; };
			e.setTackle = function () { /* visual copy: tackle is motion-only */ };
			if (!e.target) e.target = e.combatant || e;
		} catch (_) { /* visuals must never break sync */ }
	}

	public onEntitySpawned(type: string | typeof ig.Entity,
		x: number,
		y: number,
		z: number,
		settings: any,
		showAppearEffects?: boolean): ig.Entity {
		// Static objects that never change or objects that should never be
		// synced. Entity classes in 1.4.x are distinct constructor types, so we
		// compare loosely (`unknown`) rather than against a shared ctor type.
		const blacklist: unknown[] = [
			'Marker',
			'HiddenBlock',
			ig.ENTITY.Player,
			ig.ENTITY.Crosshair,
			ig.ENTITY.CrosshairDot,
			ig.ENTITY.OffsetParticle,
			ig.ENTITY.RhombusParticle,
			ig.ENTITY.HiddenSkyBlock,
			ig.ENTITY.Effect,
			ig.ENTITY.Particle,
			ig.ENTITY.CopyParticle,
		];

		if (blacklist.indexOf(type) >= 0) {
			return this.original.call(ig.game, type, x, y, z, settings, showAppearEffects);
		}

		if (typeof type !== 'string' && (type as unknown) === (ig.ENTITY.Ball as unknown)) {
			const isLocalPlayerBall = settings.combatant === ig.game.playerEntity;
			// Only re-broadcast balls the LOCAL player threw. Remote-player mirrors
			// replay their own balls via onThrowBall, and enemy (NPC) balls are
			// simulated locally by the host — neither needs a lookup here. filterBall
			// only knows the player's proxies, so it can't resolve enemy ball types;
			// don't spam a warning for those.
			if (isLocalPlayerBall) {
				const ballSettings = this.filterBall(settings);
				// ROUND 164 (ice-skill sync diagnostics): opt-in [mpice] trace via
				// window._mpIceDiag = true. One art cast then pinpoints whether the
				// sender relay resolves the ball/proxy name at all.
				try { if ((window as any)._mpIceDiag) console.log('[mpice] TX ball name=' + (ballSettings ? ballSettings.ballInfo : 'UNRESOLVED') + ' pos=' + (x | 0) + ',' + (y | 0) + ',' + (z | 0)); } catch (_) { /* ignore */ }
				if (ballSettings) {
					// 1.75.x: ship the engine's exact spawn coords. Skill bursts
					// (SHOOT_PROXY_RANGE's startDist/offset — the Burn! flame cone)
					// otherwise collapse onto the mirror's face point on receivers.
					ballSettings.pos = { x, y, z };
					this.main.connection.throwBall(ballSettings);
				} else {
					console.warn('[multiplayer] Could not find type of ball (filterBall returned null). combatant=localPlayer');
				}
			} else {
				// 1.76.x (bot attack sync): one of OUR party bots (leader, native AI)
				// threw — relay it with the bot's name so receivers anchor the visual
				// on their bot puppet. The bot's own proxy set resolves the ball type.
				const bn = this.main.ownedBotNameOf(settings.combatant);
				if (bn) {
					const botBall = this.filterBotBall(settings, settings.combatant);
					if (botBall) {
						botBall.pos = { x, y, z };
						botBall.bn = bn;
						this.main.connection.throwBall(botBall);
					}
				}
			}
			return this.original.call(ig.game, type, x, y, z, settings, showAppearEffects);
		}

		// 1.75.x (player skill-proxy sync): GENERIC combat proxies (CombatProxyEntity)
		// placed by the LOCAL player's arts — the heat dash-art mines (mine/moveMine),
		// flameWall, meteorShower, wave/shock dash dummies, ... — are NOT Balls, so no
		// existing relay ever carried them and teammates saw nothing. Relay the spawn
		// over the throwBall channel as 'proxy:<name>'; the receiver replays a
		// visual-only copy on the caster's mirror (see onThrowBall 'proxy:' branch).
		// Proxies owned by mirrors/enemies never match the playerEntity gate, so this
		// cannot echo back from a receiver.
		try {
			const CPE: any = (sc as any).CombatProxyEntity;
			if (CPE && (type as unknown) === CPE && settings) {
				// ROUND 164 (ice-skill sync diagnostics): window._mpIceDiag = true logs
				// every GENERIC proxy relay decision ([mpice] TX proxy ...). Logging only.
				const iceDiag = !!(window as any)._mpIceDiag;
				// 1.76.x (bot attack sync): a BOT-owned generic proxy (the bot's dash-art
				// mines / walls) resolves against the BOT's own proxy set and relays
				// with the bot name.
				const botProxyName = this.main.ownedBotNameOf(settings.combatant);
				if (botProxyName) {
					let relayedName = ''; // ROUND 164
					const botProxies: any = (settings.combatant as any).proxies || {};
					for (const name in botProxies) {
						const p: any = botProxies[name];
						if (p && p.data && p.data === settings.data) {
							this.main.connection.throwBall({
								ballInfo: 'proxy:' + name,
								combatant: (settings.combatant as unknown as IMultiplayerEntity).multiplayerId,
								dir: settings.dir || { x: 0, y: 0 },
								party: 0,
								pos: { x, y, z },
								bn: botProxyName,
							});
							relayedName = name; // ROUND 164
							break;
						}
					}
					if (iceDiag) console.log('[mpice] TX proxy bot=' + botProxyName + ' name=' + (relayedName || 'NOMATCH') + ' pos=' + (x | 0) + ',' + (y | 0) + ',' + (z | 0));
				} else if (settings.combatant === ig.game.playerEntity) {
				let relayedName = ''; // ROUND 164
				const proxies: any = (ig.game.playerEntity as any).proxies || {};
				for (const name in proxies) {
					const p: any = proxies[name];
					// settings.data IS the proxy instance's own data object (GENERIC
					// spawn passes `data: this.data`), so identity match is exact.
					if (p && p.data && p.data === settings.data) {
						this.main.connection.throwBall({
							ballInfo: 'proxy:' + name,
							combatant: (ig.game.playerEntity as unknown as IMultiplayerEntity).multiplayerId,
							dir: settings.dir || { x: 0, y: 0 },
							party: 0,
							pos: { x, y, z },
						});
						relayedName = name; // ROUND 164
						break;
					}
				}
				if (iceDiag) console.log('[mpice] TX proxy player name=' + (relayedName || 'NOMATCH') + ' pos=' + (x | 0) + ',' + (y | 0) + ',' + (z | 0));
				} else if (iceDiag) {
					// ROUND 164: proxy owned by someone else (mirror replay copy, enemy,
					// nested proxy-of-proxy) — never relayed by design. Describe the owner
					// so we can tell a legit skip from a wrongly-classified player proxy.
					let who = 'other';
					try {
						const c: any = settings.combatant;
						if (c) {
							if (c.isPlayer) who = 'player?';
							else if ((c as any)._mpProxyVisual) who = 'replay-copy';
							else if (c.enemyType || c.enemyName) who = 'enemy:' + (c.enemyName || '?');
							else if ((c as any).multiplayerId !== undefined) who = 'mid:' + (c as any).multiplayerId;
							else who = (c.constructor && (c.constructor as any).name) || 'entity';
						} else who = 'null';
					} catch (_) { /* ignore */ }
					console.log('[mpice] TX proxy SKIP combatant=' + who + ' pos=' + (x | 0) + ',' + (y | 0) + ',' + (z | 0));
				}
			}
		} catch (_) { /* the proxy relay must never break a spawn */ }

		const entity = this.original.call(ig.game, type, x, y, z, settings, showAppearEffects) as IMultiplayerEntity;

		// ROUND 164 (ice-skill sync): a replayed visual copy's NESTED spawns (the
		// copy's own action SHOOT_PROXYs children — icicleBig → icicleSubLine → its
		// icicle line) arrive here with combatant = the copy, so the relay above
		// correctly skips them (they must not echo back over the wire). But they
		// spawn as LIVE proxies — neutralize them like their parent copy: no live
		// tackle and a guaranteed non-null target, or the TACKLE step's no-target
		// insta-end (non-player combatant) would shatter them on their first frame.
		try {
			const CPE2: any = (sc as any).CombatProxyEntity;
			if (CPE2 && (type as unknown) === CPE2 && entity && settings
				&& settings.combatant && (settings.combatant as any)._mpProxyVisual) {
				this.neutralizeNestedProxyCopy(entity);
			}
		} catch (_) { /* nested-copy neutralization must never break a spawn */ }

		const realType = this.findEntityType(type);
		if (realType === undefined) {
			if (this.unknownEntities.indexOf(type) === -1) {
				console.log('Unknown entity type spawned');
				this.unknownEntities.push(type);

				for (const key in sc) {
					if ((sc as any)[key] === type) {
						console.log(`Unkown entity is of type sc.${key}`);
					}
				}
			}

			return entity;
		}

		if (entity && !entity.multiplayerId) {
			entity.settings = settings;

			// 1.74.x: record map-enemy spawn data on the HOST so a late-joining guest's
			// encounter can be re-spawned after the host already cleared it (see
			// netSync.maybeRespawnStaleBattle).
			try {
				const Enemy = (ig.ENTITY as any).Enemy;
				if (this.main.host && Enemy && entity instanceof Enemy && (entity as any).mapId && this.main.netSync) {
					this.main.netSync.recordEnemySpawn((entity as any).mapId, x, y, z, settings);
				}
			} catch (_) { /* ignore */ }

			// Under the new block sync the host does NOT register/broadcast enemies here —
			// it streams the whole map's enemy state (keyed by stable mapId) at ~15Hz and
			// members spawn their own puppets. Skip registration so entities stay
			// multiplayerId-free (which is exactly what netSync's sendEnemyBlock expects).
			if (this.main.host && !this.main.useNetSync) {
				const mid = this.main.registerEntity(entity);

				// TODO: improve this (Maybe with a white/blacklist?)
				let isRecursive = false;

				if (this.recursiveEntities.includes(type)) {
					isRecursive = true;
				} else {
					try {
						JSON.stringify(settings);
					} catch (e: any) {
						if (e.name === 'TypeError') {
							isRecursive = true;
							this.recursiveEntities.push(type);
							console.log('Added type to recursive blacklist: ', this.findEntityType(type), type);
						} else {
							throw e;
						}
					}
				}

				this.main.connection.registerEntity(mid,
					realType,
					{x, y, z},
					isRecursive ? {} : settings);
			}

			entity.lastPosition = {x, y, z};
		}

		return entity;
	}

	/** 1.76.x (bot attack sync): resolve a BOT-thrown ball's proxy NAME against the
	 * bot entity's OWN proxy set (same data-identity match as filterBall). Returns
	 * null when the ball is not one of the bot's proxies (key/override balls — those
	 * stay unrelayed, exactly like the player path's unmatched case). */
	private filterBotBall(settings: {
		ballInfo: any
		combatant: ig.Entity,
		dir: Vec2,
		party: number,
	}, bot: ig.Entity): IBallInfo | null {
		const proxies: any = (bot as any).proxies;
		if (!proxies) return null;
		for (const name in proxies) {
			if (Object.prototype.hasOwnProperty.call(proxies, name)) {
				const proxy = proxies[name] as any;
				if (proxy !== undefined && proxy.data === settings.ballInfo) {
					return {
						ballInfo: name,
						combatant: (settings.combatant as IMultiplayerEntity).multiplayerId,
						dir: settings.dir,
						party: settings.party,
					};
				}
			}
		}
		return null;
	}

	private filterBall(settings: {
		ballInfo: any
		combatant: ig.Entity,
		dir: Vec2,
		party: number,
	}): IBallInfo | null {
		const player = ig.game.playerEntity;
		const proxies = player.proxies;

		for (const name in proxies) {
			if (Object.prototype.hasOwnProperty.call(proxies, name)) {
				// `data` is an internal field on proxy spawners that the type
				// definitions do not expose; access it loosely.
				const proxy = proxies[name] as any;
				if (proxy !== undefined && proxy.data === settings.ballInfo) {
					return {
						ballInfo: name,
						combatant:
							settings.combatant === null
								? null
								: (settings.combatant as IMultiplayerEntity).multiplayerId,
						dir: settings.dir,
						party: settings.party,
					};
				}
			}
		}

		// 1.72.0 (assault fix): equipment with the 强袭/ASSAULT modifier fires extra
		// projectiles from the engine's shared per-element templates
		// (sc.ASSAULT_PROJECTILES[element]) — never one of the player's proxies, so
		// the loop above missed them and EVERY swing logged "Could not find type of
		// ball". Identify by template identity and relay as 'assault:<elementKey>';
		// the receiver spawns the same template (see onThrowBall).
		// 1.73.x: BallInfo.spawn passes ballInfo: this.DATA (the raw config), NOT the
		// BallInfo instance — the old instance-identity check never matched and every
		// assault ball fell through to the generic fallback, so members saw a pile of
		// normal ranged balls. Compare data first, instance as a defensive fallback.
		const assault: any = (sc as any).ASSAULT_PROJECTILES;
		if (assault && settings.ballInfo) {
			for (const el in assault) {
				if (Object.prototype.hasOwnProperty.call(assault, el)
					&& (assault[el] === settings.ballInfo
						|| (assault[el] && assault[el].data === settings.ballInfo))) {
					return {
						ballInfo: 'assault:' + el,
						combatant:
							settings.combatant === null
								? null
								: (settings.combatant as IMultiplayerEntity).multiplayerId,
						dir: settings.dir,
						party: settings.party,
					};
				}
			}
		}

		// 1.75.x (dungeon-key VISUAL-ONLY sync): relay the key throw again so
		// teammates SEE the key ball fly, but the receiver replays a NEUTRALIZED
		// copy (onThrowBall 'key:' branch — no attackInfo, no collisions) that can
		// never open their key walls/doors. Key-locked progression stays
		// per-client: each player unlocks their own walls with their own keys.
		// Match the live override by identity ('DUNGEON_KEY'/'DUNGEON_MASTER_KEY'
		// hinted ball swapped in by the active KeyPanel via playerEntity.overrideBall).
		const playerEnt: any = ig.game.playerEntity;
		const overrideBall: any = playerEnt && playerEnt.overrideBall;
		if (overrideBall && overrideBall.data === settings.ballInfo) {
			let kind = 'regular';
			try {
				const hints: any = settings.ballInfo.attack && settings.ballInfo.attack.hints;
				if (hints && hints.indexOf('DUNGEON_MASTER_KEY') !== -1) kind = 'master';
			} catch (_) { /* default to regular */ }
			return {
				ballInfo: 'key:' + kind,
				combatant:
					settings.combatant === null
						? null
						: (settings.combatant as IMultiplayerEntity).multiplayerId,
				dir: settings.dir,
				party: settings.party,
			};
		}

		// 1.72.0 (future-proofing): any OTHER unrecognized local ball (inline
		// event proxies, modded spawners, future override types) must never hit
		// this log-and-drop path again. Relay it as 'generic:<defaultProxyName>'
		// — the receiver replays the thrower's default neutral ball as a visual
		// stand-in (remote balls deal no local damage anyway; combat flows via
		// the combatHit relay), so the throw is always visible and the warning
		// below stays reserved for a genuinely broken state (no default proxy).
		const fallback = this.defaultProxyName(player);
		if (fallback) {
			return {
				ballInfo: 'generic:' + fallback,
				combatant:
					settings.combatant === null
						? null
						: (settings.combatant as IMultiplayerEntity).multiplayerId,
				dir: settings.dir,
				party: settings.party,
			};
		}

		return null;
	}

	/** The proxy name of the player's DEFAULT neutral ball — used as the wire
	 * stand-in for ball types we cannot identify (see filterBall's generic
	 * fallback). */
	private defaultProxyName(player: any): string | null {
		try {
			const cfg: any = (sc as any).PlayerConfig;
			if (!cfg || typeof cfg.getElementBall !== 'function') return null;
			const root: any = player && player.getCombatantRoot ? player.getCombatantRoot() : player;
			const def: any = cfg.getElementBall(root, (sc as any).ELEMENT.NEUTRAL, false);
			if (!def) return null;
			const proxies = player.proxies;
			for (const name in proxies) {
				if (Object.prototype.hasOwnProperty.call(proxies, name) && proxies[name] === def) return name;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	private findEntityType(type: string | typeof ig.Entity): string | undefined {
		if (typeof type === 'string') {
			return type;
		}

		for (const t in ig.ENTITY) {
			if ((ig.ENTITY as any)[t] === type) {
				return t;
			}
		}
	}
}