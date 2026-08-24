export interface IBallInfo {
    ballInfo: string;
    combatant: number | string | null | undefined;
    dir: Vec2;
    party: number;
    /** 1.75.x: the engine's exact spawn coords (skill bursts need them — the
     * Burn! flame cone's startDist/offset). Optional; old senders omit it and
     * receivers fall back to the legacy face-point spawn. */
    pos?: Vec3;
}