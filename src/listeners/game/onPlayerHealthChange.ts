import { Multiplayer } from '../../multiplayer';
import { PlayerListener } from './playerListener';

export class OnPlayerHealthChangeListener {
	private lastHp = -1;
	private lastSp = -1;
	// Element badge state (party-HUD portrait icon + overload overlay). Sent on
	// the same player-scoped updatePlayerStats channel: em = element mode (0-4),
	// el = elementLoad quantized to 0.05 steps (decay stays under ~2 pkt/s), ov =
	// hasOverload. Every send carries all three so a dropped packet self-heals.
	private lastEm = -1;
	private lastElQ = -1;
	private lastOv = false;

	constructor(
        private main: Multiplayer,
	) { }

	public register(playerListener: PlayerListener): void {
		const instance = this;
		playerListener.addChild((player: ig.ENTITY.Player) => {
			instance.onUpdate(player);
		});
	}

	private onUpdate(player: ig.ENTITY.Player): void {
		if (!player || !player.params) {
			return;
		}
		const params: any = player.params;
		const hp = params.currentHp;
		const sp = params.currentSp;

		// Element badge state for the party-HUD portrait (element mode / element
		// load / overload). Read from the player MODEL, not the entity.
		let em = 0;
		let elQ = 0;
		let ov = false;
		try {
			const pm: any = (sc as any).model && (sc as any).model.player;
			if (pm) {
				em = (typeof pm.currentElementMode === 'number' ? pm.currentElementMode : 0) | 0;
				ov = pm.hasOverload === true;
				// While overloaded the load drains at 4x — pin the reported value at 1
				// (full blinking fill) until the overload flag itself clears.
				const el = typeof pm.elementLoad === 'number' ? pm.elementLoad : 0;
				elQ = ov ? 1 : Math.round(el * 20) / 20;
			}
		} catch (e) { /* ignore */ }

		// Push whenever HP or SP changes (near-real-time). updatePlayerStats is
		// player-scoped (not host-gated) and feeds the in-game party HUD directly.
		if (hp !== this.lastHp || sp !== this.lastSp
			|| em !== this.lastEm || elQ !== this.lastElQ || ov !== this.lastOv) {
			this.lastHp = hp;
			this.lastSp = sp;
			this.lastEm = em;
			this.lastElQ = elQ;
			this.lastOv = ov;
			try {
				(this.main.connection as any).updatePlayerStats({
					hp,
					maxHp: params.getStat ? params.getStat('hp') : 0,
					sp,
					maxSp: params.maxSp,
					em,
					el: elQ,
					ov,
				});
			} catch (e) { /* ignore */ }
		}
	}
}
