import { afterEach, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';
import { installStatTracker } from './stat-tracker';
import { TRACKED_STATS, type TrackerValues } from './stat-tracker-model';
import { attackCapInterval, attackSpeedLabel, critDamageLabel } from '../../shared/stat-rating';
import { criticalDamage, type CriticalDamageParts } from '../../shared/critical-damage';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup(saved: Record<string, string> = {}) {
  vi.useFakeTimers();
  const { document, window } = parseHTML('<html><body><div id="hud"></div><button id="statTrackerToggle"></button></body></html>');
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  Object.assign(window, { innerWidth: 800, innerHeight: 600 });
  const values = new Map(Object.entries({ 'wildstat-native-stat-tracker-enabled': 'true', ...saved }));
  const stats = Object.fromEntries(TRACKED_STATS.map(stat => [stat, 10])) as TrackerValues;
  let raise = 0, rate = 3;
  let crit: CriticalDamageParts = { rating: 1e300 };
  installStatTracker({ storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } },
    read: () => {
      const cap = 1 / attackCapInterval({ minInterval: 1 / 3, raise });
      const result = criticalDamage(crit);
      return { identity: 'test', values: { ...stats }, details: {
        attackSpeed: attackSpeedLabel(Math.min(rate, cap), cap).replace(' (Max)', ' Max'),
        critDamage: critDamageLabel(result.multiplier, result.cap).replace(' (Max)', ' Max'),
      } };
    } });
  const panel = document.querySelector<HTMLElement>('.stat-tracker:not(.stat-tracker-settings)')!;
  const settings = document.querySelector<HTMLElement>('.stat-tracker-settings')!;
  const change = (input: HTMLInputElement, checked: boolean) => {
    input.checked = checked;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const compact = settings.querySelector<HTMLInputElement>('.stat-tracker-compact-option input')!;
  const columns = [...settings.querySelectorAll<HTMLInputElement>('.stat-tracker-compact-options input')];
  const current = (stat: string) => panel.querySelector(`[data-stat="${stat}"] td`)!.textContent;
  return { window, panel, settings, compact, columns, change, values, stats, current,
    setCap: (nextRaise: number, nextRate: number) => { raise = nextRaise; rate = nextRate; },
    setCrit: (next: CriticalDamageParts) => { crit = next; } };
}

it('defaults to full mode and hides compact options until enabled, retaining timer and reset', () => {
  const s = setup();
  expect(s.compact.checked).toBe(false);
  expect(s.settings.querySelector<HTMLElement>('.stat-tracker-compact-options')!.hidden).toBe(true);
  s.change(s.compact, true);
  expect(s.panel.classList.contains('is-compact')).toBe(true);
  expect(s.values.get('wildstat-stat-tracker-compact')).toBe('true');
  expect(s.settings.querySelector<HTMLElement>('.stat-tracker-compact-options')!.hidden).toBe(false);
  expect(s.panel.querySelector<HTMLElement>('tr > :nth-child(2)')!.hidden).toBe(false);
  expect(s.panel.querySelector<HTMLElement>('tr > :nth-child(3)')!.hidden).toBe(true);
  vi.advanceTimersByTime(2000);
  expect(s.panel.querySelector('.stat-tracker-time')!.textContent).toBe('00:00:02');
  s.panel.querySelector<HTMLButtonElement>('.stat-tracker-reset')!.click();
  expect(s.panel.querySelector('.stat-tracker-time')!.textContent).toBe('00:00:00');
});

it('locks the stat tracker without changing collapse state and restores the saved lock', () => {
  const s = setup();
  const handle = s.panel.querySelector<HTMLButtonElement>('.stat-tracker-handle')!;
  const fire = (detail: number) => handle.dispatchEvent(Object.assign(new s.window.Event('click'), { detail }));
  const expanded = handle.getAttribute('aria-expanded');
  fire(1); fire(2);
  vi.advanceTimersByTime(400);
  expect(handle.getAttribute('aria-expanded')).toBe(expanded);
  expect(s.panel.classList.contains('is-position-locked')).toBe(true);
  expect(s.values.get('wildstat-stat-tracker-position-locked')).toBe('true');
  const restored = setup({ 'wildstat-stat-tracker-position-locked': 'true' });
  expect(restored.panel.classList.contains('is-position-locked')).toBe(true);
});

it('persists columns and icons, retains accessible labels, and restores full columns', () => {
  const s = setup({ 'wildstat-stat-tracker-compact': 'true', 'wildstat-stat-tracker-compact-icons': 'true' });
  expect(s.panel.querySelector('[data-stat="kills"] th svg')).not.toBeNull();
  expect(s.panel.querySelector('[data-stat="kills"] th')!.getAttribute('aria-label')).toBe('Kills');
  s.change(s.columns[0], false);
  expect(s.values.get('wildstat-stat-tracker-compact-icons')).toBe('false');
  expect(s.panel.querySelector('svg.stat-tracker-stat-icon')).toBeNull();
  s.change(s.columns[0], true);
  expect(s.values.get('wildstat-stat-tracker-compact-icons')).toBe('true');
  s.change(s.columns[1], false); // Current
  expect(s.values.get('wildstat-stat-tracker-compact-current')).toBe('false');
  expect(s.columns[3].disabled).toBe(true); // Last numeric column remains enabled for display.
  s.change(s.columns[2], true); // Session gain
  expect(s.panel.querySelector<HTMLElement>('tr > :nth-child(3)')!.hidden).toBe(false);
  expect(s.columns[3].disabled).toBe(false);
  s.change(s.compact, false);
  expect(s.panel.querySelector('svg.stat-tracker-stat-icon')).toBeNull();
  expect(s.panel.querySelector<HTMLElement>('tr > :nth-child(2)')!.hidden).toBe(false);
  expect(s.panel.querySelector<HTMLElement>('tr > :nth-child(3)')!.hidden).toBe(false);
});

it('recovers saved all-hidden columns and respects existing stat-row filters', () => {
  const s = setup({ 'wildstat-stat-tracker-compact': 'true', 'wildstat-stat-tracker-compact-current': 'false',
    'wildstat-stat-tracker-compact-gain': 'false', 'wildstat-stat-tracker-compact-hour': 'false',
    'wildstat-stat-tracker-hidden-stats': '["armor"]' });
  expect(s.columns[3].checked).toBe(true);
  expect(s.panel.querySelector<HTMLElement>('[data-stat="armor"]')!.hidden).toBe(true);
});

it.each([false, true])('updates capped display and restores ratings when caps increase (compact=%s)', compact => {
  const s = setup({ 'wildstat-stat-tracker-compact': String(compact) });
  expect(s.current('attackSpeed')).toBe('3.00/s Max');
  expect(s.current('critDamage')).toBe('5.00× Max');
  s.setCap(2, 3); // A perk/card raises the active attack cap above current speed.
  s.setCrit({ rating: 0, capRank: 5, card: .15, researchRank: 10 });
  vi.advanceTimersByTime(1000);
  expect(s.current('attackSpeed')).not.toContain('Max');
  expect(s.current('critDamage')).not.toContain('Max');
  s.setCap(2, 5);
  s.setCrit({ rating: 1e300, capRank: 5, card: .15, researchRank: 10 });
  vi.advanceTimersByTime(1000);
  expect(s.current('attackSpeed')).toBe('5.00/s Max');
  expect(s.current('critDamage')).toBe('11.50× Max');
});
