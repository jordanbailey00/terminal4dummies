import { useEffect } from 'react';

export function usePageTitle(title: string | null) {
  useEffect(() => {
    document.title = title ? `${title} · terminal4dummies` : 'terminal4dummies: Linux terminal emulator and lessons';
  }, [title]);
}
