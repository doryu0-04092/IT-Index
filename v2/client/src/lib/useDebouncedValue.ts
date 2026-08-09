import { useEffect, useState } from 'react';

/** 要件定義書§4.1「入力は150ms程度デバウンス」(v1 ../../../src/ui/shared/useDebouncedValue.ts) */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
