// Durable JSON store (decision D9 + recipe S0.2 in docs/forja/TECHNOLOGY.md).
//
// Rules that must not be relaxed:
//  - a data file that cannot be read is NEVER written, deleted, renamed or truncated;
//  - every write is atomic: temp file in the same folder -> writeFile -> sync -> close -> rename;
//  - `rename` is retried on Windows (EPERM/EBUSY/EACCES) and, when it finally gives up,
//    the previous file is left exactly as it was;
//  - writes never overlap: they run one at a time on a promise chain owned by the store;
//  - no handle is ever kept open on the final file (reads use readFile, which opens and closes).
//
// Built-ins only: node:fs/promises, node:path, node:crypto (the unique suffix of the temp name).
// Error messages are Portuguese, name the file and say the next step (product profile, §Fasquia).
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// S0.2 point 4: on Windows another process holding the destination open (Defender, the indexer,
// OneDrive, an open editor) makes `rename` fail with EPERM. Retry, then give up without touching
// the final file.
const RETRIABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = [100, 200, 400];

/** The data file exists but cannot be understood. Nothing was read, nothing was written. */
export class UnreadableDataFile extends Error {
  constructor(filePath, reason, options) {
    super(
      `O ficheiro de dados não pôde ser lido: ${filePath}. Motivo: ${reason}. ` +
        'O ficheiro ficou intacto e nada foi gravado. Passo seguinte: guarde uma cópia do ficheiro, ' +
        'corrija-o para ser uma lista JSON (por exemplo []) ou mude-o de sítio, e tente outra vez.',
      options,
    );
    this.name = 'UnreadableDataFile';
    this.path = filePath;
  }
}

/** The new content was written to the temp file but could not replace the final file. */
export class DataFileWriteFailed extends Error {
  constructor(filePath, tempPath, reason, options) {
    super(
      `O ficheiro de dados não pôde ser gravado: ${filePath}. Motivo: ${reason}. ` +
        `O ficheiro anterior ficou intacto e os dados novos ficaram em ${tempPath}. ` +
        'Passo seguinte: feche os programas que possam ter o ficheiro aberto (editor, antivírus, ' +
        'sincronização na nuvem) e tente outra vez.',
      options,
    );
    this.name = 'DataFileWriteFailed';
    this.path = filePath;
    this.tempPath = tempPath;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// S0.2 point 6: readFile opens and closes, so the store never holds a handle on the final file.
// Missing or empty file -> empty list (point 9). Anything else unreadable -> throw, file untouched.
async function readRecords(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw new UnreadableDataFile(file, `não foi possível abrir o ficheiro (${err?.code ?? err})`, {
      cause: err,
    });
  }
  if (raw.trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UnreadableDataFile(file, `o conteúdo não é JSON válido (${err.message})`, { cause: err });
  }
  if (!Array.isArray(parsed)) {
    throw new UnreadableDataFile(file, 'o conteúdo é JSON mas não é uma lista', undefined);
  }
  return parsed;
}

// S0.2 points 1-2 and 5: unique temp name in the same folder; write, flush to disk, close;
// try/finally removes the temp file when anything fails before the rename.
async function writeTempFile(tempPath, records) {
  let written = false;
  try {
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(JSON.stringify(records, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    written = true;
  } finally {
    if (!written) await unlink(tempPath).catch(() => {});
  }
}

// S0.2 points 3-4: one atomic replace, retried on the Windows codes with growing waits.
// Giving up leaves the final file untouched and keeps the temp file (it holds the new data).
// No fsync of the folder (point 7: it fails with EPERM on Windows).
async function renameWithRetry(tempPath, file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempPath, file);
      return;
    } catch (err) {
      const canRetry = RETRIABLE_CODES.has(err?.code) && attempt < RETRY_DELAYS_MS.length;
      if (!canRetry) {
        throw new DataFileWriteFailed(
          file,
          tempPath,
          `não foi possível substituir o ficheiro (${err?.code ?? err})`,
          { cause: err },
        );
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function writeRecords(file, records) {
  await mkdir(path.dirname(file), { recursive: true }); // point 10
  const tempPath = path.join(
    path.dirname(file),
    `${path.basename(file)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`,
  );
  await writeTempFile(tempPath, records);
  await renameWithRetry(tempPath, file);
}

/**
 * A durable list of records kept in one JSON file.
 * @param {string} filePath path of the JSON file (e.g. data/greetings.json)
 * @returns {{ file: string, load: () => Promise<unknown[]>, append: (record: unknown) => Promise<unknown> }}
 */
export function createStore(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('createStore precisa do caminho do ficheiro de dados.');
  }
  const file = path.resolve(filePath);

  // S0.2 point 8: one promise chain per store, so two writes never overlap. A failed operation
  // does not break the chain for the next ones.
  let queue = Promise.resolve();
  function enqueue(work) {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    file,
    /** Every record on disk, oldest first. Missing or empty file -> []. Never writes. */
    load() {
      return enqueue(() => readRecords(file));
    },
    /** Re-reads the file, appends the record and rewrites it atomically. Returns the record. */
    append(record) {
      return enqueue(async () => {
        const records = await readRecords(file); // unreadable -> throws before touching anything
        records.push(record);
        await writeRecords(file, records);
        return record;
      });
    },
  };
}
