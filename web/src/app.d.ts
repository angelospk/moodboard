import type PocketBase from 'pocketbase';
import type { RecordModel } from 'pocketbase';

declare global {
	namespace App {
		interface PageData {
			pb: PocketBase;
			user: RecordModel | null;
		}
	}
}

export {};
