// The signed-in user's levels, shared by every page and panel. The root layout fills it on load;
// the level manager updates it after each change.
import { levelName, type LevelRow } from '#lib/levels.js';

export const levelStore = $state<{ list: LevelRow[] }>({ list: [] });

export function setLevels(rows: LevelRow[]): void {
	levelStore.list = rows;
}

/** The name of a level id, or '' for none or a deleted one. */
export function levelLabel(id: string | null | undefined): string {
	return levelName(levelStore.list, id);
}
