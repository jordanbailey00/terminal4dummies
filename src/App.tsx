import { lazy, Suspense, type ReactNode } from 'react';
import { Header } from './components/Header';
import { matchPath, useLocation } from './router';
import { Learn } from './pages/Learn';
import { NotFound } from './pages/NotFound';
import './styles/pages.css';

// Pages that need the terminal simulator are loaded on demand.
const LessonPage = lazy(() => import('./pages/LessonPage').then((m) => ({ default: m.LessonPage })));
const Emulator = lazy(() => import('./pages/Emulator').then((m) => ({ default: m.Emulator })));
const Reference = lazy(() => import('./pages/Reference').then((m) => ({ default: m.Reference })));

function Loading() {
  return (
    <div className="page-loading" role="status">
      loading…
    </div>
  );
}

export function App() {
  const { pathname } = useLocation();
  let page: ReactNode;
  let fullBleed = false;
  let params: Record<string, string> | null;
  if (pathname === '/') {
    page = <Emulator />;
    fullBleed = true;
  } else if (matchPath('/learn', pathname)) page = <Learn />;
  else if ((params = matchPath('/learn/:id', pathname))) {
    page = <LessonPage lessonId={params.id} />;
    fullBleed = true;
  } else if (matchPath('/reference', pathname)) page = <Reference />;
  else page = <NotFound />;
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main" className={fullBleed ? 'main-full' : undefined}>
        <Suspense fallback={<Loading />}>{page}</Suspense>
      </main>
    </>
  );
}
