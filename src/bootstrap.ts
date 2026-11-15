import { parsePairingFragment } from './storage';
import { startup } from './startup';

// Run before loading the Even SDK or any UI. The pairing secret is transient
// fragment data; it must never remain in history or an SDK launch URL.
if (location.hash.startsWith('#pair=')) {
  const fragment = location.hash;
  history.replaceState(null, '', location.pathname + location.search);
  try { startup.incoming = parsePairingFragment(fragment); }
  catch (error) { startup.error = (error as Error).message; }
}
await import('./main');
