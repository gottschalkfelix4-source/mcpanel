/**
 * Text in die Zwischenablage legen. Die Zwischenablage-API gibt es nur über
 * HTTPS (oder localhost) – ein Panel im Heimnetz läuft aber meist über
 * `http://192.168.…`. Dann über eine unsichtbare Textauswahl kopieren.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // weiter mit dem Ausweichweg
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
