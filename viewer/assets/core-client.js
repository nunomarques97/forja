// Own requests by generation: obsolete completions never publish a snapshot.
export function createCoreClient({ fetchImpl = globalThis.fetch, onSnapshot, onState = () => {}, timeoutMs = 10000 }) {
  let generation = 0, active = null, decision = null, disposed = false, hasSnapshot = false;
  function invalidate() { generation++; active?.controller.abort(); active = null; }
  async function request(path, options, controller) {
    let timer, abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(Object.assign(new Error('Pedido cancelado.'), { name: 'AbortError' }));
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('O servidor demorou demasiado a responder. Tenta atualizar novamente.'), { name: 'TimeoutError' }));
        controller.abort();
      }, timeoutMs);
    });
    try {
      return await Promise.race([(async () => {
        let response;
        try { response = await fetchImpl(path, { credentials: 'same-origin', ...options, signal: controller.signal }); }
        catch { throw Error('Ligação indisponível. Verifica a ligação ao servidor e tenta novamente.'); }
        if (response.status === 401) throw Error('Sessão expirada. Abre a página inicial para entrar novamente.');
        let data;
        try { data = await response.json(); }
        catch { throw Error('Não foi possível ler a resposta do servidor. Tenta novamente.'); }
        if (!data || typeof data !== 'object') throw Error('A resposta do servidor está incompleta.');
        if (!response.ok || !data.ok) throw Error(data.error || 'Não foi possível obter uma resposta do servidor.');
        return data;
      })(), deadline, cancelled]);
    } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
  }
  function refresh({ force = false } = {}) {
    if (disposed || decision) return Promise.resolve(null);
    if (active && !force) return active.promise;
    invalidate();
    const id = generation, controller = new AbortController();
    onState({ kind: hasSnapshot ? 'refreshing' : 'loading' });
    const promise = request('/api/core', { cache: 'no-store' }, controller)
      .then(data => {
        if (disposed || id !== generation) return null;
        if (!Array.isArray(data.projects)) throw Error('A resposta do servidor está incompleta.');
        onSnapshot(data); hasSnapshot = true; onState({ kind: 'ready', at: data.at }); return data;
      })
      .catch(error => { if (!disposed && id === generation) onState({ kind: hasSnapshot ? 'stale' : 'error', message: error.message }); return null; })
      .finally(() => { if (id === generation) active = null; });
    active = { controller, promise };
    return promise;
  }
  async function choose(body) {
    if (disposed || decision) throw Error('Já existe uma escolha a ser guardada.');
    invalidate();
    const controller = new AbortController(); decision = controller;
    try { return await request('/api/core/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, controller); }
    finally { if (decision === controller) decision = null; }
  }
  function dispose() { disposed = true; invalidate(); decision?.abort(); }
  return { refresh, choose, dispose };
}
