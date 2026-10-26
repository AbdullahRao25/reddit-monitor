import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Load data now and keep reloading it. `intervalMs` may be a function of the
 * latest data, so a view can poll faster while a check is running.
 * On a failed reload the previous data is kept and `error` is set.
 */
export function usePolling(load, intervalMs, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loadRef = useRef(load);
  const dataRef = useRef(null);
  useLayoutEffect(() => {
    loadRef.current = load;
  });

  const refresh = useCallback(async () => {
    try {
      const data = await loadRef.current();
      dataRef.current = data;
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState((prev) => ({ ...prev, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const tick = async () => {
      await refresh();
      if (cancelled) return;
      const delay = typeof intervalMs === 'function' ? intervalMs(dataRef.current) : intervalMs;
      timer = setTimeout(tick, delay);
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, refresh };
}

// Minimal hash router: "#/accounts/<uuid>" or the dashboard.
export function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const match = hash.match(/^#\/accounts\/([0-9a-f-]{36})$/i);
  if (match) return { view: 'account', id: match[1] };
  if (/^#\/check\b/i.test(hash)) return { view: 'check' };
  return { view: 'dashboard' };
}

export function navigate(path) {
  window.location.hash = path;
}

// Width of an element, tracked as it resizes.
export function useElementWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
