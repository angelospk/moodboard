import type { PageLoad } from './$types.js';
import { loadShared, type SharedBoard } from '#lib/share.js';

// A shared board: read with the link's token only, never with the visitor's session.
export const load: PageLoad = async ({ params }) => {
	let board: SharedBoard | null = null;
	let error: string | null = null;
	try {
		board = await loadShared(params.token);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	return { token: params.token, board, error };
};
