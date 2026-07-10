/**
 * 新订单提示音（美团风格）：
 *   钟声 (Web Audio 合成正弦) → ~150ms 间隙 → 人声播报 (mp3, macOS Tingting/婷婷 离线 TTS)
 *
 * - 钟声 motif 区分订单类型：
 *     堂食 dine-in: 高→低 "叮咚"  (A5 → E5)
 *     外卖 takeout: 等高两声 "叮叮" (A5 × 2)
 *     送餐 delivery: 中→低 "叮咚" (G5 → C5)
 * - mp3 位于 `frontend/public/sounds/order-{dinein|takeout|delivery}.mp3`
 * - mp3 加载失败时仍播钟声；须用户手势后 `unlockAudio()` 解锁自动播放。
 */

export type OrderSoundPayload = {
  _id?: string;
  type?: string;
  status?: string;
  deliverySource?: 'phone' | 'qr' | string;
};

let audioCtx: AudioContext | null = null;
let unlocked = false;

type VoiceKind = 'dineIn' | 'takeout' | 'delivery';

const voiceCache: Partial<Record<VoiceKind, HTMLAudioElement>> = {};
const VOICE_SRC: Record<VoiceKind, string> = {
  dineIn: '/sounds/order-dinein.mp3',
  takeout: '/sounds/order-takeout.mp3',
  delivery: '/sounds/order-delivery.mp3',
};
const CHIME_TO_VOICE_GAP_MS = 150;

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

  (Object.keys(VOICE_SRC) as VoiceKind[]).forEach((k) => {
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

function playVoice(kind: VoiceKind): void {
  const cached = voiceCache[kind];
  const audio = cached ? (cached.cloneNode(true) as HTMLAudioElement) : new Audio(VOICE_SRC[kind]);
  audio.volume = 1.0;
  void audio.play().catch(() => {
    /* 自动播放被拒：忽略，钟声依然提示了 */
  });
}

/** 堂食：钟声「叮咚」(A5→E5) + 语音「您有一个新的堂食订单」 */
export function playDineInSound() {
  const ctx = getCtx();
  let chimeMs = 0;
  if (ctx) {
    const now = ctx.currentTime;
    playTone(880, now, 0.25, ctx);
    playTone(660, now + 0.25, 0.35, ctx);
    chimeMs = (0.25 + 0.35) * 1000;
  }
  setTimeout(() => playVoice('dineIn'), chimeMs + CHIME_TO_VOICE_GAP_MS);
}

/** 外卖：钟声「叮叮」(A5×2) + 语音「您有一个新的外卖订单」 */
export function playTakeoutSound() {
  const ctx = getCtx();
  let chimeMs = 0;
  if (ctx) {
    const now = ctx.currentTime;
    playTone(880, now, 0.2, ctx);
    playTone(880, now + 0.3, 0.2, ctx);
    chimeMs = (0.3 + 0.2) * 1000;
  }
  setTimeout(() => playVoice('takeout'), chimeMs + CHIME_TO_VOICE_GAP_MS);
}

/** 送餐：钟声「叮咚」(G5→C5) + 语音「您有一个新的送餐订单」 */
export function playDeliverySound() {
  const ctx = getCtx();
  let chimeMs = 0;
  if (ctx) {
    const now = ctx.currentTime;
    playTone(784, now, 0.22, ctx);
    playTone(523, now + 0.28, 0.38, ctx);
    chimeMs = (0.28 + 0.38) * 1000;
  }
  setTimeout(() => playVoice('delivery'), chimeMs + CHIME_TO_VOICE_GAP_MS);
}

/** order:new 是否应播报（扫码送餐 pending 仅下单不播，等付款后 order:updated 再播） */
export function shouldPlayNewOrderSound(order: OrderSoundPayload): boolean {
  if (order.type === 'delivery') {
    const src = String(order.deliverySource || '').toLowerCase();
    const st = String(order.status || 'pending');
    if (src === 'qr' && st === 'pending') return false;
    return true;
  }
  return true;
}

/** 扫码送餐付款成功：pending → paid_online / checked_out */
export function shouldPlayDeliveryPaidSound(
  order: OrderSoundPayload,
  prevStatus: string | undefined,
): boolean {
  if (order.type !== 'delivery') return false;
  if (String(order.deliverySource || '').toLowerCase() !== 'qr') return false;
  const st = String(order.status || '');
  const wasUnpaid = !prevStatus || prevStatus === 'pending';
  const nowPaidish = st === 'paid_online' || st === 'checked_out';
  return wasUnpaid && nowPaidish;
}

export function playNewOrderSound(order: OrderSoundPayload): void {
  if (order.type === 'delivery') playDeliverySound();
  else if (order.type === 'takeout') playTakeoutSound();
  else playDineInSound();
}
