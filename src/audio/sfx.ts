import type { GameEvent } from '../game/state';

// 8-bit 风格音效合成器。**位于游戏层之外**：仅此文件触碰 WebAudio。
// 不用任何音频素材，全部用振荡器 / 噪声实时合成。
// AudioContext 受浏览器自动播放策略限制，须在首次用户手势（keydown）后创建/恢复。

export class Sfx {
  private ctx: AudioContext | null = null;

  // 首次用户手势时调用（main.ts 在 keydown 里触发）：懒创建并恢复 AudioContext。
  unlock(): void {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  }

  // 播放一个游戏事件对应的音效。未解锁（无手势）时静默返回。
  play(event: GameEvent): void {
    const ctx = this.ensure();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();

    switch (event) {
      case 'playerFire':
        this.tone(720, 300, 0.06, 'square', 0.12); // 下滑方波脆响
        break;
      case 'brickHit':
        this.noise(0.05, { from: 5200, to: 3200, vol: 0.14 }); // 短噪声爆
        break;
      case 'steelHit':
        this.tone(2100, 1700, 0.03, 'square', 0.1); // 高频金属脆响
        break;
      case 'explosionSmall':
        this.noise(0.12, { from: 4200, to: 900, vol: 0.15 });
        break;
      case 'explosionBig':
        this.noise(0.4, { from: 3000, to: 200, vol: 0.28 }); // 落频低通噪声
        break;
      case 'playerDeath':
        this.noise(0.4, { from: 3400, to: 150, vol: 0.3 });
        break;
      case 'eagleDeath':
        this.noise(0.6, { from: 2800, to: 90, vol: 0.34 }); // 最长最重
        break;
      case 'stageStart':
        // 关卡开场号角（经典 NES 过场风格，非原曲逐音复刻，凭听感重制）：
        // 方波主旋律 —— C 大调琶音上行 + 跳进收束长音；叠一层三角波低音填充厚度。
        // 全曲约 2s，恰好奏完于开场幕布（STAGE_START_TICKS = 120 帧）内。
        this.seq(
          [
            [392, 0.13], [523, 0.13], [659, 0.13], [784, 0.26], [659, 0.13],
            [784, 0.13], [1047, 0.36], [880, 0.13], [988, 0.13], [1047, 0.46],
          ],
          'square',
          0.14,
        );
        this.seq(
          [[131, 0.26], [131, 0.26], [196, 0.26], [196, 0.26], [131, 0.26], [196, 0.2], [131, 0.49]],
          'triangle',
          0.08,
        );
        break;
      case 'stageClear':
        this.jingle([523, 659, 784], 0.12, 'square', 0.14); // C5-E5-G5 上行
        break;
      case 'gameOver':
        this.jingle([392, 311, 262], 0.18, 'square', 0.14); // G4-D#4-C4 下行
        break;
      case 'pause':
        this.jingle([988, 659], 0.07, 'square', 0.12); // 经典双音提示
        break;
      case 'powerupSpawn':
        this.jingle([740, 1109], 0.05, 'square', 0.12); // 短促双音（道具出现）
        break;
      case 'powerupPickup':
        this.jingle([784, 988, 1319], 0.06, 'square', 0.14); // 上行清脆铃音（约 0.18s）
        break;
      case 'lifeUp':
        this.jingle([659, 880, 1047, 1319], 0.09, 'square', 0.16); // 经典 1UP 欢快上行
        break;
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }

  // 单音（可带线性/指数滑音）：振荡器 + 指数衰减包络。
  private tone(from: number, to: number, dur: number, type: OscillatorType, vol: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur);
  }

  // 白噪声爆：可选低通频率扫落，模拟爆炸。
  private noise(dur: number, opts: { from?: number; to?: number; vol?: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1; // 音频层允许 Math.random
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const from = opts.from ?? 8000;
    const to = opts.to ?? from;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.vol ?? 0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t);
    src.stop(t + dur);
  }

  // 逐音符旋律：每个音符可指定自己的时长（[频率, 秒]），支持收束长音等节奏变化。
  // 从 ctx.currentTime 起顺序排布；多次调用（不同音色）即叠成多声部（主旋律 + 低音）。
  private seq(notes: Array<[number, number]>, type: OscillatorType, vol: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let t = ctx.currentTime;
    for (const [f, dur] of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + dur);
      t += dur;
    }
  }

  // 依次播放若干音符，构成短旋律（通关/失败/暂停提示）。
  private jingle(freqs: number[], noteDur: number, type: OscillatorType, vol: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    let t = ctx.currentTime;
    for (const f of freqs) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f, t);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + noteDur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + noteDur);
      t += noteDur;
    }
  }
}
