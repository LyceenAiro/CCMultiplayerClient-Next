import { Multiplayer } from '../multiplayer';

/**
 * 1.76.x (temporary cutscene companions).
 *
 * Some story scenes REQUIRE a party bot: triggers gated on
 * `party.has.X`/`party.alive.X` never fire without the companion, and event
 * steps animate her through `{"party":"Emilie"}` entity fetches, which resolve
 * via `sc.party.getPartyMemberEntity(name)` -> `partyEntities[name]`. In
 * multiplayer the follower roster is player-driven, so a bot the story expects
 * (Emilie in the Schneider meeting, Emilie+Glasses on autumn-fall, ...) can be
 * missing entirely: the trigger stays silent or the step derefs null and the
 * scene dies half-way (soft-lock, story vars never set).
 *
 * This module makes those scenes playable WITHOUT the bot in the party:
 *   1. `party.has.X`/`party.alive.X` var reads report TRUE for an absent
 *      official companion while connected (alive keeps the native dungeon
 *      block), so companion-gated triggers fire at all — and `party.size`
 *      (a pure script var; engine code uses getPartySize() directly) reports
 *      a FULL vanilla party (3) so size-routed scenes take the "companions
 *      present" variant consistently with the faked has/alive answers;
 *   2. when the RUNNING scene then resolves the bot's entity by name and finds
 *      nothing, a TEMPORARY PartyMemberEntity is spawned on the spot
 *      (vanilla `_spawnPartyMemberEntity` — pops in next to the player, no
 *      appear effect, exactly like the engine's own mid-scene adds);
 *   3. the temp bot is LOCAL-ONLY: it is never pushed into currentParty, so
 *      the leader botState stream, the party HUD, the enemy target pool and
 *      every roster iteration skip it; it is not an Enemy and carries no
 *      multiplayerId, so entity/pos/anim sync never touches it — nobody else
 *      can see it and nothing about it is ever broadcast;
 *   4. it cannot die while it acts (`model.noDie` set for the temp window,
 *      restored afterwards — the model object is persistent);
 *   5. cleanup runs once the scene is over (events idle ~1.5s, map change,
 *      disconnect): `_removePartyMemberEntity` removes it. If the REAL
 *      machinery adopted it meanwhile — the story added the bot for real
 *      (ADD_PARTY_MEMBER -> currentParty) or the party leader's botState
 *      stream puppeted it (_mpPuppet) — ownership stays with that machinery
 *      and only the temp tag is dropped, so a teammate carrying the real bot
 *      into the room can never crash against our copy.
 *
 * Nothing changes while offline: every gate requires an open connection.
 */

export interface ITempPartyBotSupport {
	install(): void;
	/** Event/cutscene context + companion eligibility gate for name lookups. */
	shouldSpawnForEvent(party: any, name: string): boolean;
	/** Spawn (or re-tag) the temp companion entity. Never throws. */
	spawnTemp(party: any, name: string): any;
	/** Remove every live temp companion (adopted ones are kept). Never throws. */
	cleanupTemps(reason: string): void;
}

let shared: TempPartyBotSupport | null = null;

export function installTempPartyBotSupport(getMain: () => Multiplayer | undefined): ITempPartyBotSupport {
	if (!shared) shared = new TempPartyBotSupport(getMain);
	return shared;
}

/** How long the event system must be fully idle before temp companions vanish. */
const IDLE_SWEEP_MS = 1500;

class TempPartyBotSupport implements ITempPartyBotSupport {
	private installed = false;
	/** Names of the live temp bots we spawned (partyEntities key -> true). */
	private temps: { [name: string]: boolean } = {};
	/** When the event system first looked idle with temps active (0 = busy). */
	private idleSince = 0;

	constructor(private getMain: () => Multiplayer | undefined) { }

