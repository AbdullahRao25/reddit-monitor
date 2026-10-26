import React, { useEffect, useState } from 'react';
import { authReady, onAuthChange, signInWithGoogle, signOut } from '../lib/auth.js';

// Wraps the app in a sign-in gate. When auth isn't configured (local dev / the
// test build), it renders the app straight through so nothing changes there.
// Otherwise it shows a sign-in screen until a Google session exists, then
// renders the app and hands it { user, signOut }.
export default function AuthGate({ children }) {
  const [state, setState] = useState(authReady ? { phase: 'loading' } : { phase: 'open' });

  useEffect(() => {
    if (!authReady) return undefined;
    let first = true;
    const off = onAuthChange((user) => {
      setState({ phase: user ? 'in' : 'out', user });
      first = false;
    });
    // If the SDK never calls back (misconfigured), don't hang on the loader.
    const t = setTimeout(() => { if (first) setState({ phase: 'out' }); }, 6000);
    return () => { off(); clearTimeout(t); };
  }, []);

  if (state.phase === 'open') return children(null);
  if (state.phase === 'in') return children({ user: state.user, signOut });

  return (
    <div style={S.screen}>
      <div style={S.card}>
        <div style={S.mark} aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 4 5v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V5z"/></svg>
        </div>
        <h1 style={S.h1}>Command Center</h1>
        <p style={S.sub}>Sign in to open your account monitoring workspace.</p>
        {state.phase === 'loading' ? (
          <div style={S.loading}>Checking your session…</div>
        ) : (
          <button style={S.btn} onClick={() => signInWithGoogle()} type="button">
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.6z"/><path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.8H1.8v3C3.7 21.4 7.6 24 12 24z"/><path fill="#FBBC05" d="M5.6 14.6a7.2 7.2 0 0 1 0-4.6v-3H1.8a12 12 0 0 0 0 10.6l3.8-3z"/><path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.7l3.3-3.3C17.7 1.2 15.1 0 12 0 7.6 0 3.7 2.6 1.8 6.4l3.8 3C6.5 6.7 9 4.8 12 4.8z"/></svg>
          Sign in with Google
        </button>
        )}
        <p style={S.foot}>Access is limited to the people your workspace admits.</p>
      </div>
    </div>
  );
}

const S = {
  screen: { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '24px', background: 'var(--bg,#0a0c13)', color: 'var(--ink,#e9ecf6)', fontFamily: "'Plus Jakarta Sans',system-ui,sans-serif" },
  card: { width: '100%', maxWidth: '380px', background: 'var(--surface,#12151e)', border: '1px solid var(--line,#272e40)', borderRadius: '18px', padding: '34px 28px', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,.4)' },
  mark: { width: '52px', height: '52px', margin: '0 auto 18px', borderRadius: '14px', display: 'grid', placeItems: 'center', color: 'var(--purple-2,#ab9bff)', background: 'var(--purple-bg,rgba(143,127,240,.13))', border: '1px solid var(--purple-line,rgba(143,127,240,.32))' },
  h1: { margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-.02em' },
  sub: { margin: '10px 0 24px', color: 'var(--muted,#9aa4bc)', fontSize: '14px', lineHeight: 1.6 },
  btn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '10px', width: '100%', padding: '12px 16px', borderRadius: '10px', border: '1px solid var(--line,#272e40)', background: 'var(--surface-2,#171b28)', color: 'var(--ink,#e9ecf6)', fontSize: '14px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  loading: { padding: '12px', color: 'var(--muted,#9aa4bc)', fontSize: '14px' },
  foot: { margin: '20px 0 0', color: 'var(--subtle,#6c768f)', fontSize: '12px', lineHeight: 1.6 },
};
