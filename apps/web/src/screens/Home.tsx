import { Link } from 'react-router-dom';
import { useSession } from '../App';

export function HomeScreen() {
  const session = useSession();
  return (
    <main className="home">
      <p className="muted">Fictional shelter · one station · water and charging</p>
      <h1>Requests stay visible until a person handles them.</h1>
      <p style={{ maxWidth: 680, fontSize: '1.2rem' }}>
        A resident confirms water or charging. The laptop saves that request before it is delivered.
        A coordinator acknowledges it, reviews a capacity-valid plan, and approves it. Nothing here calls emergency services.
      </p>
      <div className="cards">
        <Link className="choice-card panel" to="/station" onClick={() => void session.choose('station')}>
          <span className="muted">Resident station</span>
          <strong style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: '1.8rem' }}>Ask for water or a charge</strong>
          <span>Saved on this station and delivered are different states.</span>
        </Link>
        <Link className="choice-card panel" to="/coord" onClick={() => void session.choose('coordinator')}>
          <span className="muted">Coordinator</span>
          <strong style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: '1.8rem' }}>See what is still unanswered</strong>
          <span>Unacknowledged and unmatched requests stay on their own lists.</span>
        </Link>
        <Link className="choice-card panel" to="/volunteer" onClick={() => void session.choose('volunteer')}>
          <span className="muted">Volunteer North</span>
          <strong style={{ fontFamily: 'Fraunces, Georgia, serif', fontSize: '1.8rem' }}>Only the task you were given</strong>
          <span>No directory of other residents. Complete the attached assignment.</span>
        </Link>
      </div>
      <p className="footer-note">
        This build runs the blueprint’s reducers in a local authority. SpacetimeDB is not connected, and Nemotron stays unavailable until a real endpoint is configured.
        Role buttons are the demo stand-in for separate identities. The server still rejects a station that tries to approve a plan.
      </p>
    </main>
  );
}
