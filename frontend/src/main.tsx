import './styles/global.css';
import './styles/login.css';
import './styles/voice.css';
import './styles/home.css';
import './styles/material.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
