---
name: lzfood-wallet-lag
description: >-
  LZFOOD Apple Wallet「加入钱包」卡顿：每次现做 .pkpass（Jimp stamp 条、p12 解密、
  Logo 远程拉、门店 geocode）。Wake when the user says 钱包卡顿 (also 加入钱包慢,
  Wallet 卡顿, pkpass 慢) — read-only unless they say ok go / 实现 / 写代码.
---

# 钱包卡顿（加入 Apple 钱包慢）

## Trigger
**钱包卡顿**. Also: 加入钱包慢 / Wallet 卡顿 / pkpass 慢 / 生成会员卡慢.

## Defaults
- **No code** until user says **ok go** / **实现** / **写代码**.
- Parked 2026-10-04: Lei asked to shelf the fix and wake later with **钱包卡顿**.
- Do not change web 会员卡 layout while working this (Wallet pass only, unless asked).

## Why it waits
Frontend `addToAppleWallet` keeps the button busy until `GET /api/members/me/apple-wallet-pass` finishes **and** the `.pkpass` blob downloads. Every tap **rebuilds** the pass; nothing is cached.

Slow pieces (same request):

1. **Jimp stamp strip** (`backend/src/utils/appleWallet/stampStrip.ts`) — 1x/2x/3x canvases, **6× `loadFont` per request**, no font cache. Local ~120–170ms; Cloud Run worse.
2. **PKCS#12 every time** — `loadAppleWalletSignerMaterial()` decrypts `.p12` with node-forge, no cache.
3. **Logo fetch** — `resolveLogoBuffer` in `buildPass.ts` may hit GCS/HTTP; timeout **8s**.
4. **Store locations** — `resolvePassStoreLocations` may **sequentially** Google-geocode up to 10 stores if lat/lng missing. Easiest way to get multi-second waits.

Then iPhone still has Safari’s Add-to-Wallet UI after the download.

## When implementing (after ok go)
Priority order:

1. Cache signer material in process (p12 parse once).
2. Cache Jimp fonts; generate **@2x strip only** (or cache strip by `stamps|goal|fgColor`).
3. Cache logo buffer by `logoUrl` (memory, short TTL).
4. Skip geocode when restaurant lat/lng already stored; don’t block pass issue on locations.

Do not echo certs / `.p12` / env secrets.

## Key files
| Piece | Path |
|-------|------|
| Member download | `GET /api/members/me/apple-wallet-pass` → `members.ts` |
| Issue | `backend/src/utils/appleWallet/issuePass.ts` |
| Build | `backend/src/utils/appleWallet/buildPass.ts` |
| Stamp PNGs | `backend/src/utils/appleWallet/stampStrip.ts` |
| Certs | `backend/src/utils/appleWallet/certs.ts` |
| Locations | `backend/src/utils/appleWallet/storeLocations.ts` |
| UI busy | `frontend/src/pages/customer/MemberPortalPage.tsx` `addToAppleWallet` |
