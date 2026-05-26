/**
 * 新订单提示音（美团风格）：
 *   钟声 (Web Audio 合成正弦) → ~150ms 间隙 → 人声播报 (mp3, macOS Tingting/婷婷 离线 TTS)
 *
 * - 钟声两种 motif 区分订单类型：
 *     堂食 dine-in: 高→低 "叮咚"  (A5 → E5)
 *     外卖 takeout: 等高两声 "叮叮" (A5 × 2)
 * - mp3 文件位于 `frontend/public/sounds/order-{dinein|takeout}.mp3`，约 28KB / 3.5s。
 * - mp3 加载失败 / 不支持时，自动回退到"只播钟声"，不会让 CashierLayout 那条 toast 通知静默。
 * - 浏览器自动播放策略：必须在用户首次手势后才能出声 —— 进入收银端后任一 click/touchstart 调用
 *   `unlockAudio()` 一次性解锁；解锁过程顺手 preload 两个 mp3，避免首单延迟。
 */

let audioCtx: AudioContext | null = null;
let unlocked = false;

/** preload 后的两个 `<audio>` 元素，命中后直接 `play()`，避免每次 new 一个 */
const voiceCache: Partial<Record<'dineIn' | 'takeout', HTMLAudioElement>> = {};
const VOICE_SRC: Record<'dineIn' | 'takeout', string> = {
  dineIn: '/sounds/order-dinein.mp3',
  takeout: '/sounds/order-takeout.mp3',
};
/** 钟声尾部 → 语音开头的间隙，毫秒。太短会撞钟声尾部余响，太长又拖沓 */
const CHIME_TO_VOICE_GAP_MS = 150;

/** 任一用户手势调用一次：解锁 AudioContext，并 preload 语音 mp3 */
export function unlockAudio() {
  if (unlocked) return;
  try {
    audioCtx = new AudioContext();
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch {
    audioCtx = null;
  }
  unlocked = true;

  /** 预热 HTMLAudioElement，避免首条订单出现「叮咚……（数百 ms 网络等待）……您有新的…」的撕裂感 */
  (Object.keys(VOICE_SRC) as ('dineIn' | 'takeout')[]).forEach((k) => {
    if (voiceCache[k]) return;
    const a = new Audio(VOICE_SRC[k]);
    a.preload = 'auto';
    a.load();
    voiceCache[k] = a;
  });
}

function getCtx(): AudioContext | null {
  if (!audioCtx) return null;
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

function playTone(frequency: number, startTime: number, duration: number, ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.5, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

/** 播放预热好的语音；克隆节点保证多单连击不会被上一条 cut 掉 */
function playVoice(kind: 'dineIn' | 'takeout'): void {
  const cached = voiceCache[kind];
  const audio = cached ? (cached.cloneNode(true) as HTMLAudioElement) : new Audio(VOICE_SRC[kind]);
  audio.volume = 1.0;
  void audio.play().catch(() => {
    /* 自动播放被拒：忽略，钟声依然提示了 */
  });
}

/** 堂食：钟声「叮咚」(A5→E5) + 0.15s 间隙 + 语音「您有一个新的堂食订单」 */
export function playDineInSound() {
  const ctx = getCtx();
  let chimeMs = 0;
  if (ctx) {
    const now = ctx.currentTime;
    playTone(880, now, 0.25, ctx);        // 叮 (A5)
    playTone(660, now + 0.25, 0.35, ctx); // 咚 (E5)
    chimeMs = (0.25 + 0.35) * 1000;       // 600ms
  }
  setTimeout(() => playVoice('dineIn'), chimeMs + CHIME_TO_VOICE_GAP_MS);
}

/** 外卖：钟声「叮叮」(A5×2) + 0.15s 间隙 + 语音「您有一个新的外卖订单」 */
export function playTakeoutSound() {
  const ctx = getCtx();
  let chimeMs = 0;
  if (ctx) {
    const now = ctx.currentTime;
    playTone(880, now, 0.2, ctx);        // 叮 (A5)
    playTone(880, now + 0.3, 0.2, ctx);  // 叮 (A5)
    chimeMs = (0.3 + 0.2) * 1000;        // 500ms
  }
  setTimeout(() => playVoice('takeout'), chimeMs + CHIME_TO_VOICE_GAP_MS);
}
