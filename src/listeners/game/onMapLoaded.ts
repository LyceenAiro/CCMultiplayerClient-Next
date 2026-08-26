import { Multiplayer } from '../../multiplayer';

export class OnMapLoadedListener {

	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		// Run after each game tick via Simplify's update registry (the same
		// mechanism the entity/player listeners use), rather than overwriting
		// `ig.game.update` directly.
		simplify.registerUpdate(() => {
			this.afterUpdate();
		});
	}

	public afterUpdate(): void {
		// 1.75.x: destructible-persistence reapply now runs from netSync.tick's
		// map-change branch (plus a 1s same-map safety net), so it is NOT called
		// here anymore — this listener runs BEFORE netSync.tick, where
		// netSync.mapName still names the PREVIOUS map and a reapply could kill
		// an unrelated entity that shares a mapId on the new map.
		while (this.main.futureEntities.length > 0) {
			this.main.spawnMultiplayerEntity(this.main.futureEntities[0]);
			this.main.futureEntities.shift();
		}
	}
}
