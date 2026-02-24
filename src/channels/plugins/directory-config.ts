import type { OpenClawConfig } from "../../config/types.js";
import type { ChannelDirectoryEntry } from "./types.js";

export type DirectoryConfigParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  query?: string | null;
  limit?: number | null;
};

async function emptyDirectoryResult(
  _params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  return [];
}

export const listSlackDirectoryPeersFromConfig = emptyDirectoryResult;
export const listSlackDirectoryGroupsFromConfig = emptyDirectoryResult;
export const listDiscordDirectoryPeersFromConfig = emptyDirectoryResult;
export const listDiscordDirectoryGroupsFromConfig = emptyDirectoryResult;
export const listTelegramDirectoryPeersFromConfig = emptyDirectoryResult;
export const listTelegramDirectoryGroupsFromConfig = emptyDirectoryResult;
export const listWhatsAppDirectoryPeersFromConfig = emptyDirectoryResult;
export const listWhatsAppDirectoryGroupsFromConfig = emptyDirectoryResult;
