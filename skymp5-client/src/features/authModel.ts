export interface RemoteAuthGameData {
  session: string;
  masterApiId: number | null;
  discordUsername: string | null;
  discordDiscriminator: string | null;
  discordAvatar: string | null;
  hwidHash?: string | null;
};

export interface LocalAuthGameData {
  profileId: number;
};

export interface AuthGameData {
  remote?: RemoteAuthGameData;
  local?: LocalAuthGameData;
};

export const authGameDataStorageKey = "authGameData";
