import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>{(auth) => <App auth={auth} />}</AuthGate>
  </React.StrictMode>,
);
