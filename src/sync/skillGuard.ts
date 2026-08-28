/**
 * 1.76.x (circuit branch flip guard): intermittent MP bug — mid-combat, one of
 * the player's orBranch combat arts starts behaving as the OTHER branch variant
 * while the circuit menu still shows the original branch as active; re-toggling
 * the branch fixes it. A re-toggle only re-runs switchBranch -> updateStats with
 * an UNCHANGED skills[] array, which proves the live element-config activeActions
 * map had diverged from model.skills[] (behavior source) while skills[] (menu
 * source) stayed correct. The mod never writes the skill model directly, so this
 * module (a) logs every skill-mutating engine entry point with a stack trace to
 * catch the real trigger red-handed, and (b) runs a 2s watchdog that detects an
 * activeActions-vs-skills divergence and re-applies updateStats() — the exact
 * operation the user's manual branch re-toggle performs — so behavior silently
 * re-syncs to the menu state even before the trigger is identified.
 *
 * Also detects the "both orBranch siblings learned" anomaly (learnSkill does not
 * null the sibling; switchBranch does): behavior then follows the higher uid
 * while the branch connection lines can still render the LEFT variant for some
 * tree directions (vanilla _drawOrBranchConnection quirk) — menu looks normal.
 */

type AnyRec = Record<string, any>;

function combatState(): string {
	try {
		const scAny: AnyRec = (window as any).sc;
		const c = scAny && scAny.combat;
		const active = c && typeof c.isCombatActive === 'function' ? c.isCombatActive() : (c && c.active);
		return active ? '1' : '0';
	} catch (_) { return '?'; }
}

function mapName(): string {
	try { return String(((window as any).ig && (window as any).ig.game && (window as any).ig.game.mapName) || '?'); }
	catch (_) { return '?'; }
}

function shortStack(): string {
	try {
		const s = new Error().stack || '';
		return s.split('\n').slice(2, 8).join(' <- ').slice(0, 600);
	} catch (_) { return ''; }
}

/** Wrap one PlayerModel mutator: log name + args + combat state + stack. */
function wrapMutator(proto: AnyRec, name: string, logCount: AnyRec): void {
	const orig = proto[name];
	if (typeof orig !== 'function') return;
	proto[name] = function (this: any, ...args: any[]) {
		try {
			if ((logCount[name] || 0) < 30) {
				logCount[name] = (logCount[name] || 0) + 1;
				// preLoad fires on every game load — skip its stack to keep noise down.
				const stk = name === 'preLoad' ? '' : (' | ' + shortStack());
				console.log('[mpskill] ' + name + '(' + args.map((a) => {
					try { return typeof a === 'object' ? JSON.stringify(a).slice(0, 80) : String(a); }
					catch (_) { return '?'; }
				}).join(',') + ') combat=' + combatState() + ' map=' + mapName() + stk);
			}
		} catch (_) { /* logging must never break the call */ }
		return orig.apply(this, args);
	};
}

export function installSkillGuard(): void {
	try {
		const w: AnyRec = window as any;
		if (w.__mpSkillGuardInstalled) return;
		w.__mpSkillGuardInstalled = true;
		const scAny: AnyRec = w.sc;
		const PM: AnyRec = scAny && scAny.PlayerModel;
		if (!PM || !PM.prototype) { console.warn('[mpskill] PlayerModel not found — guard inactive'); return; }

		// (a) Trigger hunt: every engine path that can mutate the skill model.
		const logCount: AnyRec = {};
		for (const name of ['learnSkill', 'unlearnSkill', 'switchBranch', 'resetSkillTree', 'setLevel', 'preLoad']) {
			try { wrapMutator(PM.prototype, name, logCount); } catch (_) { /* ignore */ }
		}

		// (b) Watchdog: verify activeActions matches skills[] for every learned
		// SpecialSkill (the orBranch combat arts); repair via updateStats() — the
		// same re-apply the user's manual branch re-toggle triggers.
		const bothLearnedSeen = new Set<string>();
		let repairs = 0;
		setInterval(() => {
			try {
				const p: AnyRec = scAny.model && scAny.model.player;
				if (!p || !p.skills || !p.elementConfigs) return;
				const PA: AnyRec = scAny.PLAYER_ACTION || {};
				const skills: any[] = p.skills;
				const diverged: string[] = [];
				for (let uid = 0; uid < skills.length; uid++) {
					const s: AnyRec = skills[uid];
					if (!s || !s.skillType || !s.branchType) continue; // SpecialSkill only
					const key = s.skillType + '_SPECIAL' + s.level;
					const slot = PA[key];
					if (!slot) continue;
					const cfg: AnyRec = p.elementConfigs[s.element];
					if (!cfg || !cfg.actions || !cfg.activeActions) continue;
					// Both-siblings anomaly: the NEXT uid is the same art's other branch.
					// applyOnConfigs runs ascending, so the sibling (higher uid) wins —
					// treat ITS action as expected here (reported separately, no repair).
					const sib: AnyRec = skills[uid + 1];
					const bothLearned = !!(sib && sib.skillType === s.skillType && sib.level === s.level && sib.branchType && sib.branchType !== s.branchType);
					if (bothLearned) {
						const tag = s.element + ':' + key + ':' + uid;
						if (!bothLearnedSeen.has(tag)) {
							bothLearnedSeen.add(tag);
							console.warn('[mpskill] ANOMALY: both orBranch variants learned for ' + key
								+ ' (uids ' + uid + '/' + (uid + 1) + ', element ' + s.element
								+ ') — behavior follows uid ' + (uid + 1) + ' (branch ' + sib.branchType
								+ ') while the circuit menu can still show branch ' + s.branchType
								+ '. combat=' + combatState() + ' map=' + mapName());
						}
					}
					const eff: AnyRec = bothLearned ? sib : s;
					const other = eff.branchType === 'A' ? 'B' : 'A';
					const expected = cfg.actions[key + '_' + eff.branchType] || cfg.actions[key + '_' + other] || null;
					const actual = cfg.activeActions[slot] || null;
					if (expected && actual !== expected) {
						diverged.push(key + '_' + eff.branchType + '@el' + s.element + '(uid ' + uid + ')');
					}
				}
				if (diverged.length) {
					repairs++;
					console.warn('[mpskill] DIVERGENCE: activeActions out of sync with skills[]: '
						+ diverged.join(', ') + ' — re-applying updateStats() (repair #' + repairs + ')'
						+ ' combat=' + combatState() + ' map=' + mapName());
					p.updateStats();
				}
			} catch (_) { /* watchdog must never throw */ }
		}, 2000);
		console.log('[mpskill] skill-branch guard installed');
	} catch (e) {
		try { console.warn('[mpskill] guard install failed', e); } catch (_) { /* ignore */ }
	}
}
