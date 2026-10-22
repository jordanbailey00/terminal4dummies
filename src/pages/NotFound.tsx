import { Link } from '../router';
import { usePageTitle } from '../components/usePageTitle';

export function NotFound() {
  usePageTitle('Not found');
  return (
    <div className="page">
      <pre>{`learner@sandbox:~$ cd ${typeof window !== 'undefined' ? window.location.pathname : '/'}\nbash: cd: No such file or directory`}</pre>
      <h1>Page not found</h1>
      <p>
        <Link to="/">emulator</Link> · <Link to="/learn">lessons</Link>
      </p>
    </div>
  );
}