	public install(): void {
		if (this.installed) return;
		this.installed = true;
		const self = this;
		try {
			(sc as any).PartyModel.inject({
				// Name-based resolution used by ig.Event.getEntity({party:"X"}).
				// Native: partyEntities[name] || null. On a MISS (or a stale
				// corpse) while a scene is running, materialize the temp bot.
				getPartyMemberEntity(this: any, name: string) {
					const e = this.parent(name);
					if (e && !e._killed) return e;
					// A corpse (map unload / killed mid-scene) is not a usable
					// actor: drop the key so a fresh spawn is possible.
					if (e && e._killed) { try { delete this.partyEntities[name]; } catch (_) { /* ignore */ } }
					try {
						if (self.shouldSpawnForEvent(this, name)) {
							const t = self.spawnTemp(this, name);
							if (t && !t._killed) return t;
						}
					} catch (_) { /* never break entity resolution */ }
					return null;
				},
				// Trigger / IF conditions reading party state: report absent
				// official companions as present while connected, so bot-gated
				// story triggers fire. Never overrides a natively true answer.
				onVarAccess(this: any, a: any, b: any) {
					try {
						if (b && b[0] === 'party') {
							const kind = b[1];
							// party.size feeds ONLY script branch routing — nothing in
							// the engine reads the var (elevators, combat, aggro pools
							// all call sc.party.getPartySize() directly and stay
							// truthful). While temp cover is active, answer with a FULL
							// vanilla party (player + 2 companions = 3) so size==3 /
							// size==2 routing chains resolve the "everyone's here"
							// variant, consistently with the faked has/alive answers.
							// (The Faj'ro door otherwise saw size==2 with both has.*
							// true and played BOTH "bring the other one" warnings.)
							if (kind === 'size') return self.shouldCoverAny(this) ? 3 : this.parent(a, b);
							if (kind === 'has' || kind === 'alive') {
								const r = this.parent(a, b);
								if (r) return r; // natively satisfied — never override a real member
								if (!self.shouldCover(this, b[2])) return r;
								// "alive" keeps the native dungeon block: follower bots
								// never appear inside dungeons, so dungeon scenes stay
								// untouched.
								return kind === 'has' ? true : !this.dungeonBlocked;
							}
						}
					} catch (_) { /* fall through to native */ }
					return this.parent(a, b);
				},
			});
			console.log('[mptempbot] temporary cutscene companion support installed');
		} catch (e) {
			console.warn('[mptempbot] install failed', e);
		}
		try {
			simplify.registerUpdate(() => { try { self.sweep(); } catch (_) { /* never break the frame */ } });
		} catch (_) { /* ignore */ }
		// Diagnostic: window.__mpTempBots() -> tracked temp companions + state.
		(window as any).__mpTempBots = () => {
			try {
				const party: any = (sc as any).party;
				const out: { [name: string]: string } = {};
				for (const n in self.temps) {
					const e = party && party.partyEntities && party.partyEntities[n];
					out[n] = !e ? 'missing' : (e._killed ? 'killed' : ((e as any)._mpPuppet ? 'adopted(puppet)' : 'alive'));
				}
				console.log('[mptempbot] tracked: ' + JSON.stringify(out)
					+ ' / cutscene=' + !!((sc as any).model && (sc as any).model.isCutscene && (sc as any).model.isCutscene())
					+ ' / events=' + ((ig as any).game && (ig as any).game.events ? (ig as any).game.events.runningEventCalls.length : -1));
				return out;
			} catch (e) { return null; }
		};
	}

	/** 0.2.6: a story cutscene has already converted companions into map NPCs
	 * (`map.partyNPCs = true`, e.g. Faj'ro roof PostExpoScene). NPC spawn
	 * conditions are `map.partyNPCs && !party.has.X` — faking has here keeps
	 * those NPCs permanently hidden and leaves leftover followers talking
	 * over the handoff. Cover must go honest the moment the handoff flag is set. */
	private storyNpcHandoffActive(): boolean {
		try {
			const vars: any = (ig as any).vars;
			return !!(vars && typeof vars.get === 'function' && vars.get('map.partyNPCs'));
		} catch (_) { return false; }
	}

	/** True while connected and AT LEAST ONE official companion is absent and
	 * temp-coverable (in practice: whenever connected — some companion is
	 * almost always missing). Drives the party.size script-var answer. */
	public shouldCoverAny(party: any): boolean {
		try {
			if (!this.connected()) return false;
			if (this.storyNpcHandoffActive()) return false;
			if (!party || !party.models) return false;
			const opts: string[] = (sc as any).PARTY_OPTIONS || [];
			for (const name of opts) {
				if (!name || name === 'Lea') continue;
				const model = party.models[name];
				if (!model || model._mpName) continue;
				if (party.currentParty && party.currentParty.indexOf(name) !== -1) continue;
				return true;
			}
		} catch (_) { /* ignore */ }
		return false;
	}

	/** Official, non-network, currently-absent companion eligible for temp cover. */
	public shouldCover(party: any, name: any): boolean {
		try {
			if (!name || typeof name !== 'string' || name === 'Lea') return false; // Lea is the player herself
			if (!this.connected()) return false;
			if (this.storyNpcHandoffActive()) return false;
			const opts: string[] = (sc as any).PARTY_OPTIONS || [];
			if (opts.indexOf(name) === -1) return false; // official companions only
			if (!party || !party.models) return false;
			const model = party.models[name];
			if (!model || model._mpName) return false; // network player alias — never a bot
			if (party.currentParty && party.currentParty.indexOf(name) !== -1) return false; // really present
			return true;
		} catch (_) { return false; }
	}

