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

test('reset drops menu direction before gameplay and accepts a fresh press', () => {
  const target = new FakeWindow();
  const keyboard = new Keyboard(target as unknown as Window);

  // 标题页用 ↓ 选中 1 PLAYER，但在 keyup 到达前已经按 Enter 开局。
  target.emit('keydown', 'ArrowDown');
  target.emit('keydown', 'Enter');
  keyboard.reset();

  assert.equal(keyboard.snapshot().down, false);
  assert.equal(keyboard.snapshot().start, false);

  // 迟到的菜单 keyup 不会污染状态，随后一次新的游戏内按键仍应正常工作。
  target.emit('keyup', 'ArrowDown');
  target.emit('keyup', 'Enter');
  target.emit('keydown', 'ArrowRight');
  assert.equal(keyboard.snapshot().right, true);
  target.emit('keyup', 'ArrowRight');
  assert.equal(keyboard.snapshot().right, false);
});

test('releasing the newest direction falls back, then fully stops', () => {
  const target = new FakeWindow();
  const keyboard = new Keyboard(target as unknown as Window);

  target.emit('keydown', 'ArrowUp');
  target.emit('keydown', 'ArrowLeft');
  assert.equal(keyboard.snapshot().left, true);
  assert.equal(keyboard.snapshot().up, false);

  target.emit('keyup', 'ArrowLeft');
  assert.equal(keyboard.snapshot().up, true);
  target.emit('keyup', 'ArrowUp');
  assert.equal(keyboard.snapshot().up, false);
});
