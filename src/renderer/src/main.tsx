import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { startBridge } from './state/bridge';
import { useStore } from './state/store';

// Debug handle for scripted screenshots (see src/main/devCapture.ts).
(window as unknown as { __tape: unknown }).__tape = { store: useStore };

// Apply the theme before first paint to avoid a flash.
const root = document.documentElement;
root.dataset.sk = 'a';
root.dataset.platform = window.tapePlatform;
root.dataset.th = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
root.dataset.cv = 'cn';

void startBridge();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
