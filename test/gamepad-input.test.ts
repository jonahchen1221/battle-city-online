import test from 'node:test';
import assert from 'node:assert/strict';
import { GamepadInput } from '../src/input/gamepad';

class FakeWindow {
  addEventListener(): void {}
}

function button(pressed = false): GamepadButton {
  return { pressed, touched: pressed, value: pressed ? 1 : 0 };
}

test('held menu direction stays suppressed until the gamepad returns to neutral', () => {
  const buttons = Array.from({ length: 16 }, () => button());
  const axes = [0, 0];
  const pad = {
    index: 0,
    buttons,
    axes,
    connected: true,
    id: 'test-pad',
    mapping: 'standard',
    timestamp: 0,
  } as Gamepad;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads: () => [pad] },
  });

  try {
    const input = new GamepadInput(new FakeWindow() as unknown as Window);
    buttons[13] = button(true); // D-pad down：菜单期仍按住。
    input.poll();
    assert.equal(input.snapshot().down, true);

    input.suppressHeldDirections();
    input.poll();
    assert.equal(input.snapshot().down, false);

    buttons[13] = button(false);
    input.poll();
    buttons[13] = button(true);
    input.poll();
    assert.equal(input.snapshot().down, true);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  }
});
