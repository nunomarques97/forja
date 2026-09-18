// Entry point of the app (`npm start`). Reads configuration from the environment, validates the
// token and the data file fail-closed (D7, D9), then listens (D8). Only node:* and ./lib/*.
//
// Rules that must not be relaxed:
//  - a startup failure writes exactly ONE Portuguese sentence to stderr with the next step and
//    exits with code 1 — never a stack trace, never the word "Error", never the token or the data
//    that was read (D13, product profile §Fasquia);
//  - GREET_DATA and GREET_TOKEN_FILE default to paths under this file's own folder
//    (`import.meta.dirname`), never `process.cwd()`, so `npm start` behaves the same from any
//    working directory;
//  - the data file is validated with `store.load()` before the server starts listening, and is
//    never written, renamed or truncated by this module — that guarantee lives in lib/store.mjs;
//  - the token never appears in anything printed here, on success or on failure.
import path from 'node:path';
import { loadToken, MissingToken } from './lib/auth.mjs';
import { createApp } from './lib/app.mjs';
import { createStore, UnreadableDataFile } from './lib/store.mjs';
import { lanAddresses } from './lib/lan.mjs';

const ROOT = import.meta.dirname;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

// One Portuguese sentence to stderr and a non-zero exit code — never a stack, never "Error:".
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function resolveHost() {
  const raw = process.env.GREET_HOST;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : DEFAULT_HOST;
}

function resolvePort() {
  const raw = process.env.GREET_PORT;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_PORT;
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT;
}

function resolveDataFile() {
  const raw = process.env.GREET_DATA;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return path.join(ROOT, 'data', 'greetings.json');
}

function resolveTokenFile() {
  const raw = process.env.GREET_TOKEN_FILE;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return path.join(ROOT, 'token.local.txt');
}

async function main() {
  let token;
  try {
    token = loadToken({ env: process.env, tokenFile: resolveTokenFile() });
  } catch (err) {
    if (err instanceof MissingToken) {
      fail(err.message);
      return;
    }
    throw err;
  }

  const dataFile = resolveDataFile();

  // A store of its own, used only to validate the file before anything listens. The app below
  // creates its own store instance for the lifetime of the server (one store per data file per
  // instance, as the append queue lives on the instance, not the process — see docs/forja/TASKS.json
  // T1's review note). Nothing is written here: `load()` only reads.
  try {
    await createStore(dataFile).load();
  } catch (err) {
    if (err instanceof UnreadableDataFile) {
      fail(err.message);
      return;
    }
    throw err;
  }

  const host = resolveHost();
  const port = resolvePort();
  const server = createApp({ token, dataFile });

  server.once('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      fail(
        `A porta ${port} já está a ser usada por outro programa. Passo seguinte: escolha outra ` +
          'porta com a variável GREET_PORT e arranque o servidor outra vez.',
      );
      return;
    }
    fail('Não foi possível arrancar o servidor. Tente outra vez dentro de momentos.');
  });

  server.once('listening', () => {
    const actualPort = server.address().port;
    // D8: 0.0.0.0 means "listen on every interface", not an address anyone opens in a browser —
    // the person on this computer always opens it through 127.0.0.1.
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    process.stdout.write(
      `O servidor está a ouvir. Abra http://${displayHost}:${actualPort}/ no browser.\n`,
    );
    if (host === '0.0.0.0') {
      const addresses = lanAddresses();
      if (addresses.length > 0) {
        for (const address of addresses) {
          process.stdout.write(`Para os colegas na mesma rede: http://${address}:${actualPort}/\n`);
        }
      } else {
        process.stdout.write(
          'Não encontrei nenhum endereço de rede local neste computador. Para o descobrir, corra ' +
            'ipconfig e procure «Endereço IPv4»; os colegas abrem http://<esse endereço>:' +
            `${actualPort}/ no browser.\n`,
        );
      }
      process.stdout.write(
        'Aviso: o servidor está a ouvir em toda a rede local — qualquer pessoa na mesma rede ' +
          'que tenha a palavra-passe consegue entrar.\n',
      );
    }
    process.stdout.write('Para parar o servidor, prima Ctrl+C.\n');
  });

  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  }
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  server.listen(port, host);
}

main().catch(() => {
  fail('Não foi possível arrancar o servidor. Tente outra vez dentro de momentos.');
});
