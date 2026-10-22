import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/commit-mono/400.css';
import '@fontsource/commit-mono/600.css';
import '@fontsource/commit-mono/700.css';
import './styles/global.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
