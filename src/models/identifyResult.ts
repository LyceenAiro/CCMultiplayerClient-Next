interface IIdentifyResult {
    success: boolean;
    host: boolean;
    mapName: string | null;
    /** ROUND 103: first-ever login for this account (no server save yet). */
    isNew?: boolean;
    /** Server-side save to restore on login, or null if none. */
    save?: { slot: string, data: string } | null;
    /** Round 16 (issue 4): server-provided per-extra-player enemy max-HP
     * fraction (config.json monsterHpPerPlayer, default 0.7 = +70% HP per extra
     * player in the room). The HOST client applies it using its room player
     * count (1.75.x: room-based, not party-roster-based). */
    hpScale?: number;
    /** 1.76.x: the same scheme, but ONLY for boss enemies (enemyType.boss) —
     * config.json monsterBossHpPerPlayer, default 1.0 = +100% HP per extra
     * player in the room. Regular enemies keep hpScale. */
    hpScaleBoss?: number;
    /** Same scheme for the hit-count break threshold (config.json
     * monsterBreakPerPlayer, default 0.7 = +70% per extra player in the room). */
    breakScale?: number;
    /** Same scheme for the elemental-status THRESHOLD (config.json
     * monsterStatusThresholdPerPlayer, default 0.6 = +60% bar-fill required per
     * extra player in the room). The HOST divides enemy statusInflict
     * susceptibility by 1 + statusScale * (playersInRoom - 1). */
    statusScale?: number;
    /** 1.74.x: whether online players collide with each other (config.json
     * playerCollision, default false = always walk-through). */
    playerCollision?: boolean;
    /** Soft-death revive HP fraction for normal (non-boss) combat revives
     * (config.json softDeathReviveHpNormal, default 0.5 = 50%). */
    softDeathReviveHpNormal?: number;
    /** Soft-death revive HP fraction while a boss battle is active
     * (config.json softDeathReviveHpBoss, default 0.25 = 25%). */
    softDeathReviveHpBoss?: number;
    /** Soft-death revive countdown in seconds for normal combat (config.json
     * softDeathReviveTimeNormal, default 30). */
    softDeathReviveTimeNormal?: number;
    /** Soft-death revive countdown in seconds for boss combat (config.json
     * softDeathReviveTimeBoss, default 30). */
    softDeathReviveTimeBoss?: number;
    /** Same scheme for the attack/defense/focus stats (defaults 0.1 = +10% per
     * extra party member). */
    attackScale?: number;
    defenseScale?: number;
    focusScale?: number;
    /** Elemental-resistance adjustments per extra member: FLAT points (as a
     * fraction, 0.1 = +10pt) and a PERCENTAGE boost that only applies to
     * positive resistance (never weaknesses). Both default 0 = no adjustment. */
    resistFlat?: number;
    resistPercent?: number;
    /** Member perfect-guard compensation (server config): after a monster hit
     * lands on a member, raising guard within (perfectGuardBaseMs +
     * perfectGuardPingFactor x RTT-to-host) still counts as a PERFECT guard and
     * the hit deals no damage while that window is open. Each part disables at
     * 0; older servers omit both -> client falls back to the defaults 30 / 0.6. */
    perfectGuardBaseMs?: number;
    perfectGuardPingFactor?: number;
    /** 1.71.0: save-mirror metadata in mirror-rollback mode (newest first). */
    mirrors?: Array<{ index: number, at: string, slot: string, bytes: number }>;
}
