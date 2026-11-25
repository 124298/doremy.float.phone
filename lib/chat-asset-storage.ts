import { deleteThemeAsset, getThemeAssetDataUrl, saveThemeAssetFromBlob } from "./theme-storage";
import type { ThemeAssetType } from "./theme-types";

// We can leverage the existing IndexedDB logic in theme-storage.ts by 
// just casting a custom type like "chat_bg" to ThemeAssetType to store chat assets.

export async function saveChatImageToIndexedDB(blob: Blob): Promise<string> {
    // "chat_bg" is not in ThemeAssetType strictly, but JS at runtime doesn't care.
    return saveThemeAssetFromBlob(blob, "chat_bg" as ThemeAssetType);
}

export async function getChatImageFromIndexedDB(id: string): Promise<string | null> {
    return getThemeAssetDataUrl(id);
}

// 删除聊天图片资产（生图身份参考图等）。
// 复用 deleteThemeAsset 的保护：资产仍被本地主题预设引用时它会静默跳过，
// 避免误删壁纸/图标后切回预设时资源缺失。
export async function deleteChatImageFromIndexedDB(id: string): Promise<void> {
    if (!id) return;
    return deleteThemeAsset(id);
}

// 聊天提示音：同一套 IndexedDB 资产存储，类型标记换成 "chat_sound"。

export async function saveChatAudioToIndexedDB(blob: Blob): Promise<string> {
    return saveThemeAssetFromBlob(blob, "chat_sound" as ThemeAssetType);
}

export async function getChatAudioFromIndexedDB(id: string): Promise<string | null> {
    return getThemeAssetDataUrl(id);
}