	public shouldSpawnForEvent(party: any, name: string): boolean {
		try {
			if (!this.shouldCover(party, name)) return false;
			const g: any = (ig as any).game;
			if (!g || !g.playerEntity || (ig as any).loading) return false;
			if (typeof g.isTeleporting === 'function' && g.isTeleporting()) return false;
			// Only materialize the bot while a scene is actually RUNNING —
			// otherwise any stray lookup (HUD polling, our own helpers) would
			// pop a companion out of thin air.
			const scAny: any = sc as any;
			const inCutscene = !!(scAny.model && typeof scAny.model.isCutscene === 'function' && scAny.model.isCutscene());
			const ev: any = g.events;
			const inEvent = !!(ev && ev.runningEventCalls && ev.runningEventCalls.length > 0);
			return inCutscene || inEvent;
		} catch (_) { return false; }
	}

	public spawnTemp(party: any, name: string): any {
		try {
			let e = party.partyEntities && party.partyEntities[name];
			if (e && e._killed) { try { delete party.partyEntities[name]; } catch (_) { /* ignore */ } e = null; }
			// Vanilla mid-scene add semantics: position behind the player, NO
			// appear effect (same as ADD_PARTY_MEMBER's immediate-spawn path).
			if (!e) e = party._spawnPartyMemberEntity(name, false, false);
			if (!e) return null;
			(e as any)._mpTempBot = true;
			if (!this.temps[name]) {
				this.temps[name] = true;
				const model = party.models && party.models[name];
				if (model && !('_mpTempNoDieWas' in model)) {
					model._mpTempNoDieWas = !!model.noDie;
					model.noDie = true; // a scene actor must not die mid-cutscene
				}
				console.log('[mptempbot] spawned temporary companion "' + name + '" for the running scene (local-only, never synced)');
			}
			return e;
		} catch (err) {
			console.warn('[mptempbot] temp spawn failed for "' + name + '"', err);
			return null;
		}
	}

	public cleanupTemps(reason: string): void {
		let party: any = null;
		try { party = (sc as any).party; } catch (_) { /* ignore */ }
		for (const name in this.temps) {
			delete this.temps[name];
			try { this.restoreNoDie(party, name); } catch (_) { /* ignore */ }
			if (!party || !party.partyEntities) continue;
			const e: any = party.partyEntities[name];
			if (!e) continue;
			if (e._killed) { try { delete party.partyEntities[name]; } catch (_) { /* ignore */ } continue; }
			// Adopted by the real machinery meanwhile: the story added the bot
			// for real (ADD_PARTY_MEMBER -> currentParty) or the party leader's
			// botState stream puppeted it (_mpPuppet). Ownership moved off the
			// temp path — keep the entity, just drop our tag.
			if ((party.currentParty && party.currentParty.indexOf(name) !== -1) || e._mpPuppet) {
				try { delete e._mpTempBot; } catch (_) { /* ignore */ }
				continue;
			}
			try {
				party._removePartyMemberEntity(name, null, true);
				console.log('[mptempbot] removed temporary companion "' + name + '" (' + reason + ')');
			} catch (_) {
				try { e.kill(); } catch (_) { /* ignore */ }
				try { delete party.partyEntities[name]; } catch (_) { /* ignore */ }
			}
		}
	}

	private restoreNoDie(party: any, name: string): void {
		const model = party && party.models && party.models[name];
		if (model && ('_mpTempNoDieWas' in model)) {
			model.noDie = !!model._mpTempNoDieWas;
			try { delete model._mpTempNoDieWas; } catch (_) { /* ignore */ }
		}
	}

	private connected(): boolean {
		try {
			const m = this.getMain();
			return !!(m && m.connection && typeof m.connection.isOpen === 'function' && m.connection.isOpen());
		} catch (_) { return false; }
	}

	/** Per-frame sweeper: once the scene is over (no cutscene mode, no BLOCKING
	 * event, not loading/teleporting) for IDLE_SWEEP_MS, remove every temp
	 * companion. Covers cutscene end, plain blocking events, map changes (the
	 * entities die with the old map) and disconnects — no engine-hook needed.
	 * 1.77.x fix: the busy check used to hold while ANY event call was running,
	 * but long-lived/permanent PARALLEL event calls (map ambience controllers,
	 * a wedged call from a diverged scene) never drain — temps then survived
	 * the scene forever ("临时NPC在剧情结束后没有移除"). Blocking-scene
	 * semantics are the correct gate: a temp bot only ever serves a cutscene,
	 * and a parallel event that still references it re-spawns it on demand via
	 * the getPartyMemberEntity hook (self-healing). */
	private sweep(): void {
		let busy = true;
		try {
			const g: any = (ig as any).game;
			const scAny: any = sc as any;
			busy = !!(ig as any).loading
				|| !!(scAny.model && typeof scAny.model.isCutscene === 'function' && scAny.model.isCutscene())
				|| !!(g && g.events && g.events.blockingEventCall)
				|| !!(g && typeof g.isTeleporting === 'function' && g.isTeleporting());
		} catch (_) { busy = true; }
		if (busy) { this.idleSince = 0; return; }
		const now = Date.now();
		if (!this.idleSince) { this.idleSince = now; return; }
		if (now - this.idleSince >= IDLE_SWEEP_MS) {
			this.idleSince = 0;
			this.cleanupTemps('scene finished');
			this.repairStoryNpcHandoff();
		}
	}

