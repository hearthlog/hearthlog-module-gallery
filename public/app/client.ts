import { hydrate } from 'svelte';
import App from './App.svelte';
import type { PublicGalleryData } from './types.js';

const data = JSON.parse(document.getElementById('gallery-data')?.textContent ?? 'null') as PublicGalleryData | null;
const target = document.getElementById('app');
if (data && target) hydrate(App, { target, props: { data } });
