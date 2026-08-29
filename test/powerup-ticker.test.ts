import test from 'node:test';
import assert from 'node:assert/strict';
import { powerupTickerText } from '../src/client/ui';
import { tryPickupPowerup } from '../src/game/powerup';
import { createGameState, type PowerupPickupEvent } from '../src/game/state';

test('powerup pickup emits the collector and kind for the marquee', () => {
  const state = createGameState(42, 2);
  const player = state.tanks[1];
  state.events.length = 0;
  state.powerups.push({ kind: 'timer', x: player.x, y: player.y });

  tryPickupPowerup(state);

  assert.deepEqual(state.events, [
    { type: 'powerupPicked', playerIndex: 1, kind: 'timer' },
    'powerupPickup',
  ]);
  assert.equal(state.powerups.length, 0);
});

test('marquee copy identifies the player, item, and effect', () => {
  const event: PowerupPickupEvent = {
    type: 'powerupPicked',
    playerIndex: 2,
    kind: 'ghost',
  };

  assert.equal(powerupTickerText(event, '阿星'), '阿星 获得【幽灵】：穿越砖墙 10 秒');
});

test('marquee copy describes the enemy-side effect', () => {
  const event: PowerupPickupEvent = {
    type: 'powerupPicked',
    playerIndex: -1,
    kind: 'grenade',
  };

  assert.equal(powerupTickerText(event, '敌军'), '敌军 获得【手榴弹】：摧毁所有玩家');
});
