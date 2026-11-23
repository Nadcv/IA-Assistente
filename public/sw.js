// Service worker: torna a app instalável e mostra as notificações push.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { corpo: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.titulo || "Assistente", {
    body: m.corpo || "",
    icon: "/icone-192.png",
    badge: "/icone-192.png",
    tag: m.tag,
    data: { url: m.url || "/" },
  }));
});

// Tocar na notificação abre (ou traz para a frente) a app.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const j of janelas) {
      if (new URL(j.url).origin === self.location.origin) { await j.focus(); return j.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});