	/** 0.2.6 (Faj'ro roof / PostExpoScene): the scene tail is
	 *   map.partyNPCs=true → REMOVE_PARTY_MEMBER(Emilie/Glasses, npc:emilie/ctron)
	 *   → DO_ACTION on those NPCs → SET_PERMA_TASK "talk to them at the south".
	 * REMOVE_PARTY_MEMBER is a no-op when the member is not in currentParty
	 * (temp-only companions), and a conversion that races the fake party.has
	 * can leave the follower entity alive. After the scene goes idle, finish
	 * the handoff by hand so the map NPCs can spawn and nothing keeps following. */
	private repairStoryNpcHandoff(): void {
		try {
			if (!this.storyNpcHandoffActive()) return;
			const g: any = (ig as any).game;
			if (!g || !g.playerEntity || (ig as any).loading) return;
			if (typeof g.isTeleporting === 'function' && g.isTeleporting()) return;
			const ev: any = g.events;
			if (ev && ev.blockingEventCall) return;
			const scAny: any = (sc as any);
			if (scAny.model && typeof scAny.model.isCutscene === 'function' && scAny.model.isCutscene()) return;
			const party: any = scAny.party;
			if (!party) return;
			const pairs: Array<[string, string]> = [['Emilie', 'emilie'], ['Glasses', 'ctron']];
			let fixed = false;
			for (const pair of pairs) {
				const member = pair[0];
				const npcName = pair[1];
				try {
					const isMember = !!(party.isPartyMember && party.isPartyMember(member));
					const ent: any = party.partyEntities && party.partyEntities[member];
					const leftover = !!(ent && !ent._killed && !isMember);
					if (!isMember && !leftover) continue;
					let npc: any = null;
					try { npc = g.getEntityByName ? g.getEntityByName(npcName) : null; } catch (_) { npc = null; }
					if (isMember) {
						party.removePartyMember(member, npc, false);
						fixed = true;
						console.warn('[mptempbot] story NPC handoff: removed leftover party member "'
							+ member + '" (map.partyNPCs)');
					} else if (leftover) {
						try { party._removePartyMemberEntity(member, npc, true); } catch (_) {
							try { ent.kill(); } catch (_) { /* ignore */ }
							try { delete party.partyEntities[member]; } catch (_) { /* ignore */ }
						}
						fixed = true;
						console.warn('[mptempbot] story NPC handoff: culled leftover follower entity "'
							+ member + '"');
					}
				} catch (err) {
					console.warn('[mptempbot] story NPC handoff failed for "' + member + '"', err);
				}
			}
			if (fixed) {
				try { if (typeof g.varsChangedDeferred === 'function') g.varsChangedDeferred(); } catch (_) { /* ignore */ }
			}
			// Belt-and-braces: once the members are gone, force the map NPCs
			// visible if they exist but stayed hidden (spawnCondition was false
			// while the fake party.has held). Same idea as the Schneider repair.
			try {
				const partyHas = (n: string): boolean => {
					try { return !!(party.isPartyMember && party.isPartyMember(n)); } catch (_) { return false; }
				};
				if (!partyHas('Emilie') && !partyHas('Glasses')) {
					const ents: any[] = (g.entities || []);
					for (const e of ents) {
						if (!e || e._killed || typeof e.name !== 'string') continue;
						const n = e.name;
						if (n !== 'emilie' && n !== 'ctron') continue;
						const wasHidden = !!e.hidden;
						const wasInvisible = !!(e.animState && e.animState.alpha === 0);
						if (!wasHidden && !wasInvisible) continue;
						if (wasHidden) { e.hidden = false; }
						if (wasInvisible) { e.animState.alpha = 1; }
						try {
							if (typeof e.updateNpcState === 'function') e.updateNpcState(true);
							else if (typeof e.show === 'function') e.show();
						} catch (_) { /* ignore */ }
						fixed = true;
						console.warn('[mptempbot] story NPC handoff: forced NPC "' + n + '" visible');
					}
				}
			} catch (_) { /* ignore */ }
		} catch (_) { /* never break the frame */ }
	}
}
