const CACHE_NOME = "ponto-clevelandia-v1";
const ARQUIVOS_DA_CASCA = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (evento) => {
  evento.waitUntil(
    caches.open(CACHE_NOME).then((cache) => cache.addAll(ARQUIVOS_DA_CASCA))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (evento) => {
  evento.waitUntil(
    caches.keys().then((nomes) =>
      Promise.all(nomes.filter((n) => n !== CACHE_NOME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (evento) => {
  const url = new URL(evento.request.url);

  // Nunca guarda em cache chamadas ao Supabase (dados precisam ser sempre atuais)
  if (url.hostname.endsWith("supabase.co")) return;

  // Só cuida de requisições do próprio site; scripts de CDN (Google Fonts, jsDelivr)
  // seguem direto para a rede, sem passar pelo cache do app.
  if (url.origin !== self.location.origin) return;

  evento.respondWith(
    caches.match(evento.request).then((emCache) => {
      const buscaRede = fetch(evento.request)
        .then((resposta) => {
          if (resposta && resposta.ok) {
            const copia = resposta.clone();
            caches.open(CACHE_NOME).then((cache) => cache.put(evento.request, copia));
          }
          return resposta;
        })
        .catch(() => emCache);
      return emCache || buscaRede;
    })
  );
});
