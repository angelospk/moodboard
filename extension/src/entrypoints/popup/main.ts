import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { initLocale } from '@/lib/i18n';

// The language is read first, so the first render is already in it.
await initLocale();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
