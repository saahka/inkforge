/** Всплывающие уведомления (тосты). */

const HOLD = { info: 2600, ok: 2200, error: 5200 };

let host = null;

export function notify(text, kind = 'info') {
  host ||= document.getElementById('toasts');
  if (!host) return;

  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.textContent = text;
  host.append(node);

  const ms = HOLD[kind] ?? HOLD.info;
  setTimeout(() => {
    node.style.transition = 'opacity .2s, transform .2s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(12px)';
    setTimeout(() => node.remove(), 220);
  }, ms);

  // Больше 5 уведомлений подряд — выкидываем старые
  while (host.children.length > 5) host.firstElementChild.remove();
}

export const notifyError = (err) => notify(err?.message || String(err), 'error');