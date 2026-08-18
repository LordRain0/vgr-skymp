export interface MasterApiAuthStatus {
    token: string;
    masterApiId: number | null;
    discordUsername: string | null;
    discordDiscriminator: string | null;
    discordAvatar: string | null;
}
