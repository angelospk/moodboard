import type { el } from './el';

// English. The type makes a missing or extra key a type error.
export const en: Record<keyof typeof el, string> = {
	'popup.update': 'New version available',
	'popup.restart': 'Restart',
	'popup.loading': 'Loading…',
	'popup.password': 'Password',
	'popup.invite': 'Invite code',
	'popup.signIn': 'Sign in',
	'popup.signUp': 'New account',
	'popup.signOut': 'Sign out',
	'popup.saved': 'Saved ·',
	'popup.open': 'Open',
	'popup.again': 'Save another',
	'popup.close': 'Close',
	'popup.preview': 'Preview',
	'popup.projectName': 'Project name',
	'popup.add': 'Add',
	'popup.newProject': '+ new project',
	'popup.note': 'Note',
	'popup.tagsPlaceholder': 'wood, light',
	'popup.level': 'Level',
	'popup.save': 'Save',
	'popup.saving': 'Saving…',
	'popup.cancel': 'Cancel',
	'popup.hint': 'Right-click an image and choose “{menu}”.',
	'popup.screenshot': 'Screenshot of this page',
	'popup.openApp': 'Open moodboard',
	'popup.unsupportedType': 'The image type is not supported.',
	'popup.screenshotFailed': 'The screenshot failed.',
	'popup.language': 'Language',
	'popup.aiFilling': 'AI is suggesting a level and tags…',

	'tags.remove': 'Remove {tag}',

	'common.unknownError': 'unknown error',

	'menu.saveImage': 'Save image to Moodboard',
	'menu.screenshot': 'Screenshot of page to Moodboard',

	'bg.downloadHttp': 'Download failed (HTTP {status}).',
	'bg.unsupportedType': 'The image type is not supported.',
	'bg.downloadFailed': 'Download failed: {error}',
	'bg.noTab': 'No active tab found.',
	'bg.noScreenshot': 'A screenshot is not available on this page.'
}
