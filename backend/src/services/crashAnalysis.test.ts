import { describe, expect, it } from 'vitest';
import { analyseCrash } from './crashAnalysis.js';

/**
 * Der Hauptfall stammt wörtlich aus einem echten Absturz auf dem Testserver
 * (Better MC, Fabric 1.20.1): `missingmodschecker` öffnet beim Start ein
 * Swing-Fenster, das es auf einem Server nicht geben kann. Vor dem Stacktrace
 * steht dort die vollständige Modliste – deshalb darf die Auswertung erst ab
 * der Fehlerzeile suchen.
 */
const ECHTER_ABSTURZ = `
[20:22:24] [main/INFO]: Loading 333 mods:
	- moogsmissingvillages 2.0.0
	- pickupnotifier 8.0.0
	   \-- error_notifier 1.0.9
	- xaerominimap 25.3.5
[20:22:25] [main/INFO]: Applying default files...
[20:22:26] [main/ERROR]: Error thrown while opening! Exiting
java.awt.HeadlessException: 
No X11 DISPLAY variable was set,
but this program performed an operation which requires it.
	at java.awt.GraphicsEnvironment.checkHeadless(Unknown Source) ~[?:?]
	at javax.swing.JFrame.<init>(Unknown Source) ~[?:?]
	at toni.missingmodschecker.MissingModsWindow.<init>(MissingModsWindow.java:55) ~[missingmodschecker.jar:?]
	at toni.missingmodschecker.MissingModsChecker.launch(MissingModsChecker.java:62) ~[missingmodschecker.jar:?]
	at net.fabricmc.loader.impl.FabricLoaderImpl.setupLanguageAdapters(FabricLoaderImpl.java:497) ~[fabric-loader-0.19.3.jar:?]
	at net.fabricmc.loader.impl.launch.knot.KnotServer.main(KnotServer.java:23) ~[fabric-loader-0.19.3.jar:?]
	at net.fabricmc.installer.ServerLauncher.main(ServerLauncher.java:69) ~[fabric-server-mc.1.20.1-loader.0.19.3-launcher.1.1.2.jar:1.1.2]
`;

const DATEIEN = [
  'AdvancedLootInfo-fabric-1.20.1-1.7.0.jar',
  'MoogsMissingVillages-1.20-2.0.0.jar',
  'PickUpNotifier-v8.0.0-1.20.1-Fabric.jar',
  'missingmodschecker.jar',
];

describe('analyseCrash – echter Absturz', () => {
  const d = analyseCrash(ECHTER_ABSTURZ, DATEIEN)!;

  it('erkennt den Fall überhaupt', () => {
    expect(d).not.toBeNull();
  });

  it('benennt missingmodschecker, nicht eine Mod aus der Modliste', () => {
    expect(d.suspect?.filename).toBe('missingmodschecker.jar');
  });

  it('verwechselt es nicht mit MoogsMissingVillages', () => {
    expect(d.suspect?.filename).not.toContain('Moogs');
  });

  it('überspringt Loader und Spiel im Stacktrace', () => {
    expect(d.suspect?.reference).not.toMatch(/fabric/i);
  });

  it('erklärt den Fehler verständlich', () => {
    expect(d.headline).toMatch(/Fenster/);
    expect(d.reason).toMatch(/keine Anzeige/);
  });

  it('meldet die Mod als aktiv', () => {
    expect(d.suspect?.enabled).toBe(true);
  });

  it('liefert einen Auszug ohne Leerzeilen', () => {
    expect(d.excerpt.length).toBeGreaterThan(0);
    expect(d.excerpt.every((z) => z.trim().length > 0)).toBe(true);
  });
});

describe('analyseCrash – weitere Fehlerbilder', () => {
  it('erkennt einen Zugriff auf die Grafikausgabe', () => {
    const log = `java.lang.NoClassDefFoundError: org/lwjgl/opengl/GL11
	at me.sodium.Renderer.init(Renderer.java:20) ~[sodium-fabric-0.5.8.jar:?]`;
    const d = analyseCrash(log, ['sodium-fabric-0.5.8.jar'])!;
    expect(d.suspect?.filename).toBe('sodium-fabric-0.5.8.jar');
    expect(d.headline).toMatch(/Grafikausgabe/);
  });

  it('erkennt eine als clientseitig ausgewiesene Klasse', () => {
    const log = `java.lang.RuntimeException: Cannot load class foo.Bar in environment type SERVER
	at foo.Bar.<clinit>(Bar.java:1) ~[colorwheel-1.2.3.jar:?]`;
    const d = analyseCrash(log, ['colorwheel-1.2.3.jar'])!;
    expect(d.suspect?.filename).toBe('colorwheel-1.2.3.jar');
    expect(d.headline).toMatch(/nur für den Client/);
  });

  it('nennt die Datei auch ohne bekanntes Fehlerbild', () => {
    const log = `java.lang.IllegalStateException: kaputt
	at x.Y.z(Y.java:9) ~[irgendwas-1.0.jar:?]`;
    const d = analyseCrash(log, ['irgendwas-1.0.jar'])!;
    expect(d.suspect?.filename).toBe('irgendwas-1.0.jar');
    expect(d.headline).toMatch(/beendet/);
  });

  it('findet die Datei auch bei abweichender Version im Namen', () => {
    const log = `java.awt.HeadlessException:
	at a.B.c(B.java:1) ~[journeymap.jar:?]`;
    const d = analyseCrash(log, ['journeymap-1.20.1-5.9.7-fabric.jar'])!;
    expect(d.suspect?.filename).toBe('journeymap-1.20.1-5.9.7-fabric.jar');
  });

  it('meldet eine bereits deaktivierte Mod als deaktiviert', () => {
    const log = `java.awt.HeadlessException:
	at a.B.c(B.java:1) ~[foo.jar:?]`;
    const d = analyseCrash(log, ['foo.jar.disabled'])!;
    expect(d.suspect?.enabled).toBe(false);
  });

  it('gibt den Protokollnamen zurück, wenn keine Datei passt', () => {
    const log = `java.awt.HeadlessException:
	at a.B.c(B.java:1) ~[verschwunden.jar:?]`;
    const d = analyseCrash(log, ['ganz-was-anderes.jar'])!;
    expect(d.suspect?.filename).toBeNull();
    expect(d.suspect?.reference).toBe('verschwunden.jar');
  });

  it('schweigt, wenn der Stacktrace keine Mod nennt', () => {
    const log = `[20:22] [main/ERROR]: Out of memory
	at java.lang.Object.wait(Native Method) ~[?:?]`;
    expect(analyseCrash(log, ['foo.jar'])).toBeNull();
  });

  it('schweigt bei leerem Protokoll', () => {
    expect(analyseCrash('   ', ['foo.jar'])).toBeNull();
  });
});
