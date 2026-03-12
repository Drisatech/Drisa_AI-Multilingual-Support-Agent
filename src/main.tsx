import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

window.onerror = function(message, source, lineno, colno, error) {
  const errorMsg = `Global Error: ${message} at ${source}:${lineno}:${colno}`;
  console.error(errorMsg, error);
  // Only show alert in production to help debug
  if (import.meta.env.PROD) {
    const root = document.getElementById('root');
    if (root) {
      root.innerHTML = `<div style="padding: 20px; color: red; font-family: sans-serif;">
        <h2>Application Error</h2>
        <p>${errorMsg}</p>
        <p>Please check your environment variables and ensure the build is correct.</p>
      </div>`;
    }
  }
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
