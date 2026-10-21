import { useEffect } from 'react';

export function usePageTitle(title: string | null) {
  useEffect(() => {
    document.title = title ? `${title} · terminal4dummies` : 'terminal4dummies: learn the command line';
  }, [title]);
}
