import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  manifest: {
    name: 'Moodboard',
    description: 'Αποθήκευση εικόνων έμπνευσης σε moodboard.',
    permissions: ['contextMenus', 'storage', 'activeTab', 'tabs'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Moodboard' },
  },
});
