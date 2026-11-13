// Reload the page data after a change the user made: the server's answer, not the cached copy.
import { invalidate } from '$app/navigation';
import { forceNextLoad } from './datacache.js';

export function reloadData(): Promise<void> {
	forceNextLoad();
	return invalidate('moodboard:data');
}
