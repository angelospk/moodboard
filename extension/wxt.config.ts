import { defineConfig } from 'wxt';

const VERSION = process.env.EXT_VERSION || '0.0.0';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  manifest: {
    name: 'Moodboard',
    // Greek and English texts: public/_locales/*/messages.json.
    default_locale: 'el',
    description: '__MSG_extDescription__',
    version: VERSION,
    permissions: ['contextMenus', 'storage', 'activeTab', 'tabs'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Moodboard' },
  },
  hooks: {
    // The typed getURL paths come from the prepare step, so declare version.json here.
    'prepare:publicPaths': (_wxt, paths) => {
      paths.push('/version.json');
    },
    // Write the built version next to the running one. The popup compares them to
    // notice that newer files were downloaded for an unpacked install.
    'build:publicAssets': (_wxt, files) => {
      files.push({
        relativeDest: 'version.json',
        contents: JSON.stringify({ version: VERSION }),
      });
    },
  },
});
