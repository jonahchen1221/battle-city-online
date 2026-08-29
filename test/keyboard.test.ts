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

test('a tap shorter than one tick still registers for exactly one snapshot', () => {
  const target = new FakeWindow();
  const keyboard = new Keyboard(target as unknown as Window);

  // keydown 与 keyup 都发生在两次快照之间（<16.7ms 的轻点）。
  target.emit('keydown', 'ArrowRight');
  target.emit('keyup', 'ArrowRight');
  target.emit('keydown', 'Space');
  target.emit('keyup', 'Space');

  const first = keyboard.snapshot();
  assert.equal(first.right, true);
  assert.equal(first.fire, true);

  // 只补报一帧，不产生粘连的重复输入。
  const second = keyboard.snapshot();
  assert.equal(second.right, false);
  assert.equal(second.fire, false);
});

test('a latched tap does not fire again while another direction is held', () => {
  const target = new FakeWindow();
  const keyboard = new Keyboard(target as unknown as Window);

  target.emit('keydown', 'ArrowUp');
  keyboard.snapshot(); // up 已被快照见过

  // 按住 up 的同时轻点 right（点按在快照间隙内完成）：后按生效原则下 right 曾是最新，
  // 但松开后 up 仍按住 —— 本帧应回落到 up，且 right 不得在后续快照里凭空出现。
  target.emit('keydown', 'ArrowRight');
  target.emit('keyup', 'ArrowRight');
  const snap = keyboard.snapshot();
  assert.equal(snap.up, true);
  assert.equal(snap.right, false);
  assert.equal(keyboard.snapshot().right, false);
});

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
    dash: false,
    start: false,
    pause: false,
  });
});
