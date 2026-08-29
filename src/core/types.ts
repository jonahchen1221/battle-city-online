// 单个玩家一帧的输入快照。联机版中它就是发给服务器的消息体，保持可序列化。
export interface InputState {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
  dash: boolean; // C / 肩键：冲刺技能（边沿触发，见 update.ts）
  start: boolean; // Enter：开局 / 结算重开 / 大厅
  pause: boolean; // P：暂停 / 恢复（与 start 分离，避免键位兼职冲突）
}

export function emptyInput(): InputState {
  return {
    up: false,
    down: false,
    left: false,
    right: false,
    fire: false,
    dash: false,
    start: false,
    pause: false,
  };
}

export type Direction = 'up' | 'down' | 'left' | 'right';
