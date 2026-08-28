export interface IBallInfo {
    ballInfo: string;
    combatant: number | string | null | undefined;
    dir: Vec2;
    party: number;
    /** 1.75.x: the engine's exact spawn coords (skill bursts need them — the
     * Burn! flame cone's startDist/offset). Optional; old senders omit it and
     * receivers fall back to the legacy face-point spawn. */
    pos?: Vec3;
    /** 1.76.x (bot attack sync): the thrower is one of the SENDER's party bots —
     * receivers anchor the replay on that bot's puppet instead of the sender's
     * mirror. The server still stamps `combatant` with the sender's username. */
    bn?: string;
}