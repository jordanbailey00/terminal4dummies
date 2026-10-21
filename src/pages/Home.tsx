import { Link } from '../router';
import { usePageTitle } from '../components/usePageTitle';

export function Home() {
  usePageTitle(null);
  return (
    <div className="page">
      <h1>Learn the command line by using one.</h1>
      <p className="lead">A real-feeling terminal in your browser, with friendly lessons that check your work as you go.</p>
      <div className="row">
        <Link className="btn btn-primary btn-lg" to="/learn">
          Start learning
        </Link>
        <Link className="btn btn-lg" to="/playground">
          Open the playground
        </Link>
      </div>
    </div>
  );
}
