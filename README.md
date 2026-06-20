# Limbo-hybrid

Made by @wolfiku

## Zwei Betriebsmodi

Limbo erkennt automatisch, ob es Schreibzugriff auf das Dateisystem hat,
und passt sich entsprechend an:

- **Socket-Modus** (Node.js, mit Schreibrechten): Setup- und Account-Daten
  werden serverseitig als JSON-Dateien unter `system/data/` gespeichert.
- **Lokaler Modus** (statisches Hosting, z.B. GitHub Pages, oder Node.js
  ohne Schreibrechte): Alle Daten werden im `localStorage` des Browsers
  gespeichert. Kein Server nötig.

Startet man das System über `node boot.js`, prüft der Server beim Start
selbst, ob er tatsächlich schreiben darf, und setzt `has_socket` in
`system/etc/info/host/environment.info` automatisch entsprechend. Schlägt
ein Schreibversuch dennoch fehl (z.B. Read-Only-Filesystem), weicht das
Frontend automatisch auf `localStorage` aus, statt das Setup abzubrechen.

## Starten

**Mit Node.js (Socket-Modus, empfohlen für volle Funktionalität):**

```bash
npm start
# entspricht: node system/system/boot/Socketboot/boot.js
```

Standardmäßig läuft der Server auf Port `3000`
(`http://localhost:3000/`). Ein anderer Port lässt sich über die
Umgebungsvariable `PORT` setzen, z.B. `PORT=8080 npm start`.

**Ohne Node.js (rein statisch, z.B. GitHub Pages):**

Einfach den Ordnerinhalt auf einen beliebigen statischen Webserver legen
und `index.html` öffnen. Das System erkennt automatisch, dass kein
Schreibzugriff vorhanden ist, und nutzt `localStorage`.
