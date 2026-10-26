import React, { useEffect, useState } from 'react';
import { authReady, onAuthChange, signInWithGitHub, signOut } from '../lib/auth.js';

// Wraps the app in a sign-in gate. When auth isn't configured (local dev / the
// test build), it renders the app straight through so nothing changes there.
// Otherwise it shows a sign-in screen until a GitHub session exists, then
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
          <button style={S.btn} onClick={() => signInWithGitHub()} type="button">
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
          Sign in with GitHub
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
