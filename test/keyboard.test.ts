import test from 'node:test';
import assert from 'node:assert/strict';
import { Keyboard } from '../src/input/keyboard';

class FakeWindow {
  private listeners = new Map<string, Array<(event: KeyboardEvent) => void>>();

  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, code: string, repeat = false): void {
    const event = { code, repeat, preventDefault() {} } as KeyboardEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

test('reset releases directions and action keys after focus loss', () => {
  const target = new FakeWindow();
  const keyboard = new Keyboard(target as unknown as Window);

  target.emit('keydown', 'ArrowUp');
  target.emit('keydown', 'Space');
  assert.equal(keyboard.snapshot().up, true);
  assert.equal(keyboard.snapshot().fire, true);

  keyboard.reset();

  assert.deepEqual(keyboard.snapshot(), {
    up: false,
    down: false,
    left: false,
    right: false,
    fire: false,
    start: false,
    pause: false,
  });
});
