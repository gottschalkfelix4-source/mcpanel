/** Nur eindeutige Abbruchmeldungen prüfen; normale Mod-Warnungen zählen nicht. */
export function hasFatalServerLog(log: string): boolean {
  return /Failed to start (?:the minecraft )?server|Minecraft has crashed!|Could not execute entrypoint stage|Mod loading errors have occurred|A problem occurred running the Server launcher/i.test(log);
}
