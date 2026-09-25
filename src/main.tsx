import './styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { bootstrap } from './app/bootstrap';
import { errorMessage } from './data/actions';
import { useData } from './data/store';

createRoot(document.getElementById('root')!).render(<App />);

bootstrap().catch((e: unknown) => {
  console.error(e);
  useData.setState({ status: 'error', error: errorMessage(e) });
});
