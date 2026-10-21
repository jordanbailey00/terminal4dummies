import { Link } from '../router';
import { usePageTitle } from '../components/usePageTitle';

export function NotFound() {
  usePageTitle('Not found');
  return (
    <div className="page page-narrow">
      <pre>{`learner@sandbox:~$ cd ${typeof window !== 'undefined' ? window.location.pathname : '/'}\nbash: cd: No such file or directory`}</pre>
      <h1>Page not found</h1>
      <p className="lead">That page doesn't exist. Try the lessons or the playground instead.</p>
      <div className="row">
        <Link className="btn btn-primary" to="/learn">
          Browse lessons
        </Link>
        <Link className="btn" to="/playground">
          Open the playground
        </Link>
      </div>
    </div>
  );
}
