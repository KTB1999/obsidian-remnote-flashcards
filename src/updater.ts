import { requestUrl } from "obsidian";
import type RemNoteFlashcardsPlugin from "./main";

const REPO = "KTB1999/obsidian-remnote-flashcards";
const API  = `https://api.github.com/repos/${REPO}/releases/latest`;

interface Asset { name: string; browser_download_url: string; }

function semverGt(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  latestVersion: string;
  assets: Asset[];
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  const res     = await requestUrl({ url: API, headers: { "User-Agent": "obsidian-remnote-flashcards" } });
  const release = res.json;
  const latest  = (release.tag_name as string)?.replace(/^v/, "") ?? "";
  return { hasUpdate: semverGt(latest, currentVersion), latestVersion: latest, assets: release.assets ?? [] };
}

export async function downloadAndInstall(plugin: RemNoteFlashcardsPlugin, assets: Asset[]): Promise<void> {
  const dir   = `.obsidian/plugins/${plugin.manifest.id}`;
  const files = ["main.js", "styles.css", "manifest.json"];

  for (const name of files) {
    const asset = assets.find(a => a.name === name);
    if (!asset) continue;
    const res = await requestUrl({ url: asset.browser_download_url });
    await plugin.app.vault.adapter.write(`${dir}/${name}`, res.text);
  }
}

export async function reloadPlugin(plugin: RemNoteFlashcardsPlugin): Promise<void> {
  const plugins = (plugin.app as any).plugins;
  await plugins.disablePlugin(plugin.manifest.id);
  await plugins.enablePlugin(plugin.manifest.id);
}
