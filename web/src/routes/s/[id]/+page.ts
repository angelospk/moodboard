import type { PageLoad } from './$types.js';
import { loadPublic, type PublicBoard } from '#lib/share.js';

// A public board: read without the visitor's session.
export const load: PageLoad = async ({ params }) => {
	let board: PublicBoard | null = null;
	let error: string | null = null;
	try {
		board = await loadPublic(params.id);
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}
	return { id: params.id, board, error };
};
