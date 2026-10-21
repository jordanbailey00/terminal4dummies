import { Footer, Header } from './components/Header';
import { matchPath, useLocation } from './router';
import { Home } from './pages/Home';
import { Playground } from './pages/Playground';
import { NotFound } from './pages/NotFound';
import './styles/pages.css';

export function App() {
  const { pathname } = useLocation();
  let page: React.ReactNode;
  let fullBleed = false;
  if (pathname === '/') page = <Home />;
  else if (matchPath('/playground', pathname)) {
    page = <Playground />;
    fullBleed = true;
  } else page = <NotFound />;
  return (
    <>
      <Header />
      <main id="main" className={fullBleed ? 'main-full' : undefined}>
        {page}
      </main>
      {!fullBleed && <Footer />}
    </>
  );
}
